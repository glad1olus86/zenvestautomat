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
  geminiModel: optional('GEMINI_MODEL', 'gemini-2.5-flash'),

  // Google Sheets
  googleServiceAccountJson: optional('GOOGLE_SERVICE_ACCOUNT_JSON', ''),
  googleSheetId: optional('GOOGLE_SHEET_ID', ''),

  // Groq (Whisper STT)
  groqApiKey: optional('GROQ_API_KEY', ''),

  // Google Drive (пустой = отключен)
  googleDriveEnabled: optional('GOOGLE_DRIVE_ENABLED', 'true'),
  googleDriveFolderId: optional('GOOGLE_DRIVE_FOLDER_ID', ''),

  // Группа руководства (алерты о пропущенных отчётах)
  managementGroupId: optional('MANAGEMENT_GROUP_ID', ''),
  managementTopicId: optional('MANAGEMENT_TOPIC_ID', ''),

  // Приложение
  dailyReportTime: optional('DAILY_REPORT_TIME', '20:00'),
  reportReminderTime: optional('REPORT_REMINDER_TIME', '18:00'),
  timezone: optional('TIMEZONE', 'Europe/Prague'),
};
