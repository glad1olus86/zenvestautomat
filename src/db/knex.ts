import Knex from 'knex';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export const db = Knex({
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 2, max: 10 },
  migrations: {
    directory: path.join(__dirname, 'migrations'),
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
  },
});

export async function initDatabase(): Promise<void> {
  try {
    await db.raw('SELECT 1');
    logger.info('Database connected');
    await db.migrate.latest();
    logger.info('Migrations applied');
  } catch (err) {
    logger.fatal({ err }, 'Database initialization failed');
    throw err;
  }
}
