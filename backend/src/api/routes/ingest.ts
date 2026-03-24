import type { FastifyInstance } from "fastify";
import { registry } from "../../plugins/registry.js";
import {
  resolveAccountId,
  registerTitle,
  syncTitle,
  queueDownloads,
  getVolumeSummary,
} from "../../services/library.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "Ingest" });

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/ingest
   *
   * One-shot endpoint: URL → register → sync → queue downloads.
   * Used by Discord Bot and iOS Share Extension.
   *
   * Body:
   *   url: string (required)
   *   accountId?: number (optional, auto-resolved if omitted)
   *
   * Response:
   *   action: "created" | "synced"
   *   libraryId, pluginId, title, author, totalVolumes
   *   newVolumes: number (only for "synced")
   *   volumeSummary: { total, done, available, unavailable, ... }
   *   downloadQueued: number
   *   message: string (human-readable summary)
   */
  app.post("/api/ingest", async (request, reply) => {
    const { url, accountId: requestedAccountId } = request.body as {
      url: string;
      accountId?: number;
    };

    if (!url) {
      return reply.status(400).send({ error: "URL is required" });
    }

    // 1. Parse URL
    let parsed;
    try {
      parsed = registry.parseUrl(url);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: `対応していないURLです: ${msg}` });
    }

    log.info(`Ingest: ${parsed.pluginId}/${parsed.titleId} from ${url}`);

    // 2. Resolve account
    const accountId = requestedAccountId ?? resolveAccountId(parsed.pluginId);

    // 3. Register (or find existing)
    let registerResult;
    try {
      registerResult = await registerTitle(parsed.pluginId, parsed.titleId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(error, `Ingest register failed: ${msg}`);
      return reply.status(500).send({ error: `登録に失敗しました: ${msg}` });
    }

    const action = registerResult.alreadyExisted ? "synced" : "created";

    // 4. Sync (metadata refresh + availability check)
    let syncResult;
    try {
      syncResult = await syncTitle(registerResult.libraryId, accountId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(error, `Ingest sync failed: ${msg}`);

      // Return partial success — title is registered but sync failed
      const summary = getVolumeSummary(registerResult.libraryId);
      const isAuthError = msg.includes("ログイン") || msg.includes("セッション") || msg.includes("認証");

      return reply.status(isAuthError ? 401 : 500).send({
        error: `同期に失敗しました: ${msg}`,
        action,
        libraryId: registerResult.libraryId,
        pluginId: parsed.pluginId,
        title: registerResult.title,
        volumeSummary: summary,
        downloadQueued: 0,
      });
    }

    // 5. Queue available downloads
    let downloadResult;
    try {
      downloadResult = await queueDownloads(registerResult.libraryId, "available", { accountId: accountId ?? undefined, source: "api" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(error, `Ingest download queue failed: ${msg}`);
      downloadResult = { queued: 0, jobIds: [], volumes: [] };
    }

    // 6. Build response
    const summary = getVolumeSummary(registerResult.libraryId);
    const message = buildMessage(action, registerResult.title, syncResult.newVolumes, downloadResult.queued, summary);

    log.info(`Ingest complete: ${action} "${registerResult.title}" — ${message}`);

    return {
      action,
      libraryId: registerResult.libraryId,
      pluginId: parsed.pluginId,
      title: registerResult.title,
      author: registerResult.author,
      totalVolumes: syncResult.totalVolumes ?? registerResult.totalVolumes,
      newVolumes: syncResult.newVolumes,
      volumeSummary: summary,
      downloadQueued: downloadResult.queued,
      downloadVolumes: downloadResult.volumes,
      message,
    };
  });
}

function buildMessage(
  action: "created" | "synced",
  title: string,
  newVolumes: number,
  downloadQueued: number,
  summary: { total: number; done: number; available: number },
): string {
  const parts: string[] = [];

  if (action === "created") {
    parts.push(`ライブラリに登録しました: ${title}`);
  } else {
    if (newVolumes > 0) {
      parts.push(`${title}: 新しく${newVolumes}巻追加されました`);
    } else {
      parts.push(`${title}: 同期完了`);
    }
  }

  if (downloadQueued > 0) {
    parts.push(`${downloadQueued}巻のDLを開始します`);
  } else if (summary.done === summary.total && summary.total > 0) {
    parts.push(`すべてDL済みです (${summary.done}/${summary.total}巻)`);
  } else if (summary.available === 0 && summary.done < summary.total) {
    parts.push(`DL可能な巻はありません`);
  }

  return parts.join("。");
}
