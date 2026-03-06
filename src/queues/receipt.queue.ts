import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './connection';
import { db } from '../db/knex';
import { recognizeReceipt } from '../services/gemini';
import { convertToCZK } from '../services/currency';
import { cleanupFile } from '../utils/downloadFile';
import { syncReceiptToSheets } from '../services/sheets';
import { logger } from '../utils/logger';
import { Bot } from 'grammy';
import { BotContext } from '../bot/bot';
import { InlineKeyboard } from 'grammy';

const QUEUE_NAME = 'receipt';

export interface ReceiptJobData {
  receiptId: number;
  imagePath: string;
  fileId: string;
  telegramGroupId: string;
  telegramMessageId: number;
}

export const receiptQueue = new Queue(QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

/**
 * Запуск воркера распознавания чеков.
 * Нужен экземпляр бота для отправки ответов в Telegram.
 */
export function startReceiptWorker(bot: Bot<BotContext>): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as ReceiptJobData;
      const { receiptId, imagePath, fileId, telegramGroupId, telegramMessageId } = data;

      logger.info({ jobId: job.id, receiptId }, 'Receipt recognition started');

      // 1. Распознавание через Gemini
      const { data: receiptData, raw } = await recognizeReceipt(imagePath);

      if (!receiptData) {
        // Не удалось распознать — чистим файл, retry не поможет
        cleanupFile(imagePath);

        await db('receipts')
          .where('id', receiptId)
          .update({
            recognition_status: 'failed',
            raw_gemini_response: JSON.stringify(raw),
            updated_at: new Date(),
          });

        // Отправляем ответ с inline-кнопкой "Повторить"
        const keyboard = new InlineKeyboard()
          .text('🔄 Отправить повторно', `retry_receipt:${receiptId}`);

        await bot.api.sendMessage(
          telegramGroupId,
          '❌ Не удалось распознать чек. Попробуйте сфотографировать ещё раз.',
          {
            reply_parameters: { message_id: telegramMessageId },
            reply_markup: keyboard,
          }
        );

        logger.info({ receiptId }, 'Receipt recognition failed — user notified');
        return;
      }

      // 2. Конвертация валюты если нужно
      let amountCzk = receiptData.amount;
      let exchangeRate = 1;

      if (receiptData.currency.toUpperCase() !== 'CZK') {
        const conversion = await convertToCZK(receiptData.amount, receiptData.currency);
        amountCzk = conversion.amountCzk;
        exchangeRate = conversion.rate;
      }

      // 3. Обновляем запись в БД
      await db('receipts')
        .where('id', receiptId)
        .update({
          amount_original: receiptData.amount,
          currency_original: receiptData.currency.toUpperCase(),
          amount_czk: amountCzk,
          exchange_rate: exchangeRate,
          receipt_date: receiptData.date || new Date().toISOString().split('T')[0],
          category: receiptData.category,
          description: receiptData.description,
          shop: receiptData.shop,
          recognition_status: 'success',
          raw_gemini_response: JSON.stringify(raw),
          updated_at: new Date(),
        });

      // 4. Подтверждение в группу
      const currencyNote = receiptData.currency.toUpperCase() !== 'CZK'
        ? `\n💱 ${receiptData.amount} ${receiptData.currency} → ${amountCzk} CZK (курс: ${exchangeRate})`
        : '';

      await bot.api.sendMessage(
        telegramGroupId,
        `✅ Чек распознан:\n` +
        `📝 ${receiptData.description}\n` +
        `💰 ${receiptData.amount} ${receiptData.currency}${currencyNote}\n` +
        `🏪 ${receiptData.shop || '—'}\n` +
        `📂 ${receiptData.category}\n` +
        `📅 ${receiptData.date}`,
        { reply_parameters: { message_id: telegramMessageId } }
      );

      // 5. Синхронизация в Google Sheets (fire-and-forget)
      syncReceiptToSheets(receiptId).catch((err) =>
        logger.error({ err, receiptId }, 'Sheets sync failed for receipt')
      );

      // Чистим файл только после полного успеха
      cleanupFile(imagePath);

      logger.info({ receiptId, amountCzk, currency: receiptData.currency }, 'Receipt recognized successfully');
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job?.id }, 'Receipt job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Receipt job failed');
  });

  logger.info('Receipt worker started (concurrency=3)');
  return worker;
}
