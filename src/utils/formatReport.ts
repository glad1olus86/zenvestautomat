/**
 * Форматирует суточный отчёт для отправки в Telegram.
 */
export function formatDailyReport(params: {
  projectName: string;
  date: string;
  doneBlock: string;
  requiredBlock: string;
  plannedBlock: string;
}): string {
  return [
    `📋 <b>СУТОЧНЫЙ ОТЧЁТ — ${params.projectName} — ${params.date}</b>`,
    '',
    '<b>Что сделано:</b>',
    params.doneBlock,
    '',
    '<b>Что требуется (дедлайн):</b>',
    params.requiredBlock,
    '',
    '<b>Что планируется:</b>',
    params.plannedBlock,
  ].join('\n');
}

/**
 * Форматирует блок "Что требуется" для топика "Актуальные вопросы".
 */
export function formatRequiredBlock(params: {
  projectName: string;
  date: string;
  requiredBlock: string;
}): string {
  return [
    `🔔 <b>Актуальные вопросы — ${params.projectName} — ${params.date}</b>`,
    '',
    params.requiredBlock,
  ].join('\n');
}
