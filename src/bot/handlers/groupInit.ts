import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';

/**
 * Обрабатывает добавление бота в группу.
 * Проверяет наличие топиков, создаёт "Актуальные вопросы".
 */
export function setupGroupInit(bot: Bot<BotContext>): void {
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const newStatus = update.new_chat_member.status;
    const chat = update.chat;

    // Реагируем только на добавление бота в группу/суперргруппу
    if (
      (newStatus !== 'administrator' && newStatus !== 'member') ||
      (chat.type !== 'group' && chat.type !== 'supergroup')
    ) {
      return;
    }

    logger.info({ chatId: chat.id, chatTitle: chat.title, status: newStatus }, 'Bot added to group');

    try {
      // Проверяем, является ли группа форумом (с топиками)
      const chatInfo = await ctx.api.getChat(chat.id);

      const isForum = 'is_forum' in chatInfo && chatInfo.is_forum === true;

      if (isForum) {
        // Пробуем создать топик "Актуальные вопросы"
        try {
          const topic = await ctx.api.createForumTopic(chat.id, 'Актуальные вопросы');

          // Сохраняем thread_id в projects (если проект уже зарегистрирован)
          await db('projects')
            .where('telegram_group_id', chat.id.toString())
            .update({
              topic_thread_id: topic.message_thread_id,
              topics_enabled: true,
              updated_at: new Date(),
            });

          logger.info({ chatId: chat.id, threadId: topic.message_thread_id }, 'Topic "Актуальные вопросы" created');

          await ctx.api.sendMessage(
            chat.id,
            '✅ Бот активирован. Топик "Актуальные вопросы" создан.',
            { message_thread_id: topic.message_thread_id }
          );
        } catch (topicErr: any) {
          // Топик может уже существовать
          if (topicErr?.description?.includes('TOPIC_NOT_MODIFIED') ||
              topicErr?.error_code === 400) {
            logger.warn({ chatId: chat.id }, 'Topic may already exist, use /settopic from the topic');
            await ctx.api.sendMessage(
              chat.id,
              '⚠️ Бот активирован. Если топик "Актуальные вопросы" уже существует — отправьте команду /settopic из этого топика, чтобы бот его запомнил.'
            );
          } else {
            throw topicErr;
          }
        }
      } else {
        // Топики не включены
        await ctx.api.sendMessage(
          chat.id,
          '⚠️ Бот активирован, но топики не включены.\n\nДля полной работы включите режим Топиков:\nНастройки группы → Топики → Вкл'
        );

        // Обновляем projects если есть
        await db('projects')
          .where('telegram_group_id', chat.id.toString())
          .update({ topics_enabled: false, updated_at: new Date() });
      }
    } catch (err) {
      logger.error({ err, chatId: chat.id }, 'Group init failed');
    }
  });

  // Команда /settopic — запомнить текущий топик как "Актуальные вопросы"
  bot.command('settopic', async (ctx) => {
    if (!ctx.message?.message_thread_id) {
      await ctx.reply('Эту команду нужно отправить из топика "Актуальные вопросы".');
      return;
    }

    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id;

    try {
      const updated = await db('projects')
        .where('telegram_group_id', chatId.toString())
        .update({
          topic_thread_id: threadId,
          topics_enabled: true,
          updated_at: new Date(),
        });

      if (updated) {
        await ctx.reply('✅ Топик "Актуальные вопросы" привязан к этому проекту.');
        logger.info({ chatId, threadId }, 'Topic set manually via /settopic');
      } else {
        await ctx.reply('⚠️ Сначала зарегистрируйте проект командой /register');
      }
    } catch (err) {
      logger.error({ err, chatId }, '/settopic failed');
      await ctx.reply('Ошибка при сохранении топика.');
    }
  });
}
