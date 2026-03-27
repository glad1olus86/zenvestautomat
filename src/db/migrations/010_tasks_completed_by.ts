import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tasks', (t) => {
    t.text('completed_by'); // Имя кто выполнил/отклонил
    t.bigInteger('completed_by_user_id'); // Telegram user ID
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tasks', (t) => {
    t.dropColumn('completed_by');
    t.dropColumn('completed_by_user_id');
  });
}
