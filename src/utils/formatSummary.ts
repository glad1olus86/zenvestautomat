export interface WorkerHoursEntry {
  workerName: string;
  workerType: string;
  hours: number;
  hourlyRate?: number;
  cost?: number;          // hours × hourlyRate
  source?: 'gps' | 'manual';
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
  spentLaborCzk: number;
  remainingLaborCzk: number;
  workerHoursToday?: WorkerHoursEntry[];
}): string {
  const lines = [
    `📊 <b>ЕЖЕДНЕВНАЯ СВОДКА — ${params.projectName} — ${params.date}</b>`,
  ];

  // Блок человеко-часов (GPS + ручной ввод) с расчётом стоимости
  if (params.workerHoursToday && params.workerHoursToday.length > 0) {
    lines.push('', '<b>Рабочие часы (сегодня):</b>');

    let totalHours = 0;
    let totalCost = 0;
    for (const entry of params.workerHoursToday) {
      const typeIcon = entry.workerType === 'helper' ? '🔧' : '👷';
      const sourceIcon = entry.source === 'gps' ? ' 📡' : entry.source === 'manual' ? ' ✏️' : '';
      const costStr = entry.cost ? ` → ${fmt(entry.cost)} CZK` : '';
      lines.push(`— ${typeIcon} ${entry.workerName}: ${entry.hours} ч${sourceIcon}${costStr}`);
      totalHours += entry.hours;
      totalCost += entry.cost || 0;
    }
    lines.push(`— <b>Итого: ${totalHours} ч → ${fmt(totalCost)} CZK</b>`);
  }

  // Блок финансов — материалы
  lines.push(
    '',
    '<b>Материалы:</b>',
    `— Потрачено сегодня: ${fmt(params.spentTodayCzk)} CZK`,
    `— Итого по объекту: ${fmt(params.spentTotalCzk)} CZK`,
    `— Бюджет: ${fmt(params.budgetCzk)} CZK`,
    `— Остаток: ${fmt(params.remainingCzk)} CZK`,
  );

  // Блок финансов — работы
  if (params.laborBudgetCzk > 0 || params.spentLaborCzk > 0) {
    lines.push(
      '',
      '<b>Работы:</b>',
      `— Заложено: ${fmt(params.laborBudgetCzk)} CZK`,
      `— Израсходовано: ${fmt(params.spentLaborCzk)} CZK`,
      `— Остаток: ${fmt(params.remainingLaborCzk)} CZK`,
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
