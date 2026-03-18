import type { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, desc, asc, and, inArray, like, sql, or } from "drizzle-orm";
import { registry } from "../../plugins/registry.js";
import { resolvePluginSession } from "../../plugins/session.js";
import type { VolumeAvailability } from "../../plugins/base.js";
import { jobQueue } from "../../queue/queue.js";
import { logger } from "../../logger.js";
import { getAllRules, updateDisplayGenres } from "../../tags/index.js";

const log = logger.child({ module: "AvailabilityCheck" });

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/url/parse
   * Parse a URL to determine plugin, titleId, and type.
   * Does NOT add to library - just returns the parsed info + metadata preview.
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
   *
   * Query params:
   *   search      - partial match on title or author
   *   pluginId    - filter by plugin (comma-separated for multiple)
   *   contentType - filter by series|standalone (comma-separated for multiple)
   *   tags        - filter by display tag (comma-separated, OR match)
   *   sort        - lastAccessedAt (default) | createdAt | title | updatedAt
   *   order       - desc (default) | asc
   *   limit       - page size (default 50)
   *   offset      - pagination offset (default 0)
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
      // Resolve pluginIds matching any of the requested contentTypes
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
      // OR: match any of the requested tags
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

    // Sort
    const sortCol = query.sort === "createdAt"
      ? schema.library.createdAt
      : query.sort === "title"
        ? schema.library.title
        : query.sort === "updatedAt"
          ? schema.library.updatedAt
          : schema.library.lastAccessedAt;
    const orderFn = query.order === "asc" ? asc : desc;
    // For title sort, default to asc
    const orderDir = query.sort === "title" && !query.order ? asc : orderFn;

    // Pagination
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;

    // Total count
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

    // Attach volume summary for each title
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

    const plugin = registry.get(resolvedPluginId);
    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin not found or does not support metadata" });
    }

    // Check if already exists
    const existing = db
      .select()
      .from(schema.library)
      .where(
        and(
          eq(schema.library.pluginId, resolvedPluginId),
          eq(schema.library.titleId, resolvedTitleId)
        )
      )
      .get();

    if (existing) {
      return reply.status(409).send({ error: "Title already in library", id: existing.id });
    }

    try {
      const session = await resolvePluginSession(resolvedPluginId);
      const titleInfo = await plugin.metadata.getTitleInfo(resolvedTitleId, session);

      // Use the canonical titleId from metadata (e.g. Kindle series ASIN)
      const canonicalTitleId = titleInfo.titleId ?? resolvedTitleId;

      // Re-check for duplicates with the canonical titleId
      if (canonicalTitleId !== resolvedTitleId) {
        const existingCanonical = db
          .select()
          .from(schema.library)
          .where(
            and(
              eq(schema.library.pluginId, resolvedPluginId),
              eq(schema.library.titleId, canonicalTitleId)
            )
          )
          .get();
        if (existingCanonical) {
          return reply.status(409).send({ error: "Title already in library", id: existingCanonical.id });
        }
      }

      const result = db
        .insert(schema.library)
        .values({
          pluginId: resolvedPluginId,
          titleId: canonicalTitleId,
          title: titleInfo.seriesTitle,
          author: titleInfo.author,
          genres: JSON.stringify(titleInfo.genres),
          totalVolumes: titleInfo.totalVolumes,
          coverUrl: titleInfo.coverUrl,
        })
        .returning()
        .get();

      // Compute display_genres
      const rules = getAllRules();
      updateDisplayGenres(result.id, JSON.stringify(titleInfo.genres), rules);

      // Create volume entries
      // Plugins without availabilityChecker (e.g. standalone/no-auth) are always available
      const hasAvailabilityChecker = !!plugin.availabilityChecker;
      for (const vol of titleInfo.volumes) {
        let initialStatus: "available" | "unknown";
        let availabilityReason: string | null = null;
        if (!hasAvailabilityChecker) {
          initialStatus = "available";
        } else if (vol.freeUntil) {
          initialStatus = "available";
          availabilityReason = "free";
        } else {
          initialStatus = "unknown";
        }
        db.insert(schema.volumes)
          .values({
            libraryId: result.id,
            volumeNum: vol.volume,
            unit: vol.unit ?? "vol",
            status: initialStatus,
            availabilityReason,
            freeUntil: vol.freeUntil ?? null,
            thumbnailUrl: vol.thumbnailUrl,
            metadata: JSON.stringify({
              readerUrl: vol.readerUrl,
              contentKey: vol.contentKey,
              detailUrl: vol.detailUrl,
            }),
          })
          .onConflictDoNothing()
          .run();
      }

      return {
        ...result,
        genres: titleInfo.genres,
        volumes: titleInfo.volumes,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
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

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);
    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin does not support metadata" });
    }

    try {
      const session = await resolvePluginSession(title.pluginId);
      const titleInfo = await plugin.metadata.getTitleInfo(title.titleId, session);

      // Update library entry (respect user overrides)
      const syncUpdates: Record<string, unknown> = {
        genres: JSON.stringify(titleInfo.genres),
        totalVolumes: titleInfo.totalVolumes,
        coverUrl: titleInfo.coverUrl,
        updatedAt: new Date().toISOString(),
      };
      if (!title.titleOverride) syncUpdates.title = titleInfo.seriesTitle;
      if (!title.authorOverride) syncUpdates.author = titleInfo.author;

      db.update(schema.library)
        .set(syncUpdates)
        .where(eq(schema.library.id, title.id))
        .run();

      // Recompute display_genres
      const refreshRules = getAllRules();
      updateDisplayGenres(title.id, JSON.stringify(titleInfo.genres), refreshRules);

      // Add any new volume entries
      let newVolumes = 0;
      for (const vol of titleInfo.volumes) {
        const volUnit = vol.unit ?? "vol";
        const existing = db
          .select()
          .from(schema.volumes)
          .where(
            and(
              eq(schema.volumes.libraryId, title.id),
              eq(schema.volumes.unit, volUnit),
              eq(schema.volumes.volumeNum, vol.volume)
            )
          )
          .get();

        if (!existing) {
          const volStatus = plugin.availabilityChecker ? "unknown" : "available";
          db.insert(schema.volumes)
            .values({
              libraryId: title.id,
              volumeNum: vol.volume,
              unit: volUnit,
              status: volStatus,
              freeUntil: vol.freeUntil ?? null,
              thumbnailUrl: vol.thumbnailUrl,
              metadata: JSON.stringify({
                readerUrl: vol.readerUrl,
                contentKey: vol.contentKey,
                detailUrl: vol.detailUrl,
              }),
            })
            .run();
          newVolumes++;
        } else {
          // Update freeUntil and thumbnailUrl on existing volumes
          const updates: Record<string, unknown> = {};
          if (vol.thumbnailUrl && existing.thumbnailUrl !== vol.thumbnailUrl) {
            updates.thumbnailUrl = vol.thumbnailUrl;
          }
          // Always sync freeUntil (may appear, change, or disappear)
          const newFreeUntil = vol.freeUntil ?? null;
          if (existing.freeUntil !== newFreeUntil) {
            updates.freeUntil = newFreeUntil;
          }
          if (Object.keys(updates).length > 0) {
            db.update(schema.volumes)
              .set(updates)
              .where(eq(schema.volumes.id, existing.id))
              .run();
          }
        }
      }

      return {
        message: "Title refreshed",
        totalVolumes: titleInfo.totalVolumes,
        newVolumes,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/check-availability
   * Check download availability for un-downloaded volumes.
   * Requires an accountId for authenticated sites.
   */
  app.post("/api/library/:id/check-availability", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId } = (request.body as { accountId?: number }) ?? {};

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);
    if (!plugin?.availabilityChecker) {
      return reply.status(400).send({ error: "Plugin does not support availability checking" });
    }

    // Get volumes that need checking (skip already downloaded or confirmed available)
    const vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all()
      .filter((v) => v.status !== "done" && v.status !== "available");

    if (vols.length === 0) {
      return { message: "No volumes need checking", results: [] };
    }

    // Get session if accountId provided (with auto re-login if invalid)
    log.info(`titleId=${title.titleId}, accountId=${accountId ?? "none"}, volumes=${vols.map(v => v.volumeNum).join(",")}`);
    let session = null;
    if (accountId && plugin.auth) {
      const account = db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (account) {
        let sessionValid = false;
        if (account.cookiePath) {
          const loaded = await plugin.auth.loadSession(account.cookiePath);
          if (loaded) {
            sessionValid = await plugin.auth.validateSession();
          }
        }

        const canAutoRelogin = plugin.manifest?.loginMethods?.includes("credentials") ?? false;

        if (sessionValid) {
          session = plugin.auth.getSession();
        } else if (canAutoRelogin) {
          // Re-login only if plugin supports credentials-based login
          log.info(`Session invalid for account #${account.id}, re-logging in...`);
          const credentials = JSON.parse(account.credentials ?? "{}");
          const success = await plugin.auth.login(credentials);
          if (!success) {
            return reply.status(401).send({ error: "ログインに失敗しました。認証情報を確認してください" });
          }
          if (account.cookiePath) {
            const fs = await import("fs/promises");
            const path = await import("path");
            await fs.mkdir(path.dirname(account.cookiePath), { recursive: true });
            await plugin.auth.saveSession(account.cookiePath);
            log.info(`Re-login successful for account #${account.id}`);
          }
          session = plugin.auth.getSession();
        } else {
          return reply.status(401).send({ error: "セッションが無効です。アカウント設定からログインしてください" });
        }

        log.info(`Session: ${session ? `${session.cookies.length} cookies` : "null"}`);
      }
    } else {
      log.info("No accountId or no auth provider - checking without session");
    }

    try {
      const volumeQueries = vols.map((v) => ({ volume: v.volumeNum, unit: v.unit ?? "vol" }));
      const results = await plugin.availabilityChecker.checkAvailability(
        title.titleId,
        volumeQueries,
        session
      );

      // Update volume statuses in DB
      const now = new Date().toISOString();
      for (const result of results) {
        const vol = vols.find((v) => v.volumeNum === result.volume && (v.unit ?? "vol") === (result.unit ?? "vol"));
        if (!vol) continue;

        // Don't overwrite queued/downloading statuses
        if (vol.status === "queued" || vol.status === "downloading") continue;

        // ViewMode=3 (sample/free reader) + freeUntil set → treat as free/available
        let newStatus: "available" | "unavailable";
        let reason: string;
        if (result.available) {
          newStatus = "available";
          reason = result.reason;
        } else if (vol.freeUntil) {
          newStatus = "available";
          reason = "free";
        } else {
          newStatus = "unavailable";
          reason = result.reason;
        }

        const updates: Record<string, unknown> = {
          status: newStatus,
          availabilityReason: reason,
          checkedAt: now,
        };

        // Override readerUrl/contentKey if provided (e.g. free volumes with different cid)
        if (result.overrideReaderUrl || result.overrideContentKey) {
          const existingMeta = vol.metadata ? JSON.parse(vol.metadata) : {};
          if (result.overrideReaderUrl) existingMeta.readerUrl = result.overrideReaderUrl;
          if (result.overrideContentKey) existingMeta.contentKey = result.overrideContentKey;
          updates.metadata = JSON.stringify(existingMeta);
        }

        db.update(schema.volumes)
          .set(updates)
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }

      return { message: "Availability checked", results };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * POST /api/library/:id/sync
   * Refresh title metadata, then check availability for unknown volumes (if account exists).
   * If `volumes` is provided, skip refresh and force-check only those specific volumes.
   */
  app.post("/api/library/:id/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId, volumes: targetVolumeNums } = (request.body as { accountId?: number; volumes?: number[] }) ?? {};

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);

    // Whether this plugin supports automatic re-login via credentials
    const canAutoRelogin = plugin?.manifest.loginMethods?.includes("credentials") ?? false;

    // Helper: resolve session for availability checking
    // Returns session on success, null if no account/plugin, throws on auth failure.
    async function resolveSession() {
      if (!accountId || !plugin?.auth) return null;
      const account = db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!account) return null;

      let sessionValid = false;
      if (account.cookiePath) {
        const loaded = await plugin.auth.loadSession(account.cookiePath);
        if (loaded) sessionValid = await plugin.auth.validateSession();
      }
      if (sessionValid) return plugin.auth.getSession();

      // Session invalid or missing — attempt re-login only if plugin supports credentials login
      if (!canAutoRelogin) {
        throw new Error("セッションが無効です。アカウント設定からログインしてください");
      }
      log.info(`Session invalid for account #${account.id}, re-logging in...`);
      const credentials = JSON.parse(account.credentials);
      const success = await plugin.auth.login(credentials);
      if (!success) {
        throw new Error("ログインに失敗しました。認証情報を確認してください");
      }
      if (account.cookiePath) {
        const fs = await import("fs/promises");
        const path = await import("path");
        await fs.mkdir(path.dirname(account.cookiePath), { recursive: true });
        await plugin.auth.saveSession(account.cookiePath);
      }
      return plugin.auth.getSession();
    }

    // Helper: force re-login (invalidate current session and login again)
    async function forceRelogin() {
      if (!accountId || !plugin?.auth) return null;
      if (!canAutoRelogin) {
        throw new Error("セッションが無効です。アカウント設定からログインしてください");
      }
      const account = db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!account) return null;
      if (!account.credentials) {
        throw new Error("セッションが無効です。アカウント設定からログインしてください");
      }
      log.info(`Force re-login for account #${account.id}...`);
      const credentials = JSON.parse(account.credentials);
      const success = await plugin.auth.login(credentials);
      if (!success) {
        throw new Error("再ログインに失敗しました。認証情報を確認してください");
      }
      if (account.cookiePath) {
        const fs = await import("fs/promises");
        const path = await import("path");
        await fs.mkdir(path.dirname(account.cookiePath), { recursive: true });
        await plugin.auth.saveSession(account.cookiePath);
      }
      return plugin.auth.getSession();
    }

    // Helper: check availability for given volumes and update DB
    async function checkAndUpdate(vols: { id: number; volumeNum: number; unit: string | null; status: string | null; freeUntil: string | null; metadata: string | null }[]) {
      if (vols.length === 0 || !plugin?.availabilityChecker) return [];
      let session = await resolveSession();

      let results: VolumeAvailability[];
      try {
        results = await plugin.availabilityChecker.checkAvailability(
          title!.titleId,
          vols.map((v) => ({ volume: v.volumeNum, unit: v.unit ?? "vol" })),
          session
        );
      } catch (error: any) {
        // Session was accepted by validateSession but rejected by the server — re-login and retry
        if (error.message?.includes("セッションが無効")) {
          log.warn("Session rejected by server, attempting re-login...");
          session = await forceRelogin();
          results = await plugin.availabilityChecker.checkAvailability(
            title!.titleId,
            vols.map((v) => ({ volume: v.volumeNum, unit: v.unit ?? "vol" })),
            session
          );
        } else {
          throw error;
        }
      }
      const now = new Date().toISOString();
      for (const result of results) {
        const vol = vols.find((v) => v.volumeNum === result.volume && (v.unit ?? "vol") === (result.unit ?? "vol"));
        if (!vol || vol.status === "queued" || vol.status === "downloading") continue;

        // Determine status/reason considering free campaigns
        let newStatus: "available" | "unavailable";
        let newReason: string;
        if (result.available) {
          newStatus = "available";
          newReason = result.reason;
        } else if (vol.freeUntil) {
          newStatus = "available";
          newReason = "free";
        } else {
          newStatus = "unavailable";
          newReason = result.reason;
        }

        const update: Record<string, unknown> = {
          availabilityReason: newReason,
          checkedAt: now,
        };
        if (vol.status !== "done") {
          update.status = newStatus;
        }

        // Override readerUrl/contentKey if provided (e.g. free volumes with different cid)
        if (result.overrideReaderUrl || result.overrideContentKey) {
          const existingMeta = vol.metadata ? JSON.parse(vol.metadata) : {};
          if (result.overrideReaderUrl) existingMeta.readerUrl = result.overrideReaderUrl;
          if (result.overrideContentKey) existingMeta.contentKey = result.overrideContentKey;
          update.metadata = JSON.stringify(existingMeta);
        }

        db.update(schema.volumes)
          .set(update)
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }
      return results;
    }

    // --- Mode A: Targeted sync (specific volumes, skip refresh) ---
    if (targetVolumeNums && targetVolumeNums.length > 0) {
      const vols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, title.id))
        .all()
        .filter((v) => targetVolumeNums.includes(v.volumeNum) && v.status !== "queued" && v.status !== "downloading");

      let availabilityResults: { volume: number; available: boolean; reason: string }[] = [];
      try {
        availabilityResults = await checkAndUpdate(vols);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(error, "Targeted availability check failed");
        const status = msg.includes("ログイン") || msg.includes("セッション") || msg.includes("認証") ? 401 : 500;
        return reply.status(status).send({ error: msg });
      }

      return {
        message: "Sync complete",
        newVolumes: 0,
        totalVolumes: null,
        checkedVolumes: vols.length,
        availableCount: availabilityResults.filter((r) => r.available).length,
      };
    }

    // --- Mode B: Full sync (refresh + check unknown) ---
    if (!plugin?.metadata) {
      return reply.status(400).send({ error: "Plugin does not support metadata" });
    }

    // For standalone (no availabilityChecker): getTitleInfo success/failure determines availability
    const isStandalone = !plugin.availabilityChecker;

    let titleInfo;
    try {
      const metaSession = await resolveSession().catch(() => null);
      titleInfo = await plugin.metadata.getTitleInfo(title.titleId, metaSession);
    } catch (error) {
      if (isStandalone) {
        // Source unreachable → mark "available" volumes as "unavailable"
        const now = new Date().toISOString();
        const updated = db
          .select()
          .from(schema.volumes)
          .where(eq(schema.volumes.libraryId, title.id))
          .all()
          .filter((v) => v.status === "available");

        for (const vol of updated) {
          db.update(schema.volumes)
            .set({ status: "unavailable", checkedAt: now })
            .where(eq(schema.volumes.id, vol.id))
            .run();
        }

        const msg = error instanceof Error ? error.message : String(error);
        log.warn(`Standalone sync failed for titleId=${title.titleId}: ${msg}`);
        return {
          message: "ソースにアクセスできません",
          newVolumes: 0,
          totalVolumes: null,
          checkedVolumes: updated.length,
          availableCount: 0,
        };
      }
      const msg = error instanceof Error ? error.message : String(error);
      log.error(error, `Metadata fetch failed during sync for titleId=${title.titleId}`);
      const status = msg.includes("ログイン") || msg.includes("セッション") || msg.includes("認証") ? 401 : 500;
      return reply.status(status).send({ error: msg });
    }

    const syncUpdates2: Record<string, unknown> = {
      genres: JSON.stringify(titleInfo.genres),
      totalVolumes: titleInfo.totalVolumes,
      coverUrl: titleInfo.coverUrl,
      updatedAt: new Date().toISOString(),
    };
    if (!title.titleOverride) syncUpdates2.title = titleInfo.seriesTitle;
    if (!title.authorOverride) syncUpdates2.author = titleInfo.author;

    db.update(schema.library)
      .set(syncUpdates2)
      .where(eq(schema.library.id, title.id))
      .run();

    // Recompute display_genres
    const syncRules = getAllRules();
    updateDisplayGenres(title.id, JSON.stringify(titleInfo.genres), syncRules);

    let newVolumes = 0;
    for (const vol of titleInfo.volumes) {
      const volUnit = vol.unit ?? "vol";
      const existing = db
        .select()
        .from(schema.volumes)
        .where(
          and(
            eq(schema.volumes.libraryId, title.id),
            eq(schema.volumes.unit, volUnit),
            eq(schema.volumes.volumeNum, vol.volume)
          )
        )
        .get();

      if (!existing) {
        const volStatus = isStandalone ? "available" : "unknown";
        db.insert(schema.volumes)
          .values({
            libraryId: title.id,
            volumeNum: vol.volume,
            unit: volUnit,
            status: volStatus,
            freeUntil: vol.freeUntil ?? null,
            thumbnailUrl: vol.thumbnailUrl,
            metadata: JSON.stringify({
              readerUrl: vol.readerUrl,
              contentKey: vol.contentKey,
              detailUrl: vol.detailUrl,
            }),
          })
          .run();
        newVolumes++;
      } else {
        // Update freeUntil and thumbnailUrl on existing volumes
        const updates: Record<string, unknown> = {};
        if (vol.thumbnailUrl && existing.thumbnailUrl !== vol.thumbnailUrl) {
          updates.thumbnailUrl = vol.thumbnailUrl;
        }
        const newFreeUntil = vol.freeUntil ?? null;
        if (existing.freeUntil !== newFreeUntil) {
          updates.freeUntil = newFreeUntil;
        }
        if (Object.keys(updates).length > 0) {
          db.update(schema.volumes)
            .set(updates)
            .where(eq(schema.volumes.id, existing.id))
            .run();
        }
      }
    }

    // Standalone: getTitleInfo succeeded → restore any "unavailable" back to "available"
    if (isStandalone) {
      const now = new Date().toISOString();
      const unavailableVols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, title.id))
        .all()
        .filter((v) => v.status === "unavailable");

      for (const vol of unavailableVols) {
        db.update(schema.volumes)
          .set({ status: "available", checkedAt: now })
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }

      return {
        message: "Sync complete",
        newVolumes,
        totalVolumes: titleInfo.totalVolumes,
        checkedVolumes: unavailableVols.length,
        availableCount: unavailableVols.length,
      };
    }

    // Promote volumes with freeUntil directly to available/free (no API check needed —
    // the presence of GA_free button on the title page is sufficient proof)
    const now = new Date().toISOString();
    const allVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    let freePromoted = 0;
    for (const vol of allVols) {
      if (vol.status === "done" || vol.status === "queued" || vol.status === "downloading") continue;
      if (vol.freeUntil && vol.availabilityReason !== "free" && vol.availabilityReason !== "purchased") {
        db.update(schema.volumes)
          .set({ status: "available" as const, availabilityReason: "free", checkedAt: now })
          .where(eq(schema.volumes.id, vol.id))
          .run();
        freePromoted++;
      } else if (!vol.freeUntil && vol.availabilityReason === "free") {
        // freeUntil was removed (campaign ended) — reset to unknown for re-check
        db.update(schema.volumes)
          .set({ status: "unknown" as const, availabilityReason: null, checkedAt: now })
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }
    }

    // Series: check availability for volumes that aren't done/queued/downloading
    let availabilityResults: { volume: number; available: boolean; reason: string }[] = [];
    const checkTargetVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all()
      .filter((v) => v.status !== "done" && v.status !== "queued" && v.status !== "downloading");

    try {
      availabilityResults = await checkAndUpdate(checkTargetVols);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(error, "Availability check failed during sync");
      const status = msg.includes("ログイン") || msg.includes("セッション") || msg.includes("認証") ? 401 : 500;
      return reply.status(status).send({ error: msg });
    }

    const availableCount = availabilityResults.filter((r) => r.available).length + freePromoted;

    return {
      message: "Sync complete",
      newVolumes,
      totalVolumes: titleInfo.totalVolumes,
      checkedVolumes: checkTargetVols.length + freePromoted,
      availableCount,
    };
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

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const plugin = registry.get(title.pluginId);
    if (!plugin) return reply.status(400).send({ error: "Plugin not found" });

    // Get all volumes for this title
    const allVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    // Determine which volumes to download
    let targetVols: typeof allVols;
    if (volumeNums === "available") {
      targetVols = allVols.filter((v) => v.status === "available");
    } else if (volumeNums === "error") {
      targetVols = allVols.filter((v) => v.status === "error");
    } else if (volumeNums === "all") {
      targetVols = allVols.filter((v) => v.status !== "done" && v.status !== "queued" && v.status !== "downloading");
    } else {
      targetVols = allVols.filter((v) => volumeNums.includes(v.volumeNum));
    }

    // Apply unit filter (disambiguate ep vs vol when both exist)
    if (filterUnit) {
      targetVols = targetVols.filter((v) => (v.unit ?? "vol") === filterUnit);
    }

    // Filter out in-progress volumes (allow re-download of "done" volumes)
    targetVols = targetVols.filter(
      (v) => v.status !== "queued" && v.status !== "downloading"
    );

    if (targetVols.length === 0) {
      return reply.status(400).send({ error: "No volumes eligible for download" });
    }

    // Queue jobs
    const jobIds: number[] = [];
    for (const vol of targetVols) {
      const jobId = await jobQueue.enqueue({
        pluginId: title.pluginId,
        accountId,
        volumeId: vol.id,
      });
      jobIds.push(jobId);
    }

    return {
      message: `${jobIds.length} job(s) queued`,
      jobIds,
      volumes: targetVols.map((v) => v.volumeNum),
    };
  });

  /**
   * PATCH /api/library/:id
   * Update title metadata (e.g. title, author).
   */
  app.patch("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title, author } = request.body as { title?: string; author?: string };

    const existing = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!existing) return reply.status(404).send({ error: "Title not found" });

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (title !== undefined) {
      updates.title = title;
      updates.titleOverride = 1;
    }
    if (author !== undefined) {
      updates.author = author;
      updates.authorOverride = 1;
    }

    db.update(schema.library)
      .set(updates)
      .where(eq(schema.library.id, Number(id)))
      .run();

    return { message: "Title updated" };
  });

  /**
   * DELETE /api/library/:id
   * Remove title from library (volumes cascade-deleted).
   */
  app.delete("/api/library/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    // Nullify volumeId references in jobs before deleting volumes (FK constraint)
    const vols = db
      .select({ id: schema.volumes.id })
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    if (vols.length > 0) {
      for (const vol of vols) {
        db.update(schema.jobs)
          .set({ volumeId: null })
          .where(eq(schema.jobs.volumeId, vol.id))
          .run();
      }
    }

    db.delete(schema.library)
      .where(eq(schema.library.id, title.id))
      .run();

    return { message: "Title deleted" };
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

    const title = db
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, Number(id)))
      .get();

    if (!title) return reply.status(404).send({ error: "Title not found" });

    const allVols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all();

    const matched = allVols.filter((v) => volumeNums.includes(v.volumeNum));
    log.info(`delete-volumes: requested=${volumeNums.join(",")}, matched=${matched.length}, statuses=${matched.map(v => `${v.volumeNum}:${v.status}`).join(",")}`);

    const vols = matched.filter((v) => v.status === "done" && v.filePath);

    if (vols.length === 0) {
      return reply.status(400).send({ error: "No downloaded volumes to delete" });
    }

    const fs = await import("fs/promises");
    let deletedCount = 0;
    const errors: string[] = [];

    for (const vol of vols) {
      try {
        await fs.rm(vol.filePath!, { recursive: true });
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          log.warn(`delete-volumes: failed to delete file for vol ${vol.volumeNum}: ${err.message}`);
          errors.push(`Vol ${vol.volumeNum}: ${err.message}`);
          continue;
        }
      }

      db.run(sql`UPDATE volumes SET status = 'unknown', file_path = NULL, file_size = NULL, page_count = NULL, downloaded_at = NULL WHERE id = ${vol.id}`);
      log.info(`delete-volumes: reset vol ${vol.volumeNum} (id=${vol.id})`);

      deletedCount++;
    }

    return {
      message: `${deletedCount}巻のファイルを削除しました`,
      deletedCount,
      errors,
    };
  });
}
