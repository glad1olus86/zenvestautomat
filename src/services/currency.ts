import { db } from '../db/knex';
import { logger } from '../utils/logger';

const FRANKFURTER_BASE = 'https://api.frankfurter.app';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

interface ConversionResult {
  amountCzk: number;
  rate: number;
}

/**
 * Конвертирует сумму из указанной валюты в CZK.
 * Курсы кэшируются в БД на 24 часа (данные ЕЦБ обновляются раз в день).
 */
export async function convertToCZK(
  amount: number,
  fromCurrency: string
): Promise<ConversionResult> {
  const currency = fromCurrency.toUpperCase();

  // CZK → CZK — без конвертации
  if (currency === 'CZK') {
    return { amountCzk: amount, rate: 1 };
  }

  // Проверяем кэш
  const cached = await db('currency_cache')
    .where({ from_currency: currency, to_currency: 'CZK' })
    .first();

  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < CACHE_TTL_MS) {
      const rate = parseFloat(cached.rate);
      return { amountCzk: round(amount * rate), rate };
    }
  }

  // Запрашиваем свежий курс
  const rate = await fetchRate(currency, 'CZK');

  // Сохраняем в кэш (upsert)
  await db('currency_cache')
    .insert({
      from_currency: currency,
      to_currency: 'CZK',
      rate,
      fetched_at: new Date(),
    })
    .onConflict(['from_currency', 'to_currency'])
    .merge({
      rate,
      fetched_at: new Date(),
    });

  return { amountCzk: round(amount * rate), rate };
}

async function fetchRate(from: string, to: string): Promise<number> {
  const url = `${FRANKFURTER_BASE}/latest?from=${from}&to=${to}`;

  logger.info({ from, to, url }, 'Fetching exchange rate');

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Frankfurter API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    rates: Record<string, number>;
  };

  const rate = data.rates[to];

  if (!rate) {
    throw new Error(`No rate found for ${from} → ${to}`);
  }

  logger.info({ from, to, rate }, 'Exchange rate fetched');
  return rate;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
