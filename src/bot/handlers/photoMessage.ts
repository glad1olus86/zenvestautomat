import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { receiptQueue } from '../../queues/receipt.queue';
import { downloadTelegramFile } from '../../utils/downloadFile';
import { logger } from '../../utils/logger';

/**
 * Обрабатывает фото ТОЛЬКО в топике «Чеки» (topic_type = 'receipts').
 * Скачивает, создаёт запись receipt(pending), ставит в очередь распознавания.
 */
export function setupPhotoMessage(bot: Bot<BotContext>): void {
  bot.on('message:photo', async (ctx) => {
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

    // Берём самое большое фото (последний элемент массива)
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    try {
      // 1. Скачиваем фото
      const imagePath = await downloadTelegramFile(ctx.api, photo.file_id, '.jpg');

      // 2. Создаём запись чека в БД со статусом pending
      const [receipt] = await db('receipts')
        .insert({
          project_id: ctx.project?.id || null,
          telegram_group_id: chatId.toString(),
          telegram_user_id: userId.toString(),
          telegram_message_id: ctx.message.message_id,
          file_id: photo.file_id,
          recognition_status: 'pending',
        })
        .returning('*');

      // 3. Ставим в очередь распознавания
      await receiptQueue.add('recognize', {
        receiptId: receipt.id,
        imagePath,
        fileId: photo.file_id,
        telegramGroupId: chatId.toString(),
        telegramMessageId: ctx.message.message_id,
      });

      logger.info({
        chatId,
        userId,
        receiptId: receipt.id,
        fileSize: photo.file_size,
      }, 'Photo queued for receipt recognition');
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to process photo message');
    }
  });
}
