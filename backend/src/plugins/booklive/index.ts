import type {
  Plugin,
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
import { BookLiveAuth } from "./auth.js";
import { BookLiveScraper } from "./scraper.js";
import { BinbEngine } from "../binb/engine.js";
import { logger } from "../../logger.js";
import * as cheerio from "cheerio";

/**
 * BookLive URL parser
 * Handles:
 *   https://booklive.jp/product/index/title_id/2122098             → title page
 *   https://booklive.jp/product/index/title_id/2122098/vol.2       → volume page
 *   https://booklive.jp/product/index/title_id/2122098/vol_no/002  → volume page (alt)
 *   https://booklive.jp/bviewer/?cid=2122098_002                   → reader
 */
class BookLiveUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /booklive\.jp/.test(url);
  }

  parse(url: string): ParsedUrl {
    // Reader URL: /bviewer/?cid=2122098_002
    const readerMatch = url.match(/cid=(\d+)_(\d+)/);
    if (readerMatch) {
      return {
        pluginId: "booklive",
        titleId: readerMatch[1],
        volume: parseInt(readerMatch[2]),
        type: "reader",
      };
    }

    // Volume page: /title_id/2122098/vol.2 or /title_id/2122098/vol_no/002
    const volMatch = url.match(/title_id\/(\d+)\/(?:vol\.(\d+)|vol_no\/(\d+))/);
    if (volMatch) {
      return {
        pluginId: "booklive",
        titleId: volMatch[1],
        volume: parseInt(volMatch[2] ?? volMatch[3]),
        type: "volume",
      };
    }

    // Title page: /title_id/2122098
    const titleMatch = url.match(/title_id\/(\d+)/);
    if (titleMatch) {
      return { pluginId: "booklive", titleId: titleMatch[1], type: "title" };
    }

    throw new Error("Unrecognized BookLive URL format");
  }
}

const log = logger.child({ module: "BookLive" });

/**
 * BookLive availability checker
 * Scrapes the authenticated title page HTML to detect purchased/free/not-purchased volumes.
 *
 * Per-volume detection via .button_area inside .item containers:
 *   - a.bl-bviewer.read_action with text "読む" (not "試し読み") → purchased
 *   - a.free_reading → free
 *   - a.cart_action.cart_in → not_purchased
 *
 * Volume number from data-vol attribute on buttons (zero-padded 3 digits, e.g. "002").
 */
class BookLiveAvailabilityChecker implements AvailabilityChecker {
  private readonly baseUrl = "https://booklive.jp";

  async checkAvailability(
    titleId: string,
    volumes: VolumeQuery[],
    session: SessionData | null
  ): Promise<VolumeAvailability[]> {
    const cookieString = session?.cookies
      ?.map((c) => `${c.name}=${c.value}`)
      .join("; ") ?? "";

    log.info(`Checking ${volumes.length} volume(s) for titleId=${titleId}`);

    const url = `${this.baseUrl}/product/index/title_id/${titleId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookieString,
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      log.error(`Failed to fetch title page: HTTP ${response.status}`);
      return volumes.map((vq) => ({ volume: vq.volume, available: false, reason: "unknown" }));
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Build a map of volume number → status
    const statusMap = new Map<number, {
      available: boolean;
      reason: string;
      overrideReaderUrl?: string;
      overrideContentKey?: string;
    }>();

    // Parse each volume item block
    $(".item .button_area").each((_, el) => {
      const $area = $(el);

      // Readable: a.read_action with text starting with "読む" (not "試し読み")
      // "読む" → purchased, "読む 4/9まで" → free (added to bookshelf)
      // data-title may differ from the original titleId for free volumes (e.g. 60218666 vs 10015738)
      const readBtn = $area.find("a.bl-bviewer.read_action");
      if (readBtn.length) {
        const readText = readBtn.text().trim();
        const volStr = readBtn.attr("data-vol");
        if (volStr && readText.startsWith("読む") && readText !== "試し読み") {
          const vol = parseInt(volStr, 10);
          const reason = readText === "読む" ? "purchased" : "free";
          const btnTitleId = readBtn.attr("data-title");

          let overrideReaderUrl: string | undefined;
          let overrideContentKey: string | undefined;
          if (btnTitleId && btnTitleId !== titleId) {
            const cid = `${btnTitleId}_${volStr}`;
            overrideReaderUrl = `https://booklive.jp/bviewer/?cid=${cid}`;
            overrideContentKey = cid;
          }

          statusMap.set(vol, { available: true, reason, overrideReaderUrl, overrideContentKey });
          return;
        }
      }

      // Free: a.free_reading
      // Free volumes use a different title_id (e.g. 60218666 instead of 10015738).
      // The href contains the free title_id: /purchase/product/title_id/{freeTitleId}/vol_no/{vol}/...
      // We must override the readerUrl to use cid={freeTitleId}_{vol} for full-page download.
      const freeBtn = $area.find("a.free_reading");
      if (freeBtn.length) {
        let vol: number | null = null;
        let overrideReaderUrl: string | undefined;
        let overrideContentKey: string | undefined;

        const href = freeBtn.attr("href") || "";

        // Extract free title_id and vol_no from href
        const freeTitleMatch = href.match(/title_id\/(\d+)\/vol_no\/(\d+)/);
        if (freeTitleMatch) {
          const freeTitleId = freeTitleMatch[1];
          vol = parseInt(freeTitleMatch[2], 10);
          const paddedVol = String(vol).padStart(3, "0");
          const freeCid = `${freeTitleId}_${paddedVol}`;
          overrideReaderUrl = `https://booklive.jp/bviewer/?cid=${freeCid}`;
          overrideContentKey = freeCid;
        } else {
          // Fallback: try vol_no only
          const volNoMatch = href.match(/vol_no\/(\d+)/);
          if (volNoMatch) {
            vol = parseInt(volNoMatch[1], 10);
          }
        }

        // Fallback: cart button in the same .item
        if (vol === null) {
          const $item = $area.closest(".item");
          const cartBtn = $item.find("a.cart_action[data-vol]");
          if (cartBtn.length) {
            vol = parseInt(cartBtn.attr("data-vol")!, 10);
          }
        }

        if (vol !== null) {
          statusMap.set(vol, {
            available: true,
            reason: "free",
            overrideReaderUrl,
            overrideContentKey,
          });
        }
        return;
      }

      // Not purchased: a.cart_action
      const cartBtn = $area.find("a.cart_action[data-vol]");
      if (cartBtn.length) {
        const volStr = cartBtn.attr("data-vol");
        if (volStr) {
          const vol = parseInt(volStr, 10);
          if (!statusMap.has(vol)) {
            statusMap.set(vol, { available: false, reason: "not_purchased" });
          }
        }
      }
    });

    log.info(`Parsed ${statusMap.size} volumes from HTML`);

    // Map results for requested volumes
    const results: VolumeAvailability[] = volumes.map((vq) => {
      const status = statusMap.get(vq.volume);
      if (status) {
        return {
          volume: vq.volume,
          available: status.available,
          reason: status.reason,
          overrideReaderUrl: status.overrideReaderUrl,
          overrideContentKey: status.overrideContentKey,
        };
      }
      return { volume: vq.volume, available: false, reason: "unknown" };
    });

    const availableCount = results.filter((r) => r.available).length;
    log.info(`Result: ${availableCount}/${results.length} available`);

    return results;
  }
}

class BookLiveDownloader implements Downloader {
  async *download(
    job: DownloadJob,
    session: SessionData | null
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const engine = new BinbEngine();

    try {
      await engine.init(job.readerUrl, job.outputDir, session?.cookies || null);
      return yield* engine.download(job);
    } finally {
      await engine.close();
    }
  }
}

export function createBookLivePlugin(): Plugin {
  return {
    manifest: {
      id: "booklive",
      name: "BookLive",
      version: "1.0.0",
      contentType: "series",
      loginMethods: ["credentials", "browser", "cookie_import"],
      authCookieNames: ["PHPSESSID"],
      authUrl: "https://booklive.jp/login",
      authDomain: ".booklive.jp",
      supportedFeatures: {
        search: false,
        metadata: true,
        download: true,
        auth: true,
        newReleaseCheck: false,
      },
    },
    urlParser: new BookLiveUrlParser(),
    auth: new BookLiveAuth(),
    metadata: new BookLiveScraper(),
    availabilityChecker: new BookLiveAvailabilityChecker(),
    downloader: new BookLiveDownloader(),
    async dispose() {
      log.info("Plugin disposed");
    },
  };
}
