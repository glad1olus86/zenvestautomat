import { google, sheets_v4 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../config';
import { db } from '../db/knex';
import { logger } from '../utils/logger';
import fs from 'fs';

let sheetsClient: sheets_v4.Sheets | null = null;
let spreadsheetId: string = '';

// ─── Разделитель аргументов формул (зависит от локали таблицы) ───
let formulaSep = ',';

/**
 * Конвертирует формулу из английского синтаксиса (запятые) в синтаксис локали таблицы.
 * Простая замена "," → ";" для европейских локалей.
 * Работает корректно для наших формул (нет запятых внутри строковых литералов).
 */
function loc(formula: string): string {
  if (formulaSep === ',') return formula;
  return formula.replace(/,/g, formulaSep);
}

// ─── Константы макета (по формату primer.xlsx) ───

/**
 *  R01:  Číslo nabídky / faktury | Согласовано | Částka celkem bez DPH | Sazba DPH | Castka celkem s DPH | Zbývá uhradít | Datum vystavení | Datum splatnosti | Datum zaplacení | Zaplaceno
 *  R02–R08:  Данные счетов (ручной ввод через Sheets)
 *  R09–R10:  пусто
 *  R11:  Название акции | Сумма на материал (план) | Фактическая закупка | Разница | Заложено работы | Фактически работа | Разница
 *  R12:  <имя> | budget | spent | diff | labor_budget | labor_spent | labor_diff
 *  R13:  ... | ... | ... | ... | часы | часы | остаток ч | ... | ... | ... | ... | часы отработанные <объект> | | | total_zp
 *  R14:  ... | ... | ... | ... | plan_h | fact_h | remain_h | ... | ... | ... | ... | техник | почасовая | часы | зп
 *  R15:  (пусто / первый работник в L-O)
 *  R16:  Дата | Поставщик | Материал | Количество | Цена за шт | Общая сумма bez DPH
 *  R17+: данные чеков
 */

const INVOICE_HEADERS_ROW = 1;
const BUDGET_HEADERS_ROW = 11;
const BUDGET_DATA_ROW = 12;
const HOURS_META_ROW = 13;
const HOURS_HEADERS_ROW = 14;
const FIRST_WORKER_ROW = 15;
const RECEIPT_HEADERS_ROW = 16;
const FIRST_RECEIPT_ROW = 17;

// Колонки для часов (0-indexed): L=11, M=12, N=13, O=14
const HOURS_COL_START = 'L';

const SUMMARY_SHEET = 'Сводка';

// ─── Инициализация ───

export async function initSheets(): Promise<boolean> {
  if (!config.googleServiceAccountJson || !config.googleSheetId) {
    logger.warn('Google Sheets not configured — sync disabled');
    return false;
  }

  if (!fs.existsSync(config.googleServiceAccountJson)) {
    logger.warn({ path: config.googleServiceAccountJson }, 'Service account JSON not found — sync disabled');
    return false;
  }

  try {
    const auth = new GoogleAuth({
      keyFile: config.googleServiceAccountJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
    spreadsheetId = config.googleSheetId;

    // Определяем локаль таблицы → разделитель аргументов формул
    const propsResp = await sheetsClient.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.locale',
    });
    const locale = propsResp.data.properties?.locale || 'en_US';
    // Европейские локали используют ";" (десятичный разделитель — запятая)
    const semiLocales = /^(cs|sk|de|fr|es|it|pt|nl|pl|ru|uk|bg|hr|da|fi|el|hu|lt|lv|nb|no|ro|sl|sv|tr|et|vi)/;
    formulaSep = semiLocales.test(locale) ? ';' : ',';
    logger.info({ locale, formulaSep }, 'Spreadsheet locale detected');

    // Убеждаемся что лист «Сводка» существует
    await ensureSummarySheet();

    // Создаём листы для всех уже зарегистрированных проектов
    const projects = await db('projects').select('id', 'name');
    for (const project of projects) {
      await ensureProjectSheet(project.name);
    }

    logger.info('Google Sheets initialized');
    return true;
  } catch (err) {
    logger.error({ err }, 'Google Sheets initialization failed');
    return false;
  }
}

function getClient(): sheets_v4.Sheets {
  if (!sheetsClient) {
    throw new Error('Sheets client not initialized');
  }
  return sheetsClient;
}

// ─── Создание листа проекта ───

/**
 * Создаёт лист для проекта с шаблоном из primer.xlsx.
 * Если лист уже существует — ничего не делает.
 */
export async function ensureProjectSheet(projectName: string): Promise<void> {
  if (!sheetsClient) return;

  const client = getClient();

  // Проверяем, существует ли лист
  const meta = await client.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });

  const existingSheets = new Set(
    meta.data.sheets?.map((s) => s.properties?.title) || []
  );

  if (existingSheets.has(projectName)) {
    logger.debug({ projectName }, 'Project sheet already exists');
    return;
  }

  // Создаём лист
  const addResp = await client.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: projectName } } }],
    },
  });
  const sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? -1;

  // ─── Шаблон: заголовки (RAW) ───
  const headers: sheets_v4.Schema$ValueRange[] = [];

  // R1: Заголовки счетов
  headers.push({
    range: `'${projectName}'!A${INVOICE_HEADERS_ROW}`,
    values: [[
      'Číslo nabídky / faktury',
      'Согласовано',
      'Částka celkem bez DPH',
      'Sazba DPH',
      'Castka celkem s DPH',
      'Zbývá uhradít',
      'Datum vystavení',
      'Datum splatnosti',
      'Datum zaplacení',
      'Zaplaceno',
    ]],
  });

  // R11: Заголовки бюджета
  headers.push({
    range: `'${projectName}'!A${BUDGET_HEADERS_ROW}`,
    values: [[
      'Название акции',
      'Сумма на материал (план)',
      'Фактическая закупка',
      'Разница',
      'Заложено работы',
      'Фактически работа',
      'Разница',
    ]],
  });

  // R13: Метки часов (E-G)
  headers.push({
    range: `'${projectName}'!E${HOURS_META_ROW}`,
    values: [['часы', 'часы', 'остаток ч']],
  });
  headers.push({
    range: `'${projectName}'!L${HOURS_META_ROW}`,
    values: [[`часы отработанные ${projectName}`, '', '', '']],
  });

  // R14: Заголовки таблицы часов (L-O)
  headers.push({
    range: `'${projectName}'!L${HOURS_HEADERS_ROW}`,
    values: [['техник', 'почасовая', 'часы', 'зп']],
  });

  // R16: Заголовки чеков
  headers.push({
    range: `'${projectName}'!A${RECEIPT_HEADERS_ROW}`,
    values: [[
      'Дата',
      'Поставщик',
      'Материал',
      'Количество',
      'Цена за шт',
      'Общая сумма',
    ]],
  });

  await client.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: headers },
  });

  // ─── Шаблон: начальные значения (RAW) ───
  await client.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        // R12: A=название, B=бюджет(0), E=работы(0)
        { range: `'${projectName}'!A${BUDGET_DATA_ROW}:B${BUDGET_DATA_ROW}`, values: [[projectName, 0]] },
        { range: `'${projectName}'!E${BUDGET_DATA_ROW}`, values: [[0]] },
        // R14: E=план часов(0)
        { range: `'${projectName}'!E${HOURS_HEADERS_ROW}`, values: [[0]] },
      ],
    },
  });

  // ─── Шаблон: формулы (batchUpdate + formulaValue — локаленезависимый) ───
  const formulaCells: Array<{ row: number; col: number; formula: string }> = [];

  // R12: бюджетные формулы
  formulaCells.push({ row: 11, col: 2, formula: '=SUMIF(A17:A1000,"<>",F17:F1000)' }); // C12: факт. закупка (исключает строку «Общие затраты»)
  formulaCells.push({ row: 11, col: 3, formula: '=B12-C12' });               // D12: разница материалов
  formulaCells.push({ row: 11, col: 5, formula: '=SUM(O15:O100)' });         // F12: факт. работа
  formulaCells.push({ row: 11, col: 6, formula: '=E12-F12' });               // G12: разница работы

  // R14: формулы часов
  formulaCells.push({ row: 13, col: 5, formula: '=SUM(N15:N100)' });         // F14: факт часов
  formulaCells.push({ row: 13, col: 6, formula: '=E14-F14' });               // G14: остаток часов

  // E2:E8: Castka celkem s DPH (НДС)
  for (let r = 2; r <= 8; r++) {
    formulaCells.push({
      row: r - 1, col: 4,  // E column = index 4, row is 0-indexed
      formula: `=IF(OR(C${r}="",D${r}=""),"",IFERROR(C${r}+C${r}*D${r},C${r}))`,
    });
  }

  // F2: Zbývá uhradít
  formulaCells.push({ row: 1, col: 5, formula: '=C2-SUM(C3:C8)' });

  // R17: Начальная строка «Общие затраты:» (сдвигается вниз при добавлении чеков)
  formulaCells.push({ row: FIRST_RECEIPT_ROW - 1, col: 5, formula: `=SUM(F${FIRST_RECEIPT_ROW}:F${FIRST_RECEIPT_ROW - 1})` }); // F17: =SUM(пусто) → 0

  await writeFormulas(sheetId, formulaCells);

  // E17: метка «Общие затраты:»
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `'${projectName}'!E${FIRST_RECEIPT_ROW}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Общие затраты:']] },
  });

  // Применяем форматирование по образцу primer.xlsx
  if (sheetId >= 0) {
    await applyProjectSheetFormatting(client, sheetId, projectName).catch((err) =>
      logger.error({ err, projectName }, 'Failed to apply project sheet formatting')
    );
  }

  logger.info({ projectName }, 'Project sheet created with template');
}

// ─── Создание листа «Сводка» ───

async function ensureSummarySheet(): Promise<void> {
  const client = getClient();

  const meta = await client.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });

  const existingSheets = new Set(
    meta.data.sheets?.map((s) => s.properties?.title) || []
  );

  if (existingSheets.has(SUMMARY_SHEET)) return;

  const summaryAddResp = await client.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SUMMARY_SHEET } } }],
    },
  });
  const summarySheetId = summaryAddResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? -1;

  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SUMMARY_SHEET}'!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Объект',
        'Бюджет (CZK)',
        'Потрачено (CZK)',
        'Остаток (CZK)',
        'Заложено часов',
        'Израсходовано часов',
        'Остаток часов',
      ]],
    },
  });

  if (summarySheetId >= 0) {
    await applySummarySheetFormatting(client, summarySheetId).catch((err) =>
      logger.error({ err }, 'Failed to apply summary sheet formatting')
    );
  }

  logger.info('Summary sheet created');
}

// ─── Переименование листа проекта ───

export async function renameProjectSheet(oldName: string, newName: string): Promise<void> {
  if (!sheetsClient) return;

  try {
    const client = getClient();

    // Находим sheetId по старому названию
    const meta = await client.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    });

    const sheet = meta.data.sheets?.find((s) => s.properties?.title === oldName);
    if (!sheet?.properties?.sheetId) {
      logger.warn({ oldName }, 'Sheet not found for rename');
      return;
    }

    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              title: newName,
            },
            fields: 'title',
          },
        }],
      },
    });

    // Обновляем метку «часы отработанные <name>» в R13
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `'${newName}'!A${BUDGET_DATA_ROW}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newName]] },
    });

    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `'${newName}'!L${HOURS_META_ROW}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[`часы отработанные ${newName}`]] },
    });

    logger.info({ oldName, newName }, 'Project sheet renamed');
  } catch (err) {
    logger.error({ err, oldName, newName }, 'Failed to rename project sheet');
  }
}

// ─── Удаление листа проекта ───

/**
 * Удаляет лист проекта из Google Sheets.
 * Вызывается при /unregister.
 */
export async function deleteProjectSheet(projectName: string): Promise<void> {
  if (!sheetsClient) return;

  try {
    const sheetId = await getSheetId(projectName);
    if (sheetId === null) {
      logger.debug({ projectName }, 'Sheet not found for deletion');
      return;
    }

    const client = getClient();
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ deleteSheet: { sheetId } }],
      },
    });

    logger.info({ projectName }, 'Project sheet deleted');
  } catch (err) {
    logger.error({ err, projectName }, 'Failed to delete project sheet');
  }
}

// ─── PG → Sheets: синхронизация чеков ───

/**
 * Синхронизирует один чек в лист проекта (секция «Материалы», R17+).
 */
export async function syncReceiptToSheets(receiptId: number): Promise<void> {
  if (!sheetsClient) return;

  try {
    const receipt = await db('receipts').where('id', receiptId).first();
    if (!receipt || receipt.recognition_status !== 'success') return;

    // Находим проект
    if (!receipt.project_id) return;
    const project = await db('projects').where('id', receipt.project_id).first();
    if (!project) return;

    const sheetName = project.name;
    const client = getClient();

    // Ищем строку с этим receipt ID или первую пустую в секции чеков
    const existingRow = await findReceiptRow(sheetName, receiptId);

    // Данные чека (A-E) + доп. инфо (G)
    const rowData = [
      receipt.receipt_date ? formatDateShort(receipt.receipt_date) : '',
      receipt.shop || '',
      receipt.description || '',
      1,
      parseFloat(receipt.amount_czk) || 0,
    ];

    const targetRow = existingRow || await findNextEmptyRow(sheetName, 'A', FIRST_RECEIPT_ROW);

    // A-E: данные (RAW)
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A${targetRow}:E${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowData] },
    });

    // F: формула =D*E (locale-independent через formulaValue)
    const sid = await getSheetId(sheetName);
    if (sid !== null) {
      await writeFormulas(sid, [
        { row: targetRow - 1, col: 5, formula: `=D${targetRow}*E${targetRow}` },
      ]);
    }

    // G: доп. инфо (оригинальная валюта если не CZK)
    if (receipt.currency_original && receipt.currency_original !== 'CZK') {
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!G${targetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[`${receipt.amount_original} ${receipt.currency_original}`]] },
      });
    }

    // Обновляем строку «Общие затраты:» (сдвигаем под последний чек)
    await updateReceiptsTotalRow(sheetName);

    logger.debug({ receiptId, sheetName }, 'Receipt synced to project sheet');
  } catch (err) {
    logger.error({ err, receiptId }, 'Failed to sync receipt to Sheets');
  }
}

// ─── PG → Sheets: синхронизация проекта ───

/**
 * Обновляет бюджетную секцию (R12) на листе проекта.
 */
export async function syncProjectToSheets(projectId: number): Promise<void> {
  if (!sheetsClient) return;

  try {
    const project = await db('projects').where('id', projectId).first();
    if (!project) return;

    // Убеждаемся что лист существует
    await ensureProjectSheet(project.name);

    await updateBudgetSection(project);

    logger.debug({ projectId, sheetName: project.name }, 'Project synced to Sheets');
  } catch (err) {
    logger.error({ err, projectId }, 'Failed to sync project to Sheets');
  }
}

// ─── PG → Sheets: синхронизация часов ───

/**
 * Синхронизирует запись worker_hours в лист проекта (колонки L–O).
 * Каждый уникальный работник занимает одну строку.
 */
export async function syncWorkerHoursToSheets(workerHoursId: number): Promise<void> {
  if (!sheetsClient) return;

  try {
    const entry = await db('worker_hours').where('id', workerHoursId).first();
    if (!entry) return;

    if (!entry.project_id) return;
    const project = await db('projects').where('id', entry.project_id).first();
    if (!project) return;

    const sheetName = project.name;
    const client = getClient();

    // Собираем агрегированные часы всех работников по этому проекту
    const hoursAgg = await db('worker_hours')
      .where('project_id', project.id)
      .groupBy('worker_name')
      .select('worker_name')
      .sum('hours as total_hours');

    // Получаем ставки из реестра рабочих (таблица workers)
    const allWorkers = await db('workers').select('name', 'hourly_rate');
    const dbRateMap = new Map<string, number>();
    for (const w of allWorkers) {
      if (w.hourly_rate) dbRateMap.set(w.name, parseFloat(w.hourly_rate));
    }

    // Также читаем ручные ставки из Sheets (fallback если нет в БД)
    const clearEnd = FIRST_WORKER_ROW + Math.max(hoursAgg.length, 20) + 2; // +2 для итоговой строки
    const existingRatesResp = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!L${FIRST_WORKER_ROW}:M${clearEnd}`,
    }).catch(() => null);

    const sheetRateMap = new Map<string, number>();
    if (existingRatesResp?.data.values) {
      for (const row of existingRatesResp.data.values) {
        if (row[0] && row[1]) {
          const rate = parseFloat(String(row[1]).replace(/,/g, '.'));
          if (!isNaN(rate)) sheetRateMap.set(row[0], rate);
        }
      }
    }

    const workerDataRows: (string | number)[][] = [];
    for (const w of hoursAgg) {
      const totalHours = parseFloat(w.total_hours || '0');
      // Приоритет: ставка из БД (workers) → ставка из Sheets (ручной ввод) → пусто
      const rate = dbRateMap.get(w.worker_name) ?? sheetRateMap.get(w.worker_name) ?? '';
      workerDataRows.push([
        w.worker_name,
        rate,
        totalHours,
      ] as (string | number)[]);
    }

    if (workerDataRows.length > 0) {
      // Очищаем старые данные (включая итоговую строку)
      await client.spreadsheets.values.clear({
        spreadsheetId,
        range: `'${sheetName}'!L${FIRST_WORKER_ROW}:O${clearEnd}`,
      });

      // L-N: данные (RAW)
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!L${FIRST_WORKER_ROW}`,
        valueInputOption: 'RAW',
        requestBody: { values: workerDataRows },
      });

      const lastWorkerRow = FIRST_WORKER_ROW + workerDataRows.length - 1;
      const totalsRow = lastWorkerRow + 1; // Строка итогов сразу после рабочих

      // Итоговая строка: L = "Итого", N = SUM часов, O = SUM зп
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!L${totalsRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['Итого', '', '', '']] },
      });

      // Формулы: O (зп для каждого рабочего) + итоги (N и O)
      const sid = await getSheetId(sheetName);
      if (sid !== null) {
        const formulas: Array<{ row: number; col: number; formula: string }> = [];

        // O: =M*N для каждого рабочего
        for (let i = 0; i < workerDataRows.length; i++) {
          const r = FIRST_WORKER_ROW + i;
          formulas.push({ row: r - 1, col: 14, formula: `=M${r}*N${r}` }); // O = col 14
        }

        // Итого: N = SUM(часы), O = SUM(зп)
        formulas.push({ row: totalsRow - 1, col: 13, formula: `=SUM(N${FIRST_WORKER_ROW}:N${lastWorkerRow})` }); // N
        formulas.push({ row: totalsRow - 1, col: 14, formula: `=SUM(O${FIRST_WORKER_ROW}:O${lastWorkerRow})` }); // O

        await writeFormulas(sid, formulas);
      }
    }

    // Обновляем бюджет (секция часов)
    await updateBudgetSection(project);

    await db('worker_hours').where('id', workerHoursId).update({ synced_to_sheets: true });

    logger.debug({ workerHoursId, sheetName }, 'Worker hours synced to project sheet');
  } catch (err) {
    logger.error({ err, workerHoursId }, 'Failed to sync worker hours to Sheets');
  }
}

// ─── PG → Sheets: обновление сводки ───

/**
 * Обновляет лист «Сводка» по всем активным проектам.
 */
export async function syncSummaryToSheets(): Promise<void> {
  if (!sheetsClient) return;

  try {
    const projects = await db('projects').where('status', 'active');
    const client = getClient();

    const rows: any[][] = [[
      'Объект',
      'Бюджет (CZK)',
      'Потрачено (CZK)',
      'Остаток (CZK)',
      'Заложено часов',
      'Израсходовано часов',
      'Остаток часов',
    ]];

    for (const project of projects) {
      const totalResult = await db('receipts')
        .where('project_id', project.id)
        .where('recognition_status', 'success')
        .sum('amount_czk as total')
        .first();
      const spentTotal = parseFloat(totalResult?.total || '0');
      const budget = parseFloat(project.budget_czk || '0');
      const allocatedHours = parseFloat(project.allocated_hours || '0');

      const hoursResult = await db('worker_hours')
        .where('project_id', project.id)
        .sum('hours as total')
        .first();
      const spentHours = parseFloat(hoursResult?.total || '0');

      rows.push([
        project.name,
        budget,
        spentTotal,
        budget - spentTotal,
        allocatedHours,
        spentHours,
        allocatedHours - spentHours,
      ]);
    }

    // Очищаем и перезаписываем
    await client.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${SUMMARY_SHEET}'!A:G`,
    });

    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SUMMARY_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    logger.debug('Summary sheet updated');
  } catch (err) {
    logger.error({ err }, 'Failed to sync summary to Sheets');
  }
}

// ─── PG → Sheets: синхронизация счетов (верхняя таблица R2–R8) ───

/**
 * Записывает данные счёта в верхнюю таблицу листа проекта (строки 2-8).
 * Находит первую свободную строку в диапазоне A2:A8.
 * Возвращает номер строки, в которую записан счёт, или null при ошибке.
 */
export async function syncInvoiceToSheets(
  projectName: string,
  invoiceData: {
    invoiceNumber?: string;
    approved?: string;
    amountBezDph?: number;
    vatRate?: string;
    remaining?: number | null;
    dateIssued?: string;
    dateDue?: string;
    datePaid?: string;
    paymentStatus?: string;
  },
): Promise<number | null> {
  if (!sheetsClient) return null;

  try {
    const client = getClient();

    // Читаем A2:A8 чтобы найти первую пустую строку
    const resp = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `'${projectName}'!A2:A8`,
    });

    const values = resp.data.values || [];
    let targetRow: number | null = null;

    for (let i = 0; i < 7; i++) {
      const cellValue = values[i]?.[0];
      if (!cellValue || String(cellValue).trim() === '') {
        targetRow = i + 2; // строки 2-8 (1-indexed)
        break;
      }
    }

    if (targetRow === null) {
      logger.warn({ projectName }, 'Invoice table full (rows 2-8 occupied)');
      return null;
    }

    // Записываем данные: A, B, C, D (E — формула), F, G, H, I, J
    const rowData: (string | number | null)[] = [
      invoiceData.invoiceNumber || '',    // A
      invoiceData.approved || '',          // B
      invoiceData.amountBezDph ?? '',      // C
      invoiceData.vatRate || '',           // D
    ];

    // Записываем A-D
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `'${projectName}'!A${targetRow}:D${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowData] },
    });

    // F: remaining (кроме строки 2, где формула)
    // G-J: даты и статус оплаты
    const fgjData: (string | number | null)[] = [];

    if (targetRow === 2) {
      // Строка 2: F2 — формула, не трогаем. Запишем G-J
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: `'${projectName}'!G${targetRow}:J${targetRow}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            invoiceData.dateIssued || '',
            invoiceData.dateDue || '',
            invoiceData.datePaid || '',
            invoiceData.paymentStatus || '',
          ]],
        },
      });
    } else {
      // Строки 3-8: F — remaining, G-J — даты и статус
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: `'${projectName}'!F${targetRow}:J${targetRow}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            invoiceData.remaining ?? '',
            invoiceData.dateIssued || '',
            invoiceData.dateDue || '',
            invoiceData.datePaid || '',
            invoiceData.paymentStatus || '',
          ]],
        },
      });
    }

    logger.info({ projectName, targetRow }, 'Invoice synced to Sheets');
    return targetRow;
  } catch (err) {
    logger.error({ err, projectName }, 'Failed to sync invoice to Sheets');
    return null;
  }
}

// ─── Sheets → PG: обратная синхронизация ───

/**
 * Читает данные из листов проектов и обновляет PG.
 */
export async function pullChangesFromSheets(): Promise<void> {
  if (!sheetsClient) return;

  try {
    const projects = await db('projects').select('id', 'name', 'budget_czk', 'allocated_hours');

    for (const project of projects) {
      await pullProjectDataFromSheet(project);
    }

    logger.debug('Sheets → PG sync completed');
  } catch (err) {
    logger.error({ err }, 'Sheets → PG sync failed');
  }
}

async function pullProjectDataFromSheet(project: any): Promise<void> {
  const client = getClient();
  const sheetName = project.name;

  try {
    // Читаем бюджетную строку (R12, A-G)
    const budgetResp = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A${BUDGET_DATA_ROW}:G${BUDGET_DATA_ROW}`,
    });

    const budgetRow = budgetResp.data.values?.[0];
    if (budgetRow) {
      const budgetCzk = parseFloat(String(budgetRow[1]).replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
      const allocatedHours = parseFloat(String(budgetRow[4] || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;

      // Обновляем только если значения изменились
      if (budgetCzk !== parseFloat(project.budget_czk || '0') ||
        allocatedHours !== parseFloat(project.allocated_hours || '0')) {
        await db('projects')
          .where('id', project.id)
          .update({
            budget_czk: budgetCzk || project.budget_czk,
            allocated_hours: allocatedHours || project.allocated_hours,
            updated_at: new Date(),
          });

        logger.debug({ projectId: project.id, budgetCzk, allocatedHours }, 'Project updated from Sheets');
      }
    }
  } catch (err: any) {
    // Лист может не существовать если проект создан до Sheets
    if (err?.code === 400) {
      logger.debug({ sheetName }, 'Project sheet not found — skipping pull');
    } else {
      logger.error({ err, sheetName }, 'Failed to pull project data from Sheets');
    }
  }
}

// ─── Вспомогательные функции ───

/**
 * Находит sheetId по имени листа.
 */
async function getSheetId(sheetName: string): Promise<number | null> {
  const client = getClient();
  const meta = await client.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
  return sheet?.properties?.sheetId ?? null;
}

/**
 * Записывает формулы через batchUpdate + formulaValue.
 * Формулы пишутся в английском синтаксисе и конвертируются через loc() в локаль таблицы.
 */
async function writeFormulas(
  sheetId: number,
  cells: Array<{ row: number; col: number; formula: string }>,
): Promise<void> {
  const client = getClient();
  const requests: sheets_v4.Schema$Request[] = cells.map((c) => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: c.row,
        endRowIndex: c.row + 1,
        startColumnIndex: c.col,
        endColumnIndex: c.col + 1,
      },
      rows: [{ values: [{ userEnteredValue: { formulaValue: loc(c.formula) } }] }],
      fields: 'userEnteredValue',
    },
  }));

  if (requests.length > 0) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

/**
 * Обновляет ТОЛЬКО входные значения бюджетной секции (R12).
 * Формулы (C12, D12, F12, G12, F14, G14) НЕ перезаписываются.
 */
async function updateBudgetSection(project: any): Promise<void> {
  const client = getClient();
  const sheetName = project.name;

  const budget = parseFloat(project.budget_czk || '0');
  const laborBudget = parseFloat(project.labor_budget_czk || '0');
  const allocatedHours = parseFloat(project.allocated_hours || '0');

  // A12: название, B12: бюджет материалов (входное значение)
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A${BUDGET_DATA_ROW}:B${BUDGET_DATA_ROW}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[project.name, budget]],
    },
  });

  // E12: заложено работы (входное значение)
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!E${BUDGET_DATA_ROW}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[laborBudget]],
    },
  });

  // E14: план часов (входное значение)
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!E${HOURS_HEADERS_ROW}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[allocatedHours]],
    },
  });
}

/**
 * Ищет строку чека по дате и сумме (колонка A и F) в секции чеков.
 */
async function findReceiptRow(sheetName: string, receiptId: number): Promise<number | null> {
  // Мы не храним receiptId в Sheets — ищем по содержимому
  // Для простоты просто не обновляем, а добавляем новые строки
  return null;
}

/**
 * Находит первую пустую строку начиная с startRow в указанной колонке.
 */
async function findNextEmptyRow(sheetName: string, col: string, startRow: number): Promise<number> {
  const client = getClient();

  const response = await client.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!${col}${startRow}:${col}1000`,
  });

  const values = response.data.values;
  if (!values || values.length === 0) return startRow;

  // Первая пустая строка после данных
  return startRow + values.length;
}

/**
 * Форматирует дату в формат ДД.ММ для Sheets.
 */
function formatDateShort(date: string | Date): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

// ─── Строка «Общие затраты:» под чеками ───

/**
 * Обновляет (перемещает) строку «Общие затраты:» — всегда сразу после последнего чека.
 * Содержит SUM-формулу по колонке F (общие суммы чеков).
 */
async function updateReceiptsTotalRow(sheetName: string): Promise<void> {
  const client = getClient();

  // 1. Ищем и очищаем старую строку «Общие затраты:»
  const resp = await client.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!E${FIRST_RECEIPT_ROW}:E200`,
  }).catch(() => null);

  if (resp?.data.values) {
    for (let i = 0; i < resp.data.values.length; i++) {
      if (String(resp.data.values[i][0]).trim() === 'Общие затраты:') {
        const oldRow = FIRST_RECEIPT_ROW + i;
        await client.spreadsheets.values.clear({
          spreadsheetId,
          range: `'${sheetName}'!E${oldRow}:F${oldRow}`,
        });
        break;
      }
    }
  }

  // 2. Первая пустая строка в A (после всех чеков)
  const totalsRow = await findNextEmptyRow(sheetName, 'A', FIRST_RECEIPT_ROW);

  // 3. Записываем метку
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!E${totalsRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Общие затраты:']] },
  });

  // 4. SUM-формула (суммирует только чеки, без себя)
  const sid = await getSheetId(sheetName);
  if (sid !== null) {
    await writeFormulas(sid, [
      { row: totalsRow - 1, col: 5, formula: `=SUM(F${FIRST_RECEIPT_ROW}:F${totalsRow - 1})` },
    ]);

    // Жирный шрифт для строки итогов
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sid,
              startRowIndex: totalsRow - 1,
              endRowIndex: totalsRow,
              startColumnIndex: 4,
              endColumnIndex: 6,
            },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        }],
      },
    });
  }
}

// ─── Форматирование листов (дизайн по образцу primer.xlsx) ───

// Палитра цветов
const CLR = {
  darkGreen:   { red: 0.153, green: 0.306, blue: 0.075 },  // #274e13
  mediumGreen: { red: 0.416, green: 0.659, blue: 0.310 },  // #6aa84f
  lightGreen:  { red: 0.851, green: 0.918, blue: 0.827 },  // #d9ead3
  lightGray:   { red: 0.952, green: 0.952, blue: 0.952 },  // #f3f3f3
  white:       { red: 1,     green: 1,     blue: 1     },
};

// Thin border style
const THIN_BORDER: sheets_v4.Schema$Border = {
  style: 'SOLID',
  color: { red: 0.8, green: 0.8, blue: 0.8 },
};

function fmtColWidth(sheetId: number, c0: number, c1: number, px: number): sheets_v4.Schema$Request {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: c0, endIndex: c1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function fmtRowHeight(sheetId: number, r0: number, r1: number, px: number): sheets_v4.Schema$Request {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: r0, endIndex: r1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function fmtCell(
  sheetId: number,
  r0: number, r1: number,
  c0: number, c1: number,
  format: sheets_v4.Schema$CellFormat,
  fields: string,
): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: format },
      fields,
    },
  };
}

function fmtMerge(sheetId: number, r0: number, r1: number, c0: number, c1: number): sheets_v4.Schema$Request {
  return {
    mergeCells: {
      range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
      mergeType: 'MERGE_ALL',
    },
  };
}

function fmtBorder(sheetId: number, r0: number, r1: number, c0: number, c1: number): sheets_v4.Schema$Request {
  return {
    updateBorders: {
      range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
      top: THIN_BORDER, bottom: THIN_BORDER,
      left: THIN_BORDER, right: THIN_BORDER,
      innerHorizontal: THIN_BORDER, innerVertical: THIN_BORDER,
    },
  };
}

const HEADER_FIELDS =
  'userEnteredFormat.backgroundColor,' +
  'userEnteredFormat.textFormat,' +
  'userEnteredFormat.horizontalAlignment,' +
  'userEnteredFormat.verticalAlignment,' +
  'userEnteredFormat.wrapStrategy';

/**
 * Применяет дизайн к листу проекта (цвета, ширины колонок, заморозка шапки).
 * Вызывается один раз при создании нового листа.
 */
async function applyProjectSheetFormatting(
  client: sheets_v4.Sheets,
  sheetId: number,
  projectName: string,
): Promise<void> {
  const requests: sheets_v4.Schema$Request[] = [

    // ── Ширины колонок ──
    fmtColWidth(sheetId,  0,  1, 200),  // A: Číslo nabídky / faktury
    fmtColWidth(sheetId,  1,  2, 110),  // B: Согласовано
    fmtColWidth(sheetId,  2,  3, 160),  // C: Částka celkem bez DPH
    fmtColWidth(sheetId,  3,  4,  90),  // D: Sazba DPH
    fmtColWidth(sheetId,  4,  5, 160),  // E: Castka celkem s DPH
    fmtColWidth(sheetId,  5,  6, 120),  // F: Zbývá uhradit
    fmtColWidth(sheetId,  6,  7, 130),  // G: Datum vystavení
    fmtColWidth(sheetId,  7,  8, 130),  // H: Datum splatnosti
    fmtColWidth(sheetId,  8,  9, 130),  // I: Datum zaplacení
    fmtColWidth(sheetId,  9, 10, 110),  // J: Zaplaceno
    fmtColWidth(sheetId, 10, 11,  20),  // K: разделитель
    fmtColWidth(sheetId, 11, 12, 155),  // L: техник
    fmtColWidth(sheetId, 12, 13, 100),  // M: почасовая
    fmtColWidth(sheetId, 13, 14,  80),  // N: часы
    fmtColWidth(sheetId, 14, 15, 105),  // O: зп

    // ── Высоты строк ──
    fmtRowHeight(sheetId,  0,  1, 50),  // R1  — шапка счетов
    fmtRowHeight(sheetId, 10, 11, 50),  // R11 — шапка бюджета
    fmtRowHeight(sheetId, 15, 16, 45),  // R16 — шапка чеков

    // ── R1: Шапка счетов (тёмно-зелёный фон, белый жирный) ──
    fmtCell(sheetId, 0, 1, 0, 10, {
      backgroundColor: CLR.darkGreen,
      textFormat: { foregroundColor: CLR.white, bold: true, fontSize: 10 },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
    }, HEADER_FIELDS),

    // ── R2–R8: Рамки строк счетов ──
    fmtBorder(sheetId, 1, 9, 0, 10),

    // ── R11: Шапка бюджетной секции (тёмно-зелёный) ──
    fmtCell(sheetId, 10, 11, 0, 7, {
      backgroundColor: CLR.darkGreen,
      textFormat: { foregroundColor: CLR.white, bold: true, fontSize: 10 },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
    }, HEADER_FIELDS),

    // ── R12: Данные бюджета — жирное название объекта ──
    fmtCell(sheetId, 11, 12, 0, 1, {
      textFormat: { bold: true },
    }, 'userEnteredFormat.textFormat'),

    // ── R12: Числа бюджета — выравнивание по правому краю ──
    fmtCell(sheetId, 11, 12, 1, 7, {
      horizontalAlignment: 'RIGHT',
    }, 'userEnteredFormat.horizontalAlignment'),

    // ── R13: Метки «часы» (E–G) — мелкий курсив ──
    fmtCell(sheetId, 12, 13, 4, 7, {
      textFormat: { italic: true, fontSize: 8 },
      horizontalAlignment: 'CENTER',
    }, 'userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment'),

    // ── R13: Шапка таблицы часов (L–O) — тёмно-зелёный, объединённая ──
    fmtMerge(sheetId, 12, 13, 11, 15),
    fmtCell(sheetId, 12, 13, 11, 15, {
      backgroundColor: CLR.darkGreen,
      textFormat: { foregroundColor: CLR.white, bold: true },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'CLIP',
    }, HEADER_FIELDS),

    // ── R14: Подзаголовки таблицы часов (L–O) — светло-зелёный ──
    fmtCell(sheetId, 13, 14, 11, 15, {
      backgroundColor: CLR.lightGreen,
      textFormat: { bold: true },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'CLIP',
    }, HEADER_FIELDS),

    // ── R14: Данные часов (E–G) — выравнивание по центру ──
    fmtCell(sheetId, 13, 14, 4, 7, {
      horizontalAlignment: 'CENTER',
      textFormat: { bold: true },
    }, 'userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat'),

    // ── R16: Шапка чеков (средне-зелёный, белый жирный) ──
    fmtCell(sheetId, 15, 16, 0, 7, {
      backgroundColor: CLR.mediumGreen,
      textFormat: { foregroundColor: CLR.white, bold: true },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
    }, HEADER_FIELDS),

    // ── R17+: Чередующиеся строки чеков (полосатый фон) ──
    {
      addBanding: {
        bandedRange: {
          range: {
            sheetId,
            startRowIndex: 16,
            endRowIndex: 200,
            startColumnIndex: 0,
            endColumnIndex: 7,
          },
          rowProperties: {
            firstBandColor: CLR.white,
            secondBandColor: CLR.lightGray,
          },
        },
      },
    },

    // ── Рамки: бюджетная секция ──
    fmtBorder(sheetId, 10, 13, 0, 7),

    // ── Рамки: чековая секция (статичные строки) ──
    fmtBorder(sheetId, 15, 80, 0, 7),

    // ── Рамки: таблица часов ──
    fmtBorder(sheetId, 12, 14, 11, 15),

    // ── Заморозка первой строки ──
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    },

    // ── Дропдаун B2:B8 — Согласовано (ANO/NE) ──
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 9, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [{ userEnteredValue: 'ANO' }, { userEnteredValue: 'NE' }],
          },
          showCustomUi: true,
        },
      },
    },

    // ── Дропдаун D2:D8 — Sazba DPH (21%/12%/Režim/Záloha) ──
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 9, startColumnIndex: 3, endColumnIndex: 4 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [
              { userEnteredValue: '21%' },
              { userEnteredValue: '12%' },
              { userEnteredValue: 'Režim' },
              { userEnteredValue: 'Záloha' },
            ],
          },
          showCustomUi: true,
        },
      },
    },

    // ── Дропдаун J2:J8 — Zaplaceno (статус оплаты) ──
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 9, startColumnIndex: 9, endColumnIndex: 10 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [
              { userEnteredValue: 'Zaplaceno' },
              { userEnteredValue: 'Po splatnosti' },
              { userEnteredValue: 'Vystavená' },
              { userEnteredValue: 'Zadržené' },
            ],
          },
          showCustomUi: true,
        },
      },
    },
  ];

  await client.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

/**
 * Применяет базовое форматирование к листу «Сводка».
 */
async function applySummarySheetFormatting(
  client: sheets_v4.Sheets,
  sheetId: number,
): Promise<void> {
  const requests: sheets_v4.Schema$Request[] = [
    // Ширины колонок
    fmtColWidth(sheetId, 0, 1, 200),  // Объект
    fmtColWidth(sheetId, 1, 2, 140),  // Бюджет
    fmtColWidth(sheetId, 2, 3, 140),  // Потрачено
    fmtColWidth(sheetId, 3, 4, 130),  // Остаток
    fmtColWidth(sheetId, 4, 5, 130),  // Заложено часов
    fmtColWidth(sheetId, 5, 6, 155),  // Израсходовано часов
    fmtColWidth(sheetId, 6, 7, 120),  // Остаток часов

    // R1: Шапка (тёмно-зелёный, белый жирный)
    fmtRowHeight(sheetId, 0, 1, 45),
    fmtCell(sheetId, 0, 1, 0, 7, {
      backgroundColor: CLR.darkGreen,
      textFormat: { foregroundColor: CLR.white, bold: true, fontSize: 10 },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
    }, HEADER_FIELDS),

    // Рамки и чередующийся фон данных
    {
      addBanding: {
        bandedRange: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: 100,
            startColumnIndex: 0,
            endColumnIndex: 7,
          },
          rowProperties: {
            firstBandColor: CLR.white,
            secondBandColor: CLR.lightGray,
          },
        },
      },
    },

    fmtBorder(sheetId, 0, 50, 0, 7),

    // Заморозка первой строки
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    },
  ];

  await client.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}
