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
import { NhentaiScraper } from "./scraper.js";
import { batchDownloadPages } from "../utils/http.js";
import { getSettingValue } from "../../api/routes/settings.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "nHentai" });

/**
 * nhentai URL parser
 * Handles:
 *   https://nhentai.net/g/520967/      -> gallery page
 *   https://nhentai.net/g/520967/5/    -> specific page (treated as gallery)
 */
class NhentaiUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /nhentai\.net/.test(url);
  }

  parse(url: string): ParsedUrl {
    const match = url.match(/\/g\/(\d+)/);
    if (match) {
      return {
        pluginId: "nhentai",
        titleId: match[1],
        volume: 1,
        type: "title",
      };
    }
    throw new Error("Unrecognized nhentai URL format");
  }
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Referer: "https://nhentai.net/",
};

/**
 * nhentai downloader
 * Fetches images directly via HTTP from i.nhentai.net.
 */
class NhentaiDownloader implements Downloader {
  private scraper: NhentaiScraper;
  private concurrency: number;

  constructor(scraper: NhentaiScraper, concurrency = 3) {
    this.scraper = scraper;
    this.concurrency = concurrency;
  }

  async *download(
    job: DownloadJob,
    _session: SessionData | null,
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const startTime = Date.now();

    yield { phase: "init", progress: 0, message: "Fetching image URLs from API" };

    const imageUrls = await this.scraper.getImageUrls(job.titleId);
    if (imageUrls.length === 0) {
      yield { phase: "error", progress: 0, message: "No images found" };
      throw new Error("No images found");
    }

    const totalPages = imageUrls.length;
    log.info(`Found ${totalPages} images for galleryId=${job.titleId}`);

    let lastProgress: { totalSize: number } = { totalSize: 0 };

    for await (const progress of batchDownloadPages({
      imageUrls,
      outputDir: job.outputDir,
      headers: HEADERS,
      concurrency: this.concurrency,
      requestInterval: getSettingValue<number>("download.requestInterval") ?? 0,
      defaultExt: ".jpg",
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

export function createNhentaiPlugin(): Plugin {
  const scraper = new NhentaiScraper();

  const manifest: PluginManifest = {
    id: "nhentai",
    name: "nHentai",
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
    urlParser: new NhentaiUrlParser(),
    metadata: scraper,
    downloader: new NhentaiDownloader(scraper),
  };
}
