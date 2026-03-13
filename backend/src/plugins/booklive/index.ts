import type {
  Plugin,
  Downloader,
  DownloadJob,
  DownloadProgress,
  DownloadResult,
  SessionData,
  UrlParser,
  ParsedUrl,
} from "../base.js";
import { BookLiveAuth } from "./auth.js";
import { BookLiveScraper } from "./scraper.js";
import { BinbEngine } from "../binb/engine.js";

/**
 * BookLive URL parser
 * Handles:
 *   https://booklive.jp/product/index/title_id/2122098         → title page
 *   https://booklive.jp/product/index/title_id/2122098/vol.2   → volume page
 *   https://booklive.jp/bviewer/?cid=2122098_002               → reader
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

    // Volume page: /title_id/2122098/vol.2
    const volMatch = url.match(/title_id\/(\d+)\/vol\.(\d+)/);
    if (volMatch) {
      return {
        pluginId: "booklive",
        titleId: volMatch[1],
        volume: parseInt(volMatch[2]),
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

class BookLiveDownloader implements Downloader {
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

export function createBookLivePlugin(options?: {
  headless?: boolean;
  executablePath?: string;
  cookieFile?: string;
}): Plugin {
  const headless = options?.headless ?? true;
  const executablePath = options?.executablePath ?? process.env.CHROME_EXECUTABLE_PATH;
  const cookieFile = options?.cookieFile ?? "booklive_cookies.json";

  return {
    manifest: {
      id: "booklive",
      name: "BookLive",
      version: "1.0.0",
      supportedFeatures: {
        search: false,
        metadata: true,
        download: true,
        auth: true,
        newReleaseCheck: false,
      },
    },
    urlParser: new BookLiveUrlParser(),
    auth: new BookLiveAuth(cookieFile),
    metadata: new BookLiveScraper(),
    // availabilityChecker: not implemented yet (mock auth)
    downloader: new BookLiveDownloader(headless, executablePath),
    async dispose() {},
  };
}
