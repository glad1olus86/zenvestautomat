import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Объекты (монтажные площадки)
  await knex.schema.createTable('projects', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.text('address');
    t.text('status').notNullable().defaultTo('active')
      .checkIn(['active', 'archived']);
    t.bigInteger('telegram_group_id').unique();
    t.integer('topic_thread_id');
    t.boolean('topics_enabled').defaultTo(false);
    t.decimal('budget_czk', 12, 2).defaultTo(0);
    t.decimal('budget_original', 12, 2).defaultTo(0);
    t.text('budget_currency').defaultTo('CZK');
    t.decimal('allocated_hours', 8, 2).defaultTo(0);
    t.date('start_date');
    t.date('end_date');
    t.timestamps(true, true);
  });

  // Буфер сообщений (для суточной суммаризации)
  await knex.schema.createTable('message_buffer', (t) => {
    t.increments('id').primary();
    t.integer('project_id').references('id').inTable('projects');
    t.bigInteger('telegram_group_id').notNullable();
    t.bigInteger('telegram_user_id').notNullable();
    t.text('user_name');
    t.text('message_type').notNullable()
      .checkIn(['text', 'voice_transcript']);
    t.text('content').notNullable();
    t.integer('telegram_message_id');
    t.date('message_date').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['telegram_group_id', 'message_date']);
  });

  // Чеки
  await knex.schema.createTable('receipts', (t) => {
    t.increments('id').primary();
    t.integer('project_id').references('id').inTable('projects');
    t.bigInteger('telegram_group_id').notNullable();
    t.bigInteger('telegram_user_id').notNullable();
    t.integer('telegram_message_id');
    t.text('file_id');
    t.decimal('amount_original', 12, 2);
    t.text('currency_original');
    t.decimal('amount_czk', 12, 2);
    t.decimal('exchange_rate', 12, 6);
    t.date('receipt_date');
    t.text('category');
    t.text('description');
    t.text('shop');
    t.text('recognition_status').notNullable().defaultTo('pending')
      .checkIn(['pending', 'success', 'failed']);
    t.jsonb('raw_gemini_response');
    t.timestamps(true, true);

    t.index(['project_id', 'receipt_date']);
  });

  // Суточные отчёты (суммаризация)
  await knex.schema.createTable('daily_reports', (t) => {
    t.increments('id').primary();
    t.integer('project_id').references('id').inTable('projects');
    t.date('report_date').notNullable();
    t.text('report_text').notNullable();
    t.text('done_block');
    t.text('required_block');
    t.text('planned_block');
    t.integer('telegram_message_id');
    t.integer('topic_message_id');
    t.boolean('synced_to_sheets').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique(['project_id', 'report_date']);
  });

  // Финансовые сводки
  await knex.schema.createTable('daily_summaries', (t) => {
    t.increments('id').primary();
    t.integer('project_id').references('id').inTable('projects');
    t.date('summary_date').notNullable();
    t.decimal('spent_today_czk', 12, 2).defaultTo(0);
    t.decimal('spent_total_czk', 12, 2).defaultTo(0);
    t.decimal('budget_czk', 12, 2).defaultTo(0);
    t.decimal('remaining_czk', 12, 2).defaultTo(0);
    t.text('summary_text');
    t.integer('telegram_message_id');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique(['project_id', 'summary_date']);
  });

  // Кэш курсов валют
  await knex.schema.createTable('currency_cache', (t) => {
    t.increments('id').primary();
    t.text('from_currency').notNullable();
    t.text('to_currency').notNullable();
    t.decimal('rate', 12, 6).notNullable();
    t.timestamp('fetched_at').defaultTo(knex.fn.now());

    t.unique(['from_currency', 'to_currency']);
  });

  // Состояние синхронизации Google Sheets
  await knex.schema.createTable('sheets_sync_state', (t) => {
    t.increments('id').primary();
    t.text('sheet_name').notNullable().unique();
    t.timestamp('last_pg_to_sheets');
    t.timestamp('last_sheets_to_pg');
    t.timestamp('sheet_modified_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sheets_sync_state');
  await knex.schema.dropTableIfExists('currency_cache');
  await knex.schema.dropTableIfExists('daily_summaries');
  await knex.schema.dropTableIfExists('daily_reports');
  await knex.schema.dropTableIfExists('receipts');
  await knex.schema.dropTableIfExists('message_buffer');
  await knex.schema.dropTableIfExists('projects');
}
