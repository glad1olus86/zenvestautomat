import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),

  // Telegram
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),

  // PostgreSQL
  databaseUrl: required('DATABASE_URL'),

  // Redis
  redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),

  // Gemini
  geminiApiKey: required('GEMINI_API_KEY'),

  // Google Sheets
  googleServiceAccountJson: optional('GOOGLE_SERVICE_ACCOUNT_JSON', ''),
  googleSheetId: optional('GOOGLE_SHEET_ID', ''),

  // whisper.cpp
  whisperModelPath: optional('WHISPER_MODEL_PATH', './models/ggml-medium.bin'),
  whisperBinaryPath: optional('WHISPER_BINARY_PATH', './whisper.cpp/main'),

  // Приложение
  dailyReportTime: optional('DAILY_REPORT_TIME', '20:00'),
  timezone: optional('TIMEZONE', 'Europe/Prague'),
};
