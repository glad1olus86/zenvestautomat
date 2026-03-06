import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { db, initDatabase } from './db/knex';
import { createBot, startBot, stopBot } from './bot/bot';
import { checkRedis } from './queues/connection';
import { startTranscriptionWorker } from './queues/transcription.queue';
import { startReceiptWorker } from './queues/receipt.queue';
import { startReportWorker } from './queues/report.queue';
import { startScheduler, stopScheduler } from './services/scheduler';
import { initSheets } from './services/sheets';
import { initDrive } from './services/drive';

async function main() {
  logger.info('Starting Zenvest...');

  // 1. База данных
  await initDatabase();

  // 2. Redis — проверка подключения
  const redisOk = await checkRedis();
  if (!redisOk) {
    throw new Error('Redis connection failed');
  }

  // 3. Google Sheets — инициализация (опционально)
  const sheetsOk = await initSheets();
  if (sheetsOk) {
    logger.info('Google Sheets sync enabled');
  } else {
    logger.warn('Google Sheets sync disabled — configure GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID');
  }

  // 3.1 Google Drive — инициализация (опционально)
  const driveOk = await initDrive();
  if (driveOk) {
    logger.info('Google Drive upload enabled');
  } else {
    logger.warn('Google Drive upload disabled — configure GOOGLE_DRIVE_FOLDER_ID');
  }

  // 4. BullMQ Workers (transcription не зависит от бота)
  const transcriptionWorker = startTranscriptionWorker();

  // 5. Express (health check)
  const app = express();
  app.get('/health', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ status: 'ok', db: true, redis: true, sheets: sheetsOk });
    } catch {
      res.status(503).json({ status: 'error', db: false, redis: false, sheets: false });
    }
  });

  const server = app.listen(config.port, () => {
    logger.info(`HTTP server on port ${config.port}`);
  });

  // 6. Telegram-бот
  const bot = createBot();
  const receiptWorker = startReceiptWorker(bot);
  const reportWorker = startReportWorker(bot);
  await startBot(bot);

  // 7. Планировщики (суточные отчёты 20:00 + Sheets sync каждые 5 мин)
  startScheduler();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down...`);
    stopScheduler();
    stopBot(bot);
    await transcriptionWorker.close();
    await receiptWorker.close();
    await reportWorker.close();
    server.close();
    await db.destroy();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
