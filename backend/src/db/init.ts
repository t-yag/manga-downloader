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
      display_genres TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_accessed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS library_plugin_title_idx
      ON library(plugin_id, title_id);

    CREATE TABLE IF NOT EXISTS volumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER REFERENCES library(id) ON DELETE CASCADE,
      volume_num INTEGER NOT NULL,
      status TEXT DEFAULT 'unknown',
      availability_reason TEXT,
      free_until TEXT,
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

    CREATE TABLE IF NOT EXISTS tag_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original TEXT NOT NULL,
      action TEXT NOT NULL,
      mapped_to TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tag_rules_original_idx
      ON tag_rules(original);
  `);

  // Seed default hide rules for common noise tags (idempotent via INSERT OR IGNORE)
  const defaultHideRules = ["SALE", "広告掲載中"];
  const insertRule = sqlite.prepare(
    "INSERT OR IGNORE INTO tag_rules (original, action) VALUES (?, 'hide')"
  );
  for (const original of defaultHideRules) {
    insertRule.run(original);
  }

  sqlite.close();
  logger.info("Database initialized");
}
