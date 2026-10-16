import type { Db } from './types';

// Append-only. Never edit a migration that has shipped; add a new one instead.
const MIGRATIONS: string[] = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   );`,
  // v1 P1: the template's demo "items" table is not part of Safe Share (D23: settings only).
  `DROP TABLE items;`,
];

export const LATEST_VERSION = MIGRATIONS.length;

export async function migrate(db: Db): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    await db.execAsync(`BEGIN; ${MIGRATIONS[version]} PRAGMA user_version = ${version + 1}; COMMIT;`);
    version++;
  }
}
