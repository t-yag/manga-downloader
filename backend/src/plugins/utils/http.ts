import { logger } from "../../logger.js";
import { getSettingValue } from "../../api/routes/settings.js";
import fs from "fs/promises";
import path from "path";

const log = logger.child({ module: "HttpUtil" });

export interface FetchWithRetryOptions {
  url: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "FETCH_ERROR",
]);

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
    if (error.name === "AbortError") return false;
    // Network errors from fetch
    if (error.message.includes("fetch failed")) return true;
  }
  return false;
}

/**
 * Fetch a URL with exponential backoff retry.
 * Retries on 429, 5xx, and network errors.
 * Does NOT retry on 4xx (except 429).
 */
export async function fetchWithRetry(options: FetchWithRetryOptions): Promise<Buffer> {
  const maxRetries = options.maxRetries ?? getSettingValue<number>("download.retryCount") ?? 3;
  const baseDelay = options.retryDelay ?? 1000;
  const timeout = options.timeout ?? 30000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(options.url, {
        headers: options.headers,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        return Buffer.from(await response.arrayBuffer());
      }

      // Non-retryable HTTP error (4xx except 429)
      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Retryable HTTP error
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        const retryAfter = response.headers.get("retry-after");
        const waitMs = retryAfter ? Math.min(Number(retryAfter) * 1000, 60000) : delay;
        log.warn(`HTTP ${response.status} for ${options.url}, retrying in ${waitMs}ms (${attempt + 1}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`HTTP ${response.status} after ${maxRetries} retries`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP ")) {
        throw error;
      }

      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        log.warn(`Network error for ${options.url}: ${(error as Error).message}, retrying in ${delay}ms (${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unreachable");
}

export interface BatchDownloadOptions {
  imageUrls: string[];
  outputDir: string;
  headers?: Record<string, string>;
  concurrency?: number;
  requestInterval?: number;
  maxRetries?: number;
  filenamePrefix?: string;
  defaultExt?: string;
}

export interface BatchProgress {
  downloaded: number;
  total: number;
  totalSize: number;
}

/**
 * Download images in batches with concurrency, per-request interval, and retry.
 * Yields progress after each batch completes.
 * Throws if any pages fail after all retries.
 */
export async function* batchDownloadPages(
  options: BatchDownloadOptions,
): AsyncGenerator<BatchProgress> {
  const {
    imageUrls,
    outputDir,
    headers,
    concurrency = 3,
    requestInterval = 0,
    maxRetries,
    filenamePrefix = "page_",
    defaultExt = ".jpg",
  } = options;

  await fs.mkdir(outputDir, { recursive: true });

  let totalSize = 0;
  let downloaded = 0;
  const failedPages: number[] = [];

  for (let i = 0; i < imageUrls.length; i += concurrency) {
    const batch = imageUrls.slice(i, i + concurrency);

    // Sequential within batch to honour requestInterval correctly
    const results: number[] = [];
    for (let idx = 0; idx < batch.length; idx++) {
      const url = batch[idx];
      const pageNum = i + idx + 1;

      if (requestInterval > 0 && (i + idx) > 0) {
        await sleep(requestInterval);
      }

      try {
        const ext = path.extname(new URL(url).pathname) || defaultExt;
        const filename = `${filenamePrefix}${String(pageNum).padStart(3, "0")}${ext}`;
        const filePath = path.join(outputDir, filename);

        const buffer = await fetchWithRetry({
          url,
          headers,
          maxRetries,
        });

        await fs.writeFile(filePath, buffer);
        results.push(buffer.length);
      } catch (error) {
        log.error(`Failed to download page ${pageNum}: ${(error as Error).message}`);
        failedPages.push(pageNum);
        results.push(0);
      }
    }

    downloaded += batch.length;
    totalSize += results.reduce((a, b) => a + b, 0);

    yield { downloaded, total: imageUrls.length, totalSize };
  }

  if (failedPages.length > 0) {
    throw new Error(`Failed to download ${failedPages.length} page(s): ${failedPages.join(", ")}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
