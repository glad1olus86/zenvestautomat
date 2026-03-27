import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';
import { analyzeIssueDialog } from '../../services/gemini';
import { transcribe } from '../../services/whisper';
import { downloadTelegramFile, cleanupFile } from '../../utils/downloadFile';
import { IssueFields, isIssueComplete } from '../../prompts/issueFormatting';

// ─── Session ───

interface IssueSession {
  step: 'collecting' | 'preview';
  botMessageId: number;
  projectId: number;
  projectName: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  collectedFields: IssueFields;
  category: string | null;
  formattedText: string | null;
  processing: boolean;
  createdAt: number;
  userMessageIds: number[];
}

const sessions = new Map<string, IssueSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

function sessionKey(chatId: number, userId: number): string {
  return `iq:${chatId}:${userId}`;
}

async function safeEdit(
  bot: Bot<BotContext>, chatId: number, messageId: number,
  text: string, kb?: InlineKeyboard,
): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  } catch { /* ignore */ }
}

async function safeDelete(bot: Bot<BotContext>, chatId: number, messageId: number): Promise<void> {
  try { await bot.api.deleteMessage(chatId, messageId); } catch { /* ignore */ }
}

// ─── Public API (для groupMenu) ───

/**
 * Запускает диалог «Актуальные вопросы» на существующем сообщении (из /menu).
 */
export async function startIssueDialog(
  bot: Bot<BotContext>,
  chatId: number,
  userId: number,
  messageId: number,
  projectId: number,
  projectName: string,
): Promise<void> {
  const key = sessionKey(chatId, userId);
  cleanup();

  // Проверяем что есть топик issues для этого проекта
  const issuesTopic = await db('project_topics')
    .where('project_id', projectId)
    .where('topic_type', 'issues')
    .first();

  if (!issuesTopic) {
    const kb = new InlineKeyboard().text('« Назад', 'gm:back');
    await safeEdit(bot, chatId, messageId,
      '❌ Для этого объекта не создан топик «Вопросы».\n\n' +
      'Привяжите топик через <b>Привязка топика → ❓ Вопросы</b>.',
      kb,
    );
    return;
  }

  // Сбрасываем старую сессию
  const existing = sessions.get(key);
  if (existing && existing.botMessageId !== messageId) {
    await safeDelete(bot, chatId, existing.botMessageId);
  }

  sessions.set(key, {
    step: 'collecting',
    botMessageId: messageId,
    projectId,
    projectName,
    conversationHistory: [],
    collectedFields: {
      situation: null,
      impact: null,
      actions_taken: null,
      options: null,
      needed_now: null,
      addressed_to: null,
    },
    category: null,
    formattedText: null,
    processing: false,
    createdAt: Date.now(),
    userMessageIds: [],
  });

  const kb = new InlineKeyboard().text('✖️ Отмена', 'iq:cancel');

  await safeEdit(bot, chatId, messageId,
    '<b>❓ Задать вопрос</b>\n\n' +
    'Опишите вашу ситуацию или проблему — текстом или голосовым сообщением.\n\n' +
    '<i>Я помогу сформулировать вопрос по регламенту и опубликую его в топик «Актуальные вопросы».</i>',
    kb,
  );
}

// ─── Handler ───

export function setupIssuesHandler(bot: Bot<BotContext>): void {

  // ════════ Callback: публикация ════════

  bot.callbackQuery('iq:publish', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (!session || session.step !== 'preview' || !session.formattedText) {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    try {
      // Находим issues-топик
      const issuesTopic = await db('project_topics')
        .where('project_id', session.projectId)
        .where('topic_type', 'issues')
        .first();

      if (!issuesTopic) {
        await safeEdit(bot, chatId, session.botMessageId, '❌ Топик «Вопросы» не найден.');
        sessions.delete(key);
        await ctx.answerCallbackQuery();
        return;
      }

      const groupId = BigInt(issuesTopic.telegram_group_id);
      const threadId = issuesTopic.topic_thread_id;

      // Публикуем в issues-топик
      const published = await bot.api.sendMessage(Number(groupId), session.formattedText, {
        parse_mode: 'HTML',
        message_thread_id: threadId,
      });

      // Сохраняем в БД
      await db('issues').insert({
        project_id: session.projectId,
        author_user_id: userId.toString(),
        author_name: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        category: session.category || '[Прочее]',
        status: 'open',
        situation: session.collectedFields.situation,
        impact: session.collectedFields.impact,
        actions_taken: session.collectedFields.actions_taken,
        options: session.collectedFields.options,
        needed_now: session.collectedFields.needed_now,
        addressed_to: session.collectedFields.addressed_to,
        formatted_text: session.formattedText,
        conversation_history: JSON.stringify(session.conversationHistory),
        telegram_group_id: groupId.toString(),
        topic_thread_id: threadId,
        published_message_id: published.message_id,
        dialog_thread_id: ctx.callbackQuery?.message?.message_thread_id || null,
      });

      // Очистка: удаляем все черновые сообщения и диалоговое сообщение бота
      for (const msgId of session.userMessageIds) {
        await safeDelete(bot, chatId, msgId);
      }
      await safeDelete(bot, chatId, session.botMessageId);

      sessions.delete(key);
      logger.info({ chatId, projectId: session.projectId, category: session.category }, 'Issue published');
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to publish issue');
      await safeEdit(bot, chatId, session.botMessageId, '❌ Ошибка при публикации вопроса.');
      sessions.delete(key);
    }

    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: изменить ════════

  bot.callbackQuery('iq:edit', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (!session || session.step !== 'preview') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    session.step = 'collecting';
    session.formattedText = null;

    // Добавляем системное сообщение в историю
    session.conversationHistory.push({
      role: 'assistant',
      content: 'Что вы хотите изменить в вопросе?',
    });

    const kb = new InlineKeyboard().text('✖️ Отмена', 'iq:cancel');

    await safeEdit(bot, chatId, session.botMessageId,
      '<b>❓ Что хотите изменить?</b>\n\n' +
      'Напишите, какую часть вопроса нужно скорректировать.',
      kb,
    );
    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: отмена ════════

  bot.callbackQuery('iq:cancel', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (session) {
      for (const msgId of session.userMessageIds) {
        await safeDelete(bot, chatId, msgId);
      }
      await safeDelete(bot, chatId, session.botMessageId);
      sessions.delete(key);
    }
    await ctx.answerCallbackQuery();
  });

  // ════════ Перехват текстовых сообщений (при активной сессии) ════════

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return next();

    const userId = ctx.from!.id;
    const key = sessionKey(ctx.chat.id, userId);
    const session = sessions.get(key);
    if (!session || session.step !== 'collecting') return next();

    // Пропускаем команды
    if (ctx.message.text.startsWith('/')) return next();

    // Пропускаем если уже обрабатываем
    if (session.processing) return;

    session.processing = true;

    try {
      // Трекаем и удаляем сообщение пользователя
      session.userMessageIds.push(ctx.message.message_id);
      try { await ctx.deleteMessage(); } catch { /* ignore */ }

      const userText = ctx.message.text;
      session.conversationHistory.push({ role: 'user', content: userText });

      // Показываем "Анализирую..."
      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        '<b>❓ Задать вопрос</b>\n\n<i>Анализирую ваш ответ...</i>',
      );

      await processDialog(bot, ctx.chat.id, userId, key, session);
    } finally {
      session.processing = false;
    }
  });

  // ════════ Перехват голосовых сообщений (при активной сессии) ════════

  bot.on('message:voice', async (ctx, next) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return next();

    const userId = ctx.from!.id;
    const key = sessionKey(ctx.chat.id, userId);
    const session = sessions.get(key);
    if (!session || session.step !== 'collecting') return next();

    if (session.processing) return;
    session.processing = true;

    let oggPath: string | null = null;

    try {
      // Трекаем и удаляем голосовое сообщение
      session.userMessageIds.push(ctx.message.message_id);
      try { await ctx.deleteMessage(); } catch { /* ignore */ }

      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        '<b>❓ Задать вопрос</b>\n\n<i>Транскрибирую голосовое сообщение...</i>',
      );

      // Скачиваем и транскрибируем
      oggPath = await downloadTelegramFile(ctx.api, ctx.message.voice.file_id, '.ogg');
      const transcript = await transcribe(oggPath);

      session.conversationHistory.push({ role: 'user', content: transcript });

      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        '<b>❓ Задать вопрос</b>\n\n<i>Анализирую ваш ответ...</i>',
      );

      await processDialog(bot, ctx.chat.id, userId, key, session);
    } catch (err) {
      logger.error({ err }, 'Issue handler voice processing failed');
      const cancelKb = new InlineKeyboard().text('✖️ Отмена', 'iq:cancel');
      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        '<b>❓ Задать вопрос</b>\n\n❌ Ошибка транскрипции. Попробуйте написать текстом.',
        cancelKb,
      );
    } finally {
      if (oggPath) cleanupFile(oggPath);
      session.processing = false;
    }
  });

  // ════════ Резолюция: ✅Готово в ответ на опубликованный вопрос ════════

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return next();

    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) return next();

    const text = ctx.message.text.trim();
    if (!/^✅\s*[Гг]отово/i.test(text)) return next();

    // Ищем опубликованный вопрос по message_id
    const issue = await db('issues')
      .where('telegram_group_id', ctx.chat.id.toString())
      .where('published_message_id', replyTo.message_id)
      .where('status', 'open')
      .first();

    if (!issue) return next();

    // Обновляем статус
    await db('issues')
      .where('id', issue.id)
      .update({
        status: 'resolved',
        resolved_at: new Date(),
        resolved_by_user_id: ctx.from!.id.toString(),
        resolved_by_name: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ''),
        updated_at: new Date(),
      });

    await ctx.reply(
      `✅ Вопрос #${issue.id} решён (${ctx.from!.first_name})`,
      {
        reply_to_message_id: replyTo.message_id,
        parse_mode: 'HTML',
      },
    );

    logger.info({ issueId: issue.id, resolvedBy: ctx.from!.id }, 'Issue resolved');
  });
}

// ─── Обработка диалога через AI ───

async function processDialog(
  bot: Bot<BotContext>,
  chatId: number,
  userId: number,
  key: string,
  session: IssueSession,
): Promise<void> {
  const result = await analyzeIssueDialog(session.conversationHistory, session.projectName);

  if (!result) {
    const cancelKb = new InlineKeyboard().text('✖️ Отмена', 'iq:cancel');
    await safeEdit(bot, chatId, session.botMessageId,
      '<b>❓ Задать вопрос</b>\n\n❌ Ошибка AI. Попробуйте ещё раз — просто напишите сообщение.',
      cancelKb,
    );
    return;
  }

  if (isIssueComplete(result)) {
    // Все поля заполнены — показываем превью
    session.step = 'preview';
    session.collectedFields = result.filled as IssueFields;
    session.category = result.category;
    session.formattedText = result.formatted;

    const kb = new InlineKeyboard()
      .text('📤 Опубликовать', 'iq:publish')
      .text('✏️ Изменить', 'iq:edit')
      .row()
      .text('✖️ Отмена', 'iq:cancel');

    const filledCount = Object.values(result.filled).filter(Boolean).length;

    await safeEdit(bot, chatId, session.botMessageId,
      `<b>❓ Превью вопроса (${filledCount}/6 полей)</b>\n\n` +
      `${result.formatted}\n\n` +
      `<i>Нажмите «Опубликовать» для отправки в топик Актуальные вопросы.</i>`,
      kb,
    );
  } else {
    // Нужно доуточнить — задаём вопрос
    session.collectedFields = result.filled as IssueFields;
    session.conversationHistory.push({ role: 'assistant', content: result.question });

    const filledCount = Object.values(result.filled).filter(Boolean).length;
    const cancelKb = new InlineKeyboard().text('✖️ Отмена', 'iq:cancel');

    await safeEdit(bot, chatId, session.botMessageId,
      `<b>❓ Задать вопрос (${filledCount}/6)</b>\n\n` +
      `${result.question}`,
      cancelKb,
    );
  }
}
