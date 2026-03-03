import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { db, initDatabase } from './db/knex';
import { createBot, startBot, stopBot } from './bot/bot';

async function main() {
  logger.info('Starting Zenvest...');

  // 1. База данных
  await initDatabase();

  // 2. Express (health check)
  const app = express();
  app.get('/health', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ status: 'ok', db: true });
    } catch {
      res.status(503).json({ status: 'error', db: false });
    }
  });

  const server = app.listen(config.port, () => {
    logger.info(`HTTP server on port ${config.port}`);
  });

  // 3. Telegram-бот
  const bot = createBot();
  await startBot(bot);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down...`);
    stopBot(bot);
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
