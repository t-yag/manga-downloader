import * as cheerio from "cheerio";
import type { MetadataProvider, TitleInfo, VolumeInfo } from "../base.js";

/**
 * Cmoa metadata scraper
 * Fetches title and volume information from Cmoa website
 */
export class CmoaScraper implements MetadataProvider {
  private readonly baseUrl = "https://www.cmoa.jp";
  private readonly timeout = 30000;

  async getTitleInfo(titleId: string): Promise<TitleInfo> {
    const url = `${this.baseUrl}/title/${titleId}/`;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Extract title
      const { title, seriesTitle } = this.extractTitle($);

      // Extract author
      const author = this.extractAuthor($);

      // Extract total volumes
      const totalVolumes = this.extractTotalVolumes($, html);

      // Extract genres
      const genres = this.extractGenres($);

      // Generate volume URLs
      const volumes = this.generateVolumeUrls(titleId, totalVolumes);

      // Try to extract cover URL
      const coverUrl = this.extractCoverUrl($);

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
    } catch (error: any) {
      throw new Error(`Failed to fetch title info: ${error.message}`);
    }
  }

  async getVolumeInfo(titleId: string, volume: number): Promise<VolumeInfo> {
    const urlInfo = CmoaScraper.generateReaderUrl(titleId, volume);
    return {
      volume,
      readerUrl: urlInfo.readerUrl,
      contentKey: urlInfo.contentId,
      detailUrl: urlInfo.detailUrl,
    };
  }

  /**
   * Extract title and series title from page.
   * Uses JSON-LD BreadCrumb for reliable series title extraction.
   */
  private extractTitle($: cheerio.CheerioAPI): {
    title: string;
    seriesTitle: string;
  } {
    // Get title with volume number (for metadata)
    let title =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      "Unknown";

    // Remove promotional prefixes
    title = title
      .replace(/【期間限定[^】]*】/g, "")
      .replace(/【無料[^】]*】/g, "")
      .replace(/【お試し[^】]*】/g, "")
      .replace(/【試し読み[^】]*】/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Extract series title from JSON-LD BreadCrumb (second-to-last item)
    let seriesTitle = "";
    $('script[type="application/ld+json"]').each((_, el) => {
      if (seriesTitle) return;
      try {
        const data = JSON.parse($(el).text());
        const list = Array.isArray(data) ? data : [data];
        for (const item of list) {
          if (item?.["@type"] === "BreadCrumbList" && item.itemListElement) {
            const items = item.itemListElement;
            if (items.length >= 2) {
              seriesTitle = items[items.length - 2].name?.trim() || "";
            }
          }
        }
      } catch {}
    });

    return { title, seriesTitle: seriesTitle || title };
  }

  /**
   * Extract author name
   */
  private extractAuthor($: cheerio.CheerioAPI): string {
    const authors = $(".title_details_author_name a")
      .map((i, el) => $(el).text().trim())
      .get();

    return authors.length > 0 ? authors.join(", ") : "Unknown";
  }

  /**
   * Extract total number of volumes
   */
  private extractTotalVolumes($: cheerio.CheerioAPI, html: string): number {
    // Look for patterns like "全○巻", "○巻配信中"
    const patterns = [/全(\d+)巻/, /(\d+)巻配信中/, /(\d+)巻セット/];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return parseInt(match[1]);
      }
    }

    // Infer from volume links
    const volumeLinks = $('a[href*="/title/"][href*="/vol/"]');
    let maxVol = 0;

    volumeLinks.each((i, el) => {
      const href = $(el).attr("href");
      if (href) {
        const volMatch = href.match(/\/vol\/(\d+)\//);
        if (volMatch) {
          maxVol = Math.max(maxVol, parseInt(volMatch[1]));
        }
      }
    });

    if (maxVol > 0) {
      return maxVol;
    }

    return 1; // Default to single volume
  }

  /**
   * Extract genres
   */
  private extractGenres($: cheerio.CheerioAPI): string[] {
    const genres: string[] = [];
    $('a[href*="/genre/"]').each((i, el) => {
      const genre = $(el).text().trim();
      if (genre && !genres.includes(genre)) {
        genres.push(genre);
      }
    });
    return genres;
  }

  /**
   * Extract cover image URL
   */
  private extractCoverUrl($: cheerio.CheerioAPI): string | undefined {
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
      return ogImage;
    }

    const imgSrc = $(".book-cover img, .title-cover img").first().attr("src");
    if (imgSrc) {
      return imgSrc.startsWith("http") ? imgSrc : `${this.baseUrl}${imgSrc}`;
    }

    return undefined;
  }

  /**
   * Generate volume URLs for all volumes
   */
  private generateVolumeUrls(titleId: string, totalVolumes: number): VolumeInfo[] {
    const volumes: VolumeInfo[] = [];

    for (let volNum = 1; volNum <= totalVolumes; volNum++) {
      const urlInfo = CmoaScraper.generateReaderUrl(titleId, volNum);
      volumes.push({
        volume: volNum,
        readerUrl: urlInfo.readerUrl,
        contentKey: urlInfo.contentId,
        detailUrl: urlInfo.detailUrl,
        thumbnailUrl: CmoaScraper.generateThumbnailUrl(titleId, volNum),
      });
    }

    return volumes;
  }

  /**
   * Generate thumbnail URL for a specific volume.
   * Pattern: https://cmoa.akamaized.net/data/image/title/title_{titleId(10)}/VOLUME/{contentId}.jpg
   */
  static generateThumbnailUrl(titleId: string, volume: number): string {
    const paddedTitle = String(titleId).padStart(10, "0");
    const contentId = `1${paddedTitle}${String(volume).padStart(4, "0")}`;
    return `https://cmoa.akamaized.net/data/image/title/title_${paddedTitle}/VOLUME/${contentId}.jpg`;
  }

  /**
   * Generate reader URL for a specific volume
   * @param titleId - Title ID (e.g., "99473")
   * @param volume - Volume number (e.g., 1)
   * @returns Reader URL information
   */
  static generateReaderUrl(
    titleId: string,
    volume: number
  ): {
    titleId: string;
    volume: number;
    contentId: string;
    readerUrl: string;
    detailUrl: string;
  } {
    const baseUrl = "https://www.cmoa.jp";

    // Generate content_id
    const paddedTitle = String(titleId).padStart(10, "0");
    const contentId = `1${paddedTitle}${String(volume).padStart(4, "0")}`;

    // Generate reader URL
    const readerUrl = `${baseUrl}/reader/browserviewer/?content_id=${contentId}`;

    // Detail page URL
    const detailUrl =
      volume === 1
        ? `${baseUrl}/title/${titleId}/`
        : `${baseUrl}/title/${titleId}/vol/${volume}/`;

    return {
      titleId,
      volume,
      contentId,
      readerUrl,
      detailUrl,
    };
  }
}
