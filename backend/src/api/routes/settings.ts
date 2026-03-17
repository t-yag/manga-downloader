import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";

const DEFAULT_SETTINGS: Record<string, unknown> = {
  "download.basePath": "./data/downloads",
  "download.pathTemplate": "{title}_vol_{volume}",
  "download.concurrency": 1,
  "download.retryCount": 3,
  "download.requestInterval": 0,
  "download.jobRetryCount": 1,
  "download.imageQuality": 95,
  "download.imageFormat": "jpg",
  "browser.headless": true,
  "browser.executablePath": "",
  "tags.unsetDefault": "hide",
};

/**
 * Get a setting value with type, falling back to defaults.
 */
export function getSettingValue<T>(key: string): T | undefined {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();

  if (row?.value) {
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as T;
    }
  }

  return DEFAULT_SETTINGS[key] as T | undefined;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Get all settings
  app.get("/api/settings", async () => {
    const rows = db.select().from(schema.settings).all();
    const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };

    for (const row of rows) {
      try {
        result[row.key] = row.value ? JSON.parse(row.value) : null;
      } catch {
        result[row.key] = row.value;
      }
    }

    return result;
  });

  // Update settings (partial update)
  app.put("/api/settings", async (request) => {
    const body = request.body as Record<string, unknown>;

    for (const [key, value] of Object.entries(body)) {
      const jsonValue = JSON.stringify(value);

      db.insert(schema.settings)
        .values({
          key,
          value: jsonValue,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: {
            value: jsonValue,
            updatedAt: new Date().toISOString(),
          },
        })
        .run();
    }

    return { message: "Settings updated" };
  });
}
