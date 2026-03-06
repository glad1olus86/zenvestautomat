import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { logger } from '../../utils/logger';

/**
 * Обрабатывает добавление бота в группу.
 * Отправляет инструкцию по настройке.
 */
export function setupGroupInit(bot: Bot<BotContext>): void {
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const newStatus = update.new_chat_member.status;
    const chat = update.chat;

    // Реагируем только на добавление бота в группу/супергруппу
    if (
      (newStatus !== 'administrator' && newStatus !== 'member') ||
      (chat.type !== 'group' && chat.type !== 'supergroup')
    ) {
      return;
    }

    logger.info({ chatId: chat.id, chatTitle: chat.title, status: newStatus }, 'Bot added to group');

    try {
      const chatInfo = await ctx.api.getChat(chat.id);
      const isForum = 'is_forum' in chatInfo && chatInfo.is_forum === true;

      if (isForum) {
        await ctx.api.sendMessage(
          chat.id,
          '👋 <b>Zenvest Bot активирован!</b>\n\n' +
          'Бот работает через топики (треды). Инструкция:\n\n' +
          '1. <b>/register Название</b> — создайте объект\n' +
          '2. Зайдите в нужный топик\n' +
          '3. <b>/link Название</b> — привяжите топик к объекту\n\n' +
          'Разные топики можно привязать к разным объектам.\n' +
          'Подробнее: /help',
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.api.sendMessage(
          chat.id,
          '👋 <b>Zenvest Bot активирован!</b>\n\n' +
          '⚠️ Топики (треды) не включены. Для полной работы бота:\n' +
          'Настройки группы → Темы → Вкл\n\n' +
          'Затем используйте /register и /link для настройки объектов.\n' +
          'Подробнее: /help',
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      logger.error({ err, chatId: chat.id }, 'Group init message failed');
    }
  });
}
