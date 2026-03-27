// ─── Типы ───

export interface ParsedReport {
  doneBlock: string | null;
  problemsBlock: string | null;
  extraWorkBlock: string | null;
  needToOrderBlock: string | null;
  planTomorrowBlock: string | null;
}

export interface ExtractedTask {
  description: string;
  sourceSection: 'need_to_order' | 'extra_work' | 'plan_tomorrow';
}

// ─── Секции и их regex ───

interface SectionDef {
  key: keyof ParsedReport;
  pattern: RegExp;
}

const SECTIONS: SectionDef[] = [
  { key: 'doneBlock',          pattern: /(?:сделано|выполнено)\s*:?/i },
  { key: 'problemsBlock',      pattern: /(?:проблем[аы]|вопрос[аы])\s*:?/i },
  { key: 'extraWorkBlock',     pattern: /(?:доп\.?\s*работ[аы]?|дополнительн[аыо][еяй]?\s*работ[аы]?)\s*:?/i },
  { key: 'needToOrderBlock',   pattern: /(?:нужно\s*заказать|заказать|закупк[аи])\s*:?/i },
  { key: 'planTomorrowBlock',  pattern: /(?:план\s*(?:на\s*)?завтра|планы|план\s*на\s*следующий\s*день)\s*:?/i },
];

// ─── Парсер ───

/**
 * Парсит REPORT-сообщение в структурированные секции.
 * Возвращает null если ни одна секция не найдена.
 */
export function parseReportMessage(text: string): ParsedReport | null {
  // Убираем ключевое слово REPORT/РЕПОРТ из начала
  const body = text.replace(/^\s*(?:REPORT|РЕПОРТ)\s*/i, '').trim();
  if (!body) return null;

  // Находим позиции всех секций
  const found: { key: keyof ParsedReport; start: number; headerEnd: number }[] = [];

  for (const section of SECTIONS) {
    const match = section.pattern.exec(body);
    if (match) {
      found.push({
        key: section.key,
        start: match.index,
        headerEnd: match.index + match[0].length,
      });
    }
  }

  // Если ни одна секция не найдена — считаем весь текст блоком "Сделано"
  if (found.length === 0) {
    return {
      doneBlock: body,
      problemsBlock: null,
      extraWorkBlock: null,
      needToOrderBlock: null,
      planTomorrowBlock: null,
    };
  }

  // Сортируем по позиции
  found.sort((a, b) => a.start - b.start);

  // Извлекаем контент каждой секции (от конца заголовка до начала следующей)
  const result: ParsedReport = {
    doneBlock: null,
    problemsBlock: null,
    extraWorkBlock: null,
    needToOrderBlock: null,
    planTomorrowBlock: null,
  };

  for (let i = 0; i < found.length; i++) {
    const nextStart = i + 1 < found.length ? found[i + 1].start : body.length;
    const content = body.slice(found[i].headerEnd, nextStart).trim();
    if (content) {
      result[found[i].key] = content;
    }
  }

  return result;
}

// ─── Экстрактор задач ───

/**
 * Извлекает задачи из секций «Нужно заказать» и «Доп. работы».
 * Каждая строка (с маркером - или * или цифрой) = одна задача.
 */
export function extractTasks(report: ParsedReport): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];

  const extractFromBlock = (
    block: string | null,
    source: ExtractedTask['sourceSection'],
  ) => {
    if (!block) return;
    const lines = block.split('\n');
    for (const line of lines) {
      // Убираем маркеры: -, *, 1., 2) и т.д.
      const cleaned = line.replace(/^\s*[-*•]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
      if (cleaned.length > 0) {
        tasks.push({ description: cleaned, sourceSection: source });
      }
    }
  };

  extractFromBlock(report.needToOrderBlock, 'need_to_order');
  extractFromBlock(report.extraWorkBlock, 'extra_work');
  extractFromBlock(report.planTomorrowBlock, 'plan_tomorrow');

  return tasks;
}
