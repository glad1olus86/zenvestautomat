import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workers', (t) => {
    t.decimal('hourly_rate', 10, 2).nullable(); // Почасовая ставка (CZK)
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workers', (t) => {
    t.dropColumn('hourly_rate');
  });
}
