/**
 * DMMBooks metadata scraper.
 * Uses BFF REST APIs to extract title and volume information.
 *
 * APIs used:
 *   /ajax/bff/product_volume/   — series meta + current volume detail (author, publisher, genre)
 *   /ajax/bff/contents_book/    — paginated volume list (per_page max 100)
 */

import type { MetadataProvider, TitleInfo, VolumeInfo, SessionData } from "../base.js";
import { logger } from "../../logger.js";

const log = logger.child({ module: "DmmBooksScraper" });

const BFF_BASE = "https://book.dmm.com/ajax/bff";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const PER_PAGE = 100;

interface BffProductVolume {
  series: {
    type: string;
    title: string;
    series_id: number;
    status: { is_completion: boolean };
    publish_format: string;
    media: string;
    first_content_id: string;
    latest_content_id: string;
    contents: { volumes: { total_count: number } };
  };
  volumes: {
    content_id: string;
    title: string;
    author: { id: string; name: string }[];
    genre: { id: string; name: string }[];
    publisher: { id: string; name: string };
    category: { id: string; name: string };
    label: { id: string; name: string };
    image_urls: { pt: string; ps: string; pl: string };
    order_number: { asc: number; desc: number };
    free_streaming_url: string | null;
    file_info: { total_pages: number; content_publish_date: string };
    limited_free: { end: string | null } | null;
  };
}

interface BffContentsBookItem {
  content_id: string;
  title: string;
  volume_number: number;
  image_urls: { pt: string; ps: string; pl: string };
  free_streaming_url: string[] | null;
  product_url: string;
  product_path: string;
  content_publish_date: string | null;
  limited_free: { end: string | null } | null;
  sell: { product_id: string } | null;
  purchased: {
    streaming_url: string;
    download_url: string;
    purchased_date: string;
  } | null;
}

interface BffContentsBook {
  volume_books: BffContentsBookItem[];
  pager: { page: number; per_page: number; total_count: number };
  total_free_count: number;
}

/** Build Cookie header string from session data */
export function buildCookieString(session?: SessionData | null): string {
  return session?.cookies?.map((c) => `${c.name}=${c.value}`).join("; ") ?? "";
}

async function fetchJson<T>(url: string, session?: SessionData | null): Promise<T> {
  const cookieString = buildCookieString(session);

  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://book.dmm.com/",
      ...(cookieString ? { Cookie: cookieString } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`BFF API error: HTTP ${response.status} for ${url}`);
  }

  return response.json() as Promise<T>;
}

export class DmmBooksScraper implements MetadataProvider {
  async getTitleInfo(
    titleId: string,
    session?: SessionData | null,
  ): Promise<TitleInfo> {
    // titleId is "seriesId:contentId" — split it
    const { seriesId, contentId } = parseTitleId(titleId);
    // TODO: book.dmm.co.jp (adult) requires shopName="adult"
    const shopName = "general";

    log.info(`Fetching title info: seriesId=${seriesId} contentId=${contentId}`);

    // 1. Get series metadata + author/publisher from product_volume
    const pv = await fetchJson<BffProductVolume>(
      `${BFF_BASE}/product_volume/?series_id=${seriesId}&content_id=${contentId}&shop_name=${shopName}`,
      session,
    );

    const seriesTitle = pv.series.title;
    const totalVolumes = pv.series.contents.volumes.total_count;
    const author = pv.volumes.author.map((a) => a.name).join(", ") || "Unknown";
    const genres = pv.volumes.genre.map((g) => g.name);

    // 2. Get all volumes via contents_book (paginated, max 100 per page)
    const allBooks = await this.fetchAllVolumes(seriesId, shopName, session);

    const volumes: VolumeInfo[] = allBooks.map((book) => {
      const freeUrls = book.free_streaming_url ?? [];
      const readerUrl =
        book.purchased?.streaming_url ??
        freeUrls[0] ??
        `https://book.dmm.com/product/${seriesId}/${book.content_id}/`;

      const limitedFreeEnd = book.limited_free?.end ?? undefined;

      return {
        volume: book.volume_number,
        readerUrl,
        contentKey: book.content_id,
        detailUrl: book.product_url || `https://book.dmm.com${book.product_path}`,
        thumbnailUrl: book.image_urls.ps,
        ...(limitedFreeEnd ? { freeUntil: limitedFreeEnd.split("T")[0] } : {}),
      };
    });

    // Cover: use the first volume's large image
    const coverUrl = allBooks[0]?.image_urls.pl ?? pv.volumes.image_urls.pl;

    // Title for the current volume page (includes volume number)
    const title = pv.volumes.title;

    return {
      titleId,
      title,
      seriesTitle,
      author,
      genres,
      totalVolumes,
      coverUrl,
      volumes,
    };
  }

  async getVolumeInfo(
    titleId: string,
    volume: number,
    session?: SessionData | null,
  ): Promise<VolumeInfo> {
    const { seriesId } = parseTitleId(titleId);
    // TODO: book.dmm.co.jp (adult) requires shopName="adult"
    const shopName = "general";

    // Fetch the specific page that contains this volume
    const page = Math.ceil(volume / PER_PAGE);
    const data = await fetchJson<BffContentsBook>(
      `${BFF_BASE}/contents_book/?shop_name=${shopName}&series_id=${seriesId}&per_page=${PER_PAGE}&page=${page}`,
      session,
    );

    const book = data.volume_books.find((b) => b.volume_number === volume);
    if (!book) {
      throw new Error(`Volume ${volume} not found in series ${seriesId}`);
    }

    const freeUrls = book.free_streaming_url ?? [];
    const readerUrl =
      book.purchased?.streaming_url ??
      freeUrls[0] ??
      `https://book.dmm.com/product/${seriesId}/${book.content_id}/`;

    return {
      volume: book.volume_number,
      readerUrl,
      contentKey: book.content_id,
      detailUrl: book.product_url || `https://book.dmm.com${book.product_path}`,
      thumbnailUrl: book.image_urls.ps,
    };
  }

  /**
   * Fetch all volumes across paginated contents_book responses.
   * First request gets total_count, then remaining pages are fetched in parallel.
   */
  private async fetchAllVolumes(
    seriesId: string,
    shopName: string,
    session?: SessionData | null,
  ): Promise<BffContentsBookItem[]> {
    const firstPage = await fetchJson<BffContentsBook>(
      `${BFF_BASE}/contents_book/?shop_name=${shopName}&series_id=${seriesId}&per_page=${PER_PAGE}&page=1`,
      session,
    );

    const totalCount = firstPage.pager.total_count;
    const totalPages = Math.ceil(totalCount / PER_PAGE);
    const allBooks = [...firstPage.volume_books];

    log.info(
      `contents_book: ${totalCount} volumes, ${totalPages} page(s)`,
    );

    if (totalPages > 1) {
      const remaining = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          fetchJson<BffContentsBook>(
            `${BFF_BASE}/contents_book/?shop_name=${shopName}&series_id=${seriesId}&per_page=${PER_PAGE}&page=${i + 2}`,
            session,
          ),
        ),
      );
      for (const page of remaining) {
        allBooks.push(...page.volume_books);
      }
    }

    return allBooks;
  }
}

/**
 * Parse composite titleId "seriesId:contentId" back into parts.
 * If no colon is present, treat the whole string as seriesId
 * (contentId will need to be resolved via contents_book first volume).
 */
export function parseTitleId(titleId: string): {
  seriesId: string;
  contentId: string;
} {
  const sep = titleId.indexOf(":");
  if (sep >= 0) {
    return {
      seriesId: titleId.slice(0, sep),
      contentId: titleId.slice(sep + 1),
    };
  }
  return { seriesId: titleId, contentId: "" };
}
