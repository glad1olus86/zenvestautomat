import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';

/**
 * Команда /register <Название проекта>
 * Регистрирует текущую группу как объект (проект).
 * Используется для MVP до появления веб-интерфейса.
 */
export function setupRegister(bot: Bot<BotContext>): void {
  bot.command('register', async (ctx) => {
    // Только в группах
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    const name = ctx.match?.trim();

    if (!name) {
      await ctx.reply('Использование: /register Название объекта\nПример: /register Прага-Центр Реконструкция');
      return;
    }

    const chatId = ctx.chat.id.toString();

    try {
      // Проверяем, не зарегистрирована ли уже эта группа
      const existing = await db('projects')
        .where('telegram_group_id', chatId)
        .first();

      if (existing) {
        await ctx.reply(`Эта группа уже привязана к объекту "${existing.name}".\nДля изменения названия используйте /rename Новое название`);
        return;
      }

      // Создаём проект
      const [project] = await db('projects')
        .insert({
          name,
          telegram_group_id: chatId,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning('*');

      logger.info({ projectId: project.id, name, chatId }, 'Project registered');

      await ctx.reply(
        `✅ Объект "${name}" зарегистрирован.\n\n` +
        `ID: ${project.id}\n` +
        `Группа привязана. Бот начнёт собирать сообщения для суточных отчётов.`
      );
    } catch (err) {
      logger.error({ err, chatId }, '/register failed');
      await ctx.reply('Ошибка при регистрации объекта.');
    }
  });

  // /rename — переименование объекта
  bot.command('rename', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return;
    }

    const newName = ctx.match?.trim();
    if (!newName) {
      await ctx.reply('Использование: /rename Новое название');
      return;
    }

    try {
      const updated = await db('projects')
        .where('telegram_group_id', ctx.chat.id.toString())
        .update({ name: newName, updated_at: new Date() });

      if (updated) {
        await ctx.reply(`✅ Объект переименован: "${newName}"`);
      } else {
        await ctx.reply('⚠️ Объект не найден. Сначала используйте /register');
      }
    } catch (err) {
      logger.error({ err }, '/rename failed');
      await ctx.reply('Ошибка при переименовании.');
    }
  });
}
