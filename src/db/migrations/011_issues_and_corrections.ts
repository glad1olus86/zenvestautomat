import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Менеджер проекта
  await knex.schema.alterTable('projects', (t) => {
    t.bigInteger('project_manager_user_id');
    t.text('project_manager_name');
  });

  // Актуальные вопросы
  await knex.schema.createTable('issues', (t) => {
    t.increments('id').primary();
    t.integer('project_id').notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');

    t.bigInteger('author_user_id').notNullable();
    t.text('author_name').notNullable();

    t.text('category').notNullable();
    t.text('status').notNullable().defaultTo('open');

    // 6 обязательных полей
    t.text('situation');
    t.text('impact');
    t.text('actions_taken');
    t.text('options');
    t.text('needed_now');
    t.text('addressed_to');

    t.text('formatted_text').notNullable();
    t.jsonb('conversation_history').notNullable();

    // Telegram
    t.bigInteger('telegram_group_id');
    t.integer('topic_thread_id');
    t.integer('published_message_id');
    t.integer('dialog_thread_id');

    // Резолюция
    t.timestamp('resolved_at');
    t.bigInteger('resolved_by_user_id');
    t.text('resolved_by_name');

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['project_id', 'status']);
    t.index(['published_message_id']);
  });

  // Правки объекта
  await knex.schema.createTable('corrections', (t) => {
    t.increments('id').primary();
    t.integer('project_id').notNullable()
      .references('id').inTable('projects').onDelete('CASCADE');

    t.bigInteger('manager_user_id').notNullable();
    t.text('manager_name').notNullable();

    t.jsonb('photos').defaultTo('[]');
    t.text('voice_transcript');
    t.text('text_input');
    t.text('description').notNullable();
    t.text('fix_required').notNullable();
    t.text('manager_comment');
    t.text('formatted_text').notNullable();

    t.text('status').notNullable().defaultTo('open');

    // Telegram
    t.bigInteger('telegram_group_id');
    t.integer('topic_thread_id');
    t.integer('published_message_id');

    // Статус-трекинг
    t.timestamp('fixed_at');
    t.bigInteger('fixed_by_user_id');
    t.text('fixed_by_name');
    t.timestamp('verified_at');
    t.bigInteger('verified_by_user_id');
    t.text('verified_by_name');

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['project_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('corrections');
  await knex.schema.dropTableIfExists('issues');
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('project_manager_user_id');
    t.dropColumn('project_manager_name');
  });
}
