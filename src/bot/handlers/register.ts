import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { renameProjectSheet, syncProjectToSheets, deleteProjectSheet } from '../../services/sheets';
import { logger } from '../../utils/logger';

// --- Визард регистрации ---

interface RegisterSession {
  step: 'name' | 'budget' | 'labor';
  botMessageId: number;
  projectName?: string;
  budgetCzk?: number;
  createdAt: number;
}

/** Активные сессии визарда: ключ = "chatId:userId" */
const registerSessions = new Map<string, RegisterSession>();

/** Автоочистка зависших сессий (старше 5 минут) */
const SESSION_TTL_MS = 5 * 60 * 1000;

function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [key, session] of registerSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      registerSessions.delete(key);
    }
  }
}

/** Безопасное удаление сообщения (игнорирует ошибки если уже удалено) */
async function safeDelete(bot: Bot<BotContext>, chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch {
    // Сообщение уже удалено или нет прав — игнорируем
  }
}

/** Парсит число из текста (поддержка запятой, пробелов) */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num < 0) return null;
  return num;
}

export function setupRegister(bot: Bot<BotContext>): void {
  // --- /register — запуск визарда ---
  bot.command('register', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    cleanupStaleSessions();

    const chatId = ctx.chat.id;
    const userId = ctx.from!.id;
    const key = `${chatId}:${userId}`;

    // Если уже есть активная сессия — сбрасываем
    const existing = registerSessions.get(key);
    if (existing) {
      await safeDelete(bot, chatId, existing.botMessageId);
      registerSessions.delete(key);
    }

    // Шаг 1: спрашиваем название
    const msg = await ctx.reply('📋 <b>Введите название объекта:</b>', { parse_mode: 'HTML' });

    registerSessions.set(key, {
      step: 'name',
      botMessageId: msg.message_id,
      createdAt: Date.now(),
    });
  });

  // --- /cancel — отмена визарда ---
  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) return;

    const key = `${chatId}:${userId}`;
    const session = registerSessions.get(key);
    if (!session) return;

    // Удаляем сообщение бота и команду /cancel
    await safeDelete(bot, chatId, session.botMessageId);
    await safeDelete(bot, chatId, ctx.message!.message_id);
    registerSessions.delete(key);
  });

  // --- Перехватчик текста для визарда (ПЕРЕД textMessage.ts) ---
  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from!.id;
    const key = `${chatId}:${userId}`;

    const session = registerSessions.get(key);
    if (!session) return next();

    const text = ctx.message.text;

    // Команды — пропускаем (кроме /cancel который выше)
    if (text.startsWith('/')) return next();

    // Удаляем сообщение юзера
    await safeDelete(bot, chatId, ctx.message.message_id);

    try {
      if (session.step === 'name') {
        await handleNameStep(bot, ctx, session, key, text);
      } else if (session.step === 'budget') {
        await handleBudgetStep(bot, ctx, session, key, text);
      } else if (session.step === 'labor') {
        await handleLaborStep(bot, ctx, session, key, text);
      }
    } catch (err) {
      logger.error({ err, chatId, userId, step: session.step }, 'Register wizard step failed');
      await safeDelete(bot, chatId, session.botMessageId);
      registerSessions.delete(key);
      await ctx.reply('Ошибка при создании объекта. Попробуйте /register заново.');
    }

    // НЕ вызываем next() — сообщение обработано визардом
  });

  // --- /unregister <название> — удаление объекта ---
  bot.command('unregister', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply('Использование: /unregister Название объекта');
      return;
    }

    try {
      const project = await db('projects')
        .whereRaw('LOWER(name) = LOWER(?)', [name])
        .first();

      if (!project) {
        await ctx.reply(`⚠️ Объект "${name}" не найден.`);
        return;
      }

      // Удаляем всё связанное в транзакции
      await db.transaction(async (trx) => {
        await trx('message_buffer').where('project_id', project.id).del();
        await trx('daily_reports').where('project_id', project.id).del();
        await trx('daily_summaries').where('project_id', project.id).del();
        await trx('worker_hours').where('project_id', project.id).del();
        await trx('receipts').where('project_id', project.id).del();
        // project_topics — CASCADE, но удалим явно для надёжности
        await trx('project_topics').where('project_id', project.id).del();
        await trx('projects').where('id', project.id).del();
      });

      // Удаляем лист из Google Sheets
      deleteProjectSheet(project.name).catch((err) =>
        logger.error({ err, projectId: project.id }, 'Failed to delete project sheet on unregister')
      );

      logger.info({ projectId: project.id, name: project.name }, 'Project unregistered');

      await ctx.reply(`🗑 Объект "${project.name}" удалён. Все привязанные топики отвязаны.`);
    } catch (err) {
      logger.error({ err }, '/unregister failed');
      await ctx.reply('Ошибка при удалении объекта.');
    }
  });

  // --- /rename — переименование объекта текущего топика ---
  bot.command('rename', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return;
    }

    const newName = ctx.match?.trim();
    if (!newName) {
      await ctx.reply('Использование: /rename Новое название');
      return;
    }

    if (!ctx.project) {
      await ctx.reply('⚠️ Этот топик не привязан к объекту. Используйте /link для привязки.');
      return;
    }

    try {
      const oldName = ctx.project.name;

      await db('projects')
        .where('id', ctx.project.id)
        .update({ name: newName, updated_at: new Date() });

      renameProjectSheet(oldName, newName).catch((err) =>
        logger.error({ err, projectId: ctx.project!.id }, 'Sheets rename failed')
      );

      logger.info({ projectId: ctx.project.id, oldName, newName }, 'Project renamed');

      await ctx.reply(`✅ Объект переименован: "${oldName}" → "${newName}"`);
    } catch (err) {
      logger.error({ err }, '/rename failed');
      await ctx.reply('Ошибка при переименовании.');
    }
  });
}

// --- Обработчики шагов визарда ---

async function handleNameStep(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: RegisterSession,
  key: string,
  text: string
): Promise<void> {
  const name = text.trim();
  if (!name) {
    await bot.api.editMessageText(
      ctx.chat!.id,
      session.botMessageId,
      '⚠️ Название не может быть пустым.\n\n📋 <b>Введите название объекта:</b>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Проверяем уникальность
  const existing = await db('projects')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .first();

  if (existing) {
    await bot.api.editMessageText(
      ctx.chat!.id,
      session.botMessageId,
      `⚠️ Объект "${existing.name}" уже существует.\n\n📋 <b>Введите другое название:</b>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  session.projectName = name;
  session.step = 'budget';

  await bot.api.editMessageText(
    ctx.chat!.id,
    session.botMessageId,
    `📋 Объект: <b>${name}</b>\n\n💰 <b>Сумма на материал, план (CZK):</b>\n<i>Введите 0 чтобы пропустить</i>`,
    { parse_mode: 'HTML' }
  );
}

async function handleBudgetStep(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: RegisterSession,
  key: string,
  text: string
): Promise<void> {
  const amount = parseAmount(text);
  if (amount === null) {
    await bot.api.editMessageText(
      ctx.chat!.id,
      session.botMessageId,
      `📋 Объект: <b>${session.projectName}</b>\n\n⚠️ Введите число.\n\n💰 <b>Сумма на материал, план (CZK):</b>\n<i>Введите 0 чтобы пропустить</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  session.budgetCzk = amount;
  session.step = 'labor';

  await bot.api.editMessageText(
    ctx.chat!.id,
    session.botMessageId,
    `📋 Объект: <b>${session.projectName}</b>\n💰 Материалы: ${amount.toLocaleString('cs-CZ')} CZK\n\n👷 <b>Заложено на работы (CZK):</b>\n<i>Введите 0 чтобы пропустить</i>`,
    { parse_mode: 'HTML' }
  );
}

async function handleLaborStep(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: RegisterSession,
  key: string,
  text: string
): Promise<void> {
  const amount = parseAmount(text);
  if (amount === null) {
    await bot.api.editMessageText(
      ctx.chat!.id,
      session.botMessageId,
      `📋 Объект: <b>${session.projectName}</b>\n💰 Материалы: ${session.budgetCzk!.toLocaleString('cs-CZ')} CZK\n\n⚠️ Введите число.\n\n👷 <b>Заложено на работы (CZK):</b>\n<i>Введите 0 чтобы пропустить</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const chatId = ctx.chat!.id;
  const name = session.projectName!;
  const budgetCzk = session.budgetCzk!;
  const laborBudgetCzk = amount;

  // Удаляем сообщение-вопрос бота
  await safeDelete(bot, chatId, session.botMessageId);
  registerSessions.delete(key);

  // Создаём проект
  const [project] = await db('projects')
    .insert({
      name,
      telegram_group_id: chatId.toString(),
      status: 'active',
      budget_czk: budgetCzk,
      labor_budget_czk: laborBudgetCzk,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');

  logger.info({ projectId: project.id, name, budgetCzk, laborBudgetCzk, chatId }, 'Project registered (wizard)');

  // Создаём лист и синхронизируем бюджет в Google Sheets
  syncProjectToSheets(project.id).catch((err) =>
    logger.error({ err, projectId: project.id }, 'Sheets sync failed')
  );

  // Финальное сообщение
  const lines = [`✅ Объект "<b>${name}</b>" создан (ID: ${project.id}).`];
  if (budgetCzk > 0) lines.push(`💰 Материалы: ${budgetCzk.toLocaleString('cs-CZ')} CZK`);
  if (laborBudgetCzk > 0) lines.push(`👷 Работы: ${laborBudgetCzk.toLocaleString('cs-CZ')} CZK`);
  lines.push('', `Следующий шаг: зайдите в нужный топик и выполните:\n/link ${name}`);

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
