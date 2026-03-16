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
} from "../base.js";
import { MomongaScraper } from "./scraper.js";
import { batchDownloadPages } from "../utils/http.js";
import { getSettingValue } from "../../api/routes/settings.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "Momonga" });

/**
 * momon:GA URL parser
 * Handles:
 *   https://momon-ga.com/fanzine/mo3807117/  -> fanzine page
 *   https://momon-ga.com/magazine/mo1234567/  -> magazine page
 */
class MomongaUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /momon-ga\.com/.test(url);
  }

  parse(url: string): ParsedUrl {
    const match = url.match(/\/(?:fanzine|magazine)\/mo(\d+)/);
    if (match) {
      return {
        pluginId: "momonga",
        titleId: match[1],
        volume: 1,
        type: "title",
      };
    }
    throw new Error("Unrecognized momon:GA URL format");
  }
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Referer: "https://momon-ga.com/",
};

/**
 * momon:GA downloader
 * Fetches static images directly via HTTP.
 */
class MomongaDownloader implements Downloader {
  private scraper: MomongaScraper;
  private concurrency: number;

  constructor(scraper: MomongaScraper, concurrency = 3) {
    this.scraper = scraper;
    this.concurrency = concurrency;
  }

  async *download(
    job: DownloadJob,
    _session: SessionData | null,
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const startTime = Date.now();

    yield { phase: "init", progress: 0, message: "Fetching image URLs" };

    const imageUrls = await this.scraper.getImageUrls(job.titleId);
    if (imageUrls.length === 0) {
      yield { phase: "error", progress: 0, message: "No images found" };
      throw new Error("No images found");
    }

    const totalPages = imageUrls.length;
    log.info(`Found ${totalPages} images for titleId=${job.titleId}`);

    let lastProgress: { totalSize: number } = { totalSize: 0 };

    for await (const progress of batchDownloadPages({
      imageUrls,
      outputDir: job.outputDir,
      headers: HEADERS,
      concurrency: this.concurrency,
      requestInterval: getSettingValue<number>("download.requestInterval") ?? 0,
      defaultExt: ".webp",
    })) {
      lastProgress = progress;
      yield {
        phase: "downloading",
        progress: progress.downloaded / progress.total,
        currentPage: progress.downloaded,
        totalPages,
        message: `Downloaded ${progress.downloaded}/${progress.total} pages`,
      };
    }

    yield {
      phase: "done",
      progress: 1.0,
      totalPages,
      message: "Download completed",
    };

    return {
      totalPages,
      totalTime: Date.now() - startTime,
      filePath: job.outputDir,
      fileSize: lastProgress.totalSize,
    };
  }
}

export function createMomongaPlugin(): Plugin {
  const scraper = new MomongaScraper();

  const manifest: PluginManifest = {
    id: "momonga",
    name: "momon:GA",
    version: "1.0.0",
    contentType: "standalone",
    supportedFeatures: {
      search: false,
      metadata: true,
      download: true,
      auth: false,
      newReleaseCheck: false,
    },
  };

  return {
    manifest,
    urlParser: new MomongaUrlParser(),
    metadata: scraper,
    downloader: new MomongaDownloader(scraper),
  };
}
