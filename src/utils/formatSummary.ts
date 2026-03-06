export interface WorkerHoursEntry {
  workerName: string;
  workerType: string;
  hours: number;
}

/**
 * Форматирует ежедневную финансовую сводку для отправки в Telegram.
 */
export function formatDailySummary(params: {
  projectName: string;
  date: string;
  spentTodayCzk: number;
  spentTotalCzk: number;
  budgetCzk: number;
  remainingCzk: number;
  laborBudgetCzk: number;
  allocatedHours: number;
  spentHours: number;
  remainingHours: number;
  workerHoursToday?: WorkerHoursEntry[];
}): string {
  const lines = [
    `📊 <b>ЕЖЕДНЕВНАЯ СВОДКА — ${params.projectName} — ${params.date}</b>`,
  ];

  // Блок человеко-часов (ручной ввод через /hours)
  if (params.workerHoursToday && params.workerHoursToday.length > 0) {
    lines.push('', '<b>Рабочие часы (сегодня):</b>');

    let totalHours = 0;
    for (const entry of params.workerHoursToday) {
      const icon = entry.workerType === 'helper' ? '🔧' : '👷';
      lines.push(`— ${icon} ${entry.workerName}: ${entry.hours} ч`);
      totalHours += entry.hours;
    }
    lines.push(`— <b>Итого: ${totalHours} ч</b>`);
  }

  // Блок финансов
  lines.push(
    '',
    '<b>Финансы:</b>',
    `— Потрачено сегодня: ${fmt(params.spentTodayCzk)} CZK`,
    `— Итого по объекту: ${fmt(params.spentTotalCzk)} CZK`,
    `— Бюджет материалы: ${fmt(params.budgetCzk)} CZK`,
    `— Остаток материалы: ${fmt(params.remainingCzk)} CZK`,
  );

  if (params.laborBudgetCzk > 0) {
    lines.push(`— Заложено работы: ${fmt(params.laborBudgetCzk)} CZK`);
  }

  // Блок заложенных часов — только если есть данные (GPS отложен)
  if (params.allocatedHours > 0) {
    lines.push(
      '',
      '<b>Часы (план):</b>',
      `— Заложено: ${params.allocatedHours} ч`,
      `— Израсходовано: ${params.spentHours} ч`,
      `— Остаток: ${params.remainingHours} ч`,
    );
  }

  return lines.join('\n');
}

/**
 * Форматирует число с разделителем тысяч.
 */
function fmt(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
