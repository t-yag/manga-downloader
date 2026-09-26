import * as cheerio from "cheerio";
import { logger } from "../../logger.js";
import type {
  MetadataProvider,
  TitleInfo,
  VolumeInfo,
  CookieData,
  AvailabilityChecker,
  VolumeAvailability,
  VolumeQuery,
  SessionData,
} from "../base.js";

const log = logger.child({ module: "KindleMetadata" });

const KINDLE_LIBRARY_URL = "https://read.amazon.co.jp/kindle-library";

const AMAZON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ja,en;q=0.9",
};

interface KindleItem {
  asin: string;
  title: string;
  authors: string[];
  productUrl: string;
  webReaderUrl: string;
  mangaOrComicAsin: boolean;
  seriesAsin?: string;
  percentageRead?: number;
  resourceType?: string;
  originType?: string;
}

/**
 * Parse volume number from a Kindle book title.
 * Handles patterns like:
 *   "タイトル 3巻", "タイトル（３）", "Title Vol.3", "Title (3)",
 *   "タイトル 第3巻", "タイトル 上/中/下"
 */
function parseVolumeNumber(title: string): number | null {
  // "第N巻", "N巻"
  const kanMatch = title.match(/第?(\d+)\s*巻/);
  if (kanMatch) return parseInt(kanMatch[1], 10);

  // Full-width numbers: "（３）" etc.
  const fwMatch = title.match(/[（(]\s*([０-９]+)\s*[）)]/);
  if (fwMatch) {
    const num = fwMatch[1].replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30),
    );
    return parseInt(num, 10);
  }

  // "(3)", "( 3 )"
  const parenMatch = title.match(/[（(]\s*(\d+)\s*[）)]/);
  if (parenMatch) return parseInt(parenMatch[1], 10);

  // "Vol.3", "vol 3"
  const volMatch = title.match(/vol\.?\s*(\d+)/i);
  if (volMatch) return parseInt(volMatch[1], 10);

  // 上中下
  const kamiShimoMap: Record<string, number> = { 上: 1, 中: 2, 下: 3 };
  const ksMatch = title.match(/\s([上中下])\s*$/);
  if (ksMatch && kamiShimoMap[ksMatch[1]]) return kamiShimoMap[ksMatch[1]];

  return null;
}

/**
 * Extract the series title by removing volume indicators from the full title.
 */
function extractSeriesTitle(title: string): string {
  return title
    .replace(/\s*第?\d+\s*巻.*$/, "")
    .replace(/\s*[（(]\s*[\d０-９]+\s*[）)].*$/, "")
    .replace(/\s*vol\.?\s*\d+.*$/i, "")
    .replace(/\s*[上中下]\s*$/, "")
    .replace(/\s*\(Japanese Edition\)\s*$/i, "")
    .trim();
}

function extractCookies(session: SessionData | null): CookieData[] {
  if (!session?.cookies?.length) {
    throw new Error("Kindleセッションがありません。アカウント設定からログインしてください");
  }
  return session.cookies;
}

function buildCookieString(cookies: CookieData[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// These responses must never be treated as a book or hidden by a fallback.
class KindleAccessError extends Error {}

function checkAmazonPage(html: string, responseUrl: string): void {
  const $ = cheerio.load(html);
  const pathname = responseUrl ? new URL(responseUrl).pathname : "";
  if ($('input#captchacharacters, form[action*="validateCaptcha"]').length ||
      /captcha|validateCaptcha/i.test(pathname)) {
    throw new KindleAccessError("Amazonの確認画面（CAPTCHA）が表示されています。ブラウザで確認を完了してから再試行してください");
  }
  if ($('input#ap_email, input#ap_email_login, form[name="signIn"]').length ||
      /^\/(?:ap\/signin|ax\/claim|landing)(?:\/|$)/.test(pathname)) {
    throw new KindleAccessError("Kindleセッションが無効です。アカウント設定から再ログインしてください");
  }
}

async function fetchLibraryItems(cookies: CookieData[]): Promise<KindleItem[]> {
  const cookieString = buildCookieString(cookies);

  const response = await fetch(KINDLE_LIBRARY_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Cookie: cookieString,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Kindle Library fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();

  checkAmazonPage(html, response.url);

  // Attribute order may vary. The new /your-books page no longer embeds this data.
  const script = cheerio.load(html)('script#itemViewResponse').text();
  if (!script) {
    throw new Error("Kindleライブラリの補助情報を取得できません（本棚の形式が変更されています）");
  }

  try {
    const data = JSON.parse(script);
    if (!data.itemsList || !Array.isArray(data.itemsList)) {
      throw new Error("Kindle Library: itemsList not found in itemViewResponse");
    }
    log.info(`Library fetched: ${data.itemsList.length} items`);
    return data.itemsList;
  } catch (e: any) {
    if (e.message.includes("itemsList")) throw e;
    throw new Error(`Kindle Library: failed to parse itemViewResponse JSON: ${e.message}`);
  }
}

// ----- Series page scraping -----

export interface SeriesItem {
  index: number;
  asin: string;
  title: string;
  owned: boolean;
  free: boolean;
  thumbnail?: string;
}

export interface SeriesInfo {
  seriesAsin: string;
  seriesTitle: string;
  totalItems: number;
  author: string;
  items: SeriesItem[];
}

function parseSeriesItemsFromHtml(html: string): SeriesItem[] {
  const $ = cheerio.load(html);
  const items: SeriesItem[] = [];

  $(".series-childAsin-item").each((_, el) => {
    const $el = $(el);
    const idMatch = $el.attr("id")?.match(/series-childAsin-item_(\d+)/);
    const index = idMatch ? parseInt(idMatch[1], 10) : 0;
    const owned = $el.hasClass("hasOwnership");

    const href =
      $el.find("a.itemImageLink").first().attr("href") ||
      $el.find("a.itemBookTitle").first().attr("href") ||
      "";
    const asinMatch = href.match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/);
    const asin = asinMatch?.[1] || "";

    const title =
      $el.find(".itemBookTitle h3").first().text().trim() ||
      $el.find("a.itemImageLink").attr("title")?.trim() ||
      "";

    const thumbnail =
      $el.find(".asinImage, .itemImageLink img").first().attr("src") ||
      undefined;

    // Detect free (￥0) volumes from the price span
    const priceText = $el.find(".a-color-price").first().text().trim();
    const free = /￥\s*0(?:[^\d,]|$)/.test(priceText);

    if (asin) {
      items.push({ index, asin, title, owned, free, thumbnail });
    }
  });

  return items;
}

export async function fetchSeriesInfo(
  seriesAsin: string,
  cookieString: string,
  visited = new Set<string>(),
): Promise<SeriesInfo> {
  if (visited.has(seriesAsin)) throw new Error("Kindleシリーズのリンクが循環しています");
  visited.add(seriesAsin);
  const headers = { ...AMAZON_HEADERS, Cookie: cookieString };

  // 1. Fetch the series page
  const url = `https://www.amazon.co.jp/dp/${seriesAsin}?binding=kindle_edition`;
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Series page fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  checkAmazonPage(html, res.url);

  const $ = cheerio.load(html);
  const seriesTitle =
    $('meta[property="og:title"]').attr("content")?.trim() || "";
  // Collect contributors from the first item.
  // Contributors may be directly in DOM or inside a popover's inlineContent.
  const authorParts: string[] = [];
  const firstItem = $(".series-childAsin-item").first();

  // Try direct DOM first
  firstItem
    .find(".series-childAsin-item-details-contributor")
    .each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
      if (text) authorParts.push(text);
    });

  // Fallback: extract from popover inlineContent
  if (authorParts.length === 0) {
    const popoverAttr = firstItem.find("[data-a-popover]").first().attr("data-a-popover");
    if (popoverAttr) {
      try {
        const popoverData = JSON.parse(popoverAttr);
        if (popoverData.inlineContent) {
          const inner$ = cheerio.load(popoverData.inlineContent);
          inner$(".series-childAsin-item-details-contributor").each((_, el) => {
            const text = inner$(el).text().replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
            if (text) authorParts.push(text);
          });
        }
      } catch {
        // ignore malformed popover JSON
      }
    }
  }

  const author = authorParts.join(", ").replace(/,\s*$/, "");

  // Pagination metadata
  const paginationEl = $("#seriesAsinListPagination");
  const totalItems = parseInt(
    paginationEl.attr("data-number_of_items") || "0",
    10,
  );
  const pageSize = parseInt(
    paginationEl.attr("data-page_size") || "10",
    10,
  );

  let allItems = parseSeriesItemsFromHtml(html);

  // No pagination div — could be a single-volume series or an individual product page
  if (!paginationEl.length) {
    // Check if this is an individual product page that links to a series
    // Matches: "全16巻の第1巻:", "全1話中第1話:", etc.
    const seriesLinkEl = $('a[href*="binding=kindle_edition"]').filter((_, el) => {
      const text = $(el).text();
      return /全\d+[巻話冊]/.test(text);
    });
    if (seriesLinkEl.length > 0) {
      const href = seriesLinkEl.first().attr("href") || "";
      const linkedAsin = href.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      if (linkedAsin && linkedAsin !== seriesAsin) {
        log.info(`Detected series ASIN ${linkedAsin} from product page ${seriesAsin}`);
        return fetchSeriesInfo(linkedAsin, cookieString, visited);
      }
    }

    if (allItems.length === 0) {
      // Product page for a single volume — extract from page metadata
      const titleText =
        $("span#productTitle, span#ebooksProductTitle").first().text().trim() ||
        seriesTitle;
      if (!titleText || !$("#productTitle, #ebooksProductTitle").length) {
        throw new Error("Kindleの商品情報を取得できません。商品・シリーズページのURLを確認してください");
      }
      allItems = [
        {
          index: 1,
          asin: seriesAsin,
          title: titleText,
          owned:
            html.includes("a-button-kindle-read") ||
            html.includes("kindle-read-button"),
          free: false,
        },
      ];
    }
    return {
      seriesAsin,
      seriesTitle: seriesTitle || allItems[0]?.title || "",
      totalItems: allItems.length,
      author,
      items: allItems,
    };
  }

  // 2. Fetch remaining pages via AJAX endpoint
  if (totalItems > pageSize) {
    const totalPages = Math.ceil(totalItems / pageSize);
    for (let page = 2; page <= totalPages; page++) {
      const ajaxUrl =
        `https://www.amazon.co.jp/kindle-dbs/productPage/ajax/seriesAsinList` +
        `?asin=${seriesAsin}&pageNumber=${page}&pageSize=${pageSize}` +
        `&binding=kindle_edition&ref_=series_dp_batch_load_all`;
      log.debug(`Fetching series page ${page}/${totalPages}`);
      const pageRes = await fetch(ajaxUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (!pageRes.ok) {
        throw new Error(`Kindleシリーズの${page}ページ目を取得できません: HTTP ${pageRes.status}`);
      }
      const pageHtml = await pageRes.text();
      checkAmazonPage(pageHtml, pageRes.url);
      allItems.push(...parseSeriesItemsFromHtml(pageHtml));
    }
  }

  allItems = [...new Map(allItems.map((item) => [item.asin, item])).values()];
  if (!allItems.length || (totalItems > 0 && allItems.length !== totalItems)) {
    throw new Error(`Kindleシリーズの巻情報が不完全です（${allItems.length}/${totalItems}巻）。再試行してください`);
  }

  log.info(
    `Series "${seriesTitle}": ${allItems.length}/${totalItems} items fetched`,
  );

  return {
    seriesAsin,
    seriesTitle,
    totalItems,
    author,
    items: allItems,
  };
}

export class KindleMetadata implements MetadataProvider {
  async getTitleInfo(asin: string, session?: SessionData | null): Promise<TitleInfo> {
    log.info(`Fetching title info for ASIN: ${asin}`);

    const cookies = extractCookies(session ?? null);
    const cookieString = buildCookieString(cookies);

    // Product/series pages are the primary source. The old Kindle library now
    // redirects to Your Books for some accounts and must not block registration.
    let series: SeriesInfo | undefined;
    let seriesError: unknown;
    try {
      series = await fetchSeriesInfo(asin, cookieString);
    } catch (error) {
      if (error instanceof KindleAccessError) throw error;
      seriesError = error;
    }

    let libraryItems: KindleItem[];
    try {
      libraryItems = await fetchLibraryItems(cookies);
    } catch (error) {
      if (!series) throw seriesError ?? error;
      log.warn("Kindle library enrichment unavailable; using product/series metadata");
      libraryItems = [];
    }
    const nonMangaAsins = new Set(
      libraryItems.filter((i) => i.mangaOrComicAsin === false).map((i) => i.asin),
    );
    if (series) return this.seriesToTitleInfo(series, nonMangaAsins);
    if (!libraryItems.some((item) => item.asin === asin || item.seriesAsin === asin)) {
      throw seriesError;
    }
    return this.getTitleInfoFromLibrary(asin, libraryItems);
  }

  private seriesToTitleInfo(series: SeriesInfo, nonMangaAsins: Set<string>): TitleInfo {
    const volumeEntries: { item: SeriesItem; volume: number }[] = [];
    for (const item of series.items) {
      // Skip books known to be non-manga (text reader not supported)
      if (nonMangaAsins.has(item.asin)) {
        log.debug(`Skipping non-manga ASIN ${item.asin}: ${item.title}`);
        continue;
      }
      const vol = parseVolumeNumber(item.title);
      volumeEntries.push({ item, volume: vol ?? item.index });
    }

    if (volumeEntries.length === 0) {
      throw new Error(
        `「${series.seriesTitle}」にはマンガ形式の巻がないため、ダウンロードに対応していません`,
      );
    }

    // Sort by volume number
    volumeEntries.sort((a, b) => a.volume - b.volume);

    // Resolve duplicate volume numbers
    const seenVols = new Set<number>();
    for (const entry of volumeEntries) {
      while (seenVols.has(entry.volume)) {
        entry.volume++;
      }
      seenVols.add(entry.volume);
    }

    const volumes: VolumeInfo[] = volumeEntries.map((entry) => ({
      volume: entry.volume,
      unit: "vol",
      readerUrl: `https://read.amazon.co.jp/manga/${entry.item.asin}`,
      contentKey: entry.item.asin,
      thumbnailUrl: entry.item.thumbnail,
    }));

    log.info(
      `Series "${series.seriesTitle}": ${volumes.length} volume(s)`,
    );

    return {
      titleId: series.seriesAsin,
      title: series.seriesTitle,
      seriesTitle: series.seriesTitle,
      author: series.author,
      genres: [],
      totalVolumes: volumes.length,
      coverUrl: series.items[0]?.thumbnail,
      volumes,
    };
  }

  private getTitleInfoFromLibrary(asin: string, items: KindleItem[]): TitleInfo {
    const targetItem = items.find((item) => item.asin === asin) ??
      items.find((item) => item.seriesAsin === asin && item.mangaOrComicAsin);
    if (!targetItem) {
      throw new Error(
        `ASIN ${asin} がKindleライブラリに見つかりません。購入済みか確認してください`,
      );
    }

    if (!targetItem.mangaOrComicAsin) {
      throw new Error(
        `「${targetItem.title}」はマンガではないため、ダウンロードに対応していません`,
      );
    }

    let seriesItems: KindleItem[];
    if (targetItem.seriesAsin) {
      seriesItems = items
        .filter((item) => item.seriesAsin === targetItem.seriesAsin)
        .filter((item) => item.mangaOrComicAsin);
    } else {
      seriesItems = [targetItem];
    }

    const volumeEntries: { item: KindleItem; volume: number }[] = [];
    for (const item of seriesItems) {
      const vol = parseVolumeNumber(item.title);
      volumeEntries.push({ item, volume: vol ?? 1 });
    }

    const allSameVol =
      volumeEntries.length > 1 &&
      volumeEntries.every((e) => e.volume === volumeEntries[0].volume);
    if (allSameVol) {
      volumeEntries.forEach((e, i) => (e.volume = i + 1));
    }

    volumeEntries.sort((a, b) => a.volume - b.volume);

    const seenVols = new Set<number>();
    for (const entry of volumeEntries) {
      while (seenVols.has(entry.volume)) {
        entry.volume++;
      }
      seenVols.add(entry.volume);
    }

    const seriesTitle = targetItem.seriesAsin
      ? extractSeriesTitle(targetItem.title)
      : targetItem.title.replace(/\s*\(Japanese Edition\)\s*$/i, "").trim();

    const author = targetItem.authors
      ?.map((a) => a.replace(/:$/, "").trim())
      .filter(Boolean)
      .join(", ") ?? "";

    const volumes: VolumeInfo[] = volumeEntries.map((entry) => ({
      volume: entry.volume,
      unit: "vol",
      readerUrl: `https://read.amazon.co.jp/manga/${entry.item.asin}`,
      contentKey: entry.item.asin,
      thumbnailUrl: entry.item.productUrl || undefined,
    }));

    log.info(
      `Series "${seriesTitle}": ${volumes.length} volume(s) (from library)`,
    );

    return {
      titleId: targetItem.seriesAsin || asin,
      title: seriesTitle,
      seriesTitle,
      author,
      genres: [],
      totalVolumes: volumes.length,
      coverUrl: targetItem.productUrl || undefined,
      volumes,
    };
  }

  async getVolumeInfo(titleId: string, volume: number, session?: SessionData | null): Promise<VolumeInfo> {
    const info = await this.getTitleInfo(titleId, session);
    const vol = info.volumes.find((v) => v.volume === volume);
    if (!vol) {
      throw new Error(`Volume ${volume} not found for title ${titleId}`);
    }
    return vol;
  }
}

export class KindleAvailabilityChecker implements AvailabilityChecker {
  async checkAvailability(
    titleId: string,
    volumes: VolumeQuery[],
    session: SessionData | null,
  ): Promise<VolumeAvailability[]> {
    const cookies = extractCookies(session);
    const cookieString = buildCookieString(cookies);

    const series = await fetchSeriesInfo(titleId, cookieString);

    // Build a map of volume number → status from series items
    const statusByVol = new Map<number, { owned: boolean; free: boolean }>();
    for (const item of series.items) {
      const vol = parseVolumeNumber(item.title) ?? item.index;
      statusByVol.set(vol, { owned: item.owned, free: item.free });
    }

    return volumes.map((vq) => {
      const status = statusByVol.get(vq.volume);
      if (!status) {
        return { volume: vq.volume, unit: vq.unit, available: false, reason: "unknown" };
      }
      // Priority: purchased > free > not_purchased
      if (status.owned) {
        return { volume: vq.volume, unit: vq.unit, available: true, reason: "purchased" };
      }
      if (status.free) {
        return { volume: vq.volume, unit: vq.unit, available: true, reason: "free" };
      }
      return { volume: vq.volume, unit: vq.unit, available: false, reason: "not_purchased" };
    });
  }
}
