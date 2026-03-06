import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('invoices', (t) => {
    t.increments('id').primary();
    t.integer('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.text('invoice_number');               // A: Číslo nabídky / faktury
    t.text('approved');                      // B: ANO/NE
    t.decimal('amount_bez_dph', 12, 2);     // C: Částka celkem bez DPH
    t.text('vat_rate');                      // D: 21%/12%/Režim/Záloha
    t.decimal('amount_s_dph', 12, 2);       // E: Castka celkem s DPH
    t.decimal('remaining', 12, 2);          // F: Zbývá uhradít
    t.text('date_issued');                   // G: Datum vystavení
    t.text('date_due');                      // H: Datum splatnosti
    t.text('date_paid');                     // I: Datum zaplacení
    t.text('payment_status');               // J: Zaplaceno/Po splatnosti/...
    t.text('drive_link');                    // Ссылка на документ в Google Drive
    t.text('file_id');                       // Telegram file_id (для retry)
    t.jsonb('raw_gemini_response');
    t.integer('sheet_row');                  // Строка в Sheets (2-8)
    t.bigInteger('created_by_user_id');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('invoices');
}
