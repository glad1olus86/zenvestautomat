import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';
import { describePhoto, formatCorrection } from '../../services/gemini';
import { transcribe } from '../../services/whisper';
import { downloadTelegramFile, cleanupFile } from '../../utils/downloadFile';

// ─── Session ───

interface CorrectionSession {
  step: 'collecting' | 'preview' | 'editing';
  botMessageId: number;
  projectId: number;
  projectName: string;
  photos: { fileId: string; description: string }[];
  voiceTranscript: string | null;
  textInput: string | null;
  formattedResult: {
    description: string;
    fix_required: string;
    manager_comment: string;
    formatted: string;
  } | null;
  processing: boolean;
  createdAt: number;
  userMessageIds: number[];
  editRequest: string | null;
}

const sessions = new Map<string, CorrectionSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

function sessionKey(chatId: number, userId: number): string {
  return `pc:${chatId}:${userId}`;
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

function collectingKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Готово', 'pc:done')
    .text('✖️ Отмена', 'pc:cancel');
}

function statusText(session: CorrectionSession): string {
  const parts: string[] = [];
  if (session.photos.length > 0) parts.push(`📷 Фото: ${session.photos.length}`);
  if (session.voiceTranscript) parts.push(`🎤 Голосовое`);
  if (session.textInput) parts.push(`📝 Текст`);

  return parts.length > 0 ? parts.join('  |  ') : '<i>Пока ничего не отправлено</i>';
}

// ─── Public API (для groupMenu) ───

/**
 * Запускает сбор правок на существующем сообщении (из /menu).
 */
export async function startCorrectionSession(
  bot: Bot<BotContext>,
  chatId: number,
  userId: number,
  messageId: number,
  projectId: number,
  projectName: string,
): Promise<void> {
  const key = sessionKey(chatId, userId);
  cleanup();

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
    photos: [],
    voiceTranscript: null,
    textInput: null,
    formattedResult: null,
    processing: false,
    createdAt: Date.now(),
    userMessageIds: [],
    editRequest: null,
  });

  await safeEdit(bot, chatId, messageId,
    '<b>🔧 Правки объекта</b>\n\n' +
    'Отправьте материалы:\n' +
    '• 📷 Фото дефектов/проблем\n' +
    '• 🎤 Голосовое с описанием\n' +
    '• 📝 Текстовое описание\n\n' +
    'Когда закончите — нажмите <b>Готово</b>.',
    collectingKb(),
  );
}

// ─── Handler ───

export function setupCorrectionsHandler(bot: Bot<BotContext>): void {

  // ════════ Callback: готово (сформировать превью) ════════

  bot.callbackQuery('pc:done', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (!session || session.step !== 'collecting') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    // Проверяем что хоть что-то есть
    if (session.photos.length === 0 && !session.voiceTranscript && !session.textInput) {
      await ctx.answerCallbackQuery({ text: 'Отправьте хотя бы фото, голос или текст' });
      return;
    }

    session.processing = true;

    try {
      await safeEdit(bot, chatId, session.botMessageId,
        '<b>🔧 Правки объекта</b>\n\n<i>Формирую сообщение...</i>',
      );

      const result = await formatCorrection(
        session.photos.map((p) => p.description),
        session.voiceTranscript,
        session.textInput,
      );

      if (!result) {
        await safeEdit(bot, chatId, session.botMessageId,
          '<b>🔧 Правки объекта</b>\n\n❌ Ошибка AI. Попробуйте добавить больше информации и нажмите Готово.',
          collectingKb(),
        );
        session.step = 'collecting';
        await ctx.answerCallbackQuery();
        return;
      }

      session.step = 'preview';
      session.formattedResult = result;
      session.editRequest = null;

      const kb = new InlineKeyboard()
        .text('📤 Опубликовать', 'pc:publish')
        .text('✏️ Изменить', 'pc:edit')
        .row()
        .text('✖️ Отмена', 'pc:cancel');

      await safeEdit(bot, chatId, session.botMessageId,
        `<b>🔧 Превью правки</b>\n\n${result.formatted}\n\n` +
        `<i>Нажмите «Опубликовать» для отправки в топик.</i>`,
        kb,
      );
    } catch (err) {
      logger.error({ err }, 'Correction formatting failed');
      await safeEdit(bot, chatId, session.botMessageId,
        '<b>🔧 Правки объекта</b>\n\n❌ Произошла ошибка.',
        collectingKb(),
      );
      session.step = 'collecting';
    } finally {
      session.processing = false;
    }
    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: изменить ════════

  bot.callbackQuery('pc:edit', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (!session || session.step !== 'preview') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    session.step = 'editing';
    session.editRequest = null;

    const kb = new InlineKeyboard().text('✖️ Отмена', 'pc:cancel');

    await safeEdit(bot, chatId, session.botMessageId,
      '<b>🔧 Что хотите изменить?</b>\n\n' +
      'Напишите, какую часть правки нужно скорректировать.',
      kb,
    );
    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: публикация ════════

  bot.callbackQuery('pc:publish', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (!session || session.step !== 'preview' || !session.formattedResult) {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    try {
      const threadId = ctx.callbackQuery?.message?.message_thread_id || null;
      const managerName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');

      // Отправляем фото (если есть) как медиагруппу
      if (session.photos.length > 0) {
        const mediaGroup = session.photos.map((p, i) => ({
          type: 'photo' as const,
          media: p.fileId,
          ...(i === 0 ? { caption: session.formattedResult!.formatted, parse_mode: 'HTML' as const } : {}),
        }));

        await bot.api.sendMediaGroup(chatId, mediaGroup, {
          message_thread_id: threadId ?? undefined,
        });
      } else {
        // Без фото — просто текст
        await bot.api.sendMessage(chatId, session.formattedResult.formatted, {
          parse_mode: 'HTML',
          message_thread_id: threadId ?? undefined,
        });
      }

      // Сохраняем в БД
      await db('corrections').insert({
        project_id: session.projectId,
        manager_user_id: userId.toString(),
        manager_name: managerName,
        photos: JSON.stringify(session.photos),
        voice_transcript: session.voiceTranscript,
        text_input: session.textInput,
        description: session.formattedResult.description,
        fix_required: session.formattedResult.fix_required,
        manager_comment: session.formattedResult.manager_comment,
        formatted_text: session.formattedResult.formatted,
        status: 'open',
        telegram_group_id: chatId.toString(),
        topic_thread_id: threadId,
      });

      // Очистка: удаляем все черновые сообщения и диалоговое сообщение бота
      for (const msgId of session.userMessageIds) {
        await safeDelete(bot, chatId, msgId);
      }
      await safeDelete(bot, chatId, session.botMessageId);

      sessions.delete(key);
      logger.info({ chatId, projectId: session.projectId, photos: session.photos.length }, 'Correction published');
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to publish correction');
      await safeEdit(bot, chatId, session.botMessageId, '❌ Ошибка при публикации правки.');
      sessions.delete(key);
    }

    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: отмена ════════

  bot.callbackQuery('pc:cancel', async (ctx) => {
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

  // ════════ Перехват фото (при активной сессии) ════════

  bot.on('message:photo', async (ctx, next) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return next();

    const userId = ctx.from!.id;
    const key = sessionKey(ctx.chat.id, userId);
    const session = sessions.get(key);
    if (!session || session.step !== 'collecting') return next();

    if (session.processing) return;
    session.processing = true;

    let imagePath: string | null = null;

    try {
      // Трекаем и удаляем фото из чата
      session.userMessageIds.push(ctx.message.message_id);
      try { await ctx.deleteMessage(); } catch { /* ignore */ }

      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>🔧 Правки объекта</b>\n\n<i>Анализирую фото ${session.photos.length + 1}...</i>`,
        collectingKb(),
      );

      // Берём самое большое фото
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];

      imagePath = await downloadTelegramFile(ctx.api, largestPhoto.file_id, '.jpg');
      const description = await describePhoto(imagePath);

      session.photos.push({
        fileId: largestPhoto.file_id,
        description: description || 'Фото без описания',
      });

      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>🔧 Правки объекта</b>\n\n${statusText(session)}\n\n` +
        'Отправьте ещё материалы или нажмите <b>Готово</b>.',
        collectingKb(),
      );
    } catch (err) {
      logger.error({ err }, 'Correction photo processing failed');
      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>🔧 Правки объекта</b>\n\n${statusText(session)}\n\n` +
        '⚠️ Ошибка при обработке фото. Попробуйте ещё раз.',
        collectingKb(),
      );
    } finally {
      if (imagePath) cleanupFile(imagePath);
      session.processing = false;
    }
  });

  // ════════ Перехват голосовых (при активной сессии) ════════

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
      session.userMessageIds.push(ctx.message.message_id);
      try { await ctx.deleteMessage(); } catch { /* ignore */ }

      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>🔧 Правки объекта</b>\n\n<i>Транскрибирую голосовое...</i>`,
        collectingKb(),
      );

      oggPath = await downloadTelegramFile(ctx.api, ctx.message.voice.file_id, '.ogg');
      const transcript = await transcribe(oggPath);

      session.voiceTranscript = session.voiceTranscript
        ? `${session.voiceTranscript}\n${transcript}`
        : transcript;

      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>🔧 Правки объекта</b>\n\n${statusText(session)}\n\n` +
        'Отправьте ещё материалы или нажмите <b>Готово</b>.',
        collectingKb(),
      );
    } catch (err) {
      logger.error({ err }, 'Correction voice processing failed');
      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>🔧 Правки объекта</b>\n\n${statusText(session)}\n\n` +
        '⚠️ Ошибка транскрипции. Попробуйте написать текстом.',
        collectingKb(),
      );
    } finally {
      if (oggPath) cleanupFile(oggPath);
      session.processing = false;
    }
  });

  // ════════ Перехват текста (при активной сессии) ════════

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return next();

    const userId = ctx.from!.id;
    const key = sessionKey(ctx.chat.id, userId);
    const session = sessions.get(key);
    if (!session || (session.step !== 'collecting' && session.step !== 'editing')) return next();

    // Пропускаем команды
    if (ctx.message.text.startsWith('/')) return next();

    session.userMessageIds.push(ctx.message.message_id);
    try { await ctx.deleteMessage(); } catch { /* ignore */ }

    // Режим редактирования: пользователь описывает что изменить → сразу переформируем
    if (session.step === 'editing') {
      if (session.processing) return;
      session.processing = true;

      try {
        session.editRequest = ctx.message.text;

        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          '<b>🔧 Правки объекта</b>\n\n<i>Переформирую с учётом правок...</i>',
        );

        const result = await formatCorrection(
          session.photos.map((p) => p.description),
          session.voiceTranscript,
          session.textInput,
          session.editRequest,
        );

        if (!result) {
          const kb = new InlineKeyboard().text('✖️ Отмена', 'pc:cancel');
          await safeEdit(bot, ctx.chat.id, session.botMessageId,
            '<b>🔧 Правки объекта</b>\n\n❌ Ошибка AI. Попробуйте описать правку иначе.',
            kb,
          );
          session.step = 'editing';
          return;
        }

        session.step = 'preview';
        session.formattedResult = result;
        session.editRequest = null;

        const kb = new InlineKeyboard()
          .text('📤 Опубликовать', 'pc:publish')
          .text('✏️ Изменить', 'pc:edit')
          .row()
          .text('✖️ Отмена', 'pc:cancel');

        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          `<b>🔧 Превью правки</b>\n\n${result.formatted}\n\n` +
          `<i>Нажмите «Опубликовать» для отправки в топик.</i>`,
          kb,
        );
      } catch (err) {
        logger.error({ err }, 'Correction edit re-format failed');
        const kb = new InlineKeyboard().text('✖️ Отмена', 'pc:cancel');
        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          '<b>🔧 Правки объекта</b>\n\n❌ Ошибка. Попробуйте ещё раз.',
          kb,
        );
        session.step = 'editing';
      } finally {
        session.processing = false;
      }
      return;
    }

    // Обычный режим сбора
    session.textInput = session.textInput
      ? `${session.textInput}\n${ctx.message.text}`
      : ctx.message.text;

    await safeEdit(bot, ctx.chat.id, session.botMessageId,
      `<b>🔧 Правки объекта</b>\n\n${statusText(session)}\n\n` +
      'Отправьте ещё материалы или нажмите <b>Готово</b>.',
      collectingKb(),
    );
  });
}
