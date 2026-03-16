import puppeteer, { Browser, Page } from 'puppeteer';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../logger.js';
import type {
  DownloadJob,
  DownloadProgress,
  DownloadResult,
  CookieData,
} from '../base.js';

const log = logger.child({ module: 'BinbEngine' });

export class BinbEngine {
  private browser: Browser | null = null;
  private page: Page | null = null;
  /** Map of blob URL → captured image buffer */
  private blobBuffers: Map<string, Buffer> = new Map();
  private headless: boolean;
  private executablePath?: string;
  private totalPages: number = 0;

  constructor(headless: boolean, executablePath?: string) {
    this.headless = headless;
    this.executablePath = executablePath;
  }

  async init(readerUrl: string, outputDir: string, cookies: CookieData[] | null) {
    log.info('Initializing...');

    await fs.mkdir(outputDir, { recursive: true });

    // Use portrait viewport to force single-page display mode
    const launchOptions = {
      headless: this.headless,
      defaultViewport: { width: 800, height: 1200 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    };

    this.browser = await puppeteer.launch(launchOptions);
    this.page = await this.browser.newPage();

    // Set authentication cookies
    if (cookies && cookies.length > 0) {
      const puppeteerCookies = cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: cookie.expires,
      }));
      await this.page.setCookie(...puppeteerCookies);
      log.info(`Cookies set: ${cookies.length}`);
    }

    // Capture all blob image responses into the map (keyed by URL)
    this.page.on('response', async (response) => {
      const url = response.url();
      if (
        url.startsWith('blob:') &&
        response.headers()['content-type']?.includes('image/')
      ) {
        try {
          const buffer = await response.buffer();
          this.blobBuffers.set(url, buffer);
        } catch (e: any) {
          if (
            !e.message?.includes('preflight') &&
            !e.message?.includes('Could not load response body')
          ) {
            log.error(`Failed to capture blob: ${e.message}`);
          }
        }
      }
    });

    log.info('Browser initialized');

    // Load reader page
    log.info(`Loading reader: ${readerUrl}`);
    await this.page.goto(readerUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Wait for slider to become available (indicates viewer is ready)
    this.totalPages = await this.waitForSlider();

    log.info(`Reader loaded, ${this.blobBuffers.size} blobs captured, totalPages=${this.totalPages}`);
  }

  /**
   * Wait for the jQuery UI slider to become available, then read total page count.
   * Replaces fixed 3s wait + separate detection step.
   */
  private async waitForSlider(timeoutMs = 15000): Promise<number> {
    if (!this.page) return 0;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const sliderMax = await this.page.evaluate(
          `(function() {
            try {
              if (window.jQuery && document.getElementById('slider')) {
                return window.jQuery('#slider').slider('option', 'max');
              }
            } catch(e) {}
            return null;
          })()`
        );

        if (typeof sliderMax === 'number' && sliderMax > 0) {
          log.info(`Slider max: ${sliderMax}`);
          return sliderMax + 1;
        }
      } catch { /* not ready yet */ }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    log.error('Could not detect total pages from slider');
    return 0;
  }

  /**
   * Navigate to a specific page and wait for its blob URLs to appear in the DOM.
   * Combines navigation + DOM polling to eliminate fixed waits.
   * Returns blob URLs sorted by vertical position (top to bottom).
   */
  private async navigateAndGetBlobUrls(pageIndex: number, timeoutMs = 10000): Promise<string[]> {
    if (!this.page) throw new Error('Page not initialized');

    await this.page.evaluate(
      `BBAppMovePage(JSON.stringify({page: ${pageIndex}}))`
    );

    // Poll DOM until blob URLs appear in the visible content div
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const urls = await this.page.evaluate(
        `(function() {
          var divs = document.querySelectorAll('[id^="content-p"]');
          for (var i = 0; i < divs.length; i++) {
            var rect = divs[i].getBoundingClientRect();
            if (rect.left >= 0 && rect.left < window.innerWidth) {
              var imgs = divs[i].querySelectorAll('img[src^="blob:"]');
              if (imgs.length === 0) return [];
              var sorted = Array.from(imgs).sort(function(a, b) {
                return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
              });
              return sorted.map(function(img) { return img.src; });
            }
          }
          return [];
        })()`
      ) as string[];

      if (urls.length > 0) {
        return urls;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    log.warn(`Timeout waiting for blob URLs on page ${pageIndex}`);
    return [];
  }

  /**
   * Wait until all blob URLs for a page have been captured.
   */
  private async waitForBlobs(urls: string[], timeoutMs = 10000): Promise<Buffer[]> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const allPresent = urls.every((url) => this.blobBuffers.has(url));
      if (allPresent) {
        return urls.map((url) => this.blobBuffers.get(url)!);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Return whatever we have
    log.warn(`Timeout waiting for blobs (got ${urls.filter((u) => this.blobBuffers.has(u)).length}/${urls.length})`);
    return urls
      .filter((url) => this.blobBuffers.has(url))
      .map((url) => this.blobBuffers.get(url)!);
  }

  private async combineStrips(
    stripBuffers: Buffer[],
    pageNumber: number,
    outputDir: string
  ): Promise<{ outputPath: string; width: number; height: number }> {
    if (stripBuffers.length === 1) {
      // Single image, no combining needed
      const metadata = await sharp(stripBuffers[0]).metadata();
      const outputPath = path.join(
        outputDir,
        `page_${String(pageNumber).padStart(3, '0')}.jpg`
      );
      await sharp(stripBuffers[0]).jpeg({ quality: 95 }).toFile(outputPath);
      return { outputPath, width: metadata.width!, height: metadata.height! };
    }

    // Get metadata for each strip
    const metadatas = await Promise.all(
      stripBuffers.map((buffer) => sharp(buffer).metadata())
    );

    // Detect overlap by comparing bottom of strip N with top of strip N+1
    // Use fixed overlap values (determined empirically for binb viewer)
    const OVERLAP_1_TO_2 = 7;
    const OVERLAP_2_TO_3 = 6;

    let totalHeight = metadatas[0].height!;
    if (metadatas.length >= 2) {
      totalHeight += metadatas[1].height! - OVERLAP_1_TO_2;
    }
    if (metadatas.length >= 3) {
      totalHeight += metadatas[2].height! - OVERLAP_2_TO_3;
    }

    const maxWidth = Math.max(...metadatas.map((meta) => meta.width!));

    let composite = sharp({
      create: {
        width: maxWidth,
        height: totalHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    });

    const compositeImages: sharp.OverlayOptions[] = [];
    let yOffset = 0;

    for (let i = 0; i < stripBuffers.length; i++) {
      compositeImages.push({
        input: stripBuffers[i],
        top: yOffset,
        left: 0,
      });

      if (i === 0) {
        yOffset += metadatas[i].height! - OVERLAP_1_TO_2;
      } else if (i === 1) {
        yOffset += metadatas[i].height! - OVERLAP_2_TO_3;
      } else {
        yOffset += metadatas[i].height!;
      }
    }

    const outputPath = path.join(
      outputDir,
      `page_${String(pageNumber).padStart(3, '0')}.jpg`
    );
    await composite.composite(compositeImages).jpeg({ quality: 95 }).toFile(outputPath);

    return { outputPath, width: maxWidth, height: totalHeight };
  }

  async *download(
    job: DownloadJob
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const startTime = Date.now();

    if (this.totalPages === 0) {
      throw new Error('Total pages not detected');
    }

    log.info(`Starting download: ${this.totalPages} pages`);

    yield {
      phase: 'init',
      progress: 0,
      totalPages: this.totalPages,
      message: `Downloading ${this.totalPages} pages`,
    };

    let savedPages = 0;

    // BBAppMovePage page index: 0 = cover (first page), totalPages-1 = last page
    // Output: page_001.jpg = cover, page_059.jpg = last
    for (let pageIndex = 0; pageIndex < this.totalPages; pageIndex++) {
      // Navigate and wait for blob URLs to appear in DOM
      const blobUrls = await this.navigateAndGetBlobUrls(pageIndex);

      if (blobUrls.length === 0) {
        log.error(`No blob URLs for page ${pageIndex}, skipping`);
        continue;
      }

      // Wait for all blob buffers to be captured
      const buffers = await this.waitForBlobs(blobUrls);

      if (buffers.length === 0) {
        log.warn(`No buffers captured for page ${pageIndex}, skipping`);
        continue;
      }

      const pageNum = pageIndex + 1;
      await this.combineStrips(buffers, pageNum, job.outputDir);
      savedPages++;

      // Free captured blobs for this page to limit memory usage
      for (const url of blobUrls) {
        this.blobBuffers.delete(url);
      }

      const progress = (pageIndex + 1) / this.totalPages;

      yield {
        phase: 'downloading',
        progress,
        currentPage: pageIndex + 1,
        totalPages: this.totalPages,
        message: `${pageIndex + 1}/${this.totalPages}`,
      };
    }

    const totalTime = Date.now() - startTime;

    // Get file size
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

  async close() {
    if (this.browser) {
      await this.browser.close();
      log.info('Browser closed');
    }
  }
}
