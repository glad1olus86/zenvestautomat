import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('workers', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.text('username');                          // Telegram @username (необязательно)
    t.text('worker_type').notNullable().defaultTo('helper')
      .checkIn(['technician', 'junior_technician', 'helper']);
    t.bigInteger('created_by_user_id').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workers');
}
