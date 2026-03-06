import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { receiptQueue } from '../../queues/receipt.queue';
import { downloadTelegramFile } from '../../utils/downloadFile';
import { logger } from '../../utils/logger';

/**
 * Обрабатывает inline-кнопку "Отправить повторно" для чеков.
 * Callback data формат: retry_receipt:{receiptId}
 */
export function setupCallbackRetry(bot: Bot<BotContext>): void {
  bot.callbackQuery(/^retry_receipt:(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1], 10);

    try {
      // Находим чек в БД
      const receipt = await db('receipts')
        .where('id', receiptId)
        .first();

      if (!receipt) {
        await ctx.answerCallbackQuery({ text: 'Чек не найден' });
        return;
      }

      if (!receipt.file_id) {
        await ctx.answerCallbackQuery({ text: 'Файл недоступен' });
        return;
      }

      // Скачиваем файл заново по file_id (file_id не истекает)
      const imagePath = await downloadTelegramFile(ctx.api, receipt.file_id, '.jpg');

      // Сбрасываем статус
      await db('receipts')
        .where('id', receiptId)
        .update({
          recognition_status: 'pending',
          updated_at: new Date(),
        });

      // Ставим в очередь повторно
      await receiptQueue.add('recognize', {
        receiptId,
        imagePath,
        fileId: receipt.file_id,
        telegramGroupId: receipt.telegram_group_id,
        telegramMessageId: receipt.telegram_message_id,
      });

      await ctx.answerCallbackQuery({ text: '🔄 Повторная обработка...' });

      // Убираем inline-клавиатуру с сообщения
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Может не получиться если сообщение слишком старое
      }

      logger.info({ receiptId }, 'Receipt retry queued');
    } catch (err) {
      logger.error({ err, receiptId }, 'Receipt retry failed');
      await ctx.answerCallbackQuery({ text: 'Ошибка, попробуйте позже' });
    }
  });
}
