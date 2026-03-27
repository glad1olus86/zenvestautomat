/**
 * Промт для распознавания чека через Gemini API.
 * Возвращает структурированный JSON.
 */
export const RECEIPT_RECOGNITION_PROMPT = `Ты — система распознавания чеков. Проанализируй изображение чека и извлеки данные.

ПРАВИЛА:
- Если на изображении чек или квитанция — извлеки данные
- Если изображение нечитаемое или это не чек — верни объект с полем "error"
- ВАЖНО: amount — это ВСЕГДА сумма БЕЗ НДС (bez DPH / without VAT). Если на чеке указана только итоговая сумма с НДС — вычти НДС. Стандартные ставки НДС в Чехии: 21%, 12%. Если ставка НДС видна на чеке — используй её. Если не видна — предполагай 21%.
- Суммы указывай как числа (без символов валют)
- Дату указывай в формате YYYY-MM-DD
- Категорию определи из списка: материалы, инструменты, транспорт, питание, аренда, услуги, прочее
- Описание — краткое (1-2 слова), что было куплено

Верни ТОЛЬКО валидный JSON, без markdown-обёртки, без пояснений.

Формат успешного ответа:
{
  "amount": 1033.47,
  "amount_with_vat": 1250.50,
  "vat_rate": 21,
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
  amount: number;          // сумма БЕЗ НДС (bez DPH)
  amount_with_vat?: number; // сумма С НДС (s DPH)
  vat_rate?: number;        // ставка НДС (21, 12, ...)
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
