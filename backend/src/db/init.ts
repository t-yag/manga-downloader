import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { logger } from "../logger.js";

/**
 * Initialize the database with schema.
 * Uses raw SQL for initial table creation (no migration files needed for bootstrap).
 */
export function initDatabase(): void {
  const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), "data", "db");
  const DB_PATH = path.join(DB_DIR, "manga-downloader.db");

  fs.mkdirSync(DB_DIR, { recursive: true });

  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      label TEXT,
      credentials TEXT NOT NULL,
      cookie_path TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      title_id TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      genres TEXT,
      total_volumes INTEGER,
      cover_url TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS library_plugin_title_idx
      ON library(plugin_id, title_id);

    CREATE TABLE IF NOT EXISTS volumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER REFERENCES library(id) ON DELETE CASCADE,
      volume_num INTEGER NOT NULL,
      status TEXT DEFAULT 'unknown',
      availability_reason TEXT,
      page_count INTEGER,
      file_path TEXT,
      file_size INTEGER,
      thumbnail_url TEXT,
      downloaded_at TEXT,
      checked_at TEXT,
      metadata TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS volumes_library_vol_idx
      ON volumes(library_id, volume_num);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id),
      volume_id INTEGER REFERENCES volumes(id),
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      progress REAL DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations: add columns if they don't exist yet
  const volColumns = sqlite
    .prepare("PRAGMA table_info(volumes)")
    .all() as { name: string }[];
  const volColumnNames = new Set(volColumns.map((c) => c.name));

  if (!volColumnNames.has("thumbnail_url")) {
    sqlite.exec("ALTER TABLE volumes ADD COLUMN thumbnail_url TEXT");
  }

  const libColumns = sqlite
    .prepare("PRAGMA table_info(library)")
    .all() as { name: string }[];
  const libColumnNames = new Set(libColumns.map((c) => c.name));

  if (!libColumnNames.has("last_accessed_at")) {
    sqlite.exec("ALTER TABLE library ADD COLUMN last_accessed_at TEXT");
    sqlite.exec("UPDATE library SET last_accessed_at = COALESCE(updated_at, datetime('now'))");
  }

  const jobColumns = sqlite
    .prepare("PRAGMA table_info(jobs)")
    .all() as { name: string }[];
  const jobColumnNames = new Set(jobColumns.map((c) => c.name));

  if (!jobColumnNames.has("retry_count")) {
    sqlite.exec("ALTER TABLE jobs ADD COLUMN retry_count INTEGER DEFAULT 0");
  }

  sqlite.close();
  logger.info("Database initialized");
}
