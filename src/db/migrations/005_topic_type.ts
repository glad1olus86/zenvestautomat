import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('project_topics', (t) => {
    // 'general' — обратная совместимость, 'reports' — отчёты, 'receipts' — чеки
    t.text('topic_type').defaultTo('general');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('project_topics', (t) => {
    t.dropColumn('topic_type');
  });
}
