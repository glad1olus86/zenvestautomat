import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './connection';
import { db } from '../db/knex';
import { transcribe } from '../services/whisper';
import { cleanupFile } from '../utils/downloadFile';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'transcription';

export interface TranscriptionJobData {
  oggPath: string;
  telegramGroupId: string;
  telegramUserId: string;
  userName: string;
  telegramMessageId: number;
  messageDate: string; // YYYY-MM-DD
  projectId: number | null;
}

// Очередь для enqueue из handlers
export const transcriptionQueue = new Queue(QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

// Worker — concurrency=3 (Groq API, не локальный процесс)
export function startTranscriptionWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as TranscriptionJobData;
      const { oggPath, telegramGroupId, telegramUserId, userName, telegramMessageId, messageDate, projectId } = data;

      try {
        logger.info({ jobId: job.id, oggPath }, 'Transcription job started');

        // OGG → текст через Groq Whisper API (конвертация не нужна)
        const transcript = await transcribe(oggPath);

        logger.info({ jobId: job.id, transcriptLength: transcript.length }, 'Transcription successful');

        // Сохраняем в буфер сообщений
        await db('message_buffer').insert({
          project_id: projectId,
          telegram_group_id: telegramGroupId,
          telegram_user_id: telegramUserId,
          user_name: userName,
          message_type: 'voice_transcript',
          content: transcript,
          telegram_message_id: telegramMessageId,
          message_date: messageDate,
        });

        logger.info({ jobId: job.id }, 'Transcript saved to message_buffer');
      } finally {
        // Чистим временный файл
        cleanupFile(oggPath);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job?.id }, 'Transcription job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Transcription job failed');
  });

  logger.info('Transcription worker started (concurrency=3, Groq Whisper API)');
  return worker;
}
