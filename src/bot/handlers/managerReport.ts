import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { db } from '../../db/knex';
import { logger } from '../../utils/logger';
import { downloadTelegramFile, cleanupFile } from '../../utils/downloadFile';
import { recognizeInvoice } from '../../services/gemini';
import { uploadFileToDrive, downloadFromDriveUrl, isDriveEnabled } from '../../services/drive';
import { syncInvoiceToSheets } from '../../services/sheets';
import { InvoiceExtraction } from '../../prompts/invoiceRecognition';

// ─── Session State ───

type WizardStep =
  | 'project'
  | 'document'
  | 'name'
  | 'approved'
  | 'amount_mode'
  | 'amount'
  | 'vat'
  | 'remaining'
  | 'dates_review'
  | 'date_edit_select'
  | 'date_edit_value'
  | 'payment'
  | 'confirm';

interface ManagerSession {
  step: WizardStep;
  botMessageId: number;
  projectId: number;
  projectName: string;
  // Фоновый скан
  scanPromise?: Promise<void>;
  scannedData?: InvoiceExtraction | null;
  documentPath?: string;
  fileId?: string;
  // Собранные данные
  invoiceName?: string;
  driveLink?: string;
  approved?: string;
  amountMode?: 'bez_dph' | 's_dph';
  amount?: number;
  vatRate?: string;
  amountBezDph?: number;
  amountSDph?: number;
  remaining?: number | null;
  dateIssued?: string;
  dateDue?: string;
  datePaid?: string;
  dateEditField?: string;
  paymentStatus?: string;
  createdAt: number;
}

const sessions = new Map<number, ManagerSession>(); // key = userId

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 минут

function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      if (session.documentPath) cleanupFile(session.documentPath);
      sessions.delete(key);
    }
  }
}

/** Безопасное редактирование сообщения (игнорирует ошибки) */
async function safeEdit(
  bot: Bot<BotContext>,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch {
    // Сообщение уже удалено или текст не изменился
  }
}

/** Безопасное удаление сообщения */
async function safeDelete(bot: Bot<BotContext>, chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch {
    // Игнорируем
  }
}

/** Парсит число из текста */
function parseAmount(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num < 0) return null;
  return Math.round(num * 100) / 100;
}

/** Форматирует число для отображения */
function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Парсит дату из гибкого формата в DD.MM.YYYY.
 * Поддерживаемые форматы:
 *   10.04.2026, 10/04/2026, 10 04 2026  — полная дата
 *   10.04.26,   10/04/26,   10 04 26    — двузначный год (20xx)
 *   10.04,      10/04,      10 04       — без года (текущий год)
 * Разделители: точка, слеш, пробел.
 * Возвращает нормализованную строку DD.MM.YYYY или null если не распознано.
 */
function parseDate(text: string): string | null {
  const s = text.trim();
  // Разбиваем по точке, слешу или пробелу
  const parts = s.split(/[.\/\s]+/).filter(Boolean);

  if (parts.length < 2 || parts.length > 3) return null;

  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  if (isNaN(day) || isNaN(month)) return null;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  let year: number;
  if (parts.length === 3) {
    year = parseInt(parts[2], 10);
    if (isNaN(year)) return null;
    if (year < 100) year += 2000; // 26 → 2026
  } else {
    year = new Date().getFullYear();
  }

  if (year < 2000 || year > 2100) return null;

  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  return `${dd}.${mm}.${year}`;
}

/** Определяет расширение по mime type документа */
function mimeToExt(mime: string): string {
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('word') || mime.includes('docx')) return '.docx';
  if (mime.includes('sheet') || mime.includes('xlsx')) return '.xlsx';
  return '.bin';
}

/** Проверяет, является ли текст ссылкой на Google Drive */
function isDriveUrl(text: string): boolean {
  return /drive\.google\.com/.test(text) || /docs\.google\.com/.test(text);
}

// ─── Визард ───

/**
 * Запускает визард добавления счёта для пользователя.
 * Вызывается из /managerreport и из inline-меню (menu:mr).
 */
export async function startInvoiceWizard(bot: Bot<BotContext>, chatId: number, userId: number): Promise<void> {
  cleanupStaleSessions();

  // Сбрасываем существующую сессию
  const existing = sessions.get(userId);
  if (existing) {
    await safeDelete(bot, chatId, existing.botMessageId);
    if (existing.documentPath) cleanupFile(existing.documentPath);
    sessions.delete(userId);
  }

  // Загружаем активные проекты
  const projects = await db('projects').where('status', 'active').select('id', 'name').orderBy('name');

  if (projects.length === 0) {
    await bot.api.sendMessage(chatId, 'Нет активных объектов. Создайте объект командой /register в группе.');
    return;
  }

  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(p.name, `mr:p:${p.id}`).row();
  }

  const msg = await bot.api.sendMessage(
    chatId,
    '<b>Менеджерский отчёт — счёт/фактура</b>\n\nВыберите объект:',
    { parse_mode: 'HTML', reply_markup: kb },
  );

  sessions.set(userId, {
    step: 'project',
    botMessageId: msg.message_id,
    projectId: 0,
    projectName: '',
    createdAt: Date.now(),
  });
}

export function setupManagerReport(bot: Bot<BotContext>): void {

  // ════════════════════ /managerreport ════════════════════

  bot.command('managerreport', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Эта команда работает только в личном чате с ботом.');
      return;
    }
    await startInvoiceWizard(bot, ctx.chat.id, ctx.from!.id);
  });

  // ════════════════════ Callback: выбор проекта ════════════════════

  bot.callbackQuery(/^mr:p:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'project') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела. Начните /managerreport заново.' });
      return;
    }

    const projectId = parseInt(ctx.match[1], 10);
    const project = await db('projects').where('id', projectId).first();
    if (!project) {
      await ctx.answerCallbackQuery({ text: 'Объект не найден' });
      return;
    }

    session.projectId = projectId;
    session.projectName = project.name;
    session.step = 'document';

    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Объект:</b> ${project.name}\n\n` +
      `Отправьте документ (фото, PDF) или ссылку на Google Drive.\n` +
      `Или напишите номер счёта текстом, чтобы пропустить загрузку.`,
    );
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:approved ════════════════════

  bot.callbackQuery(/^mr:approved:(ANO|NE)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'approved') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    session.approved = ctx.match[1];

    // Переход к шагу суммы
    await showAmountModeStep(bot, ctx.chat!.id, session);
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:amode ════════════════════

  bot.callbackQuery(/^mr:amode:(bez_dph|s_dph|use_scanned)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'amount_mode') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    const mode = ctx.match[1];

    if (mode === 'use_scanned' && session.scannedData?.amount) {
      // Используем распознанную сумму
      session.amountMode = 'bez_dph';
      session.amount = session.scannedData.amount;
      session.amountBezDph = session.scannedData.amount;

      // Переходим к НДС
      await showVatStep(bot, ctx.chat!.id, session);
    } else {
      session.amountMode = mode as 'bez_dph' | 's_dph';
      session.step = 'amount';

      const label = mode === 'bez_dph' ? 'без НДС' : 'с НДС';
      await safeEdit(
        bot, ctx.chat!.id, session.botMessageId,
        `<b>Объект:</b> ${session.projectName}\n\n` +
        `Введите сумму ${label} (число):`,
      );
    }
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:vat ════════════════════

  bot.callbackQuery(/^mr:vat:(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'vat') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    session.vatRate = ctx.match[1];

    // Обратный расчёт
    calculateAmounts(session);

    // Переходим к остатку
    await showRemainingStep(bot, ctx.chat!.id, session);
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:rem ════════════════════

  bot.callbackQuery(/^mr:rem:(0|skip)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'remaining') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    session.remaining = ctx.match[1] === '0' ? 0 : null;

    // Переходим к датам
    await showDatesReviewStep(bot, ctx.chat!.id, session);
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:dates ════════════════════

  bot.callbackQuery(/^mr:dates:(ok|edit)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'dates_review') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    if (ctx.match[1] === 'ok') {
      // Переходим к статусу оплаты
      await showPaymentStep(bot, ctx.chat!.id, session);
    } else {
      // Показываем выбор даты для редактирования
      session.step = 'date_edit_select';
      const kb = new InlineKeyboard()
        .text('Дата выставления', 'mr:dedit:issued').row()
        .text('Дата сплатности', 'mr:dedit:due').row()
        .text('Дата оплаты', 'mr:dedit:paid').row()
        .text('Назад', 'mr:dedit:back').row();

      await safeEdit(
        bot, ctx.chat!.id, session.botMessageId,
        `<b>Какую дату изменить?</b>`,
        kb,
      );
    }
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:dedit ════════════════════

  bot.callbackQuery(/^mr:dedit:(issued|due|paid|back)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || (session.step !== 'date_edit_select' && session.step !== 'date_edit_value')) {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    const field = ctx.match[1];

    if (field === 'back') {
      await showDatesReviewStep(bot, ctx.chat!.id, session);
      await ctx.answerCallbackQuery();
      return;
    }

    const labels: Record<string, string> = {
      issued: 'дату выставления',
      due: 'дату сплатности',
      paid: 'дату оплаты',
    };

    session.step = 'date_edit_value';
    session.dateEditField = field;

    const kb = new InlineKeyboard().text('Пропустить (—)', `mr:dskip:${field}`);

    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `Введите ${labels[field]} (напр. 10.04, 10/04/26, 10 04 2026):`,
      kb,
    );
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:dskip (пропуск даты) ════════════════════

  bot.callbackQuery(/^mr:dskip:(issued|due|paid)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'date_edit_value') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    const field = ctx.match[1];
    if (field === 'issued') session.dateIssued = '';
    else if (field === 'due') session.dateDue = '';
    else if (field === 'paid') session.datePaid = '';

    await showDatesReviewStep(bot, ctx.chat!.id, session);
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:pay ════════════════════

  bot.callbackQuery(/^mr:pay:(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'payment') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    session.paymentStatus = ctx.match[1];

    // Показываем сводку
    await showConfirmStep(bot, ctx.chat!.id, session);
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:save / mr:cancel ════════════════════

  bot.callbackQuery(/^mr:(save|cancel)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'confirm') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    if (ctx.match[1] === 'cancel') {
      if (session.documentPath) cleanupFile(session.documentPath);
      sessions.delete(userId);
      const backKb = new InlineKeyboard().text('← В меню', 'menu:back_fresh');
      await safeEdit(bot, ctx.chat!.id, session.botMessageId, 'Отменено.', backKb);
      await ctx.answerCallbackQuery();
      return;
    }

    // ─── Сохранение ───
    try {
      // Запись в БД
      const [invoice] = await db('invoices')
        .insert({
          project_id: session.projectId,
          invoice_number: session.invoiceName || null,
          approved: session.approved || null,
          amount_bez_dph: session.amountBezDph ?? null,
          vat_rate: session.vatRate || null,
          amount_s_dph: session.amountSDph ?? null,
          remaining: session.remaining ?? null,
          date_issued: session.dateIssued || null,
          date_due: session.dateDue || null,
          date_paid: session.datePaid || null,
          payment_status: session.paymentStatus || null,
          drive_link: session.driveLink || null,
          file_id: session.fileId || null,
          raw_gemini_response: session.scannedData ? JSON.stringify(session.scannedData) : null,
          created_by_user_id: userId,
        })
        .returning('*');

      // Запись в Google Sheets
      const sheetRow = await syncInvoiceToSheets(session.projectName, {
        invoiceNumber: session.invoiceName,
        approved: session.approved,
        amountBezDph: session.amountBezDph,
        vatRate: session.vatRate,
        remaining: session.remaining,
        dateIssued: session.dateIssued,
        dateDue: session.dateDue,
        datePaid: session.datePaid,
        paymentStatus: session.paymentStatus,
      });

      // Обновляем sheet_row в БД
      if (sheetRow && invoice) {
        await db('invoices').where('id', invoice.id).update({ sheet_row: sheetRow });
      }

      if (session.documentPath) cleanupFile(session.documentPath);
      sessions.delete(userId);

      const sheetsStatus = sheetRow
        ? `Записано в строку ${sheetRow}`
        : 'Таблица заполнена или Sheets недоступен';

      const doneKb = new InlineKeyboard()
        .text('📄 Добавить ещё', 'menu:mr').row()
        .text('← В меню', 'menu:back_fresh');

      await safeEdit(
        bot, ctx.chat!.id, session.botMessageId,
        `Счёт сохранён!\n\n` +
        `<b>Объект:</b> ${session.projectName}\n` +
        `<b>Счёт:</b> ${session.invoiceName || '—'}\n` +
        `<b>Sheets:</b> ${sheetsStatus}` +
        (session.driveLink ? `\n<b>Документ:</b> <a href="${session.driveLink}">Открыть</a>` : ''),
        doneKb,
      );

      logger.info({ invoiceId: invoice?.id, projectId: session.projectId, sheetRow }, 'Invoice saved via manager report');
    } catch (err) {
      logger.error({ err, userId }, 'Failed to save invoice');
      const errKb = new InlineKeyboard().text('📄 Попробовать снова', 'menu:mr').row().text('← В меню', 'menu:back_fresh');
      await safeEdit(bot, ctx.chat!.id, session.botMessageId, 'Ошибка при сохранении.', errKb);
      if (session.documentPath) cleanupFile(session.documentPath);
      sessions.delete(userId);
    }

    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Callback: mr:name_use / mr:name_other ════════════════════

  bot.callbackQuery(/^mr:name_(use|other)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'name') {
      await ctx.answerCallbackQuery({ text: 'Сессия устарела' });
      return;
    }

    if (ctx.match[1] === 'use' && session.scannedData?.invoiceNumber) {
      session.invoiceName = session.scannedData.invoiceNumber;
      session.step = 'approved';

      const kb = new InlineKeyboard()
        .text('ANO', 'mr:approved:ANO')
        .text('NE', 'mr:approved:NE');

      await safeEdit(
        bot, ctx.chat!.id, session.botMessageId,
        `<b>Объект:</b> ${session.projectName}\n` +
        `<b>Счёт:</b> ${session.invoiceName}\n\n` +
        `Согласовано?`,
        kb,
      );
    } else {
      // Ввод вручную
      await safeEdit(
        bot, ctx.chat!.id, session.botMessageId,
        `<b>Объект:</b> ${session.projectName}\n\nВведите название/номер счёта:`,
      );
    }
    await ctx.answerCallbackQuery();
  });

  // ════════════════════ Обработка текстовых сообщений ════════════════════

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from!.id;
    const session = sessions.get(userId);
    if (!session) return next();

    const text = ctx.message.text;

    // Команды — пропускаем
    if (text.startsWith('/')) return next();

    // Удаляем сообщение менеджера для чистоты
    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);

    try {
      if (session.step === 'document') {
        await handleDocumentTextInput(bot, ctx, session, text);
      } else if (session.step === 'name') {
        await handleNameInput(bot, ctx, session, text);
      } else if (session.step === 'amount') {
        await handleAmountInput(bot, ctx, session, text);
      } else if (session.step === 'remaining') {
        await handleRemainingInput(bot, ctx, session, text);
      } else if (session.step === 'date_edit_value') {
        await handleDateEditInput(bot, ctx, session, text);
      } else if (session.step === 'dates_review') {
        // Пользователь вводит дату на шаге dates_review (если дат не было)
        await handleManualDateInput(bot, ctx, session, text);
      }
    } catch (err) {
      logger.error({ err, userId, step: session.step }, 'Manager report wizard step failed');
    }
  });

  // ════════════════════ Обработка фото ════════════════════

  bot.on('message:photo', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from!.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'document') return next();

    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);

    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    session.fileId = largest.file_id;

    await safeEdit(
      bot, ctx.chat.id, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\nОбрабатываю фото...`,
    );

    // Фоновый скан
    session.scanPromise = (async () => {
      try {
        const filePath = await downloadTelegramFile(ctx.api, largest.file_id, '.jpg');
        session.documentPath = filePath;

        // Загрузка на Drive (параллельно с Gemini)
        const drivePromise = isDriveEnabled()
          ? uploadFileToDrive(filePath, `invoice_${Date.now()}.jpg`, session.projectName)
          : Promise.resolve(null);

        const [scanResult, driveLink] = await Promise.all([
          recognizeInvoice(filePath),
          drivePromise,
        ]);

        session.scannedData = scanResult.data;
        if (driveLink) session.driveLink = driveLink;
      } catch (err) {
        logger.error({ err, userId }, 'Background invoice scan failed');
        session.scannedData = null;
      }
    })();

    // Переходим к шагу имени (сканирование в фоне)
    await showNameStep(bot, ctx.chat.id, session);
  });

  // ════════════════════ Обработка документов (PDF и т.д.) ════════════════════

  bot.on('message:document', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const userId = ctx.from!.id;
    const session = sessions.get(userId);
    if (!session || session.step !== 'document') return next();

    const doc = ctx.message.document;
    const mime = doc.mime_type || '';
    const supportedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    const isSupported = supportedMimes.some((m) => mime.startsWith(m)) ||
      mime.includes('word') || mime.includes('docx');

    if (!isSupported) {
      await safeEdit(
        bot, ctx.chat.id, session.botMessageId,
        `<b>Объект:</b> ${session.projectName}\n\n` +
        `Неподдерживаемый формат (${mime}).\n` +
        `Отправьте PDF, фото или ссылку на Google Drive.`,
      );
      return;
    }

    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);

    session.fileId = doc.file_id;
    const ext = mimeToExt(mime);

    await safeEdit(
      bot, ctx.chat.id, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\nОбрабатываю документ...`,
    );

    // Фоновый скан
    session.scanPromise = (async () => {
      try {
        const filePath = await downloadTelegramFile(ctx.api, doc.file_id, ext);
        session.documentPath = filePath;

        const fileName = doc.file_name || `invoice_${Date.now()}${ext}`;

        const drivePromise = isDriveEnabled()
          ? uploadFileToDrive(filePath, fileName, session.projectName)
          : Promise.resolve(null);

        const [scanResult, driveLink] = await Promise.all([
          recognizeInvoice(filePath),
          drivePromise,
        ]);

        session.scannedData = scanResult.data;
        if (driveLink) session.driveLink = driveLink;
      } catch (err) {
        logger.error({ err, userId }, 'Background invoice scan failed');
        session.scannedData = null;
      }
    })();

    await showNameStep(bot, ctx.chat.id, session);
  });
}

// ─── Step Handlers ───

async function handleDocumentTextInput(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: ManagerSession,
  text: string,
): Promise<void> {
  if (isDriveUrl(text)) {
    // Ссылка на Google Drive
    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\nСкачиваю с Google Drive...`,
    );

    session.driveLink = text;

    session.scanPromise = (async () => {
      try {
        const filePath = await downloadFromDriveUrl(text);
        if (filePath) {
          session.documentPath = filePath;
          const scanResult = await recognizeInvoice(filePath);
          session.scannedData = scanResult.data;
        } else {
          session.scannedData = null;
        }
      } catch (err) {
        logger.error({ err }, 'Drive URL processing failed');
        session.scannedData = null;
      }
    })();

    await showNameStep(bot, ctx.chat!.id, session);
  } else {
    // Текст — используем как название счёта, пропускаем загрузку документа
    session.invoiceName = text.trim();
    session.step = 'approved';

    const kb = new InlineKeyboard()
      .text('ANO', 'mr:approved:ANO')
      .text('NE', 'mr:approved:NE');

    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n` +
      `<b>Счёт:</b> ${session.invoiceName}\n\n` +
      `Согласовано?`,
      kb,
    );
  }
}

async function showNameStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  // Ждём немного, чтобы scanPromise успел начаться
  // Но не блокируем — покажем шаг сразу
  session.step = 'name';

  // Дадим пару секунд на быстрый скан
  const timeout = new Promise<void>((r) => setTimeout(r, 3000));
  await Promise.race([session.scanPromise, timeout]).catch(() => {});

  if (session.scannedData?.invoiceNumber) {
    const kb = new InlineKeyboard()
      .text('Да', 'mr:name_use')
      .text('Ввести другое', 'mr:name_other');

    await safeEdit(
      bot, chatId, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\n` +
      `Найдено: <b>${session.scannedData.invoiceNumber}</b>\nИспользовать?`,
      kb,
    );
  } else {
    await safeEdit(
      bot, chatId, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\nВведите название/номер счёта:`,
    );
  }
}

async function handleNameInput(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: ManagerSession,
  text: string,
): Promise<void> {
  session.invoiceName = text.trim();
  session.step = 'approved';

  const kb = new InlineKeyboard()
    .text('ANO', 'mr:approved:ANO')
    .text('NE', 'mr:approved:NE');

  await safeEdit(
    bot, ctx.chat!.id, session.botMessageId,
    `<b>Объект:</b> ${session.projectName}\n` +
    `<b>Счёт:</b> ${session.invoiceName}\n\n` +
    `Согласовано?`,
    kb,
  );
}

async function showAmountModeStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  session.step = 'amount_mode';

  // Дождёмся скан если ещё идёт
  if (session.scanPromise) {
    await session.scanPromise.catch(() => {});
  }

  if (session.scannedData?.amount) {
    const currency = session.scannedData.currency || 'CZK';
    const kb = new InlineKeyboard()
      .text(`Да (${fmtNum(session.scannedData.amount)} ${currency})`, 'mr:amode:use_scanned').row()
      .text('Ввести без НДС', 'mr:amode:bez_dph')
      .text('Ввести с НДС', 'mr:amode:s_dph');

    await safeEdit(
      bot, chatId, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n` +
      `<b>Счёт:</b> ${session.invoiceName}\n` +
      `<b>Согласовано:</b> ${session.approved}\n\n` +
      `Найдена сумма: <b>${fmtNum(session.scannedData.amount)} ${currency}</b>\nИспользовать?`,
      kb,
    );
  } else {
    const kb = new InlineKeyboard()
      .text('Без НДС', 'mr:amode:bez_dph')
      .text('С НДС', 'mr:amode:s_dph');

    await safeEdit(
      bot, chatId, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n` +
      `<b>Счёт:</b> ${session.invoiceName}\n` +
      `<b>Согласовано:</b> ${session.approved}\n\n` +
      `Как вводить сумму?`,
      kb,
    );
  }
}

async function handleAmountInput(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: ManagerSession,
  text: string,
): Promise<void> {
  const num = parseAmount(text);
  if (num === null || num <= 0) {
    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\n` +
      `Введите корректное число (больше 0):`,
    );
    return;
  }

  session.amount = num;

  if (session.amountMode === 'bez_dph') {
    session.amountBezDph = num;
  } else {
    session.amountSDph = num;
  }

  // Переходим к НДС
  await showVatStep(bot, ctx.chat!.id, session);
}

async function showVatStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  session.step = 'vat';

  const kb = new InlineKeyboard()
    .text('21%', 'mr:vat:21%')
    .text('12%', 'mr:vat:12%')
    .row()
    .text('Režim', 'mr:vat:Režim')
    .text('Záloha', 'mr:vat:Záloha');

  // Если скан нашёл ставку — подсвечиваем
  const hint = session.scannedData?.vatRate
    ? `\n<i>Распознано: ${session.scannedData.vatRate}</i>`
    : '';

  await safeEdit(
    bot, chatId, session.botMessageId,
    `<b>Объект:</b> ${session.projectName}\n` +
    `<b>Счёт:</b> ${session.invoiceName}\n` +
    `<b>Сумма:</b> ${fmtNum(session.amount)}\n\n` +
    `Ставка НДС?${hint}`,
    kb,
  );
}

function calculateAmounts(session: ManagerSession): void {
  const vat = session.vatRate;

  if (session.amountMode === 's_dph') {
    // Ввели с НДС — вычисляем без НДС
    const sDph = session.amountSDph || session.amount || 0;
    session.amountSDph = sDph;

    if (vat === '21%') {
      session.amountBezDph = Math.round((sDph / 1.21) * 100) / 100;
    } else if (vat === '12%') {
      session.amountBezDph = Math.round((sDph / 1.12) * 100) / 100;
    } else {
      // Režim / Záloha — НДС = 0
      session.amountBezDph = sDph;
    }
  } else {
    // Ввели без НДС — вычисляем с НДС
    const bezDph = session.amountBezDph || session.amount || 0;
    session.amountBezDph = bezDph;

    if (vat === '21%') {
      session.amountSDph = Math.round(bezDph * 1.21 * 100) / 100;
    } else if (vat === '12%') {
      session.amountSDph = Math.round(bezDph * 1.12 * 100) / 100;
    } else {
      session.amountSDph = bezDph;
    }
  }
}

async function showRemainingStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  session.step = 'remaining';

  const kb = new InlineKeyboard()
    .text('0', 'mr:rem:0')
    .text('Пропустить', 'mr:rem:skip');

  await safeEdit(
    bot, chatId, session.botMessageId,
    `<b>Объект:</b> ${session.projectName}\n` +
    `<b>Без НДС:</b> ${fmtNum(session.amountBezDph)}\n` +
    `<b>С НДС:</b> ${fmtNum(session.amountSDph)}\n\n` +
    `Остаток к оплате (число) или кнопка:`,
    kb,
  );
}

async function handleRemainingInput(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: ManagerSession,
  text: string,
): Promise<void> {
  const num = parseAmount(text);
  if (num === null) {
    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Объект:</b> ${session.projectName}\n\n` +
      `Введите число или нажмите кнопку:`,
      new InlineKeyboard().text('0', 'mr:rem:0').text('Пропустить', 'mr:rem:skip'),
    );
    return;
  }

  session.remaining = num;
  await showDatesReviewStep(bot, ctx.chat!.id, session);
}

async function showDatesReviewStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  session.step = 'dates_review';

  // Дождёмся скан если ещё идёт
  if (session.scanPromise) {
    await session.scanPromise.catch(() => {});
  }

  // Если даты ещё не заданы — попробуем из скана
  if (session.dateIssued === undefined) {
    session.dateIssued = session.scannedData?.dateIssued || '';
  }
  if (session.dateDue === undefined) {
    session.dateDue = session.scannedData?.dateDue || '';
  }
  if (session.datePaid === undefined) {
    session.datePaid = session.scannedData?.datePaid || '';
  }

  const hasDates = session.dateIssued || session.dateDue || session.datePaid;

  if (hasDates) {
    const kb = new InlineKeyboard()
      .text('Ок', 'mr:dates:ok')
      .text('Изменить', 'mr:dates:edit');

    await safeEdit(
      bot, chatId, session.botMessageId,
      `<b>Даты:</b>\n` +
      `  Дата выставления: <b>${session.dateIssued || '—'}</b>\n` +
      `  Дата сплатности: <b>${session.dateDue || '—'}</b>\n` +
      `  Дата оплаты: <b>${session.datePaid || '—'}</b>\n\n` +
      `Всё верно?`,
      kb,
    );
  } else {
    // Нет дат — запрашиваем ввод
    const kb = new InlineKeyboard().text('Пропустить все', 'mr:dates:ok');

    await safeEdit(
      bot, chatId, session.botMessageId,
      `<b>Даты не найдены.</b>\n\n` +
      `Введите дату выставления (напр. 10.04, 10/04/26, 10 04 2026) или «Пропустить»:`,
      kb,
    );
  }
}

async function handleManualDateInput(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: ManagerSession,
  text: string,
): Promise<void> {
  const parsed = parseDate(text);
  if (!parsed && text.trim() !== '') {
    return; // Игнорируем невалидный ввод
  }

  const dateValue = parsed || '';

  // Определяем какую дату заполнять
  if (!session.dateIssued) {
    session.dateIssued = dateValue;

    const kb = new InlineKeyboard().text('Пропустить', 'mr:dates:ok');
    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Дата выставления:</b> ${session.dateIssued || '—'}\n\n` +
      `Введите дату сплатности (DD.MM или DD/MM/YYYY) или «Пропустить»:`,
      kb,
    );
  } else if (!session.dateDue) {
    session.dateDue = dateValue;

    const kb = new InlineKeyboard().text('Пропустить', 'mr:dates:ok');
    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `<b>Дата выставления:</b> ${session.dateIssued}\n` +
      `<b>Дата сплатности:</b> ${session.dateDue || '—'}\n\n` +
      `Введите дату оплаты (DD.MM или DD/MM/YYYY) или «Пропустить»:`,
      kb,
    );
  } else {
    session.datePaid = dateValue;
    await showDatesReviewStep(bot, ctx.chat!.id, session);
  }
}

async function handleDateEditInput(
  bot: Bot<BotContext>,
  ctx: BotContext,
  session: ManagerSession,
  text: string,
): Promise<void> {
  const parsed = parseDate(text);
  if (!parsed) {
    await safeEdit(
      bot, ctx.chat!.id, session.botMessageId,
      `Неверный формат. Примеры: 10.04.2026, 10/04/26, 10 04:`,
      new InlineKeyboard().text('Пропустить (—)', `mr:dskip:${session.dateEditField}`),
    );
    return;
  }

  const field = session.dateEditField;
  if (field === 'issued') session.dateIssued = parsed;
  else if (field === 'due') session.dateDue = parsed;
  else if (field === 'paid') session.datePaid = parsed;

  await showDatesReviewStep(bot, ctx.chat!.id, session);
}

async function showPaymentStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  session.step = 'payment';

  const kb = new InlineKeyboard()
    .text('Zaplaceno', 'mr:pay:Zaplaceno')
    .text('Po splatnosti', 'mr:pay:Po splatnosti')
    .row()
    .text('Vystavená', 'mr:pay:Vystavená')
    .text('Zadržené', 'mr:pay:Zadržené');

  await safeEdit(
    bot, chatId, session.botMessageId,
    `<b>Объект:</b> ${session.projectName}\n` +
    `<b>Счёт:</b> ${session.invoiceName}\n\n` +
    `Статус оплаты:`,
    kb,
  );
}

async function showConfirmStep(
  bot: Bot<BotContext>,
  chatId: number,
  session: ManagerSession,
): Promise<void> {
  session.step = 'confirm';

  const kb = new InlineKeyboard()
    .text('Сохранить', 'mr:save')
    .text('Отмена', 'mr:cancel');

  const driveInfo = session.driveLink
    ? `<b>Документ:</b> <a href="${session.driveLink}">Открыть</a>`
    : '<b>Документ:</b> —';

  await safeEdit(
    bot, chatId, session.botMessageId,
    `<b>Итог:</b>\n` +
    `<b>Объект:</b> ${session.projectName}\n` +
    `<b>Счёт:</b> ${session.invoiceName || '—'}\n` +
    `<b>Согласовано:</b> ${session.approved || '—'}\n` +
    `<b>Без НДС:</b> ${fmtNum(session.amountBezDph)} CZK\n` +
    `<b>НДС:</b> ${session.vatRate || '—'}\n` +
    `<b>С НДС:</b> ${fmtNum(session.amountSDph)} CZK\n` +
    `<b>Остаток:</b> ${session.remaining !== null && session.remaining !== undefined ? fmtNum(session.remaining) : '—'}\n` +
    `<b>Даты:</b> ${session.dateIssued || '—'} / ${session.dateDue || '—'} / ${session.datePaid || '—'}\n` +
    `<b>Оплата:</b> ${session.paymentStatus || '—'}\n` +
    driveInfo,
    kb,
  );
}
