import { Bot, Context, session } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ignoreService } from './middleware/ignoreService';
import { resolveGroup } from './middleware/resolveGroup';
import { setupGroupInit } from './handlers/groupInit';
import { setupRegister } from './handlers/register';
import { setupTextMessage } from './handlers/textMessage';

export interface ProjectData {
  id: number;
  name: string;
  telegram_group_id: string;
  topic_thread_id: number | null;
  topics_enabled: boolean;
}

export interface BotContext extends Context {
  project?: ProjectData | null;
}

export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.telegramBotToken);

  // Глобальный error handler
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'Bot error');
  });

  // Middleware
  bot.use(ignoreService);
  bot.use(resolveGroup);

  // Handlers
  setupGroupInit(bot);
  setupRegister(bot);
  setupTextMessage(bot);

  return bot;
}

export async function startBot(bot: Bot<BotContext>): Promise<void> {
  const me = await bot.api.getMe();
  logger.info(`Bot started: @${me.username} (${me.id})`);
  bot.start({
    onStart: () => logger.info('Long polling started'),
  });
}

export function stopBot(bot: Bot<BotContext>): void {
  bot.stop();
  logger.info('Bot stopped');
}
