import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

const TMP_DIR = path.join(process.env.TEMP || '/tmp', 'zenvest');

/**
 * Конвертирует PDF в PNG-изображения (по одному на страницу) через pdftoppm.
 * Возвращает массив путей к изображениям.
 */
export async function convertPdfToImages(pdfPath: string): Promise<string[]> {
  const prefix = path.join(TMP_DIR, `pdf_${Date.now()}`);

  await execFileAsync('pdftoppm', [
    '-png',
    '-r', '300',
    pdfPath,
    prefix,
  ]);

  // pdftoppm создаёт файлы: prefix-1.png, prefix-2.png, ...
  // Для одностраничных может быть prefix-1.png или prefix-01.png
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);

  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(base) && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(dir, f));

  if (files.length === 0) {
    throw new Error(`pdftoppm produced no output for ${pdfPath}`);
  }

  logger.debug({ pdfPath, pages: files.length }, 'PDF converted to images');
  return files;
}

/**
 * Удаляет массив временных файлов (best-effort).
 */
export function cleanupFiles(filePaths: string[]): void {
  for (const fp of filePaths) {
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      // best-effort
    }
  }
}
