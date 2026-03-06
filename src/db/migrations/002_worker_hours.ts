import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('worker_hours', (t) => {
    t.increments('id').primary();
    t.integer('project_id').references('id').inTable('projects');
    t.bigInteger('telegram_group_id').notNullable();
    t.bigInteger('reported_by_user_id').notNullable(); // кто ввёл (техник)
    t.text('worker_name').notNullable();               // имя работника (помощник/младший техник)
    t.text('worker_type').notNullable().defaultTo('helper')
      .checkIn(['technician', 'junior_technician', 'helper']);
    t.decimal('hours', 6, 2).notNullable();
    t.date('work_date').notNullable();
    t.boolean('synced_to_sheets').defaultTo(false);
    t.timestamps(true, true);

    t.index(['project_id', 'work_date']);
    t.index(['telegram_group_id', 'work_date']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('worker_hours');
}
