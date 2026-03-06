import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot';
import { startInvoiceWizard } from './managerReport';
import { startWorkersMenu } from './workersMenu';

const WELCOME_TEXT = `<b>Zenvest Bot</b>

Выберите действие:`;

function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📄 Добавить счёт', 'menu:mr').row()
    .text('👷 Управление рабочими', 'menu:workers').row()
    .text('ℹ️ Помощь', 'menu:help');
}

/**
 * Отправляет главное меню. Возвращает message_id.
 */
export async function sendMainMenu(
  bot: Bot<BotContext>,
  chatId: number,
): Promise<number> {
  const msg = await bot.api.sendMessage(chatId, WELCOME_TEXT, {
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard(),
  });
  return msg.message_id;
}

export function setupStartMenu(bot: Bot<BotContext>): void {

  // /start в личном чате → главное меню
  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(WELCOME_TEXT, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
  });

  // Кнопка «Добавить счёт»
  bot.callbackQuery('menu:mr', async (ctx) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return;
    await ctx.answerCallbackQuery();
    // Удаляем сообщение с меню
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await startInvoiceWizard(bot, ctx.chat.id, ctx.from.id);
  });

  // Кнопка «Управление рабочими»
  bot.callbackQuery('menu:workers', async (ctx) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return;
    await ctx.answerCallbackQuery();
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await startWorkersMenu(bot, ctx.chat.id, ctx.from.id);
  });

  // Кнопка «Помощь»
  bot.callbackQuery('menu:help', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        `<b>📋 Команды Zenvest Bot</b>\n\n` +
        `<b>В личном чате:</b>\n` +
        `📄 <b>Добавить счёт</b> — пошаговый визард для счетов/фактур\n\n` +
        `<b>В группе:</b>\n` +
        `/register — создать объект\n` +
        `/link — привязать топик\n` +
        `/report — суточный отчёт\n` +
        `/hours — записать рабочие часы\n` +
        `/help — полный список команд`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Назад', 'menu:back') },
      );
    } catch { /* ignore */ }
  });

  // Кнопка «Назад» → главное меню (редактирование текущего сообщения)
  bot.callbackQuery('menu:back', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(WELCOME_TEXT, {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(),
      });
    } catch { /* ignore */ }
  });

  // Кнопка «В меню» → новое сообщение (из завершённого визарда)
  bot.callbackQuery('menu:back_fresh', async (ctx) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return;
    await ctx.answerCallbackQuery();
    await sendMainMenu(bot, ctx.chat.id);
  });
}
