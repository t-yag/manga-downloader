import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, desc, asc, and, inArray, like, sql, or } from "drizzle-orm";
import { registry } from "../../plugins/registry.js";
import { resolvePluginSession } from "../../plugins/session.js";
import {
  registerTitle,
  refreshTitle,
  checkTitleAvailability,
  syncTitle,
  queueDownloads,
  updateTitleInfo,
  deleteTitle,
  deleteVolumeFiles,
} from "../../services/library.js";

function isAuthError(msg: string): boolean {
  return msg.includes("ログイン") || msg.includes("セッション") || msg.includes("認証");
}

function errorStatus(msg: string, fallback = 500): number {
  if (msg === "Title not found") return 404;
  if (msg === "Plugin not found" || msg === "Plugin not found or does not support metadata") return 400;
  if (msg === "Plugin does not support metadata") return 400;
  if (msg === "Plugin does not support availability checking") return 400;
  if (msg === "No downloaded volumes to delete") return 400;
  if (isAuthError(msg)) return 401;
  return fallback;
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/url/parse
   * Parse a URL to determine plugin, titleId, and type.
   */
  app.post("/api/url/parse", async (request, reply) => {
    const { url } = request.body as { url: string };

    if (!url) return reply.status(400).send({ error: "URL is required" });

    try {
      const parsed = registry.parseUrl(url);
      const plugin = registry.get(parsed.pluginId);

      let titleInfo = null;
      if (plugin?.metadata) {
        const session = await resolvePluginSession(parsed.pluginId);
        titleInfo = await plugin.metadata.getTitleInfo(parsed.titleId, session);
      }

      return {
        parsed,
        titleInfo,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: msg });
    }
  });

  /**
   * GET /api/library/tags
   * List distinct display tags used across all library items.
   */
  app.get("/api/library/tags", async () => {
    const rows = db
      .select({ displayGenres: schema.library.displayGenres })
      .from(schema.library)
      .all();

    const tagCount = new Map<string, number>();
    for (const row of rows) {
      if (!row.displayGenres) continue;
      const tags: string[] = JSON.parse(row.displayGenres);
      for (const tag of tags) {
        tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
      }
    }

    const tags = Array.from(tagCount.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return { tags };
  });

  /**
   * GET /api/library
   * List titles in library with optional filtering, sorting, and pagination.
   */
  app.get("/api/library", async (request) => {
    const query = request.query as {
      search?: string;
      pluginId?: string;
      contentType?: string;
      tags?: string;
      sort?: string;
      order?: string;
      limit?: string;
      offset?: string;
    };

    const conditions = [];
    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          like(schema.library.title, pattern),
          like(schema.library.author, pattern),
        )
      );
    }
    if (query.pluginId) {
      const ids = query.pluginId.split(",").filter(Boolean);
      if (ids.length === 1) {
        conditions.push(eq(schema.library.pluginId, ids[0]));
      } else if (ids.length > 1) {
        conditions.push(inArray(schema.library.pluginId, ids));
      }
    }
    if (query.contentType) {
      const types = query.contentType.split(",").filter(Boolean);
      const matchingPluginIds = registry.getAll()
        .filter((p) => types.includes(p.manifest.contentType))
        .map((p) => p.manifest.id);
      if (matchingPluginIds.length > 0) {
        conditions.push(inArray(schema.library.pluginId, matchingPluginIds));
      } else {
        conditions.push(sql`0`);
      }
    }
    if (query.tags) {
      const tags = query.tags.split(",").filter(Boolean);
      const tagConditions = tags.map((tag) =>
        like(schema.library.displayGenres, `%"${tag}"%`)
      );
      if (tagConditions.length === 1) {
        conditions.push(tagConditions[0]);
      } else if (tagConditions.length > 1) {
        conditions.push(or(...tagConditions));
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const sortCol = query.sort === "createdAt"
      ? schema.library.createdAt
      : query.sort === "title"
        ? schema.library.title
        : query.sort === "updatedAt"
          ? schema.library.updatedAt
          : schema.library.lastAccessedAt;
    const orderFn = query.order === "asc" ? asc : desc;
    const orderDir = query.sort === "title" && !query.order ? asc : orderFn;

    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;

    const [{ count: total }] = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.library)
      .where(where)
      .all();

    const titles = db
      .select()
      .from(schema.library)
      .where(where)
      .orderBy(orderDir(sortCol))
      .limit(limit)
      .offset(offset)
      .all();

    const items = titles.map((t) => {
      const vols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, t.id))
        .all();

      const summary = {
        total: vols.length,
        downloaded: vols.filter((v) => v.status === "done").length,
        available: vols.filter((v) => v.status === "available").length,
        unknown: vols.filter((v) => v.status === "unknown").length,
      };

      const plugin = registry.get(t.pluginId);
      return {
        ...t,
        contentType: plugin?.manifest.contentType ?? "series",
        genres: t.genres ? JSON.parse(t.genres) : [],
        displayGenres: t.displayGenres ? JSON.parse(t.displayGenres) : null,
        volumeSummary: summary,
      };
    });

    return { items, total };
  });

  /**
   * POST /api/library
   * Add title to library. Accepts a URL which is parsed automatically.
   */
  app.post("/api/library", async (request, reply) => {
    const { url, pluginId, titleId } = request.body as {
      url?: string;
      pluginId?: string;
      titleId?: string;
    };

    let resolvedPluginId: string;
    let resolvedTitleId: string;

    if (url) {
      const parsed = registry.parseUrl(url);
      resolvedPluginId = parsed.pluginId;
      resolvedTitleId = parsed.titleId;
    } else if (pluginId && titleId) {
      resolvedPluginId = pluginId;
      resolvedTitleId = titleId;
    } else {
      return reply.status(400).send({ error: "Either url or (pluginId + titleId) is required" });
    }

    try {
      const result = await registerTitle(resolvedPluginId, resolvedTitleId);

      if (result.alreadyExisted) {
        return reply.status(409).send({ error: "Title already in library", id: result.libraryId });
      }

      // Fetch the created entry for response
      const entry = db
        .select()
        .from(schema.library)
        .where(eq(schema.library.id, result.libraryId))
        .get();

      const vols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, result.libraryId))
        .all();

      return {
        ...entry,
        genres: entry?.genres ? JSON.parse(entry.genres) : [],
        volumes: vols,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * GET /api/library/:id
   * Get title detail with all volumes and their statuses.
   */
  app.get("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    // Update last accessed timestamp
    db.update(schema.library)
      .set({ lastAccessedAt: new Date().toISOString() })
      .where(eq(schema.library.id, title.id))
      .run();

    const plugin = registry.get(title.pluginId);
    const vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    // Enrich active volumes with job progress
    const activeVolIds = vols
      .filter((v) => v.status === "queued" || v.status === "downloading")
      .map((v) => v.id);

    const jobsByVolId = new Map<number, { progress: number; message: string | null }>();
    if (activeVolIds.length > 0) {
      const activeJobs = db
        .select({
          volumeId: schema.jobs.volumeId,
          progress: schema.jobs.progress,
          message: schema.jobs.message,
        })
        .from(schema.jobs)
        .where(
          and(
            inArray(schema.jobs.volumeId, activeVolIds),
            inArray(schema.jobs.status, ["pending", "running"]),
          )
        )
        .all();
      for (const j of activeJobs) {
        if (j.volumeId != null) {
          jobsByVolId.set(j.volumeId!, { progress: j.progress ?? 0, message: j.message });
        }
      }
    }

    return {
      ...title,
      contentType: plugin?.manifest.contentType ?? "series",
      genres: title.genres ? JSON.parse(title.genres) : [],
      displayGenres: title.displayGenres ? JSON.parse(title.displayGenres) : null,
      volumes: vols.map((v) => {
        const job = jobsByVolId.get(v.id);
        return {
          ...v,
          metadata: v.metadata ? JSON.parse(v.metadata) : null,
          jobProgress: job?.progress ?? null,
          jobMessage: job?.message ?? null,
        };
      }),
    };
  });

  /**
   * POST /api/library/:id/refresh
   * Refresh title metadata (re-fetch total volumes, check for new volumes).
   */
  app.post("/api/library/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = await refreshTitle(Number(id));
      return {
        message: "Title refreshed",
        totalVolumes: result.totalVolumes,
        newVolumes: result.newVolumes,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/check-availability
   * Check download availability for un-downloaded volumes.
   */
  app.post("/api/library/:id/check-availability", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId } = (request.body as { accountId?: number }) ?? {};

    try {
      const result = await checkTitleAvailability(Number(id), accountId ?? null);
      return { message: "Availability checked", results: result.results };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/sync
   * Full sync: refresh metadata + check availability.
   * If `volumes` is provided, skip refresh and check only those specific volumes.
   */
  app.post("/api/library/:id/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId, volumes: targetVolumeNums } = (request.body as { accountId?: number; volumes?: number[] }) ?? {};

    try {
      // Targeted sync: check specific volumes only (skip metadata refresh)
      if (targetVolumeNums && targetVolumeNums.length > 0) {
        const result = await checkTitleAvailability(Number(id), accountId ?? null, {
          targetVolumes: targetVolumeNums,
        });
        return {
          message: "Sync complete",
          newVolumes: 0,
          totalVolumes: null,
          checkedVolumes: result.checkedVolumes,
          availableCount: result.availableCount,
        };
      }

      // Full sync
      const result = await syncTitle(Number(id), accountId ?? null);
      return {
        message: result.sourceUnreachable ? "ソースにアクセスできません" : "Sync complete",
        newVolumes: result.newVolumes,
        totalVolumes: result.totalVolumes,
        checkedVolumes: result.checkedVolumes,
        availableCount: result.availableCount,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/download
   * Queue download jobs for selected volumes.
   */
  app.post("/api/library/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { volumes: volumeNums, accountId, unit: filterUnit } = request.body as {
      volumes: number[] | "available" | "all" | "error";
      accountId?: number;
      unit?: string;
    };

    try {
      const result = await queueDownloads(Number(id), volumeNums, {
        accountId,
        unit: filterUnit,
      });

      if (result.queued === 0) {
        return reply.status(400).send({ error: "No volumes eligible for download" });
      }

      return {
        message: `${result.queued} job(s) queued`,
        jobIds: result.jobIds,
        volumes: result.volumes,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * PATCH /api/library/:id
   * Update title metadata (e.g. title, author).
   */
  app.patch("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title, author } = request.body as { title?: string; author?: string };

    try {
      await updateTitleInfo(Number(id), { title, author });
      return { message: "Title updated" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * DELETE /api/library/:id
   * Remove title from library (volumes cascade-deleted).
   */
  app.delete("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await deleteTitle(Number(id));
      return { message: "Title deleted" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/delete-volumes
   * Delete downloaded files for selected volumes and reset their status.
   */
  app.post("/api/library/:id/delete-volumes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { volumes: volumeNums } = request.body as { volumes: number[] };

    if (!volumeNums || volumeNums.length === 0) {
      return reply.status(400).send({ error: "No volumes specified" });
    }

    try {
      const result = await deleteVolumeFiles(Number(id), volumeNums);
      return {
        message: `${result.deletedCount}巻のファイルを削除しました`,
        deletedCount: result.deletedCount,
        errors: result.errors,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(errorStatus(msg)).send({ error: msg });
    }
  });
}
