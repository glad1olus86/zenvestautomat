import { google, drive_v3 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

let driveClient: drive_v3.Drive | null = null;
let rootFolderId: string = '';

// Кэш подпапок: projectName → folderId
const folderCache = new Map<string, string>();

/**
 * Инициализирует Google Drive API.
 * Реиспользует тот же service account, что и Sheets.
 */
export async function initDrive(): Promise<boolean> {
  if (!config.googleServiceAccountJson || !config.googleDriveFolderId) {
    logger.warn('Google Drive not configured — upload disabled');
    return false;
  }

  if (!fs.existsSync(config.googleServiceAccountJson)) {
    logger.warn({ path: config.googleServiceAccountJson }, 'Service account JSON not found — Drive disabled');
    return false;
  }

  try {
    const auth = new GoogleAuth({
      keyFile: config.googleServiceAccountJson,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    driveClient = google.drive({ version: 'v3', auth });
    rootFolderId = config.googleDriveFolderId;

    logger.info('Google Drive initialized');
    return true;
  } catch (err) {
    logger.error({ err }, 'Google Drive initialization failed');
    return false;
  }
}

/**
 * Проверяет, инициализирован ли Drive клиент.
 */
export function isDriveEnabled(): boolean {
  return driveClient !== null;
}

/**
 * Загружает файл на Google Drive в подпапку проекта.
 * Поддерживает Shared Drives (supportsAllDrives).
 * Возвращает webViewLink (ссылку для просмотра).
 */
export async function uploadFileToDrive(
  filePath: string,
  fileName: string,
  projectName: string,
): Promise<string | null> {
  if (!driveClient) return null;

  try {
    // Находим или создаём подпапку проекта
    const folderId = await ensureProjectFolder(projectName);

    // Определяем MIME тип
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    const response = await driveClient.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType,
        body: fs.createReadStream(filePath),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    });

    const webViewLink = response.data.webViewLink || null;

    logger.debug({ fileName, projectName, webViewLink }, 'File uploaded to Drive');
    return webViewLink;
  } catch (err) {
    logger.error({ err, filePath, projectName }, 'Failed to upload file to Drive');
    return null;
  }
}

/**
 * Скачивает файл с Google Drive по URL во временную папку.
 * Возвращает путь к скачанному файлу.
 */
export async function downloadFromDriveUrl(url: string): Promise<string | null> {
  if (!driveClient) return null;

  try {
    const fileId = parseDriveFileId(url);
    if (!fileId) {
      logger.warn({ url }, 'Could not parse Google Drive file ID from URL');
      return null;
    }

    // Получаем метаданные файла
    const metaResp = await driveClient.files.get({
      fileId,
      fields: 'name,mimeType',
      supportsAllDrives: true,
    });

    const fileName = metaResp.data.name || 'document';
    const ext = path.extname(fileName) || mimeToExt(metaResp.data.mimeType || '');

    // Скачиваем файл
    const tmpDir = path.join(process.env.TEMP || '/tmp', 'zenvest');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const destPath = path.join(tmpDir, `drive_${fileId}_${Date.now()}${ext}`);

    const response = await driveClient.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );

    await new Promise<void>((resolve, reject) => {
      const dest = fs.createWriteStream(destPath);
      (response.data as NodeJS.ReadableStream)
        .pipe(dest)
        .on('finish', resolve)
        .on('error', reject);
    });

    logger.debug({ fileId, destPath }, 'File downloaded from Drive');
    return destPath;
  } catch (err) {
    logger.error({ err, url }, 'Failed to download file from Drive');
    return null;
  }
}

// ─── Вспомогательные ───

/**
 * Находит или создаёт подпапку проекта в корневой папке Drive.
 * Поддерживает Shared Drives.
 */
async function ensureProjectFolder(projectName: string): Promise<string> {
  // Проверяем кэш
  const cached = folderCache.get(projectName);
  if (cached) return cached;

  const client = driveClient!;

  // Ищем существующую папку (includeItemsFromAllDrives для Shared Drives)
  const searchResp = await client.files.list({
    q: `name='${projectName.replace(/'/g, "\\'")}' and '${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });

  if (searchResp.data.files && searchResp.data.files.length > 0) {
    const folderId = searchResp.data.files[0].id!;
    folderCache.set(projectName, folderId);
    return folderId;
  }

  // Создаём новую папку
  const createResp = await client.files.create({
    requestBody: {
      name: projectName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const folderId = createResp.data.id!;
  folderCache.set(projectName, folderId);

  logger.info({ projectName, folderId }, 'Project folder created on Drive');
  return folderId;
}

/**
 * Парсит file ID из Google Drive URL.
 * Поддерживает форматы:
 *   https://drive.google.com/file/d/{id}/view
 *   https://drive.google.com/open?id={id}
 *   https://docs.google.com/document/d/{id}/edit
 */
function parseDriveFileId(url: string): string | null {
  // /d/{id}/ pattern
  const match1 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match1) return match1[1];

  // ?id={id} pattern
  const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match2) return match2[1];

  return null;
}

/**
 * Определяет расширение файла по MIME типу.
 */
function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  return map[mimeType] || '';
}
