import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import path from "path";
import fs from "fs";

const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), "data", "db");
const DB_PATH = path.join(DB_DIR, "manga-downloader.db");

// Ensure DB directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { schema };
export type Database = typeof db;
