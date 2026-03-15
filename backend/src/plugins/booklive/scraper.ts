/**
 * BookLive metadata scraper.
 * Extracts title and volume information from BookLive pages.
 */

import * as cheerio from "cheerio";
import type { MetadataProvider, TitleInfo, VolumeInfo } from "../base.js";

export class BookLiveScraper implements MetadataProvider {
  private baseUrl = "https://booklive.jp";
  private timeout = 30000;

  async getTitleInfo(titleId: string): Promise<TitleInfo> {
    const url = `${this.baseUrl}/product/index/title_id/${titleId}`;

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

      // Extract title information
      const { title, seriesTitle } = this.extractTitle($);
      const author = this.extractAuthor($);
      const totalVolumes = this.extractTotalVolumes($, html);
      const genres = this.extractGenres($);
      // Generate volume information
      const volumes = this.generateVolumeInfos(titleId, totalVolumes);

      return {
        titleId,
        title,
        seriesTitle,
        author,
        genres,
        totalVolumes,
        volumes,
      };
    } catch (error: any) {
      throw new Error(`Failed to fetch title info: ${error.message}`);
    }
  }

  async getVolumeInfo(titleId: string, volume: number): Promise<VolumeInfo> {
    const urlInfo = BookLiveScraper.generateReaderUrl(titleId, volume);

    return {
      volume,
      readerUrl: urlInfo.readerUrl,
      contentKey: urlInfo.cid,
      detailUrl: urlInfo.detailUrl,
    };
  }

  private extractTitle($: cheerio.CheerioAPI): {
    title: string;
    seriesTitle: string;
  } {
    // Extract title from h1 (includes volume number) - for metadata
    let title =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      "Unknown";

    // Extract series title from .book_title (excludes volume number) - for directory name
    let seriesTitle = $(".book_title").first().text().trim() || title;

    // Remove promotional prefixes
    const cleanText = (text: string) =>
      text
        .replace(/【期間限定[^】]*】/g, "")
        .replace(/【無料[^】]*】/g, "")
        .replace(/【お試し[^】]*】/g, "")
        .replace(/【試し読み[^】]*】/g, "")
        .replace(/\s+/g, " ")
        .trim();

    title = cleanText(title);
    seriesTitle = cleanText(seriesTitle);

    return { title, seriesTitle };
  }

  private extractAuthor($: cheerio.CheerioAPI): string {
    const authors = $(".author a, .product_author a")
      .map((i, el) => $(el).text().trim())
      .get();

    return authors.length > 0 ? authors.join(", ") : "Unknown";
  }

  private extractTotalVolumes($: cheerio.CheerioAPI, html: string): number {
    // Look for patterns like "全○巻", "○巻配信中", etc.
    const patterns = [/全(\d+)巻/, /(\d+)巻配信中/, /(\d+)巻セット/, /(\d+)冊/];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return parseInt(match[1]);
      }
    }

    // Infer from volume links
    const volumeLinks = $('a[href*="/product/"][href*="/vol."]');
    let maxVol = 0;

    volumeLinks.each((i, el) => {
      const href = $(el).attr("href");
      if (href) {
        const volMatch = href.match(/\/vol\.(\d+)\//);
        if (volMatch) {
          maxVol = Math.max(maxVol, parseInt(volMatch[1]));
        }
      }
    });

    if (maxVol > 0) {
      return maxVol;
    }

    // Default: treat as single volume
    return 1;
  }

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

  private generateVolumeInfos(titleId: string, totalVolumes: number): VolumeInfo[] {
    const volumes: VolumeInfo[] = [];

    for (let volNum = 1; volNum <= totalVolumes; volNum++) {
      const urlInfo = BookLiveScraper.generateReaderUrl(titleId, volNum);
      volumes.push({
        volume: volNum,
        readerUrl: urlInfo.readerUrl,
        contentKey: urlInfo.cid,
        detailUrl: urlInfo.detailUrl,
      });
    }

    return volumes;
  }

  /**
   * Generate reader URL for a specific volume.
   * @param titleId - Title ID (e.g., "2122098")
   * @param volume - Volume number (e.g., 1)
   * @returns Reader URL information
   */
  static generateReaderUrl(
    titleId: string,
    volume: number
  ): {
    titleId: string;
    volume: number;
    cid: string;
    readerUrl: string;
    detailUrl: string;
  } {
    const baseUrl = "https://booklive.jp";

    // Generate cid: titleId_volumeNumber(padded to 3 digits)
    const cid = `${titleId}_${String(volume).padStart(3, "0")}`;

    // Generate reader URL
    const readerUrl = `${baseUrl}/bviewer/?cid=${cid}`;

    // Generate detail page URL
    const detailUrl =
      volume === 1
        ? `${baseUrl}/product/index/title_id/${titleId}`
        : `${baseUrl}/product/index/title_id/${titleId}/vol.${volume}`;

    return {
      titleId,
      volume,
      cid,
      readerUrl,
      detailUrl,
    };
  }
}
