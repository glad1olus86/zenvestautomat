import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { receiptQueue } from '../../queues/receipt.queue';
import { downloadTelegramFile } from '../../utils/downloadFile';
import { logger } from '../../utils/logger';

/**
 * Обрабатывает PDF-документы в группах — ставит в очередь распознавания.
 * PDF отправляется напрямую в Gemini без конвертации.
 */
export function setupDocumentMessage(bot: Bot<BotContext>): void {
  bot.on('message:document', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return;
    }

    // Только привязанные топики
    if (!ctx.project) {
      return;
    }

    // Чеки сканируются только в топике «Чеки»
    if (ctx.topicType !== 'receipts') {
      return;
    }

    const doc = ctx.message.document;

    // Только PDF
    if (doc.mime_type !== 'application/pdf') {
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    try {
      // 1. Скачиваем PDF
      const pdfPath = await downloadTelegramFile(ctx.api, doc.file_id, '.pdf');

      // 2. Создаём запись чека в БД
      const [receipt] = await db('receipts')
        .insert({
          project_id: ctx.project?.id || null,
          telegram_group_id: chatId.toString(),
          telegram_user_id: userId.toString(),
          telegram_message_id: ctx.message.message_id,
          file_id: doc.file_id,
          recognition_status: 'pending',
        })
        .returning('*');

      // 3. Ставим в очередь распознавания (PDF напрямую)
      await receiptQueue.add('recognize', {
        receiptId: receipt.id,
        imagePath: pdfPath,
        fileId: doc.file_id,
        telegramGroupId: chatId.toString(),
        telegramMessageId: ctx.message.message_id,
      });

      logger.info({
        chatId,
        userId,
        receiptId: receipt.id,
        fileName: doc.file_name,
      }, 'PDF queued for receipt recognition');
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to process PDF document');
    }
  });
}
