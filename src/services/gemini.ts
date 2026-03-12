import { GoogleGenAI, Part } from '@google/genai';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { convertPdfToImages, cleanupFiles } from '../utils/pdfToImages';
import {
  RECEIPT_RECOGNITION_PROMPT,
  ReceiptResponse,
  ReceiptData,
  isReceiptError,
} from '../prompts/receiptRecognition';
import {
  INVOICE_RECOGNITION_PROMPT,
  InvoiceResponse,
  InvoiceExtraction,
  isInvoiceError,
} from '../prompts/invoiceRecognition';

const MODEL = 'gemini-2.5-flash';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

/**
 * Подготавливает файл(ы) для отправки в Gemini.
 * Если файл — PDF, конвертирует в PNG-изображения.
 * Возвращает массив inlineData parts и пути к temp-файлам для очистки.
 */
async function prepareFileParts(filePath: string): Promise<{
  parts: Part[];
  tempFiles: string[];
}> {
  const ext = filePath.toLowerCase().split('.').pop();
  const isPdf = ext === 'pdf';

  if (isPdf) {
    // Конвертируем PDF в изображения
    const imagePaths = await convertPdfToImages(filePath);

    const parts: Part[] = imagePaths.map((imgPath) => {
      const buffer = fs.readFileSync(imgPath);
      return {
        inlineData: {
          mimeType: 'image/png',
          data: buffer.toString('base64'),
        },
      };
    });

    return { parts, tempFiles: imagePaths };
  }

  // Обычное изображение
  const buffer = fs.readFileSync(filePath);
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  const mimeType = mimeMap[ext || ''] || 'image/jpeg';

  return {
    parts: [{
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    }],
    tempFiles: [],
  };
}

/**
 * Распознаёт чек из изображения или PDF.
 * PDF автоматически конвертируется в изображения (по странице).
 * Возвращает ReceiptData при успехе или null при ошибке.
 */
export async function recognizeReceipt(imagePath: string): Promise<{
  data: ReceiptData | null;
  raw: any;
}> {
  let tempFiles: string[] = [];

  try {
    const prepared = await prepareFileParts(imagePath);
    tempFiles = prepared.tempFiles;

    let lastError: any;

    // 3 попытки с exponential backoff
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: RECEIPT_RECOGNITION_PROMPT },
                ...prepared.parts,
              ],
            },
          ],
        });

        const text = response.text?.trim();

        if (!text) {
          logger.warn({ attempt }, 'Gemini returned empty response for receipt');
          lastError = new Error('Empty response');
          continue;
        }

        // Парсим JSON (убираем markdown-обёртку если есть)
        const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        const parsed: ReceiptResponse = JSON.parse(jsonStr);

        if (isReceiptError(parsed)) {
          logger.info({ error: parsed.error }, 'Receipt not recognized by Gemini');
          return { data: null, raw: parsed };
        }

        // Валидация обязательных полей
        if (!parsed.amount || !parsed.currency) {
          logger.warn({ parsed }, 'Gemini returned incomplete receipt data');
          return { data: null, raw: parsed };
        }

        return { data: parsed, raw: parsed };
      } catch (err: any) {
        lastError = err;
        logger.warn({ attempt, err: err.message }, 'Gemini receipt recognition attempt failed');

        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    logger.error({ err: lastError }, 'Gemini receipt recognition failed after 3 attempts');
    return { data: null, raw: { error: lastError?.message } };
  } finally {
    cleanupFiles(tempFiles);
  }
}

/**
 * Суммаризирует массив сообщений в суточный отчёт.
 */
export async function summarizeMessages(
  messages: { userName: string; content: string }[],
  projectName: string,
  date: string
): Promise<{
  reportText: string;
  doneBlock: string;
  requiredBlock: string;
  plannedBlock: string;
} | null> {
  const messageList = messages
    .map((m) => `[${m.userName}]: ${m.content}`)
    .join('\n');

  const prompt = `Ты — ассистент для строительной компании. Суммаризируй сообщения рабочей группы за день в структурированный отчёт.

Объект: ${projectName}
Дата: ${date}

Сообщения за день:
${messageList}

Создай отчёт СТРОГО по шаблону (на русском языке):

СУТОЧНЫЙ ОТЧЁТ — ${projectName} — ${date}

Что сделано:
— (перечисли выполненные работы)

Что требуется (дедлайн):
— (перечисли что нужно, с датами в формате до ДД.ММ если указаны)

Что планируется:
— (перечисли планы на ближайшее время)

Если какой-то блок пустой (нет информации) — напиши "— нет данных".
Будь краток, используй маркированные списки.`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const text = response.text?.trim();
    if (!text) return null;

    // Парсим блоки
    const doneMatch = text.match(/Что сделано:\s*\n([\s\S]*?)(?=\nЧто требуется)/i);
    const requiredMatch = text.match(/Что требуется[^:]*:\s*\n([\s\S]*?)(?=\nЧто планируется)/i);
    const plannedMatch = text.match(/Что планируется:\s*\n([\s\S]*?)$/i);

    return {
      reportText: text,
      doneBlock: doneMatch?.[1]?.trim() || '— нет данных',
      requiredBlock: requiredMatch?.[1]?.trim() || '— нет данных',
      plannedBlock: plannedMatch?.[1]?.trim() || '— нет данных',
    };
  } catch (err) {
    logger.error({ err }, 'Gemini summarization failed');
    return null;
  }
}

/**
 * Распознаёт счёт/фактуру из изображения или PDF.
 * PDF автоматически конвертируется в изображения (по странице).
 * Возвращает InvoiceExtraction при успехе или null при ошибке.
 */
export async function recognizeInvoice(filePath: string): Promise<{
  data: InvoiceExtraction | null;
  raw: any;
}> {
  let tempFiles: string[] = [];

  try {
    const prepared = await prepareFileParts(filePath);
    tempFiles = prepared.tempFiles;

    let lastError: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: INVOICE_RECOGNITION_PROMPT },
                ...prepared.parts,
              ],
            },
          ],
        });

        const text = response.text?.trim();

        if (!text) {
          logger.warn({ attempt }, 'Gemini returned empty response for invoice');
          lastError = new Error('Empty response');
          continue;
        }

        const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        const parsed: InvoiceResponse = JSON.parse(jsonStr);

        if (isInvoiceError(parsed)) {
          logger.info({ error: parsed.error }, 'Invoice not recognized by Gemini');
          return { data: null, raw: parsed };
        }

        return { data: parsed as InvoiceExtraction, raw: parsed };
      } catch (err: any) {
        lastError = err;
        logger.warn({ attempt, err: err.message }, 'Gemini invoice recognition attempt failed');

        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    logger.error({ err: lastError }, 'Gemini invoice recognition failed after 3 attempts');
    return { data: null, raw: { error: lastError?.message } };
  } finally {
    cleanupFiles(tempFiles);
  }
}
