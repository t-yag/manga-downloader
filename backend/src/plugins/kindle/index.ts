import type {
  Plugin,
  PluginManifest,
  UrlParser,
  ParsedUrl,
} from "../base.js";
import { KindleAuth } from "./auth.js";
import { KindleMetadata, KindleAvailabilityChecker } from "./metadata.js";
import { KindleDownloader } from "./downloader.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "Kindle" });

// ----- URL Parser -----

class KindleUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /read\.amazon\.co\.jp|amazon\.co\.jp\//.test(url) && /\/(?:dp|gp\/product)\/[A-Z0-9]+/.test(url);
  }

  parse(url: string): ParsedUrl {
    // Reader: https://read.amazon.co.jp/manga/<ASIN>
    const readerMatch = url.match(/read\.amazon\.co\.jp\/manga\/([A-Z0-9]+)/);
    if (readerMatch) {
      return {
        pluginId: "kindle",
        titleId: readerMatch[1],
        type: "reader",
      };
    }

    // Kindle library manga-wr redirect: https://read.amazon.co.jp/kindle-library/manga-wr/<ASIN>
    const mangaWrMatch = url.match(/read\.amazon\.co\.jp\/kindle-library\/manga-wr\/([A-Z0-9]+)/);
    if (mangaWrMatch) {
      return {
        pluginId: "kindle",
        titleId: mangaWrMatch[1],
        type: "reader",
      };
    }

    // Product page: https://www.amazon.co.jp/dp/<ASIN> or /gp/product/<ASIN>
    // Also handles slugged URLs like /タイトル-著者-ebook/dp/<ASIN>/ref=...
    const dpMatch = url.match(/amazon\.co\.jp\/.*(?:dp|gp\/product)\/([A-Z0-9]+)/);
    if (dpMatch) {
      return {
        pluginId: "kindle",
        titleId: dpMatch[1],
        type: "title",
      };
    }

    throw new Error("Unrecognized Kindle URL format");
  }
}

// ----- Plugin Entry -----

export function createKindlePlugin(): Plugin {
  const manifest: PluginManifest = {
    id: "kindle",
    name: "Kindle",
    version: "1.0.0",
    contentType: "series",
    loginMethods: ["browser", "cookie_import"],
    authCookieNames: ["session-token", "at-acbjp", "x-acbjp"],
    authUrl: "https://read.amazon.co.jp/kindle-library",
    authDomain: ".amazon.co.jp",
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
    urlParser: new KindleUrlParser(),
    auth: new KindleAuth(manifest.authCookieNames!),
    metadata: new KindleMetadata(),
    availabilityChecker: new KindleAvailabilityChecker(),
    downloader: new KindleDownloader(),
    async dispose() {
      log.info("Plugin disposed");
    },
  };
}
