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
} from "../base.js";
import { CmoaAuth } from "./auth.js";
import { CmoaScraper } from "./scraper.js";
import { BinbEngine } from "../binb/engine.js";
import { logger } from "../../logger.js";
import axios from "axios";

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
 * Uses bibGetCntntInfo API to check if volumes are accessible
 */
class CmoaAvailabilityChecker implements AvailabilityChecker {
  /** Delay between API requests to avoid CMOA rate limiting (ms) */
  private readonly REQUEST_DELAY = 1500;
  /** Max retries for rate-limited requests */
  private readonly MAX_RETRIES = 2;

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async checkAvailability(
    titleId: string,
    volumes: number[],
    session: SessionData | null
  ): Promise<VolumeAvailability[]> {
    const results: VolumeAvailability[] = [];

    const cookieString = session?.cookies
      ?.map((c) => `${c.name}=${c.value}`)
      .join("; ") ?? "";

    log.info(`Checking ${volumes.length} volume(s) for titleId=${titleId}`);

    for (let i = 0; i < volumes.length; i++) {
      const vol = volumes[i];

      // Delay between requests to avoid rate limiting (skip first request)
      if (i > 0) {
        await this.delay(this.REQUEST_DELAY);
      }

      const result = await this.checkSingleVolume(titleId, vol, cookieString);
      results.push(result);
    }

    const purchased = results.filter((r) => r.available).length;
    log.info(`Done: ${purchased}/${results.length} available`);

    return results;
  }

  private async checkSingleVolume(
    titleId: string,
    vol: number,
    cookieString: string,
    attempt = 0,
  ): Promise<VolumeAvailability> {
    try {
      const paddedTitleId = String(titleId).padStart(10, "0");
      const cid = `${paddedTitleId}_jp_${String(vol).padStart(4, "0")}`;
      const dmytime = Date.now();

      const response = await axios.get(
        `https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php?cid=${cid}&dmytime=${dmytime}&k=testKey&u0=0&u1=0`,
        {
          headers: {
            Accept: "*/*",
            Cookie: cookieString,
            Referer: "https://www.cmoa.jp/",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
          timeout: 10000,
        }
      );

      const data = response.data;
      const item = data.items?.[0];
      log.debug(`vol=${vol} cid=${cid} result=${data.result} items=${data.items?.length ?? 0}`);

      // Detect rate-limited response: result=0 but items exist with empty ViewMode
      const isRateLimited = Number(data.result) === 0 && data.items?.length > 0 && !item?.ViewMode;
      if (isRateLimited && attempt < this.MAX_RETRIES) {
        const backoff = this.REQUEST_DELAY * (attempt + 2);
        log.warn(`vol=${vol} rate-limited, retrying in ${backoff}ms (attempt ${attempt + 1}/${this.MAX_RETRIES})`);
        await this.delay(backoff);
        return this.checkSingleVolume(titleId, vol, cookieString, attempt + 1);
      }

      if (Number(data.result) === 0 || !data.items?.length) {
        return { volume: vol, available: false, reason: isRateLimited ? "rate_limited" : "not_purchased" };
      }

      const isFullAccess =
        Number(item.ViewMode) === 1 &&
        (!item.LastPageURL || item.LastPageURL.includes("sample_flg=0"));

      return {
        volume: vol,
        available: isFullAccess,
        reason: isFullAccess ? "purchased" : "not_purchased",
      };
    } catch (error: any) {
      log.error(`vol=${vol} error: ${error.message}`);
      return { volume: vol, available: false, reason: "unknown" };
    }
  }
}

/**
 * Cmoa downloader using shared BINB engine
 */
class CmoaDownloader implements Downloader {
  private headless: boolean;
  private executablePath?: string;

  constructor(headless = true, executablePath?: string) {
    this.headless = headless;
    this.executablePath = executablePath;
  }

  async *download(
    job: DownloadJob,
    session: SessionData | null
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const engine = new BinbEngine(this.headless, this.executablePath);

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
    downloader: new CmoaDownloader(true, process.env.CHROME_EXECUTABLE_PATH),
    async dispose() {
      log.info("Plugin disposed");
    },
  };
}
