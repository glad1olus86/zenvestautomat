import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { triggerDailyReports } from '../../services/scheduler';
import { reportQueue } from '../../queues/report.queue';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Команда /report — ручной запуск суточного отчёта для текущей группы.
 * Полезно для тестирования, не дожидаясь 20:00.
 */
export function setupReportCommand(bot: Bot<BotContext>): void {
  bot.command('report', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('Эта команда работает только в группах.');
      return;
    }

    if (!ctx.project) {
      await ctx.reply('⚠️ Группа не привязана к объекту. Используйте /register');
      return;
    }

    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

    const statusMsg = await ctx.reply('📋 Генерация суточного отчёта запущена...');

    const threadId = ctx.message?.message_thread_id ?? null;

    await reportQueue.add('manual-report', {
      projectId: ctx.project.id,
      date: today,
      statusMessageId: statusMsg.message_id,
      statusChatId: ctx.chat.id,
      sourceThreadId: threadId,
    });

    logger.info({ projectId: ctx.project.id, date: today }, 'Manual report triggered');
  });

  // /reportall — запустить отчёты для всех проектов (для тестирования)
  bot.command('reportall', async (ctx) => {
    await triggerDailyReports();
    await ctx.reply('📋 Генерация отчётов для всех проектов запущена...');
  });
}
