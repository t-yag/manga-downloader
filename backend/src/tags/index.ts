import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getSettingValue } from "../api/routes/settings.js";

export interface TagRule {
  id: number;
  original: string;
  action: "show" | "map" | "hide";
  mappedTo: string | null;
}

/**
 * Fetch all tag rules from DB.
 */
export function getAllRules(): TagRule[] {
  return db.select().from(schema.tagRules).all() as TagRule[];
}

/**
 * Apply tag rules to raw tags, producing display tags.
 * Simple dictionary lookup - no plugin scoping.
 * When unsetDefault is "hide", tags without a rule are hidden (default).
 * When unsetDefault is "show", tags without a rule are shown as-is.
 */
export function applyTagRules(rawTags: string[], rules: TagRule[]): string[] {
  const unsetDefault = getSettingValue<string>("tags.unsetDefault") ?? "hide";
  const ruleMap = new Map<string, TagRule>();
  for (const r of rules) {
    ruleMap.set(r.original.toLowerCase(), r);
  }

  return rawTags
    .map((tag) => {
      const rule = ruleMap.get(tag.toLowerCase());
      if (!rule) return unsetDefault === "show" ? tag : null;
      if (rule.action === "hide") return null;
      if (rule.action === "show") return tag;
      return rule.mappedTo ?? tag;
    })
    .filter((t): t is string => t !== null);
}

/**
 * Compute and save display_genres for a single library item.
 */
export function updateDisplayGenres(
  libraryId: number,
  rawGenresJson: string | null,
  rules: TagRule[]
): string[] {
  const raw: string[] = rawGenresJson ? JSON.parse(rawGenresJson) : [];
  const display = applyTagRules(raw, rules);
  db.update(schema.library)
    .set({ displayGenres: JSON.stringify(display) })
    .where(eq(schema.library.id, libraryId))
    .run();
  return display;
}

/**
 * Rebuild display_genres for all library items. Returns count of updated items.
 */
export function rebuildAllDisplayGenres(): number {
  const rules = getAllRules();
  const items = db
    .select({ id: schema.library.id, genres: schema.library.genres, displayGenres: schema.library.displayGenres })
    .from(schema.library)
    .all();

  let updated = 0;
  db.transaction((tx) => {
    for (const item of items) {
      const raw: string[] = item.genres ? JSON.parse(item.genres) : [];
      const display = JSON.stringify(applyTagRules(raw, rules));
      if (display === item.displayGenres) continue;
      tx.update(schema.library)
        .set({ displayGenres: display })
        .where(eq(schema.library.id, item.id))
        .run();
      updated++;
    }
  });
  return updated;
}
