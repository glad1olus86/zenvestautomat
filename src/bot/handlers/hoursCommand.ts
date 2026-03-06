import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { config } from '../../config';
import { syncWorkerHoursToSheets } from '../../services/sheets';
import { logger } from '../../utils/logger';

// ─── Session ───

interface HoursSession {
  step: 'worker' | 'hours';
  botMessageId: number;
  workerId: number | null;   // null = себе
  workerName: string;
  workerType: string;
  createdAt: number;
}

// Ключ: `${chatId}:${userId}` (в группе могут быть параллельные сессии)
const sessions = new Map<string, HoursSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

function sessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
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

function parseHours(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.').replace(/ч$/, '');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num < 0.5 || num > 24) return null;
  return Math.round(num * 100) / 100;
}

/**
 * Показывает шаг выбора рабочего.
 * Если username вызывающего совпадает с рабочим в БД — показывает кнопку «Себе».
 */
async function showWorkerSelection(
  bot: Bot<BotContext>, chatId: number, messageId: number,
  username: string | undefined,
): Promise<void> {
  const workers = await db('workers').orderBy('name');

  // Ищем текущего пользователя среди рабочих по username
  const self = username ? workers.find((w: any) => w.username && w.username.toLowerCase() === username.toLowerCase()) : null;

  const kb = new InlineKeyboard();
  if (self) {
    kb.text(`Себе (${self.name})`, `hr:w:${self.id}`).row();
  }
  for (const w of workers) {
    if (self && w.id === self.id) continue; // уже показан как «Себе»
    kb.text(w.name, `hr:w:${w.id}`).row();
  }

  let text = '<b>⏱ Записать часы</b>\n\nВыберите рабочего:';
  if (workers.length === 0) {
    text += '\n\n<i>Добавьте рабочих через меню бота (личный чат → Управление рабочими)</i>';
  }

  await safeEdit(bot, chatId, messageId, text, kb);
}

// ─── Handler ───

export function setupHoursCommand(bot: Bot<BotContext>): void {

  // ════════ /hours ════════

  bot.command('hours', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    if (!ctx.project) {
      await ctx.reply('Этот топик не привязан к объекту. Используйте /link.');
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from!.id;
    const key = sessionKey(chatId, userId);

    cleanup();

    // Сбрасываем старую сессию
    const existing = sessions.get(key);
    if (existing) {
      await safeDelete(bot, chatId, existing.botMessageId);
      sessions.delete(key);
    }

    const tgUsername = ctx.from!.username;
    const workers = await db('workers').orderBy('name');

    // Ищем себя среди рабочих по username
    const self = tgUsername ? workers.find((w: any) => w.username && w.username.toLowerCase() === tgUsername.toLowerCase()) : null;

    const kb = new InlineKeyboard();
    if (self) {
      kb.text(`Себе (${self.name})`, `hr:w:${self.id}`).row();
    }
    for (const w of workers) {
      if (self && w.id === self.id) continue;
      kb.text(w.name, `hr:w:${w.id}`).row();
    }

    let text = '<b>⏱ Записать часы</b>\n\nВыберите рабочего:';
    if (workers.length === 0) {
      text += '\n\n<i>Добавьте рабочих через меню бота (личный чат → Управление рабочими)</i>';
    }

    const msg = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });

    sessions.set(key, {
      step: 'worker',
      botMessageId: msg.message_id,
      workerId: null,
      workerName: '',
      workerType: '',
      createdAt: Date.now(),
    });
  });

  // ════════ Callback: выбор рабочего ════════

  bot.callbackQuery(/^hr:w:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);
    if (!session || session.step !== 'worker') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return;
    }

    const workerId = parseInt(ctx.match[1], 10);
    const worker = await db('workers').where('id', workerId).first();
    if (!worker) {
      await ctx.answerCallbackQuery({ text: 'Рабочий не найден' }); return;
    }
    session.workerId = workerId;
    session.workerName = worker.name;
    session.workerType = worker.worker_type;

    session.step = 'hours';

    const kb = new InlineKeyboard()
      .text('4', 'hr:h:4')
      .text('6', 'hr:h:6')
      .text('8', 'hr:h:8')
      .text('10', 'hr:h:10');

    await safeEdit(bot, chatId, session.botMessageId,
      `<b>⏱ ${session.workerName}</b>\n\nВведите количество часов:`, kb);
    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: быстрый выбор часов ════════

  bot.callbackQuery(/^hr:h:(\d+(?:\.\d+)?)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);
    if (!session || session.step !== 'hours') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return;
    }

    const hours = parseFloat(ctx.match[1]);
    await saveHours(bot, ctx, chatId, userId, key, session, hours);
    await ctx.answerCallbackQuery();
  });

  // ════════ Callback: ещё одному / готово ════════

  bot.callbackQuery('hr:more', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);

    // Создаём новую сессию на том же сообщении
    let messageId: number;
    const old = sessions.get(key);
    if (old) {
      messageId = old.botMessageId;
    } else {
      // Если сессии нет — не можем продолжить на том же сообщении
      await ctx.answerCallbackQuery({ text: 'Используйте /hours' }); return;
    }

    sessions.set(key, {
      step: 'worker',
      botMessageId: messageId,
      workerId: null,
      workerName: '',
      workerType: '',
      createdAt: Date.now(),
    });

    await showWorkerSelection(bot, chatId, messageId, ctx.from.username);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('hr:done', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const userId = ctx.from.id;
    const key = sessionKey(chatId, userId);
    const session = sessions.get(key);

    if (session) {
      await safeDelete(bot, chatId, session.botMessageId);
      sessions.delete(key);
    }
    await ctx.answerCallbackQuery();
  });

  // ════════ Текстовый ввод часов (в группе) ════════

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return next();

    const userId = ctx.from!.id;
    const key = sessionKey(ctx.chat.id, userId);
    const session = sessions.get(key);
    if (!session || session.step !== 'hours') return next();

    const hours = parseHours(ctx.message.text);
    if (hours === null) {
      // Не похоже на число — пропускаем, чтобы не мешать обычным сообщениям
      return next();
    }

    // Удаляем сообщение пользователя
    try { await ctx.deleteMessage(); } catch { /* ignore */ }

    await saveHours(bot, ctx, ctx.chat.id, userId, key, session, hours);
  });
}

// ─── Сохранение часов ───

async function saveHours(
  bot: Bot<BotContext>,
  ctx: BotContext,
  chatId: number,
  userId: number,
  key: string,
  session: HoursSession,
  hours: number,
): Promise<void> {
  // Получаем project_id из контекста или из привязки группы
  let projectId: number | null = ctx.project?.id ?? null;

  if (!projectId) {
    // Попробуем найти проект по chat_id + thread_id
    const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
    if (threadId) {
      const pt = await db('project_topics')
        .where('telegram_group_id', chatId.toString())
        .where('topic_thread_id', threadId)
        .first();
      if (pt) projectId = pt.project_id;
    }
  }

  const workDate = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  try {
    const [entry] = await db('worker_hours')
      .insert({
        project_id: projectId,
        telegram_group_id: chatId.toString(),
        reported_by_user_id: userId.toString(),
        worker_name: session.workerName,
        worker_type: session.workerType,
        hours,
        work_date: workDate,
      })
      .returning('*');

    // Fire-and-forget Sheets sync
    syncWorkerHoursToSheets(entry.id).catch((err) =>
      logger.error({ err, workerHoursId: entry.id }, 'Sheets sync failed for worker hours'),
    );

    const kb = new InlineKeyboard()
      .text('Ещё одному', 'hr:more')
      .text('Готово', 'hr:done');

    await safeEdit(bot, chatId, session.botMessageId,
      `✅ Часы записаны:\n` +
      `<b>👷 ${session.workerName}</b> — ${hours} ч\n` +
      `📅 ${workDate}`,
      kb,
    );

    // Оставляем сессию для возможности «Ещё одному»
    session.step = 'worker'; // сбрасываем шаг

    logger.info({
      chatId, workerName: session.workerName, workerType: session.workerType,
      hours, workDate, projectId,
    }, 'Worker hours recorded via wizard');
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to save worker hours');
    await safeEdit(bot, chatId, session.botMessageId, 'Ошибка при записи часов.');
    sessions.delete(key);
  }
}
