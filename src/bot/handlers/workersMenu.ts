import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';

// ─── Session ───

type WkStep = 'list' | 'view' | 'add_type' | 'add_name' | 'add_rate' | 'add_username'
  | 'edit_name' | 'edit_username' | 'edit_rate' | 'confirm_delete';

interface WorkerMenuSession {
  step: WkStep;
  botMessageId: number;
  workerId?: number;
  newType?: string;
  newName?: string;
  newRate?: number | null;
  createdAt: number;
}

const sessions = new Map<number, WorkerMenuSession>(); // key = userId
const SESSION_TTL_MS = 15 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(k);
  }
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

const TYPE_LABELS: Record<string, string> = {
  technician: 'Техник',
  junior_technician: 'Мл. техник',
  helper: 'Помощник',
};

function typeLabel(t: string): string {
  return TYPE_LABELS[t] || t;
}

// ─── Helpers ───

async function showList(bot: Bot<BotContext>, chatId: number, messageId: number, userId: number): Promise<void> {
  const workers = await db('workers').orderBy('name');

  let text = '<b>👷 Управление рабочими</b>\n\n';
  if (workers.length === 0) {
    text += 'Список пуст. Добавьте первого рабочего.';
  } else {
    for (const w of workers) {
      const uname = w.username ? ` (@${w.username})` : '';
      const rate = w.hourly_rate ? ` — ${w.hourly_rate} CZK/ч` : '';
      text += `• <b>${w.name}</b>${uname} — ${typeLabel(w.worker_type)}${rate}\n`;
    }
  }

  const kb = new InlineKeyboard();
  // Каждый рабочий — кнопка для просмотра
  for (const w of workers) {
    kb.text(w.name, `wk:view:${w.id}`).row();
  }
  kb.text('+ Добавить', 'wk:add').row();
  kb.text('← В меню', 'menu:back_fresh');

  const session = sessions.get(userId);
  if (session) {
    session.step = 'list';
    session.botMessageId = messageId;
    session.workerId = undefined;
  }

  await safeEdit(bot, chatId, messageId, text, kb);
}

/** Отображает карточку рабочего */
async function showWorkerCard(
  bot: Bot<BotContext>, chatId: number, messageId: number,
  worker: { id: number; name: string; username: string | null; worker_type: string; hourly_rate: number | null },
): Promise<void> {
  const rateStr = worker.hourly_rate ? `${worker.hourly_rate} CZK/ч` : '—';
  const text =
    `<b>👷 ${worker.name}</b>\n` +
    `Username: ${worker.username ? '@' + worker.username : '—'}\n` +
    `Тип: ${typeLabel(worker.worker_type)}\n` +
    `Ставка: ${rateStr}`;

  const kb = new InlineKeyboard()
    .text('Изм. имя', `wk:ename:${worker.id}`)
    .text('Изм. username', `wk:euname:${worker.id}`).row()
    .text('Изм. тип', `wk:etype:${worker.id}`)
    .text('Изм. ставку', `wk:erate:${worker.id}`).row()
    .text('Удалить', `wk:del:${worker.id}`).row()
    .text('← Назад', 'wk:back_list');

  await safeEdit(bot, chatId, messageId, text, kb);
}

// ─── Exported start function ───

export async function startWorkersMenu(bot: Bot<BotContext>, chatId: number, userId: number): Promise<void> {
  cleanup();

  const workers = await db('workers').orderBy('name');

  let text = '<b>👷 Управление рабочими</b>\n\n';
  if (workers.length === 0) {
    text += 'Список пуст. Добавьте первого рабочего.';
  } else {
    for (const w of workers) {
      const uname = w.username ? ` (@${w.username})` : '';
      const rate = w.hourly_rate ? ` — ${w.hourly_rate} CZK/ч` : '';
      text += `• <b>${w.name}</b>${uname} — ${typeLabel(w.worker_type)}${rate}\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const w of workers) {
    kb.text(w.name, `wk:view:${w.id}`).row();
  }
  kb.text('+ Добавить', 'wk:add').row();
  kb.text('← В меню', 'menu:back_fresh');

  const msg = await bot.api.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });

  sessions.set(userId, {
    step: 'list',
    botMessageId: msg.message_id,
    createdAt: Date.now(),
  });
}

// ─── Handler Registration ───

export function setupWorkersMenu(bot: Bot<BotContext>): void {

  // ════════ Просмотр карточки рабочего ════════

  bot.callbackQuery(/^wk:view:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    const workerId = parseInt(ctx.match[1], 10);
    const worker = await db('workers').where('id', workerId).first();
    if (!worker) {
      await ctx.answerCallbackQuery({ text: 'Рабочий не найден' });
      return;
    }

    session.step = 'view';
    session.workerId = workerId;

    await showWorkerCard(bot, ctx.chat!.id, session.botMessageId, worker);
    await ctx.answerCallbackQuery();
  });

  // ════════ Добавление: шаг 1 — тип ════════

  bot.callbackQuery('wk:add', async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    session.step = 'add_type';

    const kb = new InlineKeyboard()
      .text('Техник', 'wk:type:technician').row()
      .text('Мл. техник', 'wk:type:junior_technician').row()
      .text('Помощник', 'wk:type:helper').row()
      .text('← Назад', 'wk:back_list');

    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      '<b>Новый рабочий</b>\n\nВыберите тип:', kb);
    await ctx.answerCallbackQuery();
  });

  // ════════ Добавление: шаг 1b — тип выбран → шаг 2 имя ════════

  bot.callbackQuery(/^wk:type:(technician|junior_technician|helper)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'add_type') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return;
    }

    session.newType = ctx.match[1];
    session.step = 'add_name';

    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      `<b>Новый рабочий</b> (${typeLabel(session.newType)})\n\nВведите имя:`);
    await ctx.answerCallbackQuery();
  });

  // ════════ Редактирование ставки ════════

  bot.callbackQuery(/^wk:erate:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    session.step = 'edit_rate';
    session.workerId = parseInt(ctx.match[1], 10);

    const kb = new InlineKeyboard().text('Убрать ставку', `wk:rate_clear:${session.workerId}`);
    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      '<b>Введите почасовую ставку (CZK/ч):</b>', kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^wk:rate_clear:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    const workerId = parseInt(ctx.match[1], 10);
    await db('workers').where('id', workerId).update({ hourly_rate: null, updated_at: db.fn.now() });

    const worker = await db('workers').where('id', workerId).first();
    if (worker) {
      session.step = 'view';
      await showWorkerCard(bot, ctx.chat!.id, session.botMessageId, worker);
    }
    await ctx.answerCallbackQuery({ text: 'Ставка убрана' });
  });

  // ════════ Редактирование имени ════════

  bot.callbackQuery(/^wk:ename:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    session.step = 'edit_name';
    session.workerId = parseInt(ctx.match[1], 10);

    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      '<b>Введите новое имя:</b>');
    await ctx.answerCallbackQuery();
  });

  // ════════ Редактирование username ════════

  bot.callbackQuery(/^wk:euname:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    session.step = 'edit_username';
    session.workerId = parseInt(ctx.match[1], 10);

    const kb = new InlineKeyboard().text('Убрать username', 'wk:uname_clear');

    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      '<b>Введите username</b> (без @):', kb);
    await ctx.answerCallbackQuery();
  });

  // ════════ Убрать username ════════

  bot.callbackQuery('wk:uname_clear', async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'edit_username' || !session.workerId) {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return;
    }

    await db('workers').where('id', session.workerId).update({ username: null, updated_at: db.fn.now() });

    const worker = await db('workers').where('id', session.workerId).first();
    if (worker) {
      session.step = 'view';
      await showWorkerCard(bot, ctx.chat!.id, session.botMessageId, worker);
    }
    await ctx.answerCallbackQuery({ text: 'Username убран' });
  });

  // ════════ Редактирование типа ════════

  bot.callbackQuery(/^wk:etype:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    session.workerId = parseInt(ctx.match[1], 10);

    const kb = new InlineKeyboard()
      .text('Техник', `wk:settype:${session.workerId}:technician`).row()
      .text('Мл. техник', `wk:settype:${session.workerId}:junior_technician`).row()
      .text('Помощник', `wk:settype:${session.workerId}:helper`).row()
      .text('← Назад', `wk:view:${session.workerId}`);

    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      '<b>Выберите новый тип:</b>', kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^wk:settype:(\d+):(technician|junior_technician|helper)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    const workerId = parseInt(ctx.match[1], 10);
    const newType = ctx.match[2];

    await db('workers').where('id', workerId).update({ worker_type: newType, updated_at: db.fn.now() });

    const worker = await db('workers').where('id', workerId).first();
    if (worker) {
      session.step = 'view';
      session.workerId = workerId;
      await showWorkerCard(bot, ctx.chat!.id, session.botMessageId, worker);
    }
    await ctx.answerCallbackQuery({ text: `Тип: ${typeLabel(newType)}` });
  });

  // ════════ Удаление: подтверждение ════════

  bot.callbackQuery(/^wk:del:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    const workerId = parseInt(ctx.match[1], 10);
    const worker = await db('workers').where('id', workerId).first();
    if (!worker) { await ctx.answerCallbackQuery({ text: 'Не найден' }); return; }

    session.step = 'confirm_delete';
    session.workerId = workerId;

    const kb = new InlineKeyboard()
      .text('Да, удалить', `wk:dconfirm:${workerId}`)
      .text('Отмена', `wk:view:${workerId}`);

    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      `Удалить рабочего <b>${worker.name}</b>?`, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^wk:dconfirm:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    const workerId = parseInt(ctx.match[1], 10);
    await db('workers').where('id', workerId).del();

    logger.info({ workerId, userId }, 'Worker deleted');

    await showList(bot, ctx.chat!.id, session.botMessageId, userId);
    await ctx.answerCallbackQuery({ text: 'Удалён' });
  });

  // ════════ Кнопка «Назад к списку» ════════

  bot.callbackQuery('wk:back_list', async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) { await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return; }

    await showList(bot, ctx.chat!.id, session.botMessageId, userId);
    await ctx.answerCallbackQuery();
  });

  // ════════ Добавление: пропустить ставку ════════

  bot.callbackQuery('wk:skip_rate', async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'add_rate') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return;
    }

    session.newRate = null;
    session.step = 'add_username';

    const kb = new InlineKeyboard().text('Пропустить', 'wk:skip_uname');
    await safeEdit(bot, ctx.chat!.id, session.botMessageId,
      `<b>Новый рабочий:</b> ${session.newName}\n\nВведите Telegram username (без @) или пропустите:`, kb);
    await ctx.answerCallbackQuery();
  });

  // ════════ Добавление: пропустить username ════════

  bot.callbackQuery('wk:skip_uname', async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'add_username') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' }); return;
    }

    // Сохраняем без username
    await db('workers').insert({
      name: session.newName,
      username: null,
      worker_type: session.newType,
      hourly_rate: session.newRate ?? null,
      created_by_user_id: userId,
    });

    logger.info({ name: session.newName, type: session.newType, rate: session.newRate, userId }, 'Worker created');

    await showList(bot, ctx.chat!.id, session.botMessageId, userId);
    await ctx.answerCallbackQuery({ text: 'Рабочий добавлен' });
  });

  // ════════ Текстовые сообщения в личном чате (имя / username) ════════

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session) return next();

    const text = ctx.message.text.trim();

    // Удаляем сообщение пользователя для чистоты чата
    try { await ctx.deleteMessage(); } catch { /* ignore */ }

    // ─── add_name ───
    if (session.step === 'add_name') {
      if (!text || text.length > 100) {
        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          `<b>Новый рабочий</b> (${typeLabel(session.newType!)})\n\nВведите имя (до 100 символов):`);
        return;
      }

      session.newName = text;
      session.step = 'add_rate';

      const kb = new InlineKeyboard().text('Пропустить', 'wk:skip_rate');
      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>Новый рабочий:</b> ${text}\n\nВведите почасовую ставку (CZK/ч) или пропустите:`, kb);
      return;
    }

    // ─── add_rate ───
    if (session.step === 'add_rate') {
      const rate = parseFloat(text.replace(/\s/g, '').replace(',', '.'));
      if (isNaN(rate) || rate < 0) {
        const kb = new InlineKeyboard().text('Пропустить', 'wk:skip_rate');
        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          `<b>Новый рабочий:</b> ${session.newName}\n\nВведите ставку (число) или пропустите:`, kb);
        return;
      }

      session.newRate = rate;
      session.step = 'add_username';

      const kb = new InlineKeyboard().text('Пропустить', 'wk:skip_uname');
      await safeEdit(bot, ctx.chat.id, session.botMessageId,
        `<b>Новый рабочий:</b> ${session.newName} (${rate} CZK/ч)\n\nВведите Telegram username (без @) или пропустите:`, kb);
      return;
    }

    // ─── add_username ───
    if (session.step === 'add_username') {
      const username = text.replace(/^@/, '');

      await db('workers').insert({
        name: session.newName,
        username: username || null,
        worker_type: session.newType,
        hourly_rate: session.newRate ?? null,
        created_by_user_id: userId,
      });

      logger.info({ name: session.newName, username, type: session.newType, rate: session.newRate, userId }, 'Worker created');

      await showList(bot, ctx.chat.id, session.botMessageId, userId);
      return;
    }

    // ─── edit_name ───
    if (session.step === 'edit_name' && session.workerId) {
      if (!text || text.length > 100) {
        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          '<b>Введите новое имя (до 100 символов):</b>');
        return;
      }

      await db('workers').where('id', session.workerId).update({ name: text, updated_at: db.fn.now() });

      const worker = await db('workers').where('id', session.workerId).first();
      if (worker) {
        session.step = 'view';
        await showWorkerCard(bot, ctx.chat.id, session.botMessageId, worker);
      }
      return;
    }

    // ─── edit_username ───
    if (session.step === 'edit_username' && session.workerId) {
      const username = text.replace(/^@/, '');
      await db('workers').where('id', session.workerId).update({ username, updated_at: db.fn.now() });

      const worker = await db('workers').where('id', session.workerId).first();
      if (worker) {
        session.step = 'view';
        await showWorkerCard(bot, ctx.chat.id, session.botMessageId, worker);
      }
      return;
    }

    // ─── edit_rate ───
    if (session.step === 'edit_rate' && session.workerId) {
      const rate = parseFloat(text.replace(/\s/g, '').replace(',', '.'));
      if (isNaN(rate) || rate < 0) {
        await safeEdit(bot, ctx.chat.id, session.botMessageId,
          '<b>Введите ставку (число CZK/ч):</b>');
        return;
      }

      await db('workers').where('id', session.workerId).update({ hourly_rate: rate, updated_at: db.fn.now() });

      const worker = await db('workers').where('id', session.workerId).first();
      if (worker) {
        session.step = 'view';
        await showWorkerCard(bot, ctx.chat.id, session.botMessageId, worker);
      }
      return;
    }

    // Не наш шаг — пропускаем
    return next();
  });
}
