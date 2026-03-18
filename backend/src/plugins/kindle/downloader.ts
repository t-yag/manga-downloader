import fs from "fs/promises";
import path from "path";
import type { Page } from "puppeteer";
import { launchBrowser } from "../browser.js";
import { logger } from "../../logger.js";
import type {
  Downloader,
  DownloadJob,
  DownloadProgress,
  DownloadResult,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "KindleDownloader" });

/** Viewport optimized for manga: portrait, single-page display */
const VIEWPORT = { width: 800, height: 1200 };

/** Wait for page image to settle after navigation */
const PAGE_SETTLE_MS = 800;
/** Extra wait when image doesn't change immediately */
const PAGE_EXTRA_WAIT_MS = 3000;
/** Max consecutive unchanged checks before concluding end-of-book */
const MAX_UNCHANGED = 2;

/**
 * Get the blob src of the currently visible page image.
 * Kindle Cloud Reader keeps 3 img elements; the visible one has left=0.
 * Returns null if no visible image is found or src is empty.
 */
async function getVisibleImageSrc(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const imgs = document.querySelectorAll<HTMLImageElement>(".kg-full-page-img img");
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (Math.abs(rect.left) < 10 && img.src && img.src.startsWith("blob:")) {
        return img.src;
      }
    }
    return null;
  });
}

/**
 * Wait until a visible page image with a blob src appears.
 * Polls every 500ms up to the given timeout.
 */
async function waitForVisibleImage(page: Page, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const src = await getVisibleImageSrc(page);
    if (src) return src;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timeout waiting for page image to load");
}

/**
 * Capture the currently visible page image via Canvas.
 * Returns JPEG buffer at the image's native resolution.
 */
async function captureCurrentPage(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const imgs = document.querySelectorAll<HTMLImageElement>(".kg-full-page-img img");
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (Math.abs(rect.left) < 10 && img.src && img.src.startsWith("blob:")) {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to get canvas context");
        ctx.drawImage(img, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.95);
      }
    }
    throw new Error("No visible page image found");
  });

  const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  return Buffer.from(base64, "base64");
}

/**
 * Get total page count from the slider markers.
 * Returns max data-real + 1.
 */
async function getTotalPages(page: Page): Promise<number> {
  return page.evaluate(() => {
    const markers = document.querySelectorAll<HTMLElement>(
      ".kw-wdg-slider-marker-tap-target",
    );
    let maxReal = 0;
    for (const m of markers) {
      const val = parseInt(m.dataset.real || "0", 10);
      if (val > maxReal) maxReal = val;
    }
    return maxReal + 1;
  });
}

/**
 * Rewind to the first page using ArrowRight key presses.
 * RTL manga: ArrowRight = go back toward cover.
 * Detects arrival at first page when the image stops changing.
 */
async function rewindToFirstPage(page: Page): Promise<void> {
  log.info("Rewinding to first page via ArrowRight...");
  await waitForVisibleImage(page, 30000);
  let prevSrc = await getVisibleImageSrc(page);
  let unchangedCount = 0;
  let steps = 0;

  while (unchangedCount < MAX_UNCHANGED) {
    await page.keyboard.press("ArrowRight");
    await new Promise((r) => setTimeout(r, 600));

    const currentSrc = await getVisibleImageSrc(page);
    if (!currentSrc || currentSrc === prevSrc) {
      await new Promise((r) => setTimeout(r, 1000));
      const recheck = await getVisibleImageSrc(page);
      if (!recheck || recheck === prevSrc) {
        unchangedCount++;
      } else {
        unchangedCount = 0;
        prevSrc = recheck;
        steps++;
      }
    } else {
      unchangedCount = 0;
      prevSrc = currentSrc;
      steps++;
    }
  }

  log.info(`Reached first page after ${steps} steps`);
}

export class KindleDownloader implements Downloader {
  async *download(
    job: DownloadJob,
    session: SessionData | null,
  ): AsyncGenerator<DownloadProgress, DownloadResult> {
    yield { phase: "init", progress: 0, message: "Initializing..." };

    if (!session?.cookies?.length) {
      throw new Error("Kindleセッションがありません。ログインしてください");
    }

    const startTime = Date.now();

    const browser = await launchBrowser({
      headless: true,
      defaultViewport: VIEWPORT,
    });
    const page = await browser.newPage();

    try {
      // Set cookies
      await page.setCookie(
        ...session.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          expires: c.expires,
        })),
      );

      yield { phase: "loading", progress: 0.05, message: "Loading viewer..." };

      // Navigate to manga reader
      await page.goto(job.readerUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // Wait for viewer to fully load
      await page.waitForNetworkIdle({ idleTime: 3000, timeout: 60000 }).catch(() => {
        log.warn("Network idle timeout, proceeding...");
      });
      await new Promise((r) => setTimeout(r, 5000));

      // Remove cover overlay that blocks interaction
      await page.evaluate(() => {
        const cover = document.getElementById("coverPageContent");
        if (cover) cover.remove();
      });

      // Wait for page image to actually render
      log.info("Waiting for first page image to render...");
      await waitForVisibleImage(page, 30000);
      log.info("Page image detected");

      // Get total pages from slider
      let totalPages = await getTotalPages(page);
      log.info(`Total pages from slider: ${totalPages}`);

      yield {
        phase: "loading",
        progress: 0.1,
        message: `Rewinding to first page (${totalPages} pages)...`,
      };

      // Rewind to first page (RTL manga: ArrowRight goes toward cover)
      await rewindToFirstPage(page);

      // Wait for the first page image to stabilize after rewind
      await new Promise((r) => setTimeout(r, 1000));
      await waitForVisibleImage(page, 10000);

      yield {
        phase: "downloading",
        progress: 0.15,
        currentPage: 0,
        totalPages,
        message: `Downloading ${totalPages} pages...`,
      };

      // Capture pages
      await fs.mkdir(job.outputDir, { recursive: true });
      let pageCount = 0;
      let unchangedCount = 0;
      let prevSrc = await getVisibleImageSrc(page);
      let totalSize = 0;

      // Capture the first page
      const firstBuf = await captureCurrentPage(page);
      const firstPath = path.join(job.outputDir, "0001.jpg");
      await fs.writeFile(firstPath, firstBuf);
      pageCount++;
      totalSize += firstBuf.length;

      yield {
        phase: "downloading",
        progress: 0.15 + (0.8 * 1) / totalPages,
        currentPage: 1,
        totalPages,
        message: `Page 1/${totalPages}`,
      };

      // Navigate forward and capture remaining pages
      while (unchangedCount < MAX_UNCHANGED) {
        await page.keyboard.press("ArrowLeft");
        await new Promise((r) => setTimeout(r, PAGE_SETTLE_MS));

        let currentSrc = await getVisibleImageSrc(page);

        if (!currentSrc || currentSrc === prevSrc) {
          // Image didn't change yet — wait longer
          await new Promise((r) => setTimeout(r, PAGE_EXTRA_WAIT_MS));
          currentSrc = await getVisibleImageSrc(page);

          if (!currentSrc || currentSrc === prevSrc) {
            unchangedCount++;
            continue;
          }
        }

        unchangedCount = 0;
        prevSrc = currentSrc;

        pageCount++;
        const buf = await captureCurrentPage(page);
        const filePath = path.join(
          job.outputDir,
          String(pageCount).padStart(4, "0") + ".jpg",
        );
        await fs.writeFile(filePath, buf);
        totalSize += buf.length;

        const progress = 0.15 + (0.8 * pageCount) / totalPages;
        yield {
          phase: "downloading",
          progress: Math.min(progress, 0.95),
          currentPage: pageCount,
          totalPages,
          message: `Page ${pageCount}/${totalPages}`,
        };
      }

      // Update total if we captured a different number
      if (pageCount !== totalPages) {
        log.info(
          `Page count mismatch: slider=${totalPages}, captured=${pageCount}`,
        );
        totalPages = pageCount;
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
}
