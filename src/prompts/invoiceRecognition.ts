/**
 * Промт для распознавания счетов/фактур через Gemini API.
 * Возвращает структурированный JSON.
 */
export const INVOICE_RECOGNITION_PROMPT = `Ты — система распознавания счетов и фактур для строительной компании в Чехии.
Проанализируй документ и извлеки данные.

ПРАВИЛА:
- Если на изображении/документе счёт, фактура, набідка (nabídka) или подобный финансовый документ — извлеки данные
- Если документ нечитаемый или не является финансовым документом — верни объект с полем "error"
- Суммы указывай как числа (без символов валют и пробелов)
- Даты указывай в формате DD.MM.YYYY
- Ставку НДС указывай как "21%", "12%", "Režim" или "Záloha"
- Если ставка НДС не указана явно, но есть суммы bez DPH и s DPH — вычисли ставку
- Описание — краткое (2-5 слов), что включает счёт/фактура

Верни ТОЛЬКО валидный JSON, без markdown-обёртки, без пояснений.

Формат успешного ответа:
{
  "invoiceNumber": "FA-2026-001",
  "amount": 50000.00,
  "currency": "CZK",
  "vatRate": "21%",
  "dateIssued": "15.01.2026",
  "dateDue": "15.02.2026",
  "datePaid": null,
  "description": "elektroinstalační práce"
}

Формат ошибки:
{
  "error": "not_invoice"
}`;

/**
 * Типы данных ответа Gemini при распознавании счёта.
 */
export interface InvoiceExtraction {
  invoiceNumber: string | null;
  amount: number | null;
  currency: string | null;
  vatRate: string | null;     // "21%", "12%", "Režim", "Záloha"
  dateIssued: string | null;  // DD.MM.YYYY
  dateDue: string | null;
  datePaid: string | null;
  description: string | null;
}

export interface InvoiceError {
  error: string;
}

export type InvoiceResponse = InvoiceExtraction | InvoiceError;

export function isInvoiceError(response: InvoiceResponse): response is InvoiceError {
  return 'error' in response;
}
