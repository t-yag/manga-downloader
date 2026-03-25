import { Browser, Page } from 'puppeteer';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../logger.js';
import { launchBrowser } from '../browser.js';
import type {
  DownloadJob,
  DownloadProgress,
  DownloadResult,
  CookieData,
} from '../base.js';

const log = logger.child({ module: 'PubLusEngine' });

// ====== Descramble constants (extracted from viewer_image.js) ======
const C_A = 61, C_B = 73, C_C = 4, C_D = 43, C_E = 47;
const C_F = 53, C_G = 59, C_H = 67, C_I = 71;
const C_J = 29, C_K = 37, C_L = 31, C_M = 41;
const TILE_SIZE = 64;

function calcPositionWithRest(a: number, b: number, c: number, d: number): number {
  return a * d + (a >= b ? c : 0);
}

function calcXCoordinateXRest(b: number, c: number, d: number): number {
  return (b + C_A * d) % c;
}

function calcYCoordinateXRest(a: number, b: number, c: number, d: number, e: number): number {
  const isOdd = e % 2 === 1;
  const k = a < b ? isOdd : !isOdd;
  const j = k ? c : d - c;
  const i = k ? 0 : c;
  return (a + e * C_F + c * C_G) % j + i;
}

function calcXCoordinateYRest(a: number, b: number, c: number, d: number, e: number): number {
  const isOdd = e % 2 === 1;
  const k = a < c ? isOdd : !isOdd;
  const j = k ? d - b : b;
  const g = k ? b : 0;
  return (a + e * C_H + b + C_I) % j + g;
}

function calcYCoordinateYRest(a: number, c: number, d: number): number {
  return (a + C_B * d) % c;
}

interface TileMapping {
  srcX: number; srcY: number;
  destX: number; destY: number;
  width: number; height: number;
}

function generateTileMap(imgWidth: number, imgHeight: number, pattern: number): TileMapping[] {
  const tileW = TILE_SIZE;
  const tileH = TILE_SIZE;
  const cols = Math.floor(imgWidth / tileW);
  const rows = Math.floor(imgHeight / tileH);
  const restW = imgWidth % tileW;
  const restH = imgHeight % tileH;
  const tiles: TileMapping[] = [];

  let iVal = cols - C_D * pattern % cols;
  iVal = iVal % cols === 0 ? (cols - C_C) % cols : iVal;
  iVal = iVal === 0 ? cols - 1 : iVal;

  let nVal = rows - C_E * pattern % rows;
  nVal = nVal % rows === 0 ? (rows - C_C) % rows : nVal;
  nVal = nVal === 0 ? rows - 1 : nVal;

  // Corner remainder tile
  if (restW > 0 && restH > 0) {
    tiles.push({
      srcX: iVal * tileW, srcY: nVal * tileH,
      destX: iVal * tileW, destY: nVal * tileH,
      width: restW, height: restH,
    });
  }

  // Bottom remainder row
  if (restH > 0) {
    for (let s = 0; s < cols; s++) {
      const u = calcXCoordinateXRest(s, cols, pattern);
      const v = calcYCoordinateXRest(u, iVal, nVal, rows, pattern);
      tiles.push({
        srcX: calcPositionWithRest(s, iVal, restW, tileW),
        srcY: nVal * tileH,
        destX: calcPositionWithRest(u, iVal, restW, tileW),
        destY: v * tileH,
        width: tileW, height: restH,
      });
    }
  }

  // Right remainder column
  if (restW > 0) {
    for (let t = 0; t < rows; t++) {
      const v = calcYCoordinateYRest(t, rows, pattern);
      const u = calcXCoordinateYRest(v, iVal, nVal, cols, pattern);
      tiles.push({
        srcX: iVal * tileW,
        srcY: calcPositionWithRest(t, nVal, restH, tileH),
        destX: u * tileW,
        destY: calcPositionWithRest(v, nVal, restH, tileH),
        width: restW, height: tileH,
      });
    }
  }

  // Main tile grid
  for (let s = 0; s < cols; s++) {
    for (let t = 0; t < rows; t++) {
      const u = (s + pattern * C_J + C_L * t) % cols;
      const v = (t + pattern * C_K + C_M * u) % rows;
      const w = u >= calcXCoordinateYRest(v, iVal, nVal, cols, pattern) ? restW : 0;
      const x = v >= calcYCoordinateXRest(u, iVal, nVal, rows, pattern) ? restH : 0;
      tiles.push({
        srcX: s * tileW + (s >= iVal ? restW : 0),
        srcY: t * tileH + (t >= nVal ? restH : 0),
        destX: u * tileW + w,
        destY: v * tileH + x,
        width: tileW, height: tileH,
      });
    }
  }

  return tiles;
}

async function descrambleImage(inputBuffer: Buffer, pattern: number): Promise<Buffer> {
  const { data: rawInput, info } = await sharp(inputBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const tileMap = generateTileMap(width, height, pattern);
  const rawOutput = Buffer.alloc(rawInput.length);

  // The viewer draws scrambled(destX,destY) → canvas(srcX,srcY)
  for (const tile of tileMap) {
    for (let row = 0; row < tile.height; row++) {
      const fromY = tile.destY + row;
      const toY = tile.srcY + row;
      if (fromY >= height || toY >= height) continue;

      const srcOff = (fromY * width + tile.destX) * channels;
      const dstOff = (toY * width + tile.srcX) * channels;
      const len = Math.min(tile.width, width - tile.destX, width - tile.srcX) * channels;

      if (srcOff >= 0 && srcOff + len <= rawInput.length &&
          dstOff >= 0 && dstOff + len <= rawOutput.length) {
        rawInput.copy(rawOutput, dstOff, srcOff, srcOff + len);
      }
    }
  }

  return sharp(rawOutput, { raw: { width, height, channels } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

interface PageInfo {
  file: string;
  pattern: number;
  index: number;
}

export class PubLusEngine {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private imageBuffers: Map<string, Buffer> = new Map();
  private totalPages: number = 0;
  private pages: PageInfo[] = [];
  private contentBaseUrl: string = '';

  async init(readerUrl: string, outputDir: string, cookies: CookieData[] | null) {
    log.info('Initializing...');
    await fs.mkdir(outputDir, { recursive: true });

    this.browser = await launchBrowser({
      defaultViewport: { width: 800, height: 1200 },
    });
    this.page = await this.browser.newPage();

    if (cookies && cookies.length > 0) {
      const puppeteerCookies = cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        ...(typeof cookie.expires === 'number' && cookie.expires > 0
          ? { expires: cookie.expires }
          : {}),
      }));
      await this.page.setCookie(...puppeteerCookies);
      log.info(`Cookies set: ${cookies.length}`);
    }

    // Capture CDN image responses
    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/OPS/images/') && url.endsWith('/0.jpeg')) {
        try {
          const buffer = await response.buffer();
          if (buffer.length > 0) {
            const filename = url.split('/OPS/images/')[1].replace('/0.jpeg', '');
            this.imageBuffers.set(filename, buffer);
          }
        } catch {
          // Response body may be unavailable (e.g. target closed, body undefined);
          // images are fetched directly via CDN as primary method, so this is harmless.
        }
      }

      // Capture content base URL from auth API
      if (url.includes('/viewerapi/auth/')) {
        try {
          const json = (await response.json()) as { url?: string };
          if (json.url) {
            this.contentBaseUrl = json.url;
            log.info(`Content base URL: ${this.contentBaseUrl}`);
          }
        } catch {}
      }
    });

    log.info(`Loading reader: ${readerUrl}`);
    await this.page.goto(readerUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for viewer to fully initialize
    await this.waitForViewer();

    // Give pending responses time to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    log.info(`Reader loaded, totalPages=${this.totalPages}, captured ${this.imageBuffers.size} images`);

  }

  private async waitForViewer(timeoutMs = 20000): Promise<void> {
    if (!this.page) return;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await this.page.evaluate(() => {
          const model = (window as any).NFBR?.a6G?.Initializer?.views_?.renderer?.model;
          if (!model) return null;
          const attrs = model.attributes;
          if (!attrs.viewerMaxPage) return null;

          const a2u = attrs.a2u;
          const contentBook = attrs.contentBook;
          const content = contentBook?.content?.normal_default;
          if (!content?.configuration) return null;

          const config = typeof content.configuration === 'string'
            ? JSON.parse(content.configuration) : content.configuration;
          const contents: Array<{ file: string; index: number }> = config.contents || [];

          // Get pattern for each page from spreads
          const spreads = a2u?.spreads || [];
          const pages: Array<{ file: string; pattern: number; index: number }> = [];

          for (let i = 0; i < contents.length; i++) {
            const spread = spreads[i];
            const pattern = spread?.left?.pattern ?? spread?.right?.pattern ?? 0;
            pages.push({
              file: contents[i].file.replace('OPS/images/', ''),
              pattern,
              index: i,
            });
          }

          return {
            totalPages: attrs.viewerMaxPage as number,
            contentUrl: content.url as string,
            pages,
          };
        });

        if (result) {
          this.totalPages = result.totalPages;
          this.pages = result.pages;
          if (result.contentUrl) this.contentBaseUrl = result.contentUrl;
          return;
        }
      } catch { /* not ready yet */ }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    log.error('Timeout waiting for viewer initialization');
  }

  async *download(
    job: DownloadJob
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const startTime = Date.now();

    if (this.totalPages === 0 || this.pages.length === 0) {
      throw new Error('Viewer not initialized or no pages detected');
    }

    log.info(`Starting download: ${this.totalPages} pages`);

    yield {
      phase: 'init',
      progress: 0,
      totalPages: this.totalPages,
      message: `Downloading ${this.totalPages} pages`,
    };

    let savedPages = 0;

    for (let i = 0; i < this.pages.length; i++) {
      const pageInfo = this.pages[i];

      // Ensure the image is loaded - if not in buffer, trigger load by navigating
      let buffer = this.imageBuffers.get(pageInfo.file);
      if (!buffer || buffer.length === 0) {
        this.imageBuffers.delete(pageInfo.file);
        buffer = await this.fetchPageImage(pageInfo, i) ?? undefined;
      }

      if (!buffer || buffer.length === 0) {
        log.warn(`No image data for page ${i + 1} (${pageInfo.file}), skipping`);
        continue;
      }

      // Descramble
      const descrambled = await descrambleImage(buffer, pageInfo.pattern);

      // Save
      const outputPath = path.join(
        job.outputDir,
        `page_${String(i + 1).padStart(3, '0')}.jpg`
      );
      await fs.writeFile(outputPath, descrambled);
      savedPages++;

      // Free buffer
      this.imageBuffers.delete(pageInfo.file);

      const progress = (i + 1) / this.totalPages;
      yield {
        phase: 'downloading',
        progress,
        currentPage: i + 1,
        totalPages: this.totalPages,
        message: `${i + 1}/${this.totalPages}`,
      };
    }

    const totalTime = Date.now() - startTime;

    // Calculate total file size
    const files = await fs.readdir(job.outputDir);
    const imageFiles = files.filter((f) => f.startsWith('page_') && f.endsWith('.jpg'));
    let totalSize = 0;
    for (const file of imageFiles) {
      const stat = await fs.stat(path.join(job.outputDir, file));
      totalSize += stat.size;
    }

    log.info(`Download complete: ${savedPages}/${this.totalPages} pages in ${totalTime}ms`);

    yield {
      phase: 'done',
      progress: 1.0,
      totalPages: savedPages,
      message: 'Download completed',
    };

    return {
      totalPages: savedPages,
      totalTime,
      filePath: job.outputDir,
      fileSize: totalSize,
    };
  }

  /** Extract all cookies from browser for CDN requests (including CDN domain) */
  private async getCdnCookieString(): Promise<string> {
    if (!this.page) return '';
    // Get cookies from both the page domain and the CDN domain
    const cdnUrl = this.contentBaseUrl || 'https://ebook04.dmm.com/';
    const [pageCookies, cdnCookies] = await Promise.all([
      this.page.cookies(),
      this.page.cookies(cdnUrl),
    ]);
    // Merge and deduplicate by name
    const cookieMap = new Map<string, string>();
    for (const c of [...pageCookies, ...cdnCookies]) {
      if (c.domain.includes('dmm.com')) {
        cookieMap.set(c.name, c.value);
      }
    }
    return Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Fetch a page image directly from CDN using browser cookies.
   */
  private async fetchPageImage(pageInfo: PageInfo, pageIndex: number, maxRetries = 3): Promise<Buffer | null> {
    if (!this.contentBaseUrl) return null;

    const imageUrl = `${this.contentBaseUrl}OPS/images/${pageInfo.file}/0.jpeg`;
    const cookieString = await this.getCdnCookieString();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await fetch(imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Cookie': cookieString,
            'Referer': 'https://book.dmm.com/',
          },
          signal: AbortSignal.timeout(30000),
        });

        if (!resp.ok) {
          if (resp.status >= 500 && attempt < maxRetries - 1) {
            log.warn(`HTTP ${resp.status} for page ${pageIndex + 1} (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            continue;
          }
          log.warn(`HTTP ${resp.status} for page ${pageIndex + 1}: ${imageUrl}`);
          return null;
        }

        const arrayBuffer = await resp.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length === 0) {
          log.warn(`Empty response for page ${pageIndex + 1}`);
          return null;
        }
        // Verify it's actually a JPEG (starts with FF D8)
        if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
          log.warn(`Page ${pageIndex + 1}: not a JPEG (got ${buffer.length} bytes, starts with ${buffer.slice(0, 4).toString('hex')})`);
          return null;
        }
        return buffer;
      } catch (e: any) {
        if (attempt < maxRetries - 1) {
          log.warn(`Fetch page ${pageIndex + 1} failed (attempt ${attempt + 1}/${maxRetries}): ${e.message}`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        } else {
          log.error(`Failed to fetch page ${pageIndex + 1} after ${maxRetries} attempts: ${e.message}`);
        }
      }
    }
    return null;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      log.info('Browser closed');
    }
  }
}
