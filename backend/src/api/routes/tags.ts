import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import {
  getAllRules,
  rebuildAllDisplayGenres,
  type TagRule,
} from "../../tags/index.js";

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/tags/discover?pluginId=...
   * Scan library genres and return unique tags with counts and matching rule.
   * pluginId is optional filter to narrow down to a specific plugin's items.
   */
  app.get("/api/tags/discover", async (request) => {
    const { pluginId } = request.query as { pluginId?: string };

    const items = pluginId
      ? db
          .select({ genres: schema.library.genres, pluginId: schema.library.pluginId })
          .from(schema.library)
          .where(eq(schema.library.pluginId, pluginId))
          .all()
      : db
          .select({ genres: schema.library.genres, pluginId: schema.library.pluginId })
          .from(schema.library)
          .all();

    // Aggregate: tag -> { count, plugins }
    const tagMap = new Map<string, { count: number; plugins: Set<string> }>();
    for (const item of items) {
      if (!item.genres) continue;
      const tags: string[] = JSON.parse(item.genres);
      for (const tag of tags) {
        const existing = tagMap.get(tag);
        if (existing) {
          existing.count++;
          existing.plugins.add(item.pluginId);
        } else {
          tagMap.set(tag, { count: 1, plugins: new Set([item.pluginId]) });
        }
      }
    }

    // Build rule lookup
    const rules = getAllRules();
    const ruleByOriginal = new Map<string, TagRule>();
    for (const r of rules) {
      ruleByOriginal.set(r.original.toLowerCase(), r);
    }

    const tags = Array.from(tagMap.entries()).map(([tag, info]) => {
      const rule = ruleByOriginal.get(tag.toLowerCase()) ?? null;
      return {
        tag,
        count: info.count,
        plugins: Array.from(info.plugins),
        rule: rule
          ? { id: rule.id, action: rule.action, mappedTo: rule.mappedTo }
          : null,
      };
    });

    // Sort: unset tags first (by count desc), then ruled tags
    tags.sort((a, b) => {
      const aUnset = a.rule === null;
      const bUnset = b.rule === null;
      if (aUnset && !bUnset) return -1;
      if (!aUnset && bUnset) return 1;
      return b.count - a.count;
    });

    return { tags };
  });

  /**
   * GET /api/tags/items?tag=...&limit=...&offset=...
   * Return library items that have the given raw genre tag.
   */
  app.get("/api/tags/items", async (request, reply) => {
    const { tag, limit: limitStr, offset: offsetStr } = request.query as {
      tag?: string;
      limit?: string;
      offset?: string;
    };
    if (!tag) return reply.status(400).send({ error: "tag is required" });

    const limit = Math.min(Number(limitStr) || 20, 100);
    const offset = Number(offsetStr) || 0;
    const tagLower = tag.toLowerCase();

    // Fetch all library rows with genres, filter in JS for exact tag match
    const rows = db
      .select({
        id: schema.library.id,
        pluginId: schema.library.pluginId,
        title: schema.library.title,
        author: schema.library.author,
        coverUrl: schema.library.coverUrl,
        genres: schema.library.genres,
      })
      .from(schema.library)
      .all();

    const matched = rows.filter((row) => {
      if (!row.genres) return false;
      const tags: string[] = JSON.parse(row.genres);
      return tags.some((t) => t.toLowerCase() === tagLower);
    });

    return {
      items: matched.slice(offset, offset + limit).map(({ genres: _, ...rest }) => rest),
      total: matched.length,
    };
  });

  /**
   * GET /api/tag-rules
   * List all tag rules.
   */
  app.get("/api/tag-rules", async () => {
    return db.select().from(schema.tagRules).all();
  });

  /**
   * POST /api/tag-rules
   * Create a new tag rule.
   */
  app.post("/api/tag-rules", async (request, reply) => {
    const body = request.body as {
      original: string;
      action: "show" | "map" | "hide";
      mappedTo?: string;
    };

    if (!body.original || !body.action) {
      return reply.status(400).send({ error: "original and action are required" });
    }

    try {
      const result = db
        .insert(schema.tagRules)
        .values({
          original: body.original,
          action: body.action,
          mappedTo: body.action === "map" ? (body.mappedTo ?? null) : null,
        })
        .returning()
        .get();

      rebuildAllDisplayGenres();
      return result;
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return reply.status(409).send({ error: "Rule already exists for this tag" });
      }
      throw err;
    }
  });

  /**
   * PUT /api/tag-rules/:id
   * Update an existing tag rule.
   */
  app.put("/api/tag-rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      action?: "show" | "map" | "hide";
      mappedTo?: string | null;
    };

    const existing = db
      .select()
      .from(schema.tagRules)
      .where(eq(schema.tagRules.id, Number(id)))
      .get();

    if (!existing) return reply.status(404).send({ error: "Rule not found" });

    const updates: Record<string, unknown> = {};
    if (body.action !== undefined) updates.action = body.action;
    if (body.mappedTo !== undefined) updates.mappedTo = body.mappedTo;

    db.update(schema.tagRules)
      .set(updates)
      .where(eq(schema.tagRules.id, Number(id)))
      .run();

    rebuildAllDisplayGenres();
    return { message: "Rule updated" };
  });

  /**
   * DELETE /api/tag-rules/:id
   * Delete a tag rule.
   */
  app.delete("/api/tag-rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = db
      .select()
      .from(schema.tagRules)
      .where(eq(schema.tagRules.id, Number(id)))
      .get();

    if (!existing) return reply.status(404).send({ error: "Rule not found" });

    db.delete(schema.tagRules)
      .where(eq(schema.tagRules.id, Number(id)))
      .run();

    rebuildAllDisplayGenres();
    return { message: "Rule deleted" };
  });

  /**
   * POST /api/tag-rules/import
   * Bulk import tag rules from a mapping dict.
   */
  app.post("/api/tag-rules/import", async (request, reply) => {
    const body = request.body as {
      mode: "merge" | "replace";
      rules: Record<string, string | null>;
    };

    if (!body.rules || !body.mode) {
      return reply.status(400).send({ error: "rules and mode are required" });
    }

    let created = 0;
    let updated = 0;

    db.transaction((tx) => {
      if (body.mode === "replace") {
        tx.delete(schema.tagRules).run();
      }

      for (const [original, value] of Object.entries(body.rules)) {
        const action = value === null ? "hide" : "map";
        const mappedTo = value === null ? null : value;

        const existing = tx
          .select()
          .from(schema.tagRules)
          .where(eq(schema.tagRules.original, original))
          .get();

        if (existing) {
          tx.update(schema.tagRules)
            .set({ action, mappedTo })
            .where(eq(schema.tagRules.id, existing.id))
            .run();
          updated++;
        } else {
          tx.insert(schema.tagRules)
            .values({ original, action, mappedTo })
            .run();
          created++;
        }
      }
    });

    rebuildAllDisplayGenres();
    return { message: "Import complete", created, updated };
  });

  /**
   * POST /api/tag-rules/rebuild
   * Manually rebuild all display_genres.
   */
  app.post("/api/tag-rules/rebuild", async () => {
    const updated = rebuildAllDisplayGenres();
    return { message: "Rebuild complete", updated };
  });
}
