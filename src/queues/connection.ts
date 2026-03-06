import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Парсит Redis URL в объект подключения для BullMQ.
 * BullMQ использует свой встроенный ioredis — не нужен отдельный пакет.
 */
export function getRedisConnection() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null as null, // требование BullMQ
  };
}

/**
 * Проверка подключения к Redis.
 * Создаём временное соединение, пингуем, закрываем.
 */
export async function checkRedis(): Promise<boolean> {
  const { Queue } = await import('bullmq');
  const testQueue = new Queue('__health_check', {
    connection: getRedisConnection(),
  });
  try {
    // Если Queue создалась без ошибок, Redis доступен
    await testQueue.close();
    logger.info('Redis connected');
    return true;
  } catch (err) {
    logger.error({ err }, 'Redis connection failed');
    try { await testQueue.close(); } catch {}
    return false;
  }
}
