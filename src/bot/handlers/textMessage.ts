import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';

/**
 * Сохраняет все текстовые сообщения в message_buffer для суточной суммаризации.
 * Пропускает команды бота (начинаются с /).
 */
export function setupTextMessage(bot: Bot<BotContext>): void {
  bot.on('message:text', async (ctx) => {
    // Только группы
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return;
    }

    const text = ctx.message.text;

    // Пропускаем команды бота
    if (text.startsWith('/')) {
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

    // Дата сообщения в таймзоне Prague
    const messageDate = new Date(ctx.message.date * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' }); // формат YYYY-MM-DD

    try {
      await db('message_buffer').insert({
        project_id: ctx.project?.id || null,
        telegram_group_id: chatId.toString(),
        telegram_user_id: userId.toString(),
        user_name: userName,
        message_type: 'text',
        content: text,
        telegram_message_id: ctx.message.message_id,
        message_date: messageDate,
      });
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to buffer text message');
    }
  });
}
