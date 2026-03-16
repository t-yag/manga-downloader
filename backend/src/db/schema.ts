import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pluginId: text("plugin_id").notNull(),
  label: text("label"),
  credentials: text("credentials").notNull(), // JSON (encrypted)
  cookiePath: text("cookie_path"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const library = sqliteTable(
  "library",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pluginId: text("plugin_id").notNull(),
    titleId: text("title_id").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    genres: text("genres"), // JSON array
    totalVolumes: integer("total_volumes"),
    coverUrl: text("cover_url"),
    metadata: text("metadata"), // JSON (plugin-specific)
    displayGenres: text("display_genres"), // JSON array (tag-rule-applied cache)
    createdAt: text("created_at").default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
    lastAccessedAt: text("last_accessed_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("library_plugin_title_idx").on(table.pluginId, table.titleId),
  ]
);

export const volumes = sqliteTable(
  "volumes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    libraryId: integer("library_id").references(() => library.id, { onDelete: "cascade" }),
    volumeNum: integer("volume_num").notNull(),
    status: text("status", {
      enum: ["unknown", "available", "unavailable", "queued", "downloading", "done", "error", "cancelled"],
    }).default("unknown"),
    /** "purchased", "free", "subscription", "not_purchased", "unknown" */
    availabilityReason: text("availability_reason"),
    /** ISO date string — free campaign expiry (e.g. "2026-03-31") */
    freeUntil: text("free_until"),
    pageCount: integer("page_count"),
    filePath: text("file_path"),
    fileSize: integer("file_size"),
    thumbnailUrl: text("thumbnail_url"),
    downloadedAt: text("downloaded_at"),
    checkedAt: text("checked_at"), // last availability check
    metadata: text("metadata"), // JSON
  },
  (table) => [
    uniqueIndex("volumes_library_vol_idx").on(table.libraryId, table.volumeNum),
  ]
);

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pluginId: text("plugin_id").notNull(),
  accountId: integer("account_id").references(() => accounts.id),
  volumeId: integer("volume_id").references(() => volumes.id),
  status: text("status", {
    enum: ["pending", "running", "done", "error", "cancelled"],
  }).default("pending"),
  priority: integer("priority").default(0),
  progress: real("progress").default(0),
  retryCount: integer("retry_count").default(0),
  message: text("message"),
  error: text("error"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"), // JSON
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const tagRules = sqliteTable(
  "tag_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    original: text("original").notNull(), // raw tag (case-insensitive match)
    action: text("action", {
      enum: ["show", "map", "hide"],
    }).notNull(),
    mappedTo: text("mapped_to"), // target tag when action='map'
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("tag_rules_original_idx").on(table.original),
  ]
);
