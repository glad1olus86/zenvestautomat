import { NextFunction } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';

/**
 * Ищет проект по telegram_group_id текущего чата.
 * Если найден — прикрепляет к ctx.project.
 * Если не найден — ctx.project = null (бот всё равно работает, буферизация по group_id).
 */
export async function resolveGroup(ctx: BotContext, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id;

  if (chatId && (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup')) {
    try {
      const project = await db('projects')
        .where('telegram_group_id', chatId.toString())
        .first();

      ctx.project = project || null;
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to resolve group');
      ctx.project = null;
    }
  } else {
    ctx.project = null;
  }

  await next();
}
