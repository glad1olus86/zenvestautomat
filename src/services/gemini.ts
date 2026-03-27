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
import {
  ISSUE_DIALOG_SYSTEM_PROMPT,
  IssueDialogResponse,
} from '../prompts/issueFormatting';
import {
  CORRECTION_FORMATTING_PROMPT,
  PHOTO_DESCRIPTION_PROMPT,
  CorrectionFormatted,
} from '../prompts/correctionFormatting';

const MODEL = config.geminiModel;

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
 * Парсит REPORT менеджера через AI: свободный текст → структурированный JSON.
 */
export async function parseManagerReport(text: string): Promise<{
  doneBlock: string | null;
  problemsBlock: string | null;
  extraWorkBlock: string | null;
  needToOrderBlock: string | null;
  planTomorrowBlock: string | null;
} | null> {
  const prompt = `Ты — ассистент строительной компании. Менеджер объекта прислал ежедневный отчёт (REPORT).
Разбей текст на секции и верни СТРОГО JSON без markdown-обёртки.

Секции:
- doneBlock — что уже сделано/выполнено СЕГОДНЯ (прошедшее время)
- problemsBlock — проблемы, вопросы, сложности, нехватка чего-то
- extraWorkBlock — дополнительные/непредвиденные работы, доработки
- needToOrderBlock — что нужно заказать, купить, закупить, починить, исправить — ЛЮБЫЕ действия которые нужно выполнить
- planTomorrowBlock — план на завтра, что планируется делать

Правила:
- Если секция отсутствует в тексте — поставь null
- Сохраняй оригинальный текст менеджера, не переписывай
- Каждый пункт списка начинай с новой строки и дефиса "— "
- Если менеджер не использовал точные заголовки секций — ОПРЕДЕЛИ ПО СМЫСЛУ в какую секцию отнести
- ВАЖНО: если текст описывает действие которое НУЖНО сделать (починить, заказать, купить, установить, привезти, вызвать, найти) — это needToOrderBlock, НЕ doneBlock
- doneBlock — ТОЛЬКО то что УЖЕ завершено (прошедшее время: сделали, установили, проложили)
- Даже короткий REPORT из одной строки нужно правильно классифицировать по смыслу

Пример полного REPORT:
{"doneBlock":"— монтаж отопления этаж 1\\n— прокладка труб","problemsBlock":"— нет радиаторов","extraWorkBlock":"— перенос трассы","needToOrderBlock":"— кран","planTomorrowBlock":"— монтаж котельной"}

Пример короткого REPORT "починить кран":
{"doneBlock":null,"problemsBlock":null,"extraWorkBlock":null,"needToOrderBlock":"— починить кран","planTomorrowBlock":null}

Пример "сделали разводку, нужен кран завтра":
{"doneBlock":"— сделали разводку","problemsBlock":null,"extraWorkBlock":null,"needToOrderBlock":"— кран","planTomorrowBlock":null}

Текст REPORT:
${text}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const raw = response.text?.trim();
    if (!raw) {
      logger.warn('Gemini returned empty response for REPORT parsing');
      return null;
    }

    const jsonStr = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr);

    // Проверяем что хотя бы одна секция не null
    const hasContent = parsed.doneBlock || parsed.problemsBlock ||
      parsed.extraWorkBlock || parsed.needToOrderBlock || parsed.planTomorrowBlock;

    if (!hasContent) return null;

    return {
      doneBlock: parsed.doneBlock || null,
      problemsBlock: parsed.problemsBlock || null,
      extraWorkBlock: parsed.extraWorkBlock || null,
      needToOrderBlock: parsed.needToOrderBlock || null,
      planTomorrowBlock: parsed.planTomorrowBlock || null,
    };
  } catch (err) {
    logger.error({ err }, 'Gemini REPORT parsing failed');
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

/**
 * Анализирует диалог для формирования «Актуального вопроса».
 * Возвращает incomplete (с уточняющим вопросом) или complete (с готовым текстом).
 */
export async function analyzeIssueDialog(
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  projectName: string,
): Promise<IssueDialogResponse | null> {
  const historyText = conversationHistory
    .map((m) => `[${m.role === 'user' ? 'Сотрудник' : 'Ассистент'}]: ${m.content}`)
    .join('\n');

  const prompt = `${ISSUE_DIALOG_SYSTEM_PROMPT}\n\nОбъект: ${projectName}\n\nИстория диалога:\n${historyText}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });

      const text = response.text?.trim();
      if (!text) {
        logger.warn({ attempt }, 'Gemini returned empty response for issue dialog');
        continue;
      }

      const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      return JSON.parse(jsonStr) as IssueDialogResponse;
    } catch (err: any) {
      logger.warn({ attempt, err: err.message }, 'Gemini issue dialog attempt failed');
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  logger.error('Gemini issue dialog analysis failed after 3 attempts');
  return null;
}

/**
 * Описывает фотографию строительного объекта для выявления дефектов.
 */
export async function describePhoto(imagePath: string): Promise<string | null> {
  let tempFiles: string[] = [];

  try {
    const prepared = await prepareFileParts(imagePath);
    tempFiles = prepared.tempFiles;

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: PHOTO_DESCRIPTION_PROMPT },
            ...prepared.parts,
          ],
        },
      ],
    });

    return response.text?.trim() || null;
  } catch (err) {
    logger.error({ err }, 'Gemini photo description failed');
    return null;
  } finally {
    cleanupFiles(tempFiles);
  }
}

/**
 * Формирует структурированное сообщение о правках объекта.
 */
export async function formatCorrection(
  photoDescriptions: string[],
  voiceTranscript: string | null,
  textInput: string | null,
  editRequest?: string | null,
): Promise<CorrectionFormatted | null> {
  const parts: string[] = [];

  if (photoDescriptions.length > 0) {
    parts.push(`Описания фотографий:\n${photoDescriptions.map((d, i) => `Фото ${i + 1}: ${d}`).join('\n')}`);
  }
  if (voiceTranscript) {
    parts.push(`Транскрипция голосового сообщения менеджера:\n${voiceTranscript}`);
  }
  if (textInput) {
    parts.push(`Текстовое описание менеджера:\n${textInput}`);
  }
  if (editRequest) {
    parts.push(`ЗАПРОС НА РЕДАКТИРОВАНИЕ: Менеджер просит изменить результат следующим образом:\n${editRequest}\n\nУчти этот запрос при формировании ответа.`);
  }

  const prompt = `${CORRECTION_FORMATTING_PROMPT}\n\nВходные данные:\n${parts.join('\n\n')}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });

      const text = response.text?.trim();
      if (!text) {
        logger.warn({ attempt }, 'Gemini returned empty response for correction');
        continue;
      }

      const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      return JSON.parse(jsonStr) as CorrectionFormatted;
    } catch (err: any) {
      logger.warn({ attempt, err: err.message }, 'Gemini correction formatting attempt failed');
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  logger.error('Gemini correction formatting failed after 3 attempts');
  return null;
}
