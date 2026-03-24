import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { registry } from "../plugins/registry.js";
import { resolvePluginSession } from "../plugins/session.js";
import type { VolumeAvailability, SessionData } from "../plugins/base.js";
import { jobQueue } from "../queue/queue.js";
import { logger } from "../logger.js";
import { getAllRules, updateDisplayGenres } from "../tags/index.js";

const log = logger.child({ module: "LibraryService" });

export interface QueueDownloadResult {
  queued: number;
  jobIds: number[];
  volumes: number[];
}

// ─── Account resolution ────────────────────────────────────────────────

/**
 * Resolve the default accountId for a plugin.
 * Returns the first active account's ID, or null if none exists.
 */
export function resolveAccountId(pluginId: string): number | null {
  const account = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.pluginId, pluginId),
        eq(schema.accounts.isActive, true),
      )
    )
    .get();

  return account?.id ?? null;
}

// ─── Session resolution with auto re-login ─────────────────────────────

/**
 * Resolve a valid session for the given plugin + account.
 * Handles auto re-login for credential-based plugins.
 * Returns null if no account or no auth needed.
 * Throws on authentication failure.
 */
export async function resolveSessionWithRelogin(
  pluginId: string,
  accountId: number | null,
): Promise<SessionData | null> {
  if (!accountId) return null;

  const plugin = registry.get(pluginId);
  if (!plugin?.auth) return null;

  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!account) return null;

  // Try existing session
  let sessionValid = false;
  if (account.cookiePath) {
    const loaded = await plugin.auth.loadSession(account.cookiePath);
    if (loaded) sessionValid = await plugin.auth.validateSession();
  }

  if (sessionValid) return plugin.auth.getSession();

  // Auto re-login if plugin supports credentials
  return forceRelogin(plugin, account);
}

/**
 * Force re-login: invalidate current session and login again with credentials.
 * Throws on failure.
 */
async function forceRelogin(
  plugin: ReturnType<typeof registry.get>,
  account: typeof schema.accounts.$inferSelect,
): Promise<SessionData> {
  if (!plugin?.auth) {
    throw new Error("セッションが無効です。アカウント設定からログインしてください");
  }
  const canAutoRelogin = plugin.manifest?.loginMethods?.includes("credentials") ?? false;
  if (!canAutoRelogin) {
    throw new Error("セッションが無効です。アカウント設定からログインしてください");
  }

  log.info(`Force re-login for account #${account.id}...`);
  const credentials = JSON.parse(account.credentials ?? "{}");
  const success = await plugin.auth.login(credentials);
  if (!success) {
    throw new Error("ログインに失敗しました。認証情報を確認してください");
  }

  if (account.cookiePath) {
    const fs = await import("fs/promises");
    const path = await import("path");
    await fs.mkdir(path.dirname(account.cookiePath), { recursive: true });
    await plugin.auth.saveSession(account.cookiePath);
    log.info(`Re-login successful for account #${account.id}`);
  }

  const session = plugin.auth.getSession();
  if (!session) {
    throw new Error("ログイン後のセッション取得に失敗しました");
  }
  return session;
}

/**
 * Execute an async operation with session retry on "セッションが無効" errors.
 * If the first attempt fails with a session error, force re-login and retry once.
 */
async function withSessionRetry<T>(
  pluginId: string,
  accountId: number | null,
  session: SessionData | null,
  fn: (session: SessionData | null) => Promise<T>,
): Promise<T> {
  try {
    return await fn(session);
  } catch (error: any) {
    if (!error.message?.includes("セッションが無効") || !accountId) throw error;

    log.warn("Session rejected by server, attempting force re-login...");
    const plugin = registry.get(pluginId);
    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();

    if (!account || !plugin?.auth) throw error;

    const retrySession = await forceRelogin(plugin, account);
    return await fn(retrySession);
  }
}

// ─── Register title ────────────────────────────────────────────────────

export interface RegisterResult {
  libraryId: number;
  title: string;
  author: string | null;
  totalVolumes: number | null;
  volumeCount: number;
  alreadyExisted: boolean;
}

/**
 * Register a title in the library.
 * If already exists, returns existing entry without modification.
 */
export async function registerTitle(
  pluginId: string,
  titleId: string,
): Promise<RegisterResult> {
  const plugin = registry.get(pluginId);
  if (!plugin?.metadata) {
    throw new Error("Plugin not found or does not support metadata");
  }

  // Check existing
  const existing = db
    .select()
    .from(schema.library)
    .where(
      and(
        eq(schema.library.pluginId, pluginId),
        eq(schema.library.titleId, titleId),
      )
    )
    .get();

  if (existing) {
    const vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, existing.id))
      .all();
    return {
      libraryId: existing.id,
      title: existing.title,
      author: existing.author,
      totalVolumes: existing.totalVolumes,
      volumeCount: vols.length,
      alreadyExisted: true,
    };
  }

  const session = await resolvePluginSession(pluginId);
  const titleInfo = await plugin.metadata.getTitleInfo(titleId, session);

  // Use canonical titleId from metadata (e.g. Kindle series ASIN)
  const canonicalTitleId = titleInfo.titleId ?? titleId;

  // Re-check with canonical titleId
  if (canonicalTitleId !== titleId) {
    const existingCanonical = db
      .select()
      .from(schema.library)
      .where(
        and(
          eq(schema.library.pluginId, pluginId),
          eq(schema.library.titleId, canonicalTitleId),
        )
      )
      .get();

    if (existingCanonical) {
      const vols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, existingCanonical.id))
        .all();
      return {
        libraryId: existingCanonical.id,
        title: existingCanonical.title,
        author: existingCanonical.author,
        totalVolumes: existingCanonical.totalVolumes,
        volumeCount: vols.length,
        alreadyExisted: true,
      };
    }
  }

  const result = db
    .insert(schema.library)
    .values({
      pluginId,
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
    libraryId: result.id,
    title: titleInfo.seriesTitle,
    author: titleInfo.author ?? null,
    totalVolumes: titleInfo.totalVolumes,
    volumeCount: titleInfo.volumes.length,
    alreadyExisted: false,
  };
}

// ─── Sync title ────────────────────────────────────────────────────────

export interface SyncResult {
  newVolumes: number;
  totalVolumes: number | null;
  checkedVolumes: number;
  availableCount: number;
  sourceUnreachable?: boolean;
}

/**
 * Full sync: refresh metadata + check availability for un-downloaded volumes.
 */
export async function syncTitle(
  libraryId: number,
  accountId: number | null,
): Promise<SyncResult> {
  const title = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!title) throw new Error("Title not found");

  const plugin = registry.get(title.pluginId);
  if (!plugin?.metadata) {
    throw new Error("Plugin does not support metadata");
  }

  const isStandalone = !plugin.availabilityChecker;

  // 1. Refresh metadata
  let titleInfo;
  try {
    const metaSession = await resolveSessionWithRelogin(title.pluginId, accountId).catch(() => null);
    titleInfo = await plugin.metadata.getTitleInfo(title.titleId, metaSession);
  } catch (error) {
    if (isStandalone) {
      // Source unreachable → mark available as unavailable
      const now = new Date().toISOString();
      const availableVols = db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.libraryId, title.id))
        .all()
        .filter((v) => v.status === "available");

      for (const vol of availableVols) {
        db.update(schema.volumes)
          .set({ status: "unavailable", checkedAt: now })
          .where(eq(schema.volumes.id, vol.id))
          .run();
      }
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Standalone sync failed for titleId=${title.titleId}: ${msg}`);
      return { newVolumes: 0, totalVolumes: null, checkedVolumes: availableVols.length, availableCount: 0, sourceUnreachable: true };
    }
    throw error;
  }

  // 2. Update library entry
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

  // 3. Recompute display_genres
  const rules = getAllRules();
  updateDisplayGenres(title.id, JSON.stringify(titleInfo.genres), rules);

  // 4. Add new volumes
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
          eq(schema.volumes.volumeNum, vol.volume),
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

  // 5. Standalone: restore unavailable → available
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
      newVolumes,
      totalVolumes: titleInfo.totalVolumes,
      checkedVolumes: unavailableVols.length,
      availableCount: unavailableVols.length,
    };
  }

  // 6. Promote free volumes
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
      db.update(schema.volumes)
        .set({ status: "unknown" as const, availabilityReason: null, checkedAt: now })
        .where(eq(schema.volumes.id, vol.id))
        .run();
    }
  }

  // 7. Check availability for non-done/queued/downloading volumes
  const checkTargetVols = db
    .select()
    .from(schema.volumes)
    .where(eq(schema.volumes.libraryId, title.id))
    .all()
    .filter((v) => v.status !== "done" && v.status !== "queued" && v.status !== "downloading");

  let availabilityResults: VolumeAvailability[] = [];
  if (checkTargetVols.length > 0 && plugin.availabilityChecker) {
    const session = await resolveSessionWithRelogin(title.pluginId, accountId);
    const volumeQueries = checkTargetVols.map((v) => ({ volume: v.volumeNum, unit: v.unit ?? "vol" }));
    availabilityResults = await withSessionRetry(
      title.pluginId, accountId, session,
      (s) => plugin.availabilityChecker!.checkAvailability(title.titleId, volumeQueries, s),
    );

    // Update volume statuses
    const checkNow = new Date().toISOString();
    for (const result of availabilityResults) {
      const vol = checkTargetVols.find(
        (v) => v.volumeNum === result.volume && (v.unit ?? "vol") === (result.unit ?? "vol"),
      );
      if (!vol || vol.status === "queued" || vol.status === "downloading") continue;

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
        checkedAt: checkNow,
      };
      if (vol.status !== "done") {
        update.status = newStatus;
      }

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
  }

  const availableCount = availabilityResults.filter((r) => r.available).length + freePromoted;

  return {
    newVolumes,
    totalVolumes: titleInfo.totalVolumes,
    checkedVolumes: checkTargetVols.length + freePromoted,
    availableCount,
  };
}

// ─── Single volume download ─────────────────────────────────────────────

export interface SingleVolumeInfo {
  volume: typeof schema.volumes.$inferSelect;
  library: typeof schema.library.$inferSelect;
}

/**
 * Find a specific volume by volumeNum in a library.
 */
export function findVolume(
  libraryId: number,
  volumeNum: number,
): SingleVolumeInfo | null {
  const lib = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();
  if (!lib) return null;

  const vol = db
    .select()
    .from(schema.volumes)
    .where(
      and(
        eq(schema.volumes.libraryId, libraryId),
        eq(schema.volumes.volumeNum, volumeNum),
      )
    )
    .get();
  if (!vol) return null;

  return { volume: vol, library: lib };
}

/**
 * Queue a single volume for download.
 * Returns the job ID, or null if the volume is not in a downloadable state.
 */
export async function queueSingleDownload(
  volumeId: number,
  accountId: number | null,
  options?: { source?: string },
): Promise<number | null> {
  const vol = db
    .select()
    .from(schema.volumes)
    .where(eq(schema.volumes.id, volumeId))
    .get();
  if (!vol || !vol.libraryId) return null;

  const lib = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, vol.libraryId))
    .get();
  if (!lib) return null;

  if (vol.status !== "available" && vol.status !== "error") return null;

  const jobId = await jobQueue.enqueue({
    pluginId: lib.pluginId,
    accountId: accountId ?? undefined,
    volumeId: vol.id,
    source: options?.source,
  });

  return jobId;
}

// ─── Volume summary helper ─────────────────────────────────────────────

export interface VolumeSummary {
  total: number;
  done: number;
  available: number;
  unavailable: number;
  unknown: number;
  queued: number;
  downloading: number;
  error: number;
}

export function getVolumeSummary(libraryId: number): VolumeSummary {
  const vols = db
    .select({ status: schema.volumes.status })
    .from(schema.volumes)
    .where(eq(schema.volumes.libraryId, libraryId))
    .all();

  const summary: VolumeSummary = {
    total: vols.length,
    done: 0,
    available: 0,
    unavailable: 0,
    unknown: 0,
    queued: 0,
    downloading: 0,
    error: 0,
  };

  for (const v of vols) {
    const s = v.status as keyof Omit<VolumeSummary, "total">;
    if (s in summary) summary[s]++;
  }

  return summary;
}

// ─── Refresh title metadata ─────────────────────────────────────────

export interface RefreshResult {
  totalVolumes: number | null;
  newVolumes: number;
}

/**
 * Refresh title metadata from plugin (re-fetch info, add new volumes).
 * Does NOT check availability.
 */
export async function refreshTitle(libraryId: number): Promise<RefreshResult> {
  const title = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!title) throw new Error("Title not found");

  const plugin = registry.get(title.pluginId);
  if (!plugin?.metadata) {
    throw new Error("Plugin does not support metadata");
  }

  const session = await resolvePluginSession(title.pluginId);
  const titleInfo = await plugin.metadata.getTitleInfo(title.titleId, session);

  // Update library entry (respect user overrides)
  const updates: Record<string, unknown> = {
    genres: JSON.stringify(titleInfo.genres),
    totalVolumes: titleInfo.totalVolumes,
    coverUrl: titleInfo.coverUrl,
    updatedAt: new Date().toISOString(),
  };
  if (!title.titleOverride) updates.title = titleInfo.seriesTitle;
  if (!title.authorOverride) updates.author = titleInfo.author;

  db.update(schema.library)
    .set(updates)
    .where(eq(schema.library.id, title.id))
    .run();

  // Recompute display_genres
  const rules = getAllRules();
  updateDisplayGenres(title.id, JSON.stringify(titleInfo.genres), rules);

  // Add new volumes
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
          eq(schema.volumes.volumeNum, vol.volume),
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
      const volUpdates: Record<string, unknown> = {};
      if (vol.thumbnailUrl && existing.thumbnailUrl !== vol.thumbnailUrl) {
        volUpdates.thumbnailUrl = vol.thumbnailUrl;
      }
      const newFreeUntil = vol.freeUntil ?? null;
      if (existing.freeUntil !== newFreeUntil) {
        volUpdates.freeUntil = newFreeUntil;
      }
      if (Object.keys(volUpdates).length > 0) {
        db.update(schema.volumes)
          .set(volUpdates)
          .where(eq(schema.volumes.id, existing.id))
          .run();
      }
    }
  }

  return { totalVolumes: titleInfo.totalVolumes, newVolumes };
}

// ─── Check availability ─────────────────────────────────────────────

export interface CheckAvailabilityResult {
  checkedVolumes: number;
  availableCount: number;
  results: VolumeAvailability[];
}

/**
 * Check download availability for volumes.
 * If targetVolumes is provided, only those volume numbers are checked.
 * Otherwise, checks unknown/unavailable/error volumes.
 */
export async function checkTitleAvailability(
  libraryId: number,
  accountId: number | null,
  options?: { targetVolumes?: number[] },
): Promise<CheckAvailabilityResult> {
  const title = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!title) throw new Error("Title not found");

  const plugin = registry.get(title.pluginId);
  if (!plugin?.availabilityChecker) {
    throw new Error("Plugin does not support availability checking");
  }

  let vols;
  if (options?.targetVolumes && options.targetVolumes.length > 0) {
    vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all()
      .filter(
        (v) =>
          options.targetVolumes!.includes(v.volumeNum) &&
          v.status !== "queued" &&
          v.status !== "downloading"
      );
  } else {
    vols = db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.libraryId, title.id))
      .all()
      .filter((v) => v.status !== "done" && v.status !== "available");
  }

  if (vols.length === 0) {
    return { checkedVolumes: 0, availableCount: 0, results: [] };
  }

  const session = await resolveSessionWithRelogin(title.pluginId, accountId);
  const volumeQueries = vols.map((v) => ({ volume: v.volumeNum, unit: v.unit ?? "vol" }));
  const results = await withSessionRetry(
    title.pluginId, accountId, session,
    (s) => plugin.availabilityChecker!.checkAvailability(title.titleId, volumeQueries, s),
  );

  // Update volume statuses
  const now = new Date().toISOString();
  for (const result of results) {
    const vol = vols.find(
      (v) => v.volumeNum === result.volume && (v.unit ?? "vol") === (result.unit ?? "vol"),
    );
    if (!vol || vol.status === "queued" || vol.status === "downloading") continue;

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

  return {
    checkedVolumes: vols.length,
    availableCount: results.filter((r) => r.available).length,
    results,
  };
}

// ─── Queue downloads (multi-mode) ───────────────────────────────────

/**
 * Queue download jobs with flexible volume selection.
 * selection: "available" | "error" | "all" | number[] (specific volumeNums)
 */
export async function queueDownloads(
  libraryId: number,
  selection: "available" | "error" | "all" | number[],
  options?: { accountId?: number; unit?: string; source?: string },
): Promise<QueueDownloadResult> {
  const title = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!title) throw new Error("Title not found");

  const plugin = registry.get(title.pluginId);
  if (!plugin) throw new Error("Plugin not found");

  const allVols = db
    .select()
    .from(schema.volumes)
    .where(eq(schema.volumes.libraryId, title.id))
    .all();

  let targetVols: typeof allVols;
  if (selection === "available") {
    targetVols = allVols.filter((v) => v.status === "available");
  } else if (selection === "error") {
    targetVols = allVols.filter((v) => v.status === "error");
  } else if (selection === "all") {
    targetVols = allVols.filter(
      (v) => v.status !== "done" && v.status !== "queued" && v.status !== "downloading",
    );
  } else {
    targetVols = allVols.filter((v) => selection.includes(v.volumeNum));
  }

  if (options?.unit) {
    targetVols = targetVols.filter((v) => (v.unit ?? "vol") === options.unit);
  }

  targetVols = targetVols.filter(
    (v) => v.status !== "queued" && v.status !== "downloading",
  );

  if (targetVols.length === 0) {
    return { queued: 0, jobIds: [], volumes: [] };
  }

  const jobIds: number[] = [];
  for (const vol of targetVols) {
    const jobId = await jobQueue.enqueue({
      pluginId: title.pluginId,
      accountId: options?.accountId,
      volumeId: vol.id,
      source: options?.source,
    });
    jobIds.push(jobId);
  }

  return {
    queued: jobIds.length,
    jobIds,
    volumes: targetVols.map((v) => v.volumeNum),
  };
}

// ─── Update title info ──────────────────────────────────────────────

export async function updateTitleInfo(
  libraryId: number,
  updates: { title?: string; author?: string },
): Promise<void> {
  const existing = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!existing) throw new Error("Title not found");

  const dbUpdates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (updates.title !== undefined) {
    dbUpdates.title = updates.title;
    dbUpdates.titleOverride = 1;
  }
  if (updates.author !== undefined) {
    dbUpdates.author = updates.author;
    dbUpdates.authorOverride = 1;
  }

  db.update(schema.library)
    .set(dbUpdates)
    .where(eq(schema.library.id, libraryId))
    .run();
}

// ─── Delete title ───────────────────────────────────────────────────

export async function deleteTitle(libraryId: number): Promise<void> {
  const title = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!title) throw new Error("Title not found");

  // Nullify volumeId references in jobs before deleting (FK constraint)
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
}

// ─── Delete volume files ────────────────────────────────────────────

export interface DeleteVolumesResult {
  deletedCount: number;
  errors: string[];
}

export async function deleteVolumeFiles(
  libraryId: number,
  volumeNums: number[],
): Promise<DeleteVolumesResult> {
  const title = db
    .select()
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .get();

  if (!title) throw new Error("Title not found");

  const allVols = db
    .select()
    .from(schema.volumes)
    .where(eq(schema.volumes.libraryId, title.id))
    .all();

  const matched = allVols.filter((v) => volumeNums.includes(v.volumeNum));
  log.info(
    `deleteVolumeFiles: requested=${volumeNums.join(",")}, matched=${matched.length}, ` +
    `statuses=${matched.map((v) => `${v.volumeNum}:${v.status}`).join(",")}`
  );

  const vols = matched.filter((v) => v.status === "done" && v.filePath);

  if (vols.length === 0) {
    throw new Error("No downloaded volumes to delete");
  }

  const fs = await import("fs/promises");
  let deletedCount = 0;
  const errors: string[] = [];

  for (const vol of vols) {
    try {
      await fs.rm(vol.filePath!, { recursive: true });
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        log.warn(`deleteVolumeFiles: failed to delete file for vol ${vol.volumeNum}: ${err.message}`);
        errors.push(`Vol ${vol.volumeNum}: ${err.message}`);
        continue;
      }
    }

    db.update(schema.volumes)
      .set({
        status: "unknown",
        filePath: null,
        fileSize: null,
        pageCount: null,
        downloadedAt: null,
      })
      .where(eq(schema.volumes.id, vol.id))
      .run();

    log.info(`deleteVolumeFiles: reset vol ${vol.volumeNum} (id=${vol.id})`);
    deletedCount++;
  }

  return { deletedCount, errors };
}
