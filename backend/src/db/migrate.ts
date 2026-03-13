import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), "data", "db");
const DB_PATH = path.join(DB_DIR, "manga-downloader.db");

fs.mkdirSync(DB_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);

console.log("Running migrations...");
migrate(db, { migrationsFolder: path.join(import.meta.dirname, "../../drizzle") });
console.log("Migrations complete.");

sqlite.close();
