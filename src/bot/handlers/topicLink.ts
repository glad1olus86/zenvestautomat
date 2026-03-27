import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { syncProjectToSheets } from '../../services/sheets';
import { logger } from '../../utils/logger';

const TOPIC_TYPE_LABELS: Record<string, string> = {
  reports: '📋 Отчёты',
  receipts: '🧾 Чеки',
  issues: '❓ Вопросы',
  general: '📌 Общий',
};

/**
 * /link    — визард привязки топика (inline-клавиатура: проект → тип).
 * /unlink  — отвязать текущий топик.
 * /list    — список объектов с типами привязанных топиков.
 *
 * Callback data:
 *   link:p:{projectId}            — выбран проект
 *   link:t:{projectId}:{type}     — выбран тип топика
 */
export function setupTopicLink(bot: Bot<BotContext>): void {

  // ────────────────── /link ──────────────────

  bot.command('link', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    // General topic has no thread_id — use 0 as marker in DB
    const threadId = ctx.message?.message_thread_id ?? 0;
    const chatId = ctx.chat.id;

    try {
      // Проверяем: топик уже привязан?
      const existing = await db('project_topics')
        .join('projects', 'project_topics.project_id', 'projects.id')
        .where('project_topics.telegram_group_id', chatId.toString())
        .where('project_topics.topic_thread_id', threadId)
        .select('projects.name', 'project_topics.topic_type')
        .first();

      if (existing) {
        const typeLabel = TOPIC_TYPE_LABELS[existing.topic_type] || existing.topic_type;
        await ctx.reply(
          `⚠️ Этот топик уже привязан к объекту "<b>${existing.name}</b>" (${typeLabel}).\n` +
          `Используйте /unlink для отвязки.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Загружаем активные проекты
      const projects = await db('projects').where('status', 'active').select('id', 'name');

      if (projects.length === 0) {
        await ctx.reply('⚠️ Нет зарегистрированных объектов.\nСоздайте объект командой /register');
        return;
      }

      if (projects.length === 1) {
        // Один проект — сразу показываем выбор типа
        await sendTypeSelection(ctx, projects[0].id, projects[0].name);
      } else {
        // Несколько проектов — сначала выбор проекта
        const kb = new InlineKeyboard();
        for (const p of projects) {
          kb.text(p.name, `link:p:${p.id}`).row();
        }

        await ctx.reply(
          '<b>Выберите объект для привязки:</b>',
          { parse_mode: 'HTML', reply_markup: kb }
        );
      }
    } catch (err) {
      logger.error({ err, chatId, threadId }, '/link failed');
      await ctx.reply('Ошибка при привязке топика.');
    }
  });

  // ────────────────── Callback: выбор проекта ──────────────────

  bot.callbackQuery(/^link:p:(\d+)$/, async (ctx) => {
    const projectId = parseInt(ctx.match[1], 10);

    try {
      const project = await db('projects').where('id', projectId).first();
      if (!project) {
        await ctx.answerCallbackQuery({ text: 'Объект не найден' });
        return;
      }

      // Заменяем сообщение на выбор типа
      const kb = buildTypeKeyboard(projectId);
      await ctx.editMessageText(
        `Объект: <b>${project.name}</b>\n\n<b>Выберите тип топика:</b>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
      await ctx.answerCallbackQuery();
    } catch (err) {
      logger.error({ err, projectId }, 'Link project selection callback failed');
      await ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте /link заново' });
    }
  });

  // ────────────────── Callback: выбор типа топика ──────────────────

  bot.callbackQuery(/^link:t:(\d+):(reports|receipts|issues)$/, async (ctx) => {
    const projectId = parseInt(ctx.match[1], 10);
    const topicType = ctx.match[2] as 'reports' | 'receipts' | 'issues';

    const chatId = ctx.callbackQuery.message?.chat?.id;
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;

    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить топик' });
      return;
    }

    try {
      const project = await db('projects').where('id', projectId).first();
      if (!project) {
        await ctx.answerCallbackQuery({ text: 'Объект не найден' });
        return;
      }

      // Проверяем что топик не был привязан пока пользователь выбирал
      const alreadyLinked = await db('project_topics')
        .where('telegram_group_id', chatId.toString())
        .where('topic_thread_id', threadId)
        .first();

      if (alreadyLinked) {
        await ctx.editMessageText('⚠️ Этот топик уже привязан. Используйте /unlink для отвязки.');
        await ctx.answerCallbackQuery();
        return;
      }

      // Создаём привязку с типом
      await db('project_topics').insert({
        project_id: projectId,
        telegram_group_id: chatId.toString(),
        topic_thread_id: threadId,
        topic_type: topicType,
        created_at: new Date(),
      });

      // Синхронизируем в Google Sheets (fire-and-forget)
      syncProjectToSheets(projectId).catch((err) =>
        logger.error({ err, projectId }, 'Sheets sync failed after /link')
      );

      const typeLabel = TOPIC_TYPE_LABELS[topicType];
      const typeDescs: Record<string, string> = {
        reports: 'Суточные отчёты будут приходить в этот топик.',
        receipts: 'Суточные отчёты НЕ будут приходить в этот топик.',
        issues: 'Актуальные вопросы будут публиковаться в этот топик.',
        general: 'Общий топик — отчёты будут приходить сюда.',
      };
      const typeDesc = typeDescs[topicType] || '';

      await ctx.editMessageText(
        `✅ Топик привязан к объекту "<b>${project.name}</b>" (${typeLabel}).\n\n` +
        `${typeDesc}\n\n` +
        `В этом топике работают:\n` +
        `• Буферизация сообщений\n` +
        `• Распознавание чеков (фото/PDF)\n` +
        `• Транскрипция голосовых\n` +
        `• Запись часов (/hours)`,
        { parse_mode: 'HTML' }
      );

      await ctx.answerCallbackQuery();

      logger.info({ projectId, chatId, threadId, topicType }, 'Topic linked to project');
    } catch (err) {
      logger.error({ err, projectId, chatId, threadId }, 'Link type selection callback failed');
      await ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте /link заново' });
    }
  });

  // ────────────────── /unlink ──────────────────

  bot.command('unlink', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return;
    }

    const threadId = ctx.message?.message_thread_id ?? 0;
    const chatId = ctx.chat.id;

    try {
      const binding = await db('project_topics')
        .where('telegram_group_id', chatId.toString())
        .where('topic_thread_id', threadId)
        .first();

      if (!binding) {
        await ctx.reply('⚠️ Этот топик не привязан ни к одному объекту.');
        return;
      }

      const project = await db('projects').where('id', binding.project_id).first();

      await db('project_topics')
        .where('telegram_group_id', chatId.toString())
        .where('topic_thread_id', threadId)
        .delete();

      logger.info({ projectId: binding.project_id, chatId, threadId }, 'Topic unlinked from project');

      await ctx.reply(`✅ Топик отвязан от объекта "${project?.name ?? '?'}".`);
    } catch (err) {
      logger.error({ err, chatId }, '/unlink failed');
      await ctx.reply('Ошибка при отвязке топика.');
    }
  });

  // ────────────────── /list ──────────────────

  bot.command('list', async (ctx) => {
    try {
      // Получаем проекты с типами привязанных топиков
      const projects = await db('projects')
        .where('status', 'active')
        .select('id', 'name')
        .orderBy('name');

      if (projects.length === 0) {
        await ctx.reply('Объектов нет. Создайте первый командой /register');
        return;
      }

      const lines: string[] = [];
      for (const p of projects) {
        const topics = await db('project_topics')
          .where('project_id', p.id)
          .select('topic_type');

        if (topics.length === 0) {
          lines.push(`🟢 <b>${p.name}</b> (ID: ${p.id}) — ⚠️ нет топиков`);
        } else {
          const types = topics.map((t: { topic_type: string }) =>
            TOPIC_TYPE_LABELS[t.topic_type] || t.topic_type
          ).join(', ');
          lines.push(`🟢 <b>${p.name}</b> (ID: ${p.id}) — ${types}`);
        }
      }

      await ctx.reply(
        `<b>Список объектов (${projects.length}):</b>\n\n${lines.join('\n')}\n\n` +
        `Привяжите топик: зайдите в топик → /link`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      logger.error({ err }, '/list failed');
      await ctx.reply('Ошибка при получении списка объектов.');
    }
  });
}

// ────────────────── Вспомогательные ──────────────────

/** Отправляет inline-клавиатуру выбора типа топика. */
async function sendTypeSelection(ctx: BotContext, projectId: number, projectName: string): Promise<void> {
  const kb = buildTypeKeyboard(projectId);
  await ctx.reply(
    `Объект: <b>${projectName}</b>\n\n<b>Выберите тип топика:</b>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

/** Строит inline-клавиатуру с типами топиков. */
function buildTypeKeyboard(projectId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Отчёты', `link:t:${projectId}:reports`)
    .text('🧾 Чеки', `link:t:${projectId}:receipts`)
    .row()
    .text('❓ Вопросы', `link:t:${projectId}:issues`);
}
