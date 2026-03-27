import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { reportQueue } from '../../queues/report.queue';
import { syncProjectToSheets, syncTasksToSheets } from '../../services/sheets';
import { config } from '../../config';
import { startHoursOnMessage } from './hoursCommand';
import { startIssueDialog } from './issuesHandler';
import { startCorrectionSession } from './correctionsHandler';
import { logger } from '../../utils/logger';

const TASKS_PAGE_SIZE = 8;

const TOPIC_TYPE_LABELS: Record<string, string> = {
  reports: '📋 Отчёты',
  receipts: '🧾 Чеки',
  issues: '❓ Вопросы',
  general: '📌 Общий',
};

// ─── Helpers ───

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

function backButton(): InlineKeyboard {
  return new InlineKeyboard().text('← В меню', 'gm:back');
}

function buildMainMenu(projectName?: string): { text: string; kb: InlineKeyboard } {
  const title = projectName
    ? `📋 <b>Меню — ${projectName}</b>`
    : '📋 <b>Меню</b>';

  const kb = new InlineKeyboard()
    .text('📊 Суточный отчёт', 'gm:report').row()
    .text('⏱ Записать часы', 'gm:hours').row()
    .text('❓ Задать вопрос', 'gm:issue')
    .text('🔧 Правки', 'gm:corrections').row()
    .text('📝 Задачи', 'gm:tasks').row()
    .text('👤 Менеджер проекта', 'gm:manager').row()
    .text('🔗 Привязка топика', 'gm:link').row()
    .text('📁 Объекты', 'gm:list').row()
    .text('❓ Помощь', 'gm:help').row()
    .text('✖️ Закрыть', 'gm:close');

  return { text: title, kb };
}

// ─── Main export ───

export function setupGroupMenu(bot: Bot<BotContext>): void {

  // ════════ /menu ════════

  bot.command('menu', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    // Удаляем сообщение пользователя
    await safeDelete(bot, ctx.chat.id, ctx.message!.message_id);

    const { text, kb } = buildMainMenu(ctx.project?.name);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  // ════════ gm:back — возврат в меню ════════

  bot.callbackQuery('gm:back', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    // Получаем project name для заголовка (General topic has threadId=0)
    let projectName: string | undefined;
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;
    const backBinding = await db('project_topics')
      .join('projects', 'project_topics.project_id', 'projects.id')
      .where('project_topics.telegram_group_id', chatId.toString())
      .where('project_topics.topic_thread_id', threadId)
      .select('projects.name')
      .first();
    projectName = backBinding?.name;

    const { text, kb } = buildMainMenu(projectName);
    await safeEdit(bot, chatId, messageId, text, kb);
    await ctx.answerCallbackQuery();
  });

  // ════════ gm:close — закрыть меню ════════

  bot.callbackQuery('gm:close', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId && messageId) {
      await safeDelete(bot, chatId, messageId);
    }
    await ctx.answerCallbackQuery();
  });

  // ════════ gm:report — суточный отчёт ════════

  bot.callbackQuery('gm:report', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    // Получаем привязку проекта (General topic has threadId=0)
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;
    let projectId: number | null = null;
    let projectName: string | null = null;

    const binding = await db('project_topics')
      .join('projects', 'project_topics.project_id', 'projects.id')
      .where('project_topics.telegram_group_id', chatId.toString())
      .where('project_topics.topic_thread_id', threadId)
      .select('projects.id', 'projects.name')
      .first();
    if (binding) {
      projectId = binding.id;
      projectName = binding.name;
    }

    if (!projectId) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Этот топик не привязан к объекту.\nИспользуйте «Привязка топика» в меню.',
        backButton());
      return;
    }

    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

    await reportQueue.add('manual-report', {
      projectId,
      date: today,
      sourceThreadId: threadId || null,
    });

    await safeEdit(bot, chatId, messageId,
      `📋 Генерация суточного отчёта запущена для <b>${projectName}</b>...\n\n<i>Отчёт появится в этом топике.</i>`,
      backButton());

    logger.info({ projectId, date: today }, 'Manual report triggered from menu');
  });

  // ════════ gm:hours — записать часы ════════

  bot.callbackQuery('gm:hours', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    // Проверяем привязку проекта (General topic has threadId=0)
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;

    const binding = await db('project_topics')
      .where('telegram_group_id', chatId.toString())
      .where('topic_thread_id', threadId)
      .first();

    if (!binding) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Этот топик не привязан к объекту.\nИспользуйте «Привязка топика» в меню.',
        backButton());
      return;
    }

    const userId = ctx.from.id;
    await startHoursOnMessage(bot, chatId, userId, messageId, ctx.from.username);
  });

  // ════════ gm:issue — задать вопрос ════════

  bot.callbackQuery('gm:issue', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    // Получаем привязку проекта (General topic has threadId=0)
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;
    let projectId: number | null = null;
    let projectName: string | null = null;

    const issueBinding = await db('project_topics')
      .join('projects', 'project_topics.project_id', 'projects.id')
      .where('project_topics.telegram_group_id', chatId.toString())
      .where('project_topics.topic_thread_id', threadId)
      .select('projects.id', 'projects.name')
      .first();
    if (issueBinding) {
      projectId = issueBinding.id;
      projectName = issueBinding.name;
    }

    if (!projectId || !projectName) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Этот топик не привязан к объекту.\nИспользуйте «Привязка топика» в меню.',
        backButton());
      return;
    }

    const userId = ctx.from.id;
    await startIssueDialog(bot, chatId, userId, messageId, projectId, projectName);
  });

  // ════════ gm:corrections — правки объекта ════════

  bot.callbackQuery('gm:corrections', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    // Получаем привязку проекта (General topic has threadId=0)
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;
    let projectId: number | null = null;
    let projectName: string | null = null;
    let projectManagerUserId: string | null = null;

    const corrBinding = await db('project_topics')
      .join('projects', 'project_topics.project_id', 'projects.id')
      .where('project_topics.telegram_group_id', chatId.toString())
      .where('project_topics.topic_thread_id', threadId)
      .select('projects.id', 'projects.name', 'projects.project_manager_user_id')
      .first();
    if (corrBinding) {
      projectId = corrBinding.id;
      projectName = corrBinding.name;
      projectManagerUserId = corrBinding.project_manager_user_id;
    }

    if (!projectId || !projectName) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Этот топик не привязан к объекту.',
        backButton());
      return;
    }

    // Проверяем что менеджер назначен
    if (!projectManagerUserId) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Менеджер проекта не назначен.\n\nНазначьте через «👤 Менеджер проекта» в меню.',
        backButton());
      return;
    }

    // Проверяем что текущий пользователь — менеджер
    if (projectManagerUserId !== ctx.from.id.toString()) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Только менеджер проекта может создавать правки.',
        backButton());
      return;
    }

    const userId = ctx.from.id;
    await startCorrectionSession(bot, chatId, userId, messageId, projectId, projectName);
  });

  // ════════ gm:manager — менеджер проекта ════════

  bot.callbackQuery('gm:manager', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    // General topic has threadId=0
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;
    let projectId: number | null = null;
    let projectName: string | null = null;
    let managerName: string | null = null;

    const mgrBinding = await db('project_topics')
      .join('projects', 'project_topics.project_id', 'projects.id')
      .where('project_topics.telegram_group_id', chatId.toString())
      .where('project_topics.topic_thread_id', threadId)
      .select('projects.id', 'projects.name', 'projects.project_manager_name')
      .first();
    if (mgrBinding) {
      projectId = mgrBinding.id;
      projectName = mgrBinding.name;
      managerName = mgrBinding.project_manager_name;
    }

    if (!projectId) {
      await safeEdit(bot, chatId, messageId,
        '⚠️ Этот топик не привязан к объекту.',
        backButton());
      return;
    }

    const kb = new InlineKeyboard()
      .text('Назначить себя', `gm:setmanager:${projectId}`).row()
      .text('← В меню', 'gm:back');

    const managerText = managerName
      ? `Менеджер проекта <b>${projectName}</b>:\n👤 <b>${managerName}</b>`
      : `Менеджер проекта <b>${projectName}</b>:\n⚠️ <i>не назначен</i>`;

    await safeEdit(bot, chatId, messageId, managerText, kb);
  });

  // ════════ gm:setmanager:{projectId} — назначить себя менеджером ════════

  bot.callbackQuery(/^gm:setmanager:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    const projectId = parseInt(ctx.match[1], 10);
    const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

    try {
      await db('projects').where('id', projectId).update({
        project_manager_user_id: ctx.from.id.toString(),
        project_manager_name: userName,
      });

      const project = await db('projects').where('id', projectId).first();

      await safeEdit(bot, chatId, messageId,
        `✅ Вы назначены менеджером проекта <b>${project?.name || '?'}</b>.`,
        backButton());

      logger.info({ projectId, managerId: ctx.from.id, managerName: userName }, 'Project manager set via menu');
    } catch (err) {
      logger.error({ err, projectId }, 'Failed to set project manager');
      await safeEdit(bot, chatId, messageId, 'Ошибка при назначении менеджера.', backButton());
    }

    await ctx.answerCallbackQuery();
  });

  // ════════ gm:link — привязка топика ════════

  bot.callbackQuery('gm:link', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    // General topic has threadId=0
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;

    try {
      // Проверяем: уже привязан?
      const existing = await db('project_topics')
        .join('projects', 'project_topics.project_id', 'projects.id')
        .where('project_topics.telegram_group_id', chatId.toString())
        .where('project_topics.topic_thread_id', threadId)
        .select('projects.name', 'project_topics.topic_type', 'project_topics.id as binding_id')
        .first();

      if (existing) {
        const typeLabel = TOPIC_TYPE_LABELS[existing.topic_type] || existing.topic_type;
        const kb = new InlineKeyboard()
          .text('Отвязать', `gm:unlink:${existing.binding_id}`).row()
          .text('← В меню', 'gm:back');
        await safeEdit(bot, chatId, messageId,
          `Этот топик привязан к <b>${existing.name}</b> (${typeLabel}).`,
          kb);
        return;
      }

      // Загружаем проекты
      const projects = await db('projects').where('status', 'active').select('id', 'name');

      if (projects.length === 0) {
        await safeEdit(bot, chatId, messageId,
          '⚠️ Нет зарегистрированных объектов.\nСоздайте объект командой /register',
          backButton());
        return;
      }

      if (projects.length === 1) {
        // Один проект — сразу выбор типа
        await showLinkTypeSelection(bot, chatId, messageId, projects[0].id, projects[0].name);
      } else {
        const kb = new InlineKeyboard();
        for (const p of projects) {
          kb.text(p.name, `gm:lp:${p.id}`).row();
        }
        kb.text('← В меню', 'gm:back');
        await safeEdit(bot, chatId, messageId,
          '<b>Выберите объект для привязки:</b>', kb);
      }
    } catch (err) {
      logger.error({ err, chatId, threadId }, 'Menu link failed');
      await safeEdit(bot, chatId, messageId, 'Ошибка при привязке.', backButton());
    }
  });

  // ════════ gm:lp:{projectId} — выбор проекта для link ════════

  bot.callbackQuery(/^gm:lp:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    const projectId = parseInt(ctx.match[1], 10);
    const project = await db('projects').where('id', projectId).first();
    if (!project) {
      await ctx.answerCallbackQuery({ text: 'Объект не найден' });
      return;
    }

    await showLinkTypeSelection(bot, chatId, messageId, project.id, project.name);
    await ctx.answerCallbackQuery();
  });

  // ════════ gm:lt:{projectId}:{type} — выбор типа топика ════════

  bot.callbackQuery(/^gm:lt:(\d+):(reports|receipts|issues)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? 0;
    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery({ text: 'Не удалось определить топик' });
      return;
    }

    const projectId = parseInt(ctx.match[1], 10);
    const topicType = ctx.match[2] as 'reports' | 'receipts' | 'issues';

    try {
      const project = await db('projects').where('id', projectId).first();
      if (!project) {
        await ctx.answerCallbackQuery({ text: 'Объект не найден' });
        return;
      }

      // Проверяем что не привязали пока выбирали
      const alreadyLinked = await db('project_topics')
        .where('telegram_group_id', chatId.toString())
        .where('topic_thread_id', threadId)
        .first();

      if (alreadyLinked) {
        await safeEdit(bot, chatId, messageId,
          '⚠️ Этот топик уже привязан. Используйте «Привязка топика» для управления.',
          backButton());
        await ctx.answerCallbackQuery();
        return;
      }

      await db('project_topics').insert({
        project_id: projectId,
        telegram_group_id: chatId.toString(),
        topic_thread_id: threadId,
        topic_type: topicType,
        created_at: new Date(),
      });

      syncProjectToSheets(projectId).catch((err) =>
        logger.error({ err, projectId }, 'Sheets sync failed after menu link')
      );

      const typeLabel = TOPIC_TYPE_LABELS[topicType];
      await safeEdit(bot, chatId, messageId,
        `✅ Топик привязан к <b>${project.name}</b> (${typeLabel}).`,
        backButton());

      await ctx.answerCallbackQuery();
      logger.info({ projectId, chatId, threadId, topicType }, 'Topic linked via menu');
    } catch (err) {
      logger.error({ err, projectId, chatId }, 'Menu link type callback failed');
      await ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте заново' });
    }
  });

  // ════════ gm:unlink:{bindingId} — отвязка топика ════════

  bot.callbackQuery(/^gm:unlink:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    const bindingId = parseInt(ctx.match[1], 10);

    try {
      const binding = await db('project_topics').where('id', bindingId).first();
      if (!binding) {
        await ctx.answerCallbackQuery({ text: 'Привязка не найдена' });
        return;
      }

      const project = await db('projects').where('id', binding.project_id).first();
      await db('project_topics').where('id', bindingId).delete();

      await safeEdit(bot, chatId, messageId,
        `✅ Топик отвязан от объекта «${project?.name ?? '?'}».`,
        backButton());

      await ctx.answerCallbackQuery();
      logger.info({ bindingId, projectId: binding.project_id }, 'Topic unlinked via menu');
    } catch (err) {
      logger.error({ err }, 'Menu unlink failed');
      await ctx.answerCallbackQuery({ text: 'Ошибка при отвязке' });
    }
  });

  // ════════ gm:tasks — задачи: выбор объекта ════════

  bot.callbackQuery('gm:tasks', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    await ctx.answerCallbackQuery();

    const projects = await db('projects').where('status', 'active').select('id', 'name').orderBy('name');
    if (projects.length === 0) {
      await safeEdit(bot, chatId, messageId, '⚠️ Нет объектов.', backButton());
      return;
    }

    // Считаем открытые задачи для каждого проекта
    const kb = new InlineKeyboard();
    for (const p of projects) {
      const countResult = await db('tasks')
        .where('project_id', p.id)
        .where('status', 'open')
        .count('id as cnt')
        .first();
      const cnt = parseInt(countResult?.cnt as string || '0', 10);
      kb.text(`${p.name} (${cnt})`, `gm:tl:${p.id}:0`).row();
    }
    kb.text('← В меню', 'gm:back');

    await safeEdit(bot, chatId, messageId,
      '<b>📝 Задачи — выберите объект:</b>', kb);
  });

  // ════════ gm:tl:{projectId}:{offset} — список открытых задач ════════

  bot.callbackQuery(/^gm:tl:(\d+):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    await ctx.answerCallbackQuery();

    const projectId = parseInt(ctx.match[1], 10);
    const offset = parseInt(ctx.match[2], 10);

    await showTaskList(bot, chatId, messageId, projectId, offset, 'open');
  });

  // ════════ gm:tc:{projectId}:{offset} — список закрытых задач ════════

  bot.callbackQuery(/^gm:tc:(\d+):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    await ctx.answerCallbackQuery();

    const projectId = parseInt(ctx.match[1], 10);
    const offset = parseInt(ctx.match[2], 10);

    await showTaskList(bot, chatId, messageId, projectId, offset, 'closed');
  });

  // ════════ gm:td:{taskId} — детализация задачи ════════

  bot.callbackQuery(/^gm:td:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    await ctx.answerCallbackQuery();

    const taskId = parseInt(ctx.match[1], 10);
    const task = await db('tasks')
      .join('projects', 'tasks.project_id', 'projects.id')
      .where('tasks.id', taskId)
      .select('tasks.*', 'projects.name as project_name')
      .first();

    if (!task) {
      await safeEdit(bot, chatId, messageId, '⚠️ Задача не найдена.', backButton());
      return;
    }

    const statusIcon = task.status === 'done' ? '✅' : task.status === 'rejected' ? '❌' : '🔵';
    const statusText = task.status === 'done' ? 'Выполнена' : task.status === 'rejected' ? 'Отклонена' : 'Открыта';
    const sourceLabel = task.source_section === 'need_to_order' ? 'Нужно заказать' : task.source_section === 'plan_tomorrow' ? 'План' : 'Доп. работы';
    const createdDate = task.created_date instanceof Date
      ? task.created_date.toLocaleDateString('ru-RU')
      : new Date(task.created_date).toLocaleDateString('ru-RU');

    const lines = [
      `<b>📝 Задача #${task.id}</b>`,
      '',
      `<b>Объект:</b> ${task.project_name}`,
      `<b>Описание:</b> ${task.description}`,
      `<b>Источник:</b> ${sourceLabel}`,
      `<b>Создана:</b> ${createdDate}`,
      `<b>Создал:</b> ${task.reported_by || '—'}`,
      `<b>Статус:</b> ${statusIcon} ${statusText}`,
    ];

    if (task.completed_by) {
      const completedDate = task.completed_date
        ? (task.completed_date instanceof Date
          ? task.completed_date.toLocaleDateString('ru-RU')
          : new Date(task.completed_date).toLocaleDateString('ru-RU'))
        : '—';
      lines.push(`<b>${task.status === 'done' ? 'Выполнил' : 'Отклонил'}:</b> ${task.completed_by}`);
      lines.push(`<b>Дата:</b> ${completedDate}`);
    }

    const kb = new InlineKeyboard();
    if (task.status === 'open') {
      kb.text('✅ Выполнена', `gm:ts:${task.id}:done`)
        .text('❌ Отклонена', `gm:ts:${task.id}:rejected`).row();
    }
    kb.text('← Назад', `gm:tl:${task.project_id}:0`);

    await safeEdit(bot, chatId, messageId, lines.join('\n'), kb);
  });

  // ════════ gm:ts:{taskId}:{status} — изменить статус задачи ════════

  bot.callbackQuery(/^gm:ts:(\d+):(done|rejected)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    await ctx.answerCallbackQuery();

    const taskId = parseInt(ctx.match[1], 10);
    const newStatus = ctx.match[2] as 'done' | 'rejected';
    const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

    try {
      const task = await db('tasks').where('id', taskId).first();
      if (!task || task.status !== 'open') {
        await ctx.answerCallbackQuery({ text: 'Задача уже обработана' });
        return;
      }

      await db('tasks').where('id', taskId).update({
        status: newStatus,
        completed_date: today,
        completed_by: userName,
        completed_by_user_id: ctx.from.id.toString(),
        synced_to_sheets: false,
        updated_at: new Date(),
      });

      // Sync to Sheets
      syncTasksToSheets(task.project_id, task.created_date).catch((err: any) =>
        logger.warn({ err }, 'Failed to sync task status to Sheets'),
      );

      const icon = newStatus === 'done' ? '✅' : '❌';
      const label = newStatus === 'done' ? 'выполнена' : 'отклонена';

      logger.info({ taskId, newStatus, by: userName }, 'Task status changed via menu');

      // Показываем обновлённый список
      await safeEdit(bot, chatId, messageId,
        `${icon} Задача #${taskId} — ${label}`,
        new InlineKeyboard().text('← К задачам', `gm:tl:${task.project_id}:0`));
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to update task status');
      await safeEdit(bot, chatId, messageId, 'Ошибка при обновлении задачи.', backButton());
    }
  });

  // ════════ gm:noop — пустой callback (номер страницы) ════════

  bot.callbackQuery('gm:noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  // ════════ gm:list — объекты ════════

  bot.callbackQuery('gm:list', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    try {
      const projects = await db('projects')
        .where('status', 'active')
        .select('id', 'name')
        .orderBy('name');

      if (projects.length === 0) {
        await safeEdit(bot, chatId, messageId,
          'Объектов нет. Создайте первый командой /register',
          backButton());
        return;
      }

      const lines: string[] = [];
      for (const p of projects) {
        const topics = await db('project_topics')
          .where('project_id', p.id)
          .select('topic_type');

        if (topics.length === 0) {
          lines.push(`🟢 <b>${p.name}</b> — ⚠️ нет топиков`);
        } else {
          const types = topics
            .map((t: { topic_type: string }) => TOPIC_TYPE_LABELS[t.topic_type] || t.topic_type)
            .join(', ');
          lines.push(`🟢 <b>${p.name}</b> — ${types}`);
        }
      }

      await safeEdit(bot, chatId, messageId,
        `<b>Объекты (${projects.length}):</b>\n\n${lines.join('\n')}`,
        backButton());
    } catch (err) {
      logger.error({ err }, 'Menu list failed');
      await safeEdit(bot, chatId, messageId, 'Ошибка при получении списка.', backButton());
    }
  });

  // ════════ gm:help — помощь ════════

  bot.callbackQuery('gm:help', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;

    await ctx.answerCallbackQuery();

    const helpText = `<b>❓ Помощь</b>

<b>📁 Объекты:</b>
/register — создать объект
/rename &lt;имя&gt; — переименовать
/unregister &lt;имя&gt; — удалить

<b>🔗 Топики:</b>
/link — привязать (или через меню)
/unlink — отвязать

<b>📊 Отчёты:</b>
<code>REPORT</code> — структурированный отчёт менеджера
/report — сгенерировать суточный отчёт
/reportall — отчёты по всем объектам

<b>⏱ Часы:</b>
/hours — записать часы (или через меню)

<b>📄 Менеджерские счета:</b>
/managerreport — добавить счёт (личный чат)

<b>📋 Меню:</b>
/menu — это меню`;

    await safeEdit(bot, chatId, messageId, helpText, backButton());
  });
}

// ─── Вспомогательные ───

async function showTaskList(
  bot: Bot<BotContext>,
  chatId: number,
  messageId: number,
  projectId: number,
  offset: number,
  mode: 'open' | 'closed',
): Promise<void> {
  const project = await db('projects').where('id', projectId).first();
  if (!project) return;

  const isOpen = mode === 'open';

  const query = db('tasks')
    .where('project_id', projectId);

  if (isOpen) {
    query.where('status', 'open');
  } else {
    query.whereIn('status', ['done', 'rejected']);
  }

  const totalResult = await query.clone().count('id as cnt').first();
  const total = parseInt(totalResult?.cnt as string || '0', 10);

  const tasks = await query.clone()
    .orderBy('created_at', isOpen ? 'asc' : 'desc')
    .offset(offset)
    .limit(TASKS_PAGE_SIZE);

  const title = isOpen
    ? `<b>📝 Задачи — ${project.name}</b>\n<i>Открытые (${total})</i>`
    : `<b>📝 Задачи — ${project.name}</b>\n<i>Закрытые (${total})</i>`;

  const kb = new InlineKeyboard();

  if (total === 0) {
    const emptyText = isOpen ? 'Нет открытых задач.' : 'Нет закрытых задач.';
    const emptyKb = new InlineKeyboard();
    if (isOpen) {
      emptyKb.text('🗂 Закрытые задачи', `gm:tc:${projectId}:0`).row();
      emptyKb.text('← К объектам', 'gm:tasks');
    } else {
      emptyKb.text('📝 Открытые задачи', `gm:tl:${projectId}:0`).row();
      emptyKb.text('← К объектам', 'gm:tasks');
    }
    await safeEdit(bot, chatId, messageId,
      `${title}\n\n${emptyText}`, emptyKb);
    return;
  }

  for (const task of tasks) {
    let icon = '🔵';
    if (task.status === 'done') icon = '✅';
    else if (task.status === 'rejected') icon = '❌';

    const desc = task.description.length > 40
      ? task.description.substring(0, 37) + '...'
      : task.description;

    kb.text(`${icon} ${desc}`, `gm:td:${task.id}`).row();
  }

  // Пагинация
  const hasPrev = offset > 0;
  const hasNext = offset + TASKS_PAGE_SIZE < total;
  const prefix = isOpen ? 'gm:tl' : 'gm:tc';

  if (hasPrev || hasNext) {
    if (hasPrev) {
      kb.text('⬅️', `${prefix}:${projectId}:${offset - TASKS_PAGE_SIZE}`);
    }
    kb.text(`${Math.floor(offset / TASKS_PAGE_SIZE) + 1}/${Math.ceil(total / TASKS_PAGE_SIZE)}`, 'gm:noop');
    if (hasNext) {
      kb.text('➡️', `${prefix}:${projectId}:${offset + TASKS_PAGE_SIZE}`);
    }
    kb.row();
  }

  // Переключатель открытые/закрытые + назад
  if (isOpen) {
    kb.text('🗂 Закрытые задачи', `gm:tc:${projectId}:0`).row();
    kb.text('← К объектам', 'gm:tasks');
  } else {
    kb.text('📝 Открытые задачи', `gm:tl:${projectId}:0`).row();
    kb.text('← К объектам', 'gm:tasks');
  }

  await safeEdit(bot, chatId, messageId, title, kb);
}

async function showLinkTypeSelection(
  bot: Bot<BotContext>,
  chatId: number,
  messageId: number,
  projectId: number,
  projectName: string,
): Promise<void> {
  const kb = new InlineKeyboard()
    .text('📋 Отчёты', `gm:lt:${projectId}:reports`)
    .text('🧾 Чеки', `gm:lt:${projectId}:receipts`).row()
    .text('❓ Вопросы', `gm:lt:${projectId}:issues`).row()
    .text('← В меню', 'gm:back');

  await safeEdit(bot, chatId, messageId,
    `Объект: <b>${projectName}</b>\n\n<b>Выберите тип топика:</b>`, kb);
}
