/**
 * @jest-environment node
 */
import { createTestDb } from '../../test/node-sqlite-db';

import { LATEST_VERSION, migrate } from './migrations';
import {
  getFileNamePolicy,
  getKeepOutputs,
  getProfileSetting,
  getThemePreference,
  setFileNamePolicy,
  setKeepOutputs,
  setProfileSetting,
  setThemePreference,
} from './settings';

async function freshDb() {
  const db = createTestDb();
  await migrate(db);
  return db;
}

describe('migrations', () => {
  it('reaches the latest version and is safe to run again', async () => {
    const db = await freshDb();
    await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(LATEST_VERSION);
  });
});

describe('schema', () => {
  it('has only the settings table (demo items table dropped by migration 2)', async () => {
    const db = await freshDb();
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    expect(tables.map((t) => t.name)).toEqual(['settings']);
  });

  it('upgrades a database that still has the v1 items table and keeps its settings', async () => {
    const db = createTestDb();
    await db.execAsync(
      `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
       CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
       INSERT INTO settings VALUES ('theme', 'dark');
       PRAGMA user_version = 1;`
    );
    await migrate(db);
    expect(await getThemePreference(db)).toBe('dark');
    const gone = await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name = 'items'");
    expect(gone).toBeNull();
  });
});

describe('theme preference', () => {
  it('defaults to system, persists changes, and ignores invalid stored values', async () => {
    const db = await freshDb();
    expect(await getThemePreference(db)).toBe('system');

    await setThemePreference(db, 'dark');
    expect(await getThemePreference(db)).toBe('dark');

    await db.runAsync("UPDATE settings SET value = 'purple' WHERE key = 'theme'");
    expect(await getThemePreference(db)).toBe('system');
  });
});

describe('profile and keep-outputs settings', () => {
  it('defaults to "Remove everything" and remembers the last choice', async () => {
    const db = await freshDb();
    expect(await getProfileSetting(db)).toBe('all');
    await setProfileSetting(db, 'location');
    expect(await getProfileSetting(db)).toBe('location');
    await setProfileSetting(db, 'camera');
    expect(await getProfileSetting(db)).toBe('camera');
  });

  it('ignores an unknown stored profile', async () => {
    const db = await freshDb();
    await db.runAsync("INSERT INTO settings (key, value) VALUES ('profile', 'bogus')");
    expect(await getProfileSetting(db)).toBe('all');
  });

  it('keep-outputs is off by default', async () => {
    const db = await freshDb();
    expect(await getKeepOutputs(db)).toBe(false);
    await setKeepOutputs(db, true);
    expect(await getKeepOutputs(db)).toBe(true);
    await setKeepOutputs(db, false);
    expect(await getKeepOutputs(db)).toBe(false);
  });
});

describe('file name policy', () => {
  it('is neutral by default, remembers "original", and ignores unknown values', async () => {
    const db = await freshDb();
    expect(await getFileNamePolicy(db)).toBe('neutral');
    await setFileNamePolicy(db, 'original');
    expect(await getFileNamePolicy(db)).toBe('original');
    await db.runAsync("UPDATE settings SET value = 'funny' WHERE key = 'fileNames'");
    expect(await getFileNamePolicy(db)).toBe('neutral');
    await setFileNamePolicy(db, 'neutral');
    expect(await getFileNamePolicy(db)).toBe('neutral');
  });
});
