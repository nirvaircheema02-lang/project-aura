import Database from 'better-sqlite3';
import { migrate } from './migrate.ts';

/**
 * Opens (creating if needed) the run database, sets WAL mode explicitly
 * (IMPLEMENTATION-PLAN.md §3), applies any pending migrations, and returns
 * the ready-to-use connection.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

export type { Database } from 'better-sqlite3';
