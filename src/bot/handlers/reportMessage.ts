import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';
import { extractTasks } from '../../prompts/reportParsing';
import { parseManagerReport } from '../../services/gemini';
import { syncManagerReportToSheets, syncTasksToSheets } from '../../services/sheets';

/**
 * Перехватывает сообщения REPORT от менеджеров в группах.
 * Парсит секции, сохраняет в БД, синхронизирует с Sheets.
 */
export function setupReportMessage(bot: Bot<BotContext>): void {
  bot.on('message:text', async (ctx, next) => {
    // Только группы
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return next();
    }

    // Только привязанные топики
    if (!ctx.project) {
      return next();
    }

    const text = ctx.message.text;

    // Проверяем ключевое слово REPORT / РЕПОРТ
    if (!/^\s*(?:REPORT|РЕПОРТ)\b/i.test(text)) {
      return next();
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const managerName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const messageId = ctx.message.message_id;
    const threadId = ctx.message.message_thread_id ?? null;

    // Дата в таймзоне Prague
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

    try {
      // 1. Парсим секции через AI
      const parsed = await parseManagerReport(text);
      if (!parsed) {
        await ctx.reply('⚠️ Не удалось разобрать REPORT. Напишите что было сделано, проблемы, план.');
        return;
      }

      // 2. Строим ссылку на сообщение
      const chatIdStr = String(Math.abs(chatId));
      const linkChatId = chatIdStr.startsWith('100') ? chatIdStr.substring(3) : chatIdStr;
      const messageLink = `https://t.me/c/${linkChatId}/${messageId}`;

      // 3. Автосумма чеков за сегодня по проекту
      const materialsResult = await db('receipts')
        .where('project_id', ctx.project.id)
        .where('receipt_date', today)
        .where('recognition_status', 'success')
        .whereIn('category', ['материалы', 'инструменты'])
        .sum('amount_czk as total')
        .first();

      const workResult = await db('receipts')
        .where('project_id', ctx.project.id)
        .where('receipt_date', today)
        .where('recognition_status', 'success')
        .whereIn('category', ['транспорт', 'аренда', 'услуги'])
        .sum('amount_czk as total')
        .first();

      const spentOnMaterials = parseFloat(materialsResult?.total || '0');
      const spentOnWork = parseFloat(workResult?.total || '0');

      // 4. Upsert в manager_reports
      const [report] = await db('manager_reports')
        .insert({
          project_id: ctx.project.id,
          report_date: today,
          telegram_user_id: userId.toString(),
          manager_name: managerName,
          raw_text: text,
          done_block: parsed.doneBlock,
          problems_block: parsed.problemsBlock,
          extra_work_block: parsed.extraWorkBlock,
          need_to_order_block: parsed.needToOrderBlock,
          plan_tomorrow_block: parsed.planTomorrowBlock,
          telegram_group_id: chatId.toString(),
          telegram_message_id: messageId,
          topic_thread_id: threadId,
          message_link: messageLink,
          spent_on_work_czk: spentOnWork,
          spent_on_materials_czk: spentOnMaterials,
        })
        .onConflict(['project_id', 'report_date'])
        .merge({
          telegram_user_id: userId.toString(),
          manager_name: managerName,
          raw_text: text,
          done_block: parsed.doneBlock,
          problems_block: parsed.problemsBlock,
          extra_work_block: parsed.extraWorkBlock,
          need_to_order_block: parsed.needToOrderBlock,
          plan_tomorrow_block: parsed.planTomorrowBlock,
          telegram_message_id: messageId,
          topic_thread_id: threadId,
          message_link: messageLink,
          spent_on_work_czk: spentOnWork,
          spent_on_materials_czk: spentOnMaterials,
          synced_to_sheets: false,
          updated_at: new Date(),
        })
        .returning('*');

      // 5. Извлекаем и сохраняем задачи
      const tasks = extractTasks(parsed);

      // Удаляем старые задачи за этот проект+дату (перезапись при повторном REPORT)
      await db('tasks')
        .where('project_id', ctx.project.id)
        .where('created_date', today)
        .whereNotNull('manager_report_id')
        .del();

      let taskCount = 0;
      if (tasks.length > 0) {
        await db('tasks').insert(
          tasks.map((t) => ({
            project_id: ctx.project!.id,
            manager_report_id: report.id,
            description: t.description,
            source_section: t.sourceSection,
            status: 'open',
            created_date: today,
            reported_by: managerName,
          })),
        );
        taskCount = tasks.length;
      }

      // 6. Sync to Sheets (fire-and-forget)
      syncManagerReportToSheets(report.id).catch((err: any) =>
        logger.warn({ err }, 'Failed to sync manager report to Sheets'),
      );
      if (taskCount > 0) {
        syncTasksToSheets(ctx.project.id, today).catch((err: any) =>
          logger.warn({ err }, 'Failed to sync tasks to Sheets'),
        );
      }

      // 7. Подтверждение
      const sectionCount = [
        parsed.doneBlock,
        parsed.problemsBlock,
        parsed.extraWorkBlock,
        parsed.needToOrderBlock,
        parsed.planTomorrowBlock,
      ].filter(Boolean).length;

      await ctx.reply(
        `✅ REPORT принят для <b>${ctx.project.name}</b> (${today}).\n` +
        `Секций: ${sectionCount} | Задач: ${taskCount}`,
        {
          parse_mode: 'HTML',
          message_thread_id: threadId ?? undefined,
        },
      );

      logger.info({
        projectId: ctx.project.id,
        date: today,
        manager: managerName,
        sections: sectionCount,
        tasks: taskCount,
      }, 'Manager REPORT saved');

      // НЕ вызываем next() — сообщение не попадёт в message_buffer
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to process manager REPORT');
    }
  });
}
