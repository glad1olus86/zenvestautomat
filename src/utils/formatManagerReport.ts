/**
 * Форматирует REPORT менеджера для отправки в Telegram (ежедневный отчёт).
 */
export function formatManagerDailyReport(params: {
  projectName: string;
  date: string;
  managerName: string;
  doneBlock: string | null;
  problemsBlock: string | null;
  extraWorkBlock: string | null;
  needToOrderBlock: string | null;
  plannedBlock: string | null;
  messageLink: string | null;
}): string {
  const lines = [
    `📋 <b>СУТОЧНЫЙ ОТЧЁТ — ${params.projectName} — ${params.date}</b>`,
    `👷 Менеджер: ${params.managerName}`,
  ];

  lines.push('', '<b>Что сделано:</b>');
  lines.push(params.doneBlock || '— нет данных');

  if (params.problemsBlock) {
    lines.push('', '<b>Проблемы:</b>');
    lines.push(params.problemsBlock);
  }

  if (params.extraWorkBlock) {
    lines.push('', '<b>Доп. работы:</b>');
    lines.push(params.extraWorkBlock);
  }

  if (params.needToOrderBlock) {
    lines.push('', '<b>Нужно заказать:</b>');
    lines.push(params.needToOrderBlock);
  }

  lines.push('', '<b>Что планируется:</b>');
  lines.push(params.plannedBlock || '— нет данных');

  if (params.messageLink) {
    lines.push('', `<a href="${params.messageLink}">Оригинал отчёта</a>`);
  }

  return lines.join('\n');
}
