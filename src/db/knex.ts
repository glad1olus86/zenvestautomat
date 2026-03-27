import Knex from 'knex';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

// Определяем расширение миграций: .js (Docker/prod) или .ts (dev/tsx)
const migrationsDir = path.join(__dirname, 'migrations');
const dirFiles = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir) : [];
// Исключаем .d.ts и .map — только реальные файлы миграций
const realMigrations = dirFiles.filter(
  (f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts') && !f.includes('.map'),
);
const migrationExt = realMigrations.some((f) => f.endsWith('.js')) ? '.js' : '.ts';

export const db = Knex({
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 2, max: 10 },
  migrations: {
    directory: migrationsDir,
    tableName: 'knex_migrations',
    loadExtensions: [migrationExt],
  },
});

export async function initDatabase(): Promise<void> {
  try {
    await db.raw('SELECT 1');
    logger.info('Database connected');

    // Нормализуем расширения миграций в БД под текущее окружение
    const wrongExt = migrationExt === '.js' ? '.ts' : '.js';
    await db('knex_migrations')
      .whereRaw(`name LIKE '%${wrongExt}'`)
      .update({ name: db.raw(`REPLACE(name, '${wrongExt}', '${migrationExt}')`) });

    await db.migrate.latest();
    logger.info('Migrations applied');
  } catch (err) {
    logger.fatal({ err }, 'Database initialization failed');
    throw err;
  }
}
