import { Browser, Page } from "puppeteer";
import sharp from "sharp";
import * as cheerio from "cheerio";
import path from "path";
import fs from "fs/promises";
import type {
  Plugin,
  PluginManifest,
  Downloader,
  DownloadJob,
  DownloadProgress,
  DownloadResult,
  SessionData,
  CookieData,
  UrlParser,
  ParsedUrl,
  AvailabilityChecker,
  VolumeAvailability,
  VolumeQuery,
} from "../base.js";
import { PiccomaAuth } from "./auth.js";
import { PiccomaScraper } from "./scraper.js";
import { launchBrowser } from "../browser.js";
import { fetchWithRetry } from "../utils/http.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "Piccoma" });

const PICCOMA_BASE = "https://piccoma.com/web";
const TILE_SIZE = 50;

// ----- URL Parser -----

class PiccomaUrlParser implements UrlParser {
  canHandle(url: string): boolean {
    return /piccoma\.com\/web/.test(url);
  }

  parse(url: string): ParsedUrl {
    // Viewer: /web/viewer/149372/3788870
    const viewerMatch = url.match(/\/web\/viewer\/(\d+)\/(\d+)/);
    if (viewerMatch) {
      return {
        pluginId: "piccoma",
        titleId: viewerMatch[1],
        type: "reader",
      };
    }

    // Product: /web/product/149372
    const productMatch = url.match(/\/web\/product\/(\d+)/);
    if (productMatch) {
      return {
        pluginId: "piccoma",
        titleId: productMatch[1],
        type: "title",
      };
    }

    throw new Error("Unrecognized piccoma URL format");
  }
}

// ----- Descramble -----

class ARC4 {
  i = 0;
  j = 0;
  S: number[] = [];

  constructor(key: number[]) {
    const s: number[] = [];
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + (key[i % key.length] || 0)) & 255;
      [s[i], s[j]] = [s[j], s[i]];
    }
    this.S = s;
    for (let i = 0; i < 256; i++) this.g(1);
  }

  g(count: number): number {
    let r = 0;
    let { i, j, S } = this;
    while (count--) {
      i = (i + 1) & 255;
      j = (j + S[i]) & 255;
      [S[i], S[j]] = [S[j], S[i]];
      r = r * 256 + S[(S[i] + S[j]) & 255];
    }
    this.i = i;
    this.j = j;
    return r;
  }
}

function seedrandom(seed: string): () => number {
  const key: number[] = [];
  let smear = 0;
  for (let j = 0; j < seed.length; j++) {
    key[255 & j] = 255 & ((smear ^= key[255 & j] * 19) + seed.charCodeAt(j));
  }
  const arc4 = new ARC4(key);
  return () => {
    let n = arc4.g(6);
    let d = 281474976710656;
    let x = 0;
    while (n < 4503599627370496) {
      n = (n + x) * 256;
      d *= 256;
      x = arc4.g(1);
    }
    while (n >= 9007199254740992) {
      n /= 2;
      d /= 2;
      x >>>= 1;
    }
    return (n + x) / d;
  };
}

function shuffleWithSeed(arr: number[], seed: string): number[] {
  const rng = seedrandom(seed);
  const indices = arr.map((_, i) => i);
  const shuffled: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const idx = Math.floor(rng() * indices.length);
    shuffled.push(arr[indices[idx]]);
    indices.splice(idx, 1);
  }
  return shuffled;
}

interface TileInfo {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getGroupCols(tiles: TileInfo[]): number {
  if (tiles.length <= 1) return tiles.length;
  const firstY = tiles[0].y;
  for (let i = 1; i < tiles.length; i++) {
    if (tiles[i].y !== firstY) return i;
  }
  return tiles.length;
}

async function descrambleImage(inputBuf: Buffer, seed: string): Promise<Buffer> {
  const meta = await sharp(inputBuf).metadata();
  const imgWidth = meta.width!;
  const imgHeight = meta.height!;

  const cols = Math.ceil(imgWidth / TILE_SIZE);
  const rows = Math.ceil(imgHeight / TILE_SIZE);
  const totalTiles = cols * rows;

  const tileGroups: Record<string, TileInfo[]> = {};
  for (let idx = 0; idx < totalTiles; idx++) {
    const row = Math.floor(idx / cols);
    const col = idx - row * cols;
    const x = col * TILE_SIZE;
    const y = row * TILE_SIZE;
    const w = TILE_SIZE - (x + TILE_SIZE <= imgWidth ? 0 : x + TILE_SIZE - imgWidth);
    const h = TILE_SIZE - (y + TILE_SIZE <= imgHeight ? 0 : y + TILE_SIZE - imgHeight);
    const key = `${w}-${h}`;
    if (!tileGroups[key]) tileGroups[key] = [];
    tileGroups[key].push({ x, y, width: w, height: h });
  }

  const rawData = await sharp(inputBuf).ensureAlpha().raw().toBuffer();
  const outData = Buffer.alloc(imgWidth * imgHeight * 4);

  for (const key of Object.keys(tileGroups)) {
    const tiles = tileGroups[key];
    const groupCols = getGroupCols(tiles);
    const indices = tiles.map((_, i) => i);
    const shuffled = shuffleWithSeed(indices, seed);

    for (let i = 0; i < tiles.length; i++) {
      const destTile = tiles[i];
      const srcIdx = shuffled[i];
      const srcRow = Math.floor(srcIdx / groupCols);
      const srcCol = srcIdx - srcRow * groupCols;
      const srcX = tiles[0].x + srcCol * destTile.width;
      const srcY = tiles[0].y + srcRow * destTile.height;

      for (let py = 0; py < destTile.height; py++) {
        const srcOff = ((srcY + py) * imgWidth + srcX) * 4;
        const dstOff = ((destTile.y + py) * imgWidth + destTile.x) * 4;
        rawData.copy(outData, dstOff, srcOff, srcOff + destTile.width * 4);
      }
    }
  }

  return sharp(outData, {
    raw: { width: imgWidth, height: imgHeight, channels: 4 },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

// ----- Availability Checker -----

/**
 * Piccoma availability checker.
 * Uses fetch + cheerio (no browser) to check episode/volume status via HTML.
 *
 * Episode status classes:
 *   PCM-epList_status_free      → ¥0 (free)
 *   PCM-epList_status_waitfree  → 待てば¥0 (wait-for-free)
 *   PCM-epList_status_point     → has coin price (not purchased)
 *   PCM-epList_status_buy       → purchased
 *
 * Volume status: determined by li class names and button types.
 */
class PiccomaAvailabilityChecker implements AvailabilityChecker {
  private buildCookieString(session: SessionData | null): string {
    return session?.cookies?.map((c) => `${c.name}=${c.value}`).join("; ") ?? "";
  }

  private async fetchHtml(url: string, cookieString: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: cookieString,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    return response.text();
  }

  async checkAvailability(
    titleId: string,
    volumes: VolumeQuery[],
    session: SessionData | null,
  ): Promise<VolumeAvailability[]> {
    const epQueries = volumes.filter((v) => (v.unit ?? "vol") === "ep");
    const volQueries = volumes.filter((v) => (v.unit ?? "vol") === "vol");
    log.info(`Checking availability: ${epQueries.length} ep(s), ${volQueries.length} vol(s), titleId=${titleId}`);

    const cookieString = this.buildCookieString(session);
    const results: VolumeAvailability[] = [];

    // Check episodes (話読み)
    if (epQueries.length > 0) {
      const url = `${PICCOMA_BASE}/product/${titleId}/episodes?etype=E`;
      const html = await this.fetchHtml(url, cookieString);
      const $ = cheerio.load(html);

      // Verify login state
      if (session?.cookies?.length && $(".PCM-headerMainLogin_loginButton").length > 0) {
        throw new Error("セッションが無効です。再ログインしてください");
      }

      const statusMap = new Map<number, string>();
      $("a[data-episode_id]").each((i, el) => {
        const statusArea = $(el).find(".PCM-epList_status");
        const statusHtml = statusArea.html() ?? "";

        let status = "unknown";
        if (statusHtml.includes("epList_status_buy")) {
          status = "purchased";
        } else if (statusHtml.includes("epList_status_free") && !statusHtml.includes("waitfree")) {
          status = "free";
        } else if (statusHtml.includes("waitfreeRead")) {
          status = "waitfree_read";
        } else if (statusHtml.includes("waitfree")) {
          status = "wait_free";
        } else if (statusHtml.includes("epList_status_point")) {
          status = "priced";
        }

        statusMap.set(i + 1, status);
      });

      for (const vq of epQueries) {
        const status = statusMap.get(vq.volume);
        if (!status) {
          results.push({ volume: vq.volume, unit: "ep", available: false, reason: "unknown" });
        } else if (status === "purchased" || status === "free" || status === "waitfree_read") {
          results.push({ volume: vq.volume, unit: "ep", available: true, reason: status });
        } else if (status === "wait_free") {
          results.push({ volume: vq.volume, unit: "ep", available: false, reason: "wait_free" });
        } else if (status === "priced") {
          results.push({ volume: vq.volume, unit: "ep", available: false, reason: "not_purchased" });
        } else {
          results.push({ volume: vq.volume, unit: "ep", available: false, reason: "unknown" });
        }
      }
    }

    // Check volumes (巻読み)
    if (volQueries.length > 0) {
      const volUrl = `${PICCOMA_BASE}/product/${titleId}/episodes?etype=V`;
      const html = await this.fetchHtml(volUrl, cookieString);
      const $ = cheerio.load(html);

      // Verify login state (if episodes were skipped)
      if (epQueries.length === 0 && session?.cookies?.length && $(".PCM-headerMainLogin_loginButton").length > 0) {
        throw new Error("セッションが無効です。再ログインしてください");
      }

      const volStatusMap = new Map<number, string>();
      let idx = 0;
      $(".PCM-productSaleList_volume li").each((_, el) => {
        const li = $(el);
        if (!li.find(".PCM-prdVol_title h2").length) return;
        idx++;
        const liClass = li.attr("class") ?? "";

        let status = "unknown";
        if (liClass.includes("campaign_free")) {
          status = "free";
        } else if (liClass.includes("campaign_buy") || liClass.includes("prdVol_buy")) {
          status = "purchased";
        } else if (li.find(".PCM-prdVol_buyBtn[data-episode_id]").length) {
          status = "not_purchased";
        }

        volStatusMap.set(idx, status);
      });

      for (const vq of volQueries) {
        const status = volStatusMap.get(vq.volume);
        if (!status) {
          results.push({ volume: vq.volume, unit: "vol", available: false, reason: "unknown" });
        } else if (status === "free" || status === "purchased") {
          results.push({ volume: vq.volume, unit: "vol", available: true, reason: status });
        } else {
          results.push({ volume: vq.volume, unit: "vol", available: false, reason: "not_purchased" });
        }
      }
    }

    const availableCount = results.filter((r) => r.available).length;
    log.info(`Availability: ${availableCount}/${results.length} available`);

    return results;
  }
}

// ----- Downloader -----

class PiccomaDownloader implements Downloader {
  async *download(
    job: DownloadJob,
    session: SessionData | null,
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    yield { phase: "init", progress: 0, message: "Initializing..." };

    const startTime = Date.now();

    const browser = await launchBrowser();
    const page = await browser.newPage();

    try {
      // Set cookies
      if (session?.cookies?.length) {
        await page.setCookie(
          ...session.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || "/",
            expires: c.expires,
          })),
        );
      }

      yield { phase: "loading", progress: 0.05, message: "Loading viewer..." };

      // Navigate to viewer
      await page.goto(job.readerUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await new Promise((r) => setTimeout(r, 3000));

      // Check if we were redirected away from the viewer (= no access or wrong episode_id)
      let currentUrl = page.url();
      if (!currentUrl.includes("/viewer/")) {
        log.warn(`Viewer redirected to ${currentUrl}, attempting to resolve correct viewer URL...`);

        // Try to find the correct viewer URL from the volume list page with session cookies
        const resolvedUrl = await this.resolveVolumeViewerUrl(page, job.titleId, job.volume);
        if (resolvedUrl) {
          log.info(`Resolved viewer URL: ${resolvedUrl}`);
          await page.goto(resolvedUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await new Promise((r) => setTimeout(r, 3000));
          currentUrl = page.url();
        }

        if (!currentUrl.includes("/viewer/")) {
          await browser.close();
          throw new Error(
            `この巻は閲覧できません（未購入またはアクセス権なし）。リダイレクト先: ${currentUrl}`,
          );
        }
      }

      // Extract _pdata_ and seed from page
      const viewerData: any = await page.evaluate(`(function() {
        var pdata = window._pdata_;
        if (!pdata) return null;

        var results = [];
        for (var i = 0; i < pdata.img.length; i++) {
          var imgPath = pdata.img[i].path;
          if (!imgPath) continue;
          var urlPath = imgPath.split("?")[0];
          var qs = imgPath.split("?")[1] || "";

          var checksum = urlPath.split("/").slice(-2)[0];
          var params = qs.split("&").reduce(function(acc, pair) {
            var kv = pair.split("=");
            acc[kv[0]] = kv[1];
            return acc;
          }, {});
          var expires = params.expires || "";

          var sum = 0;
          for (var j = 0; j < expires.length; j++) {
            sum += parseInt(expires[j]) || 0;
          }
          var offset = sum % checksum.length;
          var rawSeed = offset === 0 ? checksum : checksum.slice(-offset) + checksum.slice(0, -offset);

          var seed = rawSeed;
          try {
            if (typeof window.dd === "function") {
              seed = window.dd(rawSeed);
            }
          } catch(e) {}

          results.push({
            url: imgPath.startsWith("//") ? "https:" + imgPath : imgPath,
            width: pdata.img[i].width,
            height: pdata.img[i].height,
            seed: seed,
          });
        }

        return {
          productId: pdata.product_id,
          episodeId: pdata.episode_id,
          title: pdata.title,
          isScrambled: pdata.isScrambled,
          scroll: pdata.scroll,
          category: pdata.category,
          images: results,
        };
      })()`);

      if (!viewerData) {
        throw new Error("Failed to extract viewer data (_pdata_ not found)");
      }

      const totalPages = viewerData.images.length;
      log.info(
        `Episode "${viewerData.title}": ${totalPages} pages, scrambled=${viewerData.isScrambled}`,
      );

      yield {
        phase: "downloading",
        progress: 0.1,
        currentPage: 0,
        totalPages,
        message: `Downloading ${totalPages} pages...`,
      };

      // Download and descramble images (parallel batches)
      await fs.mkdir(job.outputDir, { recursive: true });
      let totalSize = 0;
      let downloaded = 0;
      const CONCURRENCY = 5;

      for (let i = 0; i < totalPages; i += CONCURRENCY) {
        const batch = viewerData.images.slice(i, i + CONCURRENCY);

        const results = await Promise.all(
          batch.map(async (img: any, idx: number) => {
            const pageIndex = i + idx;
            const pageNum = String(pageIndex + 1).padStart(4, "0");
            const outPath = path.join(job.outputDir, `${pageNum}.jpg`);

            if (!img.url) {
              log.error({ pageIndex, imgData: img }, `Page ${pageIndex + 1}: image URL is empty`);
              throw new Error(`Page ${pageIndex + 1}: image URL is empty. Check _pdata_.img structure.`);
            }

            log.debug(`Page ${pageIndex + 1}/${totalPages}: fetching...`);
            const rawBuf = await fetchWithRetry({
              url: img.url,
              headers: {
                Referer: "https://piccoma.com/",
                Origin: "https://piccoma.com",
              },
            });
            log.debug(`Page ${pageIndex + 1}/${totalPages}: ${rawBuf.length} bytes, descrambling...`);

            const buffer = viewerData.isScrambled
              ? await descrambleImage(rawBuf, img.seed)
              : rawBuf;

            await fs.writeFile(outPath, buffer);
            return buffer.length;
          }),
        );

        downloaded += batch.length;
        totalSize += results.reduce((a, b) => a + b, 0);

        const progress = 0.1 + (0.85 * downloaded) / totalPages;
        yield {
          phase: "downloading",
          progress,
          currentPage: downloaded,
          totalPages,
          message: `Page ${downloaded}/${totalPages}`,
        };
      }

      yield { phase: "done", progress: 1, message: "Complete" };

      return {
        totalPages,
        totalTime: Date.now() - startTime,
        filePath: job.outputDir,
        fileSize: totalSize,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /**
   * Resolve the correct viewer URL for a volume by visiting the volume list page
   * with session cookies and finding the readable button for the target volume.
   */
  private async resolveVolumeViewerUrl(
    page: import("puppeteer").Page,
    titleId: string,
    volumeNum: number,
  ): Promise<string | null> {
    const volListUrl = `${PICCOMA_BASE}/product/${titleId}/episodes?etype=V`;
    log.info(`Resolving volume viewer URL from: ${volListUrl} (vol ${volumeNum})`);

    await page.goto(volListUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 3000));

    const evalScript = `(function() {
      var items = document.querySelectorAll(".PCM-productSaleList_volume li");
      var volIndex = ${volumeNum - 1};
      if (volIndex < 0 || volIndex >= items.length) return null;

      var li = items[volIndex];

      var freeBtn = li.querySelector(".PCM-prdVol_freeBtn[data-episode_id]");
      var readBtn = li.querySelector(".PCM-prdVol_readBtn[data-episode_id]");
      var btn = freeBtn || readBtn;

      if (!btn) {
        var allBtns = li.querySelectorAll("[data-episode_id]");
        for (var i = 0; i < allBtns.length; i++) {
          var cls = allBtns[i].className || "";
          if (cls.indexOf("buyBtn") !== -1 || cls.indexOf("trialBtn") !== -1) continue;
          btn = allBtns[i];
          break;
        }
      }

      if (!btn) {
        btn = li.querySelector("[data-episode_id]");
      }

      if (!btn) return null;

      var epId = btn.getAttribute("data-episode_id") || "";
      var prodId = btn.getAttribute("data-product_id") || "";
      var btnClass = btn.className || "";

      return { episodeId: epId, productId: prodId, btnClass: btnClass };
    })()`;
    const resolved = await page.evaluate(evalScript) as { episodeId: string; productId: string; btnClass: string } | null;

    if (!resolved || !resolved.episodeId) {
      log.warn(`Could not resolve viewer URL for vol ${volumeNum}`);
      return null;
    }

    log.info(`Resolved vol ${volumeNum}: episodeId=${resolved.episodeId} (btn: ${resolved.btnClass})`);
    return `${PICCOMA_BASE}/viewer/${resolved.productId}/${resolved.episodeId}`;
  }
}

// ----- Plugin Entry -----

export function createPiccomaPlugin(): Plugin {
  const manifest: PluginManifest = {
    id: "piccoma",
    name: "ピッコマ",
    version: "1.0.0",
    contentType: "series",
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
    urlParser: new PiccomaUrlParser(),
    auth: new PiccomaAuth(),
    metadata: new PiccomaScraper(),
    availabilityChecker: new PiccomaAvailabilityChecker(),
    downloader: new PiccomaDownloader(),
    async dispose() {
      log.info("Plugin disposed");
    },
  };
}
