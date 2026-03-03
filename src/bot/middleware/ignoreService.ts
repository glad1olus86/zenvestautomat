import { NextFunction } from 'grammy';
import { BotContext } from '../bot';

/**
 * Отсекает сервисные сообщения (вход/выход, закрепление и т.д.)
 * Пропускает только обычные сообщения с контентом.
 */
export async function ignoreService(ctx: BotContext, next: NextFunction): Promise<void> {
  const msg = ctx.message;

  if (!msg) {
    await next();
    return;
  }

  // Сервисные поля — если любое из них присутствует, это сервисное сообщение
  const serviceFields = [
    'new_chat_members',
    'left_chat_member',
    'new_chat_title',
    'new_chat_photo',
    'delete_chat_photo',
    'group_chat_created',
    'supergroup_chat_created',
    'channel_chat_created',
    'migrate_to_chat_id',
    'migrate_from_chat_id',
    'pinned_message',
    'forum_topic_created',
    'forum_topic_closed',
    'forum_topic_reopened',
    'forum_topic_edited',
    'general_forum_topic_hidden',
    'general_forum_topic_unhidden',
  ] as const;

  for (const field of serviceFields) {
    if ((msg as any)[field] !== undefined) {
      return; // не вызываем next() — сообщение отсекается
    }
  }

  await next();
}
