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

  // Check if we got redirected to login (detect actual sign-in form, not navigation links)
  if (html.includes('id="ap_email"') || html.includes('name="signIn"')) {
    throw new Error("Kindleセッションが無効です。再ログインしてください");
  }

  // Extract itemsList from the itemViewResponse script tag
  const scriptMatch = html.match(
    /<script\s+id="itemViewResponse"\s+type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!scriptMatch) {
    throw new Error("Kindle Library: itemViewResponse script tag not found in HTML");
  }

  try {
    const data = JSON.parse(scriptMatch[1]);
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
): Promise<SeriesInfo> {
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

  // Detect actual sign-in page (not navigation links containing /ap/signin)
  if (html.includes('id="ap_email"') || html.includes('name="signIn"')) {
    throw new Error("Kindleセッションが無効です。再ログインしてください");
  }

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
        return fetchSeriesInfo(linkedAsin, cookieString);
      }
    }

    if (allItems.length === 0) {
      // Product page for a single volume — extract from page metadata
      const titleText =
        $("span#productTitle, span#ebooksProductTitle").first().text().trim() ||
        seriesTitle;
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
        log.warn(`Series page ${page} failed: HTTP ${pageRes.status}`);
        continue;
      }
      const pageHtml = await pageRes.text();
      allItems.push(...parseSeriesItemsFromHtml(pageHtml));
    }
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

    // Fetch library to determine which ASINs are NOT manga
    // (items not in library are assumed to be manga — they may be free/unpurchased)
    const libraryItems = await fetchLibraryItems(cookies);
    const nonMangaAsins = new Set(
      libraryItems.filter((i) => !i.mangaOrComicAsin).map((i) => i.asin),
    );

    // Try series page scraping first — works for both series ASINs and
    // individual volume ASINs that redirect to their series page.
    try {
      const series = await fetchSeriesInfo(asin, cookieString);
      if (series.items.length > 0) {
        return this.seriesToTitleInfo(series, nonMangaAsins);
      }
    } catch (e: any) {
      // "not manga" errors are definitive — don't fall back to library
      if (e.message.includes("マンガ形式の巻がない") || e.message.includes("マンガではない")) {
        throw e;
      }
      log.warn(`Series page fetch failed for ${asin}, falling back to library: ${e.message}`);
    }

    // Fallback: library-based lookup (for individual ASINs not on a series page)
    return this.getTitleInfoFromLibrary(asin, cookies, nonMangaAsins);
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

  private async getTitleInfoFromLibrary(asin: string, cookies: CookieData[], nonMangaAsins: Set<string>): Promise<TitleInfo> {
    const items = await fetchLibraryItems(cookies);

    const targetItem = items.find((item) => item.asin === asin);
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
