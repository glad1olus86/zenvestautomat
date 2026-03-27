import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('manager_reports', (t) => {
    t.increments('id').primary();
    t.integer('project_id').notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');
    t.date('report_date').notNullable();

    // Менеджер (из Telegram)
    t.bigInteger('telegram_user_id').notNullable();
    t.text('manager_name').notNullable();

    // Полный текст + распарсенные секции
    t.text('raw_text').notNullable();
    t.text('done_block');
    t.text('problems_block');
    t.text('extra_work_block');
    t.text('need_to_order_block');
    t.text('plan_tomorrow_block');

    // Telegram-ссылка
    t.bigInteger('telegram_group_id').notNullable();
    t.integer('telegram_message_id');
    t.integer('topic_thread_id');
    t.text('message_link');

    // Автосумма из чеков
    t.decimal('spent_on_work_czk', 12, 2).defaultTo(0);
    t.decimal('spent_on_materials_czk', 12, 2).defaultTo(0);

    // Sync
    t.boolean('synced_to_sheets').defaultTo(false);
    t.integer('sheet_row');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.unique(['project_id', 'report_date']);
  });

  await knex.schema.createTable('tasks', (t) => {
    t.increments('id').primary();
    t.integer('project_id').notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');
    t.integer('manager_report_id')
      .references('id').inTable('manager_reports').onDelete('SET NULL');

    t.text('description').notNullable();
    t.text('source_section').notNullable();
    t.text('status').notNullable().defaultTo('open');

    t.date('created_date').notNullable();
    t.date('completed_date');
    t.text('reported_by');

    t.boolean('synced_to_sheets').defaultTo(false);
    t.integer('sheet_row');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['project_id', 'status']);
    t.index(['project_id', 'created_date']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tasks');
  await knex.schema.dropTableIfExists('manager_reports');
}
