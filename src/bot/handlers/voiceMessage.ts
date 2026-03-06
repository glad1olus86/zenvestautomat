import { Bot } from 'grammy';
import { BotContext } from '../bot';
import { transcriptionQueue } from '../../queues/transcription.queue';
import { downloadTelegramFile } from '../../utils/downloadFile';
import { logger } from '../../utils/logger';

/**
 * Обрабатывает голосовые сообщения.
 * Скачивает .ogg файл и ставит в очередь на транскрипцию.
 */
export function setupVoiceMessage(bot: Bot<BotContext>): void {
  bot.on('message:voice', async (ctx) => {
    // Только группы
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return;
    }

    // Только привязанные топики
    if (!ctx.project) {
      return;
    }

    const voice = ctx.message.voice;
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

    // Дата в таймзоне Prague
    const messageDate = new Date(ctx.message.date * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

    try {
      // Скачиваем .ogg файл
      const oggPath = await downloadTelegramFile(ctx.api, voice.file_id, '.ogg');

      // Ставим в очередь
      await transcriptionQueue.add('transcribe', {
        oggPath,
        telegramGroupId: chatId.toString(),
        telegramUserId: userId.toString(),
        userName,
        telegramMessageId: ctx.message.message_id,
        messageDate,
        projectId: ctx.project?.id || null,
      });

      logger.info({
        chatId,
        userId,
        duration: voice.duration,
        fileSize: voice.file_size,
      }, 'Voice message queued for transcription');
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to queue voice message');
    }
  });
}
