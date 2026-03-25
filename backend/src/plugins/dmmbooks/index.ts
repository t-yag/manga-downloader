import type {
  Plugin,
  PluginManifest,
  Downloader,
  DownloadJob,
  DownloadProgress,
  DownloadResult,
  SessionData,
  UrlParser,
  ParsedUrl,
  AvailabilityChecker,
  VolumeAvailability,
  VolumeQuery,
} from "../base.js";
import { DmmBooksAuth } from "./auth.js";
import { DmmBooksScraper, buildCookieString } from "./scraper.js";
import { PubLusEngine } from "../publus/engine.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "DmmBooks" });

// ----- URL Parser -----

/**
 * DMMBooks URL parser
 * Handles:
 *   https://book.dmm.com/product/{seriesId}/{contentId}/               → title page
 *   https://book.dmm.com/product/{seriesId}/{contentId}/free_streaming/ → reader (free)
 *   https://book.dmm.co.jp/product/{seriesId}/{contentId}/             → adult title page
 *
 * titleId is encoded as "seriesId:contentId" for internal use.
 */
class DmmBooksUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /book\.dmm\.(?:com|co\.jp)\/product\//.test(url);
  }

  parse(url: string): ParsedUrl {
    // Reader URL: /product/{seriesId}/{contentId}/free_streaming/
    // or /product/{seriesId}/{contentId}/streaming/
    const readerMatch = url.match(
      /book\.dmm\.(?:com|co\.jp)\/product\/(\d+)\/([a-zA-Z0-9]+)\/(?:free_)?streaming\//,
    );
    if (readerMatch) {
      return {
        pluginId: "dmmbooks",
        titleId: `${readerMatch[1]}:${readerMatch[2]}`,
        type: "reader",
      };
    }

    // Title/volume page: /product/{seriesId}/{contentId}/
    const productMatch = url.match(
      /book\.dmm\.(?:com|co\.jp)\/product\/(\d+)\/([a-zA-Z0-9]+)/,
    );
    if (productMatch) {
      return {
        pluginId: "dmmbooks",
        titleId: `${productMatch[1]}:${productMatch[2]}`,
        type: "title",
      };
    }

    throw new Error("Unrecognized DMMBooks URL format");
  }
}

// ----- Availability Checker -----

/**
 * DMMBooks availability checker.
 * Uses /ajax/bff/contents_book/ to check purchased status.
 * The `purchased` field is non-null when the user owns the volume (requires auth cookies).
 * The `free_streaming_url` array is non-empty when free reading is available.
 */
class DmmBooksAvailabilityChecker implements AvailabilityChecker {
  async checkAvailability(
    titleId: string,
    volumes: VolumeQuery[],
    session: SessionData | null,
  ): Promise<VolumeAvailability[]> {
    const sep = titleId.indexOf(":");
    const seriesId = sep >= 0 ? titleId.slice(0, sep) : titleId;
    // TODO: book.dmm.co.jp (adult) requires shopName="adult"
    const shopName = "general";

    log.info(
      `Checking ${volumes.length} volume(s) for seriesId=${seriesId}`,
    );

    const cookieString = buildCookieString(session);

    // Fetch all volumes (paginated)
    const perPage = 100;
    const allBooks: Array<{
      volume_number: number;
      purchased: unknown;
      free_streaming_url: string[] | null;
      limited_free: { end: string | null } | null;
      sell: unknown;
    }> = [];

    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const url = `https://book.dmm.com/ajax/bff/contents_book/?shop_name=${shopName}&series_id=${seriesId}&per_page=${perPage}&page=${page}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
          Referer: "https://book.dmm.com/",
          ...(cookieString ? { Cookie: cookieString } : {}),
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        log.error(`contents_book API failed: HTTP ${response.status}`);
        return volumes.map((vq) => ({
          volume: vq.volume,
          available: false,
          reason: "unknown",
        }));
      }

      const data = (await response.json()) as {
        volume_books: typeof allBooks;
        pager: { page: number; per_page: number; total_count: number };
      };

      allBooks.push(...data.volume_books);
      totalPages = Math.ceil(data.pager.total_count / perPage);
      page++;
    }

    // Build volume status map
    const statusMap = new Map<
      number,
      { available: boolean; reason: string }
    >();

    for (const book of allBooks) {
      if (book.purchased != null) {
        statusMap.set(book.volume_number, {
          available: true,
          reason: "purchased",
        });
      } else if (
        book.free_streaming_url &&
        book.free_streaming_url.length > 0
      ) {
        statusMap.set(book.volume_number, {
          available: true,
          reason: "free",
        });
      } else {
        statusMap.set(book.volume_number, {
          available: false,
          reason: "not_purchased",
        });
      }
    }

    const results: VolumeAvailability[] = volumes.map((vq) => {
      const status = statusMap.get(vq.volume);
      if (status) {
        return { volume: vq.volume, ...status };
      }
      return { volume: vq.volume, available: false, reason: "unknown" };
    });

    const availableCount = results.filter((r) => r.available).length;
    log.info(`Result: ${availableCount}/${results.length} available`);

    return results;
  }
}

// ----- Downloader -----

class DmmBooksDownloader implements Downloader {
  async *download(
    job: DownloadJob,
    session: SessionData | null,
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const engine = new PubLusEngine();

    try {
      await engine.init(job.readerUrl, job.outputDir, session?.cookies || null);
      return yield* engine.download(job);
    } finally {
      await engine.close();
    }
  }
}

// ----- Plugin Entry -----

export function createDmmBooksPlugin(): Plugin {
  const manifest: PluginManifest = {
    id: "dmmbooks",
    name: "DMMブックス",
    version: "0.1.0",
    contentType: "series",
    loginMethods: ["credentials", "browser", "cookie_import"],
    authCookieNames: ["login_session_id", "secid"],
    authUrl: "https://accounts.dmm.com/service/login/password",
    authDomain: ".dmm.com",
    supportedFeatures: {
      search: false,
      metadata: true,
      download: true,
      auth: true,
      newReleaseCheck: false,
    },
  };

  return {
    manifest,
    urlParser: new DmmBooksUrlParser(),
    auth: new DmmBooksAuth(),
    metadata: new DmmBooksScraper(),
    availabilityChecker: new DmmBooksAvailabilityChecker(),
    downloader: new DmmBooksDownloader(),
    async dispose() {
      log.info("Plugin disposed");
    },
  };
}
