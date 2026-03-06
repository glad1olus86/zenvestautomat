import { Api } from 'grammy';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { logger } from './logger';

const TMP_DIR = path.join(process.env.TEMP || '/tmp', 'zenvest');

// Создаём tmp директорию при загрузке модуля
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * Скачивает файл из Telegram по file_id.
 * Возвращает путь к скачанному файлу.
 */
export async function downloadTelegramFile(
  api: Api,
  fileId: string,
  extension: string
): Promise<string> {
  const file = await api.getFile(fileId);

  if (!file.file_path) {
    throw new Error(`No file_path for file_id: ${fileId}`);
  }

  const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
  const filename = `${fileId}_${Date.now()}${extension}`;
  const destPath = path.join(TMP_DIR, filename);

  await downloadUrl(url, destPath);

  logger.debug({ fileId, destPath, size: fs.statSync(destPath).size }, 'File downloaded');
  return destPath;
}

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const fileStream = fs.createWriteStream(dest);

    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        fileStream.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }

      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
    }).on('error', (err) => {
      fileStream.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/**
 * Удаляет временный файл (best-effort).
 */
export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to cleanup temp file');
  }
}
