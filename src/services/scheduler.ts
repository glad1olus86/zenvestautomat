import { Cron } from 'croner';
import { config } from '../config';
import { db } from '../db/knex';
import { reportQueue } from '../queues/report.queue';
import { pullChangesFromSheets } from './sheets';
import { logger } from '../utils/logger';

let reportCron: Cron | null = null;
let sheetsSyncCron: Cron | null = null;

/**
 * Запускает все планировщики:
 * 1. Суточные отчёты — каждый день в DAILY_REPORT_TIME (20:00)
 * 2. Sheets → PG — каждые 5 минут
 */
export function startScheduler(): void {
  // 1. Суточные отчёты
  const [hours, minutes] = config.dailyReportTime.split(':').map(Number);
  const reportCronExpr = `${minutes} ${hours} * * *`;

  reportCron = new Cron(reportCronExpr, {
    timezone: config.timezone,
  }, async () => {
    await triggerDailyReports();
  });

  logger.info({
    cron: reportCronExpr,
    timezone: config.timezone,
    time: config.dailyReportTime,
  }, 'Report scheduler started');

  // 2. Google Sheets → PG (каждые 5 минут)
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
 * Можно вызывать вручную для тестирования.
 */
export async function triggerDailyReports(): Promise<void> {
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
}
