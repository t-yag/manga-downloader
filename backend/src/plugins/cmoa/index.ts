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
import { CmoaAuth } from "./auth.js";
import { CmoaScraper } from "./scraper.js";
import { BinbEngine } from "../binb/engine.js";
import { logger } from "../../logger.js";
import * as cheerio from "cheerio";

const log = logger.child({ module: "Cmoa" });

/**
 * Cmoa URL parser
 * Handles:
 *   https://www.cmoa.jp/title/99473/           → title page
 *   https://www.cmoa.jp/title/99473/vol/2/      → volume page
 *   https://www.cmoa.jp/reader/browserviewer/?content_id=... → reader
 */
class CmoaUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /cmoa\.jp/.test(url);
  }

  parse(url: string): ParsedUrl {
    // Reader URL: /reader/browserviewer/?content_id=10000994730001
    const readerMatch = url.match(/content_id=(\d{4})(\d{7})(\d{4})/);
    if (readerMatch) {
      const titleId = String(parseInt(readerMatch[2]));
      const volume = parseInt(readerMatch[3]);
      return { pluginId: "cmoa", titleId, volume, type: "reader" };
    }

    // Volume page: /title/99473/vol/2/
    const volMatch = url.match(/\/title\/(\d+)\/vol\/(\d+)/);
    if (volMatch) {
      return { pluginId: "cmoa", titleId: volMatch[1], volume: parseInt(volMatch[2]), type: "volume" };
    }

    // Title page: /title/99473/
    const titleMatch = url.match(/\/title\/(\d+)/);
    if (titleMatch) {
      return { pluginId: "cmoa", titleId: titleMatch[1], type: "title" };
    }

    throw new Error("Unrecognized cmoa URL format");
  }
}

/**
 * Cmoa availability checker
 * Scrapes the authenticated title page HTML to detect purchased/free volumes.
 * Purchased volumes have `/reader/browserviewer/?content_id=...` links.
 * Free volumes have `/reader/sample/?content_id=...` links with GA_free class.
 * All other volumes are considered not purchased.
 *
 * This approach requires only 1-2 HTTP requests (paginated title pages)
 * instead of N per-volume API calls.
 */
class CmoaAvailabilityChecker implements AvailabilityChecker {
  private readonly baseUrl = "https://www.cmoa.jp";

  async checkAvailability(
    titleId: string,
    volumes: VolumeQuery[],
    session: SessionData | null
  ): Promise<VolumeAvailability[]> {
    const cookieString = session?.cookies
      ?.map((c) => `${c.name}=${c.value}`)
      .join("; ") ?? "";

    log.info(`Checking ${volumes.length} volume(s) for titleId=${titleId} via HTML scraping`);

    // Fetch all paginated title pages and collect purchased volume numbers
    // Purchased volumes have `/reader/browserviewer/?content_id=...` links.
    // All other volumes (with sample/trial links or cart buttons) are not purchased.
    const purchased = new Set<number>();

    let page = 1;
    let hasNext = true;
    while (hasNext) {
      const url = `${this.baseUrl}/title/${titleId}/?page=${page}&order=up`;
      log.debug(`Fetching title page ${page}: ${url}`);

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Cookie: cookieString,
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        log.error(`Failed to fetch title page ${page}: HTTP ${response.status}`);
        break;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Purchased volumes: browserviewer links with content_id
      $('a[href*="reader/browserviewer"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const match = href.match(/content_id=\d(\d{10})(\d{4})/);
        if (match) purchased.add(parseInt(match[2], 10));
      });

      // Check for next page
      const nextLink = $(`.pagination a[href*="page=${page + 1}"]`);
      hasNext = nextLink.length > 0;
      page++;
    }

    log.info(`HTML scrape done (${page - 1} page(s)): ${purchased.size} purchased`);

    // Map results for requested volumes
    const results: VolumeAvailability[] = volumes.map((vq) => {
      if (purchased.has(vq.volume)) {
        return { volume: vq.volume, available: true, reason: "purchased" };
      }
      return { volume: vq.volume, available: false, reason: "not_purchased" };
    });

    const availableCount = results.filter((r) => r.available).length;
    log.info(`Result: ${availableCount}/${results.length} available`);

    return results;
  }
}

/**
 * Cmoa downloader using shared BINB engine
 */
class CmoaDownloader implements Downloader {
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

export function createCmoaPlugin(): Plugin {
  const manifest: PluginManifest = {
    id: "cmoa",
    name: "コミックシーモア",
    version: "1.0.0",
    contentType: "series",
    loginMethods: ["credentials"],
    authCookieNames: ["_ssid_", "_cmoa_login_session_token_", "prod_member_db_session"],
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
    urlParser: new CmoaUrlParser(),
    auth: new CmoaAuth(),
    metadata: new CmoaScraper(),
    availabilityChecker: new CmoaAvailabilityChecker(),
    downloader: new CmoaDownloader(),
    async dispose() {
      log.info("Plugin disposed");
    },
  };
}
