import type {
  Plugin,
  PluginManifest,
} from "../base.js";
import { KindleUrlParser } from "./url-parser.js";
import { KindleAuth } from "./auth.js";
import { KindleMetadata, KindleAvailabilityChecker } from "./metadata.js";
import { KindleDownloader } from "./downloader.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "Kindle" });

// ----- Plugin Entry -----

export function createKindlePlugin(): Plugin {
  const manifest: PluginManifest = {
    id: "kindle",
    name: "Kindle",
    version: "1.0.0",
    contentType: "series",
    loginMethods: ["browser", "cookie_import"],
    authCookieNames: ["session-token", "at-acbjp", "x-acbjp"],
    authUrl: "https://www.amazon.co.jp/your-books",
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
