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

interface ImageCapture {
  url: string;
  buffer: Buffer;
  size: number;
  timestamp: number;
}

export class BinbEngine {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private imageRequests: ImageCapture[] = [];
  private currentImageIndex = 0;
  private headless: boolean;
  private executablePath?: string;

  constructor(headless: boolean, executablePath?: string) {
    this.headless = headless;
    this.executablePath = executablePath;
  }

  async init(readerUrl: string, outputDir: string, cookies: CookieData[] | null) {
    log.info('Initializing...');

    await fs.mkdir(outputDir, { recursive: true });

    // Browser launch options
    const launchOptions = {
      headless: this.headless,
      defaultViewport: { width: 1280, height: 800 },
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

    // Monitor HTTP responses to capture blob URL requests
    this.page.on('response', async (response) => {
      const url = response.url();

      // Record only blob URL requests (descrambled images)
      if (
        url.startsWith('blob:') &&
        response.headers()['content-type']?.includes('image/')
      ) {
        try {
          const buffer = await response.buffer();
          const timestamp = Date.now();

          this.imageRequests.push({
            url,
            buffer,
            size: buffer.length,
            timestamp,
          });
        } catch (e: any) {
          // Ignore harmless errors like preflight requests
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

    log.info('Waiting for initial images...');

    // Wait for the first 3 images to load (max 6 seconds)
    const startTime = Date.now();
    const timeout = 6000;
    const targetImages = 3;

    while (this.imageRequests.length < targetImages) {
      if (Date.now() - startTime > timeout) {
        log.warn(`Timeout waiting for initial images (got ${this.imageRequests.length}/${targetImages})`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const elapsed = Date.now() - startTime;
    log.info(`Reader loaded in ${elapsed}ms, ${this.imageRequests.length} images captured`);
  }

  private async extractPageImages() {
    // Get 3 images from current index
    const startIndex = this.currentImageIndex;
    const endIndex = Math.min(startIndex + 3, this.imageRequests.length);

    if (startIndex >= this.imageRequests.length) {
      return { images: [] };
    }

    const pageImages = this.imageRequests.slice(startIndex, endIndex);

    // Advance index
    this.currentImageIndex = endIndex;

    return {
      images: pageImages,
    };
  }

  private async combineImages(
    imageBuffers: Buffer[],
    pageNumber: number,
    outputDir: string
  ): Promise<{ outputPath: string; width: number; height: number }> {
    // Overlap values (from investigation)
    const OVERLAP_1_TO_2 = 7; // Boundary between image 1 -> 2: 7px
    const OVERLAP_2_TO_3 = 6; // Boundary between image 2 -> 3: 6px

    // Get metadata for each image
    const metadatas = await Promise.all(
      imageBuffers.map((buffer) => sharp(buffer).metadata())
    );

    // Calculate height considering overlap
    // image1 + (image2 - overlap1) + (image3 - overlap2)
    let totalHeight = metadatas[0].height!;
    if (metadatas.length >= 2) {
      totalHeight += metadatas[1].height! - OVERLAP_1_TO_2;
    }
    if (metadatas.length >= 3) {
      totalHeight += metadatas[2].height! - OVERLAP_2_TO_3;
    }

    const maxWidth = Math.max(...metadatas.map((meta) => meta.width!));

    // Create empty canvas
    let composite = sharp({
      create: {
        width: maxWidth,
        height: totalHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    });

    // Position each image (considering overlap)
    const compositeImages: sharp.OverlayOptions[] = [];
    let yOffset = 0;

    for (let i = 0; i < imageBuffers.length; i++) {
      compositeImages.push({
        input: imageBuffers[i],
        top: yOffset,
        left: 0,
      });

      // Calculate offset for next image (subtract overlap)
      if (i === 0) {
        yOffset += metadatas[i].height! - OVERLAP_1_TO_2;
      } else if (i === 1) {
        yOffset += metadatas[i].height! - OVERLAP_2_TO_3;
      } else {
        yOffset += metadatas[i].height!;
      }
    }

    // Combine images and save
    const outputPath = path.join(
      outputDir,
      `page_${String(pageNumber).padStart(3, '0')}.jpg`
    );
    await composite.composite(compositeImages).jpeg({ quality: 95 }).toFile(outputPath);

    return { outputPath, width: maxWidth, height: totalHeight };
  }

  private async nextPage(maxRetries = 2): Promise<boolean> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const currentImageCount = this.imageRequests.length;
    const targetImageCount = currentImageCount + 3;

    // Navigate page with ArrowLeft key
    await this.page.keyboard.press('ArrowLeft');

    // Wait for new images, with extended wait on retry (don't re-press key)
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timeout = attempt === 0 ? 10000 : 5000;
      const startTime = Date.now();

      while (this.imageRequests.length < targetImageCount) {
        if (Date.now() - startTime > timeout) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (this.imageRequests.length >= targetImageCount) break;

      if (attempt < maxRetries) {
        log.warn(`Page load timeout (got ${this.imageRequests.length - currentImageCount}/3 images), extending wait (${attempt + 1}/${maxRetries})`);
      }
    }

    const newImagesCount = this.imageRequests.length - currentImageCount;
    return newImagesCount > 0;
  }

  async *download(
    job: DownloadJob
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    const startTime = Date.now();
    let pageNumber = 1;
    let continueProcessing = true;

    yield {
      phase: 'init',
      progress: 0,
      message: 'Initializing download',
    };

    while (continueProcessing) {
      // Check if we need to load the next page
      const imagesNeeded = pageNumber * 3;
      if (this.imageRequests.length < imagesNeeded) {
        const hasMorePages = await this.nextPage();

        if (!hasMorePages) {
          break;
        }
      }

      // Extract page images
      const { images } = await this.extractPageImages();

      if (images.length > 0) {
        await this.combineImages(
          images.map((img) => img.buffer),
          pageNumber,
          job.outputDir
        );

        yield {
          phase: 'downloading',
          progress: 0,
          currentPage: pageNumber,
          message: `${pageNumber}`,
        };

        pageNumber++;
      } else {
        continueProcessing = false;
      }
    }

    const totalPages = pageNumber - 1;
    const totalTime = Date.now() - startTime;

    // Get file size (approximate from all pages)
    const files = await fs.readdir(job.outputDir);
    const imageFiles = files.filter((f) => f.startsWith('page_') && f.endsWith('.jpg'));
    let totalSize = 0;
    for (const file of imageFiles) {
      const stat = await fs.stat(path.join(job.outputDir, file));
      totalSize += stat.size;
    }

    yield {
      phase: 'done',
      progress: 1.0,
      totalPages,
      message: 'Download completed',
    };

    return {
      totalPages,
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
