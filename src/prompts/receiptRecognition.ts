/**
 * Промт для распознавания чека через Gemini API.
 * Возвращает структурированный JSON.
 */
export const RECEIPT_RECOGNITION_PROMPT = `Ты — система распознавания чеков. Проанализируй изображение чека и извлеки данные.

ПРАВИЛА:
- Если на изображении чек или квитанция — извлеки данные
- Если изображение нечитаемое или это не чек — верни объект с полем "error"
- Суммы указывай как числа (без символов валют)
- Дату указывай в формате YYYY-MM-DD
- Категорию определи из списка: материалы, инструменты, транспорт, питание, аренда, услуги, прочее
- Описание — краткое (1-2 слова), что было куплено

Верни ТОЛЬКО валидный JSON, без markdown-обёртки, без пояснений.

Формат успешного ответа:
{
  "amount": 1250.50,
  "currency": "CZK",
  "date": "2026-03-03",
  "category": "материалы",
  "description": "шурупы, дюбели",
  "shop": "Hornbach"
}

Формат ошибки:
{
  "error": "unreadable"
}`;

/**
 * Типы данных ответа Gemini при распознавании чека.
 */
export interface ReceiptData {
  amount: number;
  currency: string;
  date: string;
  category: string;
  description: string;
  shop: string;
}

export interface ReceiptError {
  error: string;
}

export type ReceiptResponse = ReceiptData | ReceiptError;

export function isReceiptError(response: ReceiptResponse): response is ReceiptError {
  return 'error' in response;
}
