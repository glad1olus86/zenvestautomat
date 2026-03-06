import { NextFunction } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';

/**
 * Ищет проект по паре (telegram_group_id, topic_thread_id) через таблицу project_topics.
 * Сообщения вне привязанных топиков получают ctx.project = null.
 */
export async function resolveGroup(ctx: BotContext, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id;
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  // Определяем thread ID из разных типов обновлений
  const threadId =
    ctx.message?.message_thread_id ??
    ctx.callbackQuery?.message?.message_thread_id ??
    null;

  if (chatId && isGroup && threadId) {
    try {
      const project = await db('project_topics')
        .join('projects', 'project_topics.project_id', 'projects.id')
        .where('project_topics.telegram_group_id', chatId.toString())
        .where('project_topics.topic_thread_id', threadId)
        .select('projects.*')
        .first();

      ctx.project = project || null;
    } catch (err) {
      logger.error({ err, chatId, threadId }, 'Failed to resolve project by topic');
      ctx.project = null;
    }
  } else {
    ctx.project = null;
  }

  await next();
}
