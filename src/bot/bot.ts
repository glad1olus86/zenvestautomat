import { Bot, Context } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ignoreService } from './middleware/ignoreService';
import { resolveGroup } from './middleware/resolveGroup';
import { setupGroupInit } from './handlers/groupInit';
import { setupRegister } from './handlers/register';
import { setupTextMessage } from './handlers/textMessage';
import { setupVoiceMessage } from './handlers/voiceMessage';
import { setupPhotoMessage } from './handlers/photoMessage';
import { setupDocumentMessage } from './handlers/documentMessage';
import { setupCallbackRetry } from './handlers/callbackRetry';
import { setupReportCommand } from './handlers/reportCommand';
import { setupHoursCommand } from './handlers/hoursCommand';
import { setupTopicLink } from './handlers/topicLink';
import { setupHelpCommand } from './handlers/helpCommand';
import { setupManagerReport } from './handlers/managerReport';
import { setupStartMenu } from './handlers/startMenu';
import { setupWorkersMenu } from './handlers/workersMenu';

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

  // Handlers — команды ПЕРЕД общими обработчиками (иначе bot.on('message:text') перехватит)
  setupStartMenu(bot);
  setupWorkersMenu(bot);
  setupGroupInit(bot);
  setupHelpCommand(bot);
  setupRegister(bot);
  setupTopicLink(bot);
  setupManagerReport(bot);
  setupReportCommand(bot);
  setupHoursCommand(bot);
  setupTextMessage(bot);
  setupVoiceMessage(bot);
  setupPhotoMessage(bot);
  setupDocumentMessage(bot);
  setupCallbackRetry(bot);

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
