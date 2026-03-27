import { Cron } from 'croner';
import { Bot } from 'grammy';
import { BotContext } from '../bot/bot';
import { config } from '../config';
import { db } from '../db/knex';
import { reportQueue } from '../queues/report.queue';
import { pullChangesFromSheets } from './sheets';
import { logger } from '../utils/logger';

let reportCron: Cron | null = null;
let reminderCron: Cron | null = null;
let sheetsSyncCron: Cron | null = null;

/**
 * Запускает все планировщики:
 * 1. Напоминание о REPORT — каждый день в REPORT_REMINDER_TIME (18:00)
 * 2. Суточные отчёты — каждый день в DAILY_REPORT_TIME (20:00)
 * 3. Sheets → PG — каждые 5 минут
 */
export function startScheduler(bot: Bot<BotContext>): void {
  // 1. Напоминание о REPORT (18:00)
  const [remH, remM] = config.reportReminderTime.split(':').map(Number);
  const reminderCronExpr = `${remM} ${remH} * * *`;

  reminderCron = new Cron(reminderCronExpr, {
    timezone: config.timezone,
  }, async () => {
    await checkMissingReports(bot);
  });

  logger.info({
    cron: reminderCronExpr,
    timezone: config.timezone,
    time: config.reportReminderTime,
  }, 'Report reminder scheduler started');

  // 2. Суточные отчёты (20:00)
  const [hours, minutes] = config.dailyReportTime.split(':').map(Number);
  const reportCronExpr = `${minutes} ${hours} * * *`;

  reportCron = new Cron(reportCronExpr, {
    timezone: config.timezone,
  }, async () => {
    await triggerDailyReports(bot);
  });

  logger.info({
    cron: reportCronExpr,
    timezone: config.timezone,
    time: config.dailyReportTime,
  }, 'Report scheduler started');

  // 3. Google Sheets → PG (каждые 5 минут)
  sheetsSyncCron = new Cron('*/5 * * * *', {
    timezone: config.timezone,
  }, async () => {
    logger.debug('Sheets → PG sync triggered');
    await pullChangesFromSheets();
  });

  logger.info('Sheets sync scheduler started (every 5 min)');
}

/**
 * Останавливает все планировщики.
 */
export function stopScheduler(): void {
  if (reminderCron) {
    reminderCron.stop();
    reminderCron = null;
  }
  if (reportCron) {
    reportCron.stop();
    reportCron = null;
  }
  if (sheetsSyncCron) {
    sheetsSyncCron.stop();
    sheetsSyncCron = null;
  }
  logger.info('All schedulers stopped');
}

/**
 * Запускает генерацию отчётов для всех активных проектов.
 * После enqueue отправляет алерт в группу руководства о проектах без REPORT.
 */
export async function triggerDailyReports(bot?: Bot<BotContext>): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  logger.info({ date: today }, 'Triggering daily reports for all active projects');

  // Только проекты с хотя бы одним привязанным топиком
  const projects = await db('projects')
    .where('status', 'active')
    .whereExists(
      db('project_topics').whereRaw('project_topics.project_id = projects.id')
    );

  if (projects.length === 0) {
    logger.info('No active projects found');
    return;
  }

  for (const project of projects) {
    await reportQueue.add('daily-report', {
      projectId: project.id,
      date: today,
    });

    logger.debug({ projectId: project.id, projectName: project.name }, 'Report job enqueued');
  }

  logger.info({ projectCount: projects.length, date: today }, 'All report jobs enqueued');

  // Алерт в группу руководства о пропущенных REPORT
  if (bot && config.managementGroupId) {
    try {
      await sendManagementAlert(bot, projects, today);
    } catch (err) {
      logger.error({ err }, 'Failed to send management alert');
    }
  }
}

/**
 * Проверяет отсутствующие REPORT и отправляет напоминания в группы проектов (18:00).
 */
async function checkMissingReports(bot: Bot<BotContext>): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const projects = await db('projects')
    .where('status', 'active')
    .whereExists(
      db('project_topics').whereRaw('project_topics.project_id = projects.id')
    );

  for (const project of projects) {
    const report = await db('manager_reports')
      .where('project_id', project.id)
      .where('report_date', today)
      .first();

    if (report) continue;

    // Нет REPORT — напоминаем в топики проекта
    const topicBindings = await db('project_topics')
      .where('project_id', project.id)
      .whereIn('topic_type', ['reports', 'general']);

    for (const binding of topicBindings) {
      try {
        await bot.api.sendMessage(
          binding.telegram_group_id,
          `⚠️ Отчёт (REPORT) по объекту <b>${project.name}</b> ещё не написан.\n\nНапишите <code>REPORT</code> и секции: Сделано, Проблемы, План завтра.`,
          {
            parse_mode: 'HTML',
            message_thread_id: binding.topic_thread_id,
          },
        );
      } catch (err) {
        logger.error({ err, projectId: project.id }, 'Failed to send report reminder');
      }
    }

    logger.info({ projectId: project.id, projectName: project.name }, 'Report reminder sent');
  }
}

/**
 * Отправляет алерт в группу руководства о проектах без REPORT (20:00).
 */
async function sendManagementAlert(
  bot: Bot<BotContext>,
  projects: any[],
  date: string
): Promise<void> {
  const missingProjects: string[] = [];

  for (const project of projects) {
    const report = await db('manager_reports')
      .where('project_id', project.id)
      .where('report_date', date)
      .first();

    if (!report) {
      missingProjects.push(project.name);
    }
  }

  if (missingProjects.length === 0) return;

  const formattedDate = date.split('-').reverse().join('.');
  const text = `⚠️ <b>Отчёты не получены (${formattedDate}):</b>\n\n` +
    missingProjects.map((name) => `— ${name}`).join('\n');

  const opts: any = { parse_mode: 'HTML' as const };
  if (config.managementTopicId) {
    opts.message_thread_id = parseInt(config.managementTopicId, 10);
  }

  await bot.api.sendMessage(config.managementGroupId, text, opts);
  logger.info({ missing: missingProjects.length, date }, 'Management alert sent');
}
