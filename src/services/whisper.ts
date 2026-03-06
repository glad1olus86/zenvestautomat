import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Транскрибирует аудиофайл через Groq Whisper Large V3 API.
 * Принимает OGG/WAV/MP3 — конвертация не нужна.
 * Возвращает текст транскрипции.
 */
export async function transcribe(audioPath: string): Promise<string> {
  if (!config.groqApiKey) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = path.basename(audioPath);
  const ext = path.extname(audioPath).toLowerCase();

  const mimeMap: Record<string, string> = {
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/m4a',
    '.webm': 'audio/webm',
  };
  const mimeType = mimeMap[ext] || 'audio/ogg';

  const blob = new Blob([fileBuffer], { type: mimeType });
  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'ru');

  logger.info({ audioPath, size: fileBuffer.length }, 'Starting Groq Whisper transcription...');
  const startTime = Date.now();

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.groqApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errBody}`);
  }

  const result = await response.json() as { text: string };
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.info({ audioPath, elapsed: `${elapsed}s`, textLength: result.text.length }, 'Groq transcription complete');

  const text = result.text.trim();
  if (!text) {
    throw new Error('Groq returned empty transcription');
  }

  return text;
}
