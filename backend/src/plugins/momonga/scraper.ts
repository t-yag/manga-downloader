import * as cheerio from "cheerio";
import type { MetadataProvider, TitleInfo, VolumeInfo } from "../base.js";

interface ParsedPage {
  titleInfo: TitleInfo;
  imageUrls: string[];
}

export class MomongaScraper implements MetadataProvider {
  private readonly baseUrl = "https://momon-ga.com";
  private readonly timeout = 30000;
  private readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  async getTitleInfo(titleId: string): Promise<TitleInfo> {
    const parsed = await this.fetchAndParse(titleId);
    return parsed.titleInfo;
  }

  async getVolumeInfo(titleId: string, _volume: number): Promise<VolumeInfo> {
    return {
      volume: 1,
      readerUrl: "",
      contentKey: titleId,
    };
  }

  async getImageUrls(titleId: string): Promise<string[]> {
    const parsed = await this.fetchAndParse(titleId);
    return parsed.imageUrls;
  }

  private async fetchAndParse(titleId: string): Promise<ParsedPage> {
    // Try fanzine first, then magazine
    const categories = ["fanzine", "magazine"];

    for (const category of categories) {
      const url = `${this.baseUrl}/${category}/mo${titleId}/`;
      const response = await fetch(url, {
        headers: { "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (response.ok) {
        return this.parseHtml(await response.text(), titleId);
      }

      if (response.status !== 404) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }

    throw new Error(`Gallery ${titleId} not found`);
  }

  private parseHtml(html: string, titleId: string): ParsedPage {
    const $ = cheerio.load(html);

    const title = $("h1").first().text().trim() || "Unknown";

    const author = this.extractTagValue($, "作者");
    const circle = this.extractTagValue($, "サークル");
    const authorStr = [circle, author].filter(Boolean).join(" / ") || "Unknown";

    const tags: string[] = [];
    $(".post-tag-table")
      .filter((_, el) =>
        $(el).find(".post-tag-title").text().trim() === "内容",
      )
      .find(".post-tags a")
      .each((_, el) => {
        const tag = $(el).text().trim();
        if (tag) tags.push(tag);
      });

    // Extract image URLs from #post-hentai
    const imageUrls: string[] = [];
    $("#post-hentai img").each((_, el) => {
      const src = $(el).attr("src");
      if (src) imageUrls.push(src);
    });

    const thumbEl = $("div.history");
    const coverUrl =
      thumbEl.attr("data-thumb") || imageUrls[0] || undefined;

    return {
      imageUrls,
      titleInfo: {
        titleId,
        title,
        seriesTitle: title,
        author: authorStr,
        genres: tags,
        totalVolumes: 1,
        coverUrl,
        volumes: [
          {
            volume: 1,
            readerUrl: "",
            contentKey: titleId,
            thumbnailUrl: coverUrl,
          },
        ],
      },
    };
  }

  private extractTagValue($: cheerio.CheerioAPI, label: string): string {
    let value = "";
    $(".post-tag-table").each((_, el) => {
      if (value) return;
      const tagTitle = $(el).find(".post-tag-title").text().trim();
      if (tagTitle === label) {
        value = $(el)
          .find(".post-tags a")
          .map((_, a) => $(a).text().trim())
          .get()
          .join(", ");
      }
    });
    return value;
  }
}
