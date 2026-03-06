import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './connection';
import { db } from '../db/knex';
import { summarizeMessages } from '../services/gemini';
import { formatDailyReport, formatRequiredBlock } from '../utils/formatReport';
import { formatDailySummary, WorkerHoursEntry } from '../utils/formatSummary';
import { syncSummaryToSheets } from '../services/sheets';
import { logger } from '../utils/logger';
import { Bot } from 'grammy';
import { BotContext } from '../bot/bot';

const QUEUE_NAME = 'report';

export interface ReportJobData {
  projectId: number;
  date: string; // YYYY-MM-DD
  statusMessageId?: number;  // Временное сообщение «Генерация запущена...»
  statusChatId?: number;
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
      const { projectId, date, statusMessageId, statusChatId } = job.data as ReportJobData;

      // 1. Получаем проект
      const project = await db('projects').where('id', projectId).first();
      if (!project) {
        logger.warn({ projectId }, 'Report skipped: project not found');
        return;
      }

      // 2. Получаем топики для отправки отчёта (только «reports» и «general»)
      const topicBindings = await db('project_topics')
        .where('project_id', projectId)
        .whereIn('topic_type', ['reports', 'general']);
      if (topicBindings.length === 0) {
        logger.warn({ projectId }, 'Report skipped: no topic bindings');
        return;
      }

      logger.info({ projectId, projectName: project.name, date, topicsCount: topicBindings.length }, 'Daily report generation started');

      // 3. Собираем сообщения из буфера за день (по project_id, не по group_id)
      const messages = await db('message_buffer')
        .where('project_id', projectId)
        .where('message_date', date)
        .orderBy('created_at', 'asc');

      // 4. Генерация суточного отчёта (если есть сообщения)
      if (messages.length > 0) {
        await generateDailyReport(bot, project, topicBindings, messages, date);
      } else {
        logger.info({ projectId, date }, 'No messages for daily report');
      }

      // 5. Генерация финансовой сводки (всегда, даже если нет сообщений)
      await generateFinancialSummary(bot, project, topicBindings, date);

      // 6. Обновление сводки в Google Sheets (fire-and-forget)
      syncSummaryToSheets().catch((err) =>
        logger.error({ err }, 'Sheets summary sync failed')
      );

      // 7. Удаляем временное сообщение «Генерация запущена...»
      if (statusMessageId && statusChatId) {
        try {
          await bot.api.deleteMessage(statusChatId, statusMessageId);
        } catch { /* уже удалено или нет прав */ }
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
  const allocatedHours = parseFloat(project.allocated_hours || '0');

  // Человеко-часы за сегодня
  const workerHoursRows = await db('worker_hours')
    .where('project_id', project.id)
    .where('work_date', date)
    .orderBy('created_at', 'asc');

  const workerHoursToday: WorkerHoursEntry[] = workerHoursRows.map((row: any) => ({
    workerName: row.worker_name,
    workerType: row.worker_type,
    hours: parseFloat(row.hours),
  }));

  // Общие часы
  const totalHoursResult = await db('worker_hours')
    .where('project_id', project.id)
    .sum('hours as total')
    .first();
  const spentHours = parseFloat(totalHoursResult?.total || '0');
  const remainingHours = allocatedHours - spentHours;

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
    allocatedHours,
    spentHours,
    remainingHours,
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
