import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Таблица привязки топиков к проектам
  // Один топик → один проект, но у проекта может быть несколько топиков
  await knex.schema.createTable('project_topics', (t) => {
    t.increments('id').primary();
    t.integer('project_id').notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');
    t.bigInteger('telegram_group_id').notNullable();
    t.integer('topic_thread_id').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique(['telegram_group_id', 'topic_thread_id']);
    t.index('project_id');
  });

  // Мигрируем существующие данные: проекты у которых уже были привязаны топик
  await knex.raw(`
    INSERT INTO project_topics (project_id, telegram_group_id, topic_thread_id)
    SELECT id, telegram_group_id, topic_thread_id
    FROM projects
    WHERE telegram_group_id IS NOT NULL
      AND topic_thread_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);

  // Снимаем UNIQUE constraint с projects.telegram_group_id
  // (группа теперь может содержать несколько проектов через разные топики)
  await knex.schema.alterTable('projects', (t) => {
    t.dropUnique(['telegram_group_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('project_topics');

  // Восстанавливаем UNIQUE constraint
  await knex.schema.alterTable('projects', (t) => {
    t.unique(['telegram_group_id']);
  });
}
