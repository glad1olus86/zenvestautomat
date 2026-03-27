import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './connection';
import { db } from '../db/knex';
import { summarizeMessages } from '../services/gemini';
import { formatDailyReport } from '../utils/formatReport';
import { formatManagerDailyReport } from '../utils/formatManagerReport';
import { formatDailySummary, WorkerHoursEntry } from '../utils/formatSummary';
import { syncSummaryToSheets, syncAllHoursToSheets } from '../services/sheets';
import { logger } from '../utils/logger';
import { Bot } from 'grammy';
import { BotContext } from '../bot/bot';

const QUEUE_NAME = 'report';

export interface ReportJobData {
  projectId: number;
  date: string; // YYYY-MM-DD
  statusMessageId?: number;  // Временное сообщение «Генерация запущена...»
  statusChatId?: number;
  sourceThreadId?: number | null;  // Топик, откуда вызван /report
}

export const reportQueue = new Queue(QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

/**
 * Запуск воркера суточных отчётов.
 */
export function startReportWorker(bot: Bot<BotContext>): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { projectId, date, statusMessageId, statusChatId, sourceThreadId } = job.data as ReportJobData;

      try {
        // 1. Получаем проект
        const project = await db('projects').where('id', projectId).first();
        if (!project) {
          logger.warn({ projectId }, 'Report skipped: project not found');
          return;
        }

        // 2. Получаем топики для отправки отчёта (только «reports» и «general»)
        let topicBindings = await db('project_topics')
          .where('project_id', projectId)
          .whereIn('topic_type', ['reports', 'general']);

        // Для ручного /report: если нет 'reports'/'general' топиков, используем топик-источник
        if (topicBindings.length === 0 && statusChatId && sourceThreadId) {
          const sourceTopic = await db('project_topics')
            .where('project_id', projectId)
            .where('telegram_group_id', statusChatId.toString())
            .where('topic_thread_id', sourceThreadId)
            .first();
          if (sourceTopic) {
            topicBindings = [sourceTopic];
            logger.info({ projectId }, 'Using source topic as fallback for report');
          }
        }

        if (topicBindings.length === 0) {
          logger.warn({ projectId }, 'Report skipped: no topic bindings');
          // Уведомляем пользователя
          if (statusChatId && sourceThreadId) {
            try {
              await bot.api.sendMessage(
                statusChatId,
                '⚠️ Нет топика с типом «Отчёты». Привяжите топик через /link → 📋 Отчёты.',
                { message_thread_id: sourceThreadId },
              );
            } catch { /* ignore */ }
          }
          return;
        }

        logger.info({ projectId, projectName: project.name, date, topicsCount: topicBindings.length }, 'Daily report generation started');

        // 3. Проверяем наличие REPORT от менеджера (приоритет)
        const managerReport = await db('manager_reports')
          .where('project_id', projectId)
          .where('report_date', date)
          .first();

        // 4. Генерация суточного отчёта
        if (managerReport) {
          // Есть REPORT менеджера — используем его, не вызываем Gemini
          await generateDailyReportFromManager(bot, project, topicBindings, managerReport, date);
        } else {
          // Нет REPORT — AI-суммаризация из буфера сообщений
          const messages = await db('message_buffer')
            .where('project_id', projectId)
            .where('message_date', date)
            .orderBy('created_at', 'asc');

          if (messages.length > 0) {
            await generateDailyReport(bot, project, topicBindings, messages, date);
          } else {
            logger.info({ projectId, date }, 'No messages and no manager report for daily report');
          }
        }

        // 5. Очищаем message_buffer за этот проект и дату (отчёт уже сгенерирован)
        const deletedRows = await db('message_buffer')
          .where('project_id', projectId)
          .where('message_date', date)
          .del();
        if (deletedRows > 0) {
          logger.info({ projectId, date, deletedRows }, 'Message buffer cleared after report');
        }

        // 6. Генерация финансовой сводки (всегда, даже если нет сообщений)
        await generateFinancialSummary(bot, project, topicBindings, date);

        // 7. Обновление сводки в Google Sheets (fire-and-forget)
        syncSummaryToSheets().catch((err) =>
          logger.error({ err }, 'Sheets summary sync failed')
        );

        // 8. Синхронизация GPS+ручных часов в лист проекта (fire-and-forget)
        syncAllHoursToSheets(projectId).catch((err) =>
          logger.error({ err }, 'GPS hours Sheets sync failed')
        );
      } finally {
        // ВСЕГДА удаляем временное сообщение «Генерация запущена...»
        if (statusMessageId && statusChatId) {
          try {
            await bot.api.deleteMessage(statusChatId, statusMessageId);
          } catch { /* уже удалено или нет прав */ }
        }
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job?.id }, 'Report job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Report job failed');
  });

  logger.info('Report worker started (concurrency=2)');
  return worker;
}

/**
 * Генерирует суточный отчёт из REPORT менеджера (без Gemini).
 */
async function generateDailyReportFromManager(
  bot: Bot<BotContext>,
  project: any,
  topicBindings: any[],
  managerReport: any,
  date: string
): Promise<void> {
  const formattedDate = formatDateRu(date);

  const reportText = formatManagerDailyReport({
    projectName: project.name,
    date: formattedDate,
    managerName: managerReport.manager_name,
    doneBlock: managerReport.done_block,
    problemsBlock: managerReport.problems_block,
    extraWorkBlock: managerReport.extra_work_block,
    needToOrderBlock: managerReport.need_to_order_block,
    plannedBlock: managerReport.plan_tomorrow_block,
    messageLink: managerReport.message_link,
  });

  // Публикуем отчёт во все привязанные топики
  let savedMessageId: number | null = null;
  for (const binding of topicBindings) {
    try {
      const msg = await bot.api.sendMessage(
        binding.telegram_group_id,
        reportText,
        {
          parse_mode: 'HTML',
          message_thread_id: binding.topic_thread_id,
        }
      );
      if (!savedMessageId) savedMessageId = msg.message_id;
    } catch (err) {
      logger.error({ err, binding }, 'Failed to send manager daily report to topic');
    }
  }

  // Сохраняем в daily_reports
  await db('daily_reports')
    .insert({
      project_id: project.id,
      report_date: date,
      report_text: reportText,
      done_block: managerReport.done_block,
      required_block: managerReport.need_to_order_block,
      planned_block: managerReport.plan_tomorrow_block,
      telegram_message_id: savedMessageId,
    })
    .onConflict(['project_id', 'report_date'])
    .merge({
      report_text: reportText,
      done_block: managerReport.done_block,
      required_block: managerReport.need_to_order_block,
      planned_block: managerReport.plan_tomorrow_block,
      telegram_message_id: savedMessageId,
    });

  logger.info({
    projectId: project.id,
    date,
    manager: managerReport.manager_name,
    source: 'manager_report',
  }, 'Daily report published (from manager REPORT)');
}

/**
 * Генерирует суточный отчёт через Gemini и публикует во все привязанные топики.
 */
async function generateDailyReport(
  bot: Bot<BotContext>,
  project: any,
  topicBindings: any[],
  messages: any[],
  date: string
): Promise<void> {
  const formattedDate = formatDateRu(date);

  // Суммаризация через Gemini
  const result = await summarizeMessages(
    messages.map((m) => ({ userName: m.user_name || 'Аноним', content: m.content })),
    project.name,
    formattedDate
  );

  if (!result) {
    logger.error({ projectId: project.id, date }, 'Gemini summarization returned null');
    return;
  }

  const reportText = formatDailyReport({
    projectName: project.name,
    date: formattedDate,
    doneBlock: result.doneBlock,
    requiredBlock: result.requiredBlock,
    plannedBlock: result.plannedBlock,
  });

  // Публикуем отчёт во все привязанные топики
  let savedMessageId: number | null = null;
  for (const binding of topicBindings) {
    try {
      const msg = await bot.api.sendMessage(
        binding.telegram_group_id,
        reportText,
        {
          parse_mode: 'HTML',
          message_thread_id: binding.topic_thread_id,
        }
      );
      if (!savedMessageId) savedMessageId = msg.message_id;
    } catch (err) {
      logger.error({ err, binding }, 'Failed to send daily report to topic');
    }
  }

  // Сохраняем отчёт в БД
  await db('daily_reports')
    .insert({
      project_id: project.id,
      report_date: date,
      report_text: result.reportText,
      done_block: result.doneBlock,
      required_block: result.requiredBlock,
      planned_block: result.plannedBlock,
      telegram_message_id: savedMessageId,
    })
    .onConflict(['project_id', 'report_date'])
    .merge({
      report_text: result.reportText,
      done_block: result.doneBlock,
      required_block: result.requiredBlock,
      planned_block: result.plannedBlock,
      telegram_message_id: savedMessageId,
    });

  logger.info({
    projectId: project.id,
    date,
    messagesCount: messages.length,
  }, 'Daily report published');
}

/**
 * Генерирует финансовую сводку и публикует во все привязанные топики.
 */
async function generateFinancialSummary(
  bot: Bot<BotContext>,
  project: any,
  topicBindings: any[],
  date: string
): Promise<void> {
  const formattedDate = formatDateRu(date);

  // Потрачено сегодня
  const todayResult = await db('receipts')
    .where('project_id', project.id)
    .where('receipt_date', date)
    .where('recognition_status', 'success')
    .sum('amount_czk as total')
    .first();
  const spentTodayCzk = parseFloat(todayResult?.total || '0');

  // Потрачено всего
  const totalResult = await db('receipts')
    .where('project_id', project.id)
    .where('recognition_status', 'success')
    .sum('amount_czk as total')
    .first();
  const spentTotalCzk = parseFloat(totalResult?.total || '0');

  const budgetCzk = parseFloat(project.budget_czk || '0');
  const remainingCzk = budgetCzk - spentTotalCzk;
  const laborBudgetCzk = parseFloat(project.labor_budget_czk || '0');

  // ── Человеко-часы за сегодня (GPS приоритет + ручной fallback) ──

  // A. GPS-часы за дату (gps_work_hours → vehicles → workers)
  const gpsHoursToday = await db('gps_work_hours')
    .join('vehicles', 'gps_work_hours.vehicle_id', 'vehicles.id')
    .join('workers', 'vehicles.worker_id', 'workers.id')
    .where('gps_work_hours.project_id', project.id)
    .where('gps_work_hours.work_date', date)
    .whereNotNull('gps_work_hours.hours')
    .groupBy('workers.id', 'workers.name', 'workers.worker_type', 'workers.hourly_rate')
    .select(
      'workers.name as worker_name',
      'workers.worker_type',
      'workers.hourly_rate',
      db.raw('SUM(gps_work_hours.hours) as total_hours'),
    );

  // B. Ручные часы за дату
  const manualHoursToday = await db('worker_hours')
    .where('project_id', project.id)
    .where('work_date', date)
    .orderBy('created_at', 'asc');

  // C. GPS-трекаемые рабочие (имеют машину с VIN)
  const gpsTrackedNames: string[] = await db('workers')
    .join('vehicles', 'vehicles.worker_id', 'workers.id')
    .whereNotNull('vehicles.vin')
    .pluck('workers.name');
  const gpsTrackedSet = new Set(gpsTrackedNames);

  // Ставки из справочника workers
  const allWorkers = await db('workers').select('name', 'hourly_rate');
  const rateMap = new Map<string, number>();
  for (const w of allWorkers) {
    if (w.hourly_rate) rateMap.set(w.name, parseFloat(w.hourly_rate));
  }

  // D. Объединение: GPS-рабочие + ручные (только не-GPS)
  const workerHoursToday: WorkerHoursEntry[] = [
    ...gpsHoursToday.map((row: any) => {
      const hours = parseFloat(row.total_hours);
      const rate = row.hourly_rate ? parseFloat(row.hourly_rate) : (rateMap.get(row.worker_name) ?? 0);
      return {
        workerName: row.worker_name,
        workerType: row.worker_type,
        hours,
        hourlyRate: rate,
        cost: hours * rate,
        source: 'gps' as const,
      };
    }),
    ...manualHoursToday
      .filter((row: any) => !gpsTrackedSet.has(row.worker_name))
      .map((row: any) => {
        const hours = parseFloat(row.hours);
        const rate = rateMap.get(row.worker_name) ?? 0;
        return {
          workerName: row.worker_name,
          workerType: row.worker_type,
          hours,
          hourlyRate: rate,
          cost: hours * rate,
          source: 'manual' as const,
        };
      }),
  ];

  // E. Общая стоимость работ (все время): GPS (часы × ставка) + ручные (не-GPS)
  const gpsLaborRows = await db('gps_work_hours')
    .join('vehicles', 'gps_work_hours.vehicle_id', 'vehicles.id')
    .join('workers', 'vehicles.worker_id', 'workers.id')
    .where('gps_work_hours.project_id', project.id)
    .whereNotNull('gps_work_hours.hours')
    .groupBy('workers.id', 'workers.name', 'workers.hourly_rate')
    .select(
      'workers.name as worker_name',
      'workers.hourly_rate',
      db.raw('SUM(gps_work_hours.hours) as total_hours'),
    );

  let spentLaborCzk = 0;
  for (const row of gpsLaborRows) {
    const hours = parseFloat(row.total_hours || '0');
    const rate = row.hourly_rate ? parseFloat(row.hourly_rate) : (rateMap.get(row.worker_name) ?? 0);
    spentLaborCzk += hours * rate;
  }

  // Ручные часы (не-GPS рабочие) — стоимость
  const manualLaborRows = await db('worker_hours')
    .where('project_id', project.id)
    .modify((qb: any) => {
      if (gpsTrackedNames.length > 0) qb.whereNotIn('worker_name', gpsTrackedNames);
    })
    .groupBy('worker_name')
    .select('worker_name')
    .sum('hours as total_hours');

  for (const row of manualLaborRows) {
    const hours = parseFloat(row.total_hours || '0');
    const rate = rateMap.get(row.worker_name) ?? 0;
    spentLaborCzk += hours * rate;
  }

  const remainingLaborCzk = laborBudgetCzk - spentLaborCzk;

  // Не отправляем пустую сводку если нет бюджета, трат и часов
  if (budgetCzk === 0 && laborBudgetCzk === 0 && spentTotalCzk === 0 && workerHoursToday.length === 0) {
    logger.debug({ projectId: project.id, date }, 'Financial summary skipped: no data');
    return;
  }

  const summaryText = formatDailySummary({
    projectName: project.name,
    date: formattedDate,
    spentTodayCzk,
    spentTotalCzk,
    budgetCzk,
    remainingCzk,
    laborBudgetCzk,
    spentLaborCzk,
    remainingLaborCzk,
    workerHoursToday,
  });

  // Публикуем сводку во все привязанные топики
  let savedMessageId: number | null = null;
  for (const binding of topicBindings) {
    try {
      const msg = await bot.api.sendMessage(
        binding.telegram_group_id,
        summaryText,
        {
          parse_mode: 'HTML',
          message_thread_id: binding.topic_thread_id,
        }
      );
      if (!savedMessageId) savedMessageId = msg.message_id;
    } catch (err) {
      logger.error({ err, binding }, 'Failed to send financial summary to topic');
    }
  }

  // Сохраняем в БД
  await db('daily_summaries')
    .insert({
      project_id: project.id,
      summary_date: date,
      spent_today_czk: spentTodayCzk,
      spent_total_czk: spentTotalCzk,
      budget_czk: budgetCzk,
      remaining_czk: remainingCzk,
      summary_text: summaryText,
      telegram_message_id: savedMessageId,
    })
    .onConflict(['project_id', 'summary_date'])
    .merge({
      spent_today_czk: spentTodayCzk,
      spent_total_czk: spentTotalCzk,
      budget_czk: budgetCzk,
      remaining_czk: remainingCzk,
      summary_text: summaryText,
      telegram_message_id: savedMessageId,
    });

  logger.info({
    projectId: project.id,
    date,
    spentTodayCzk,
    spentTotalCzk,
    budgetCzk,
  }, 'Financial summary published');
}

/**
 * Форматирует дату YYYY-MM-DD → ДД.ММ.ГГГГ
 */
function formatDateRu(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}
