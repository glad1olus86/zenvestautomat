import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('projects', (t) => {
    t.decimal('labor_budget_czk', 12, 2).defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('labor_budget_czk');
  });
}
