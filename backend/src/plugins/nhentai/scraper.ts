import type { MetadataProvider, TitleInfo, VolumeInfo } from "../base.js";

interface NhentaiGallery {
  id: number;
  media_id: string;
  title: {
    english: string;
    japanese: string;
    pretty: string;
  };
  images: {
    pages: { t: string; w: number; h: number }[];
    cover: { t: string; w: number; h: number };
  };
  tags: {
    id: number;
    type: string;
    name: string;
    url: string;
    count: number;
  }[];
  num_pages: number;
  num_favorites: number;
}

const IMAGE_TYPE_MAP: Record<string, string> = {
  j: "jpg",
  p: "png",
  g: "gif",
  w: "webp",
};

export class NhentaiScraper implements MetadataProvider {
  private readonly apiBase = "https://nhentai.net/api";
  private readonly imageBase = "https://i.nhentai.net/galleries";
  private readonly thumbBase = "https://t.nhentai.net/galleries";
  private readonly timeout = 30000;

  async getTitleInfo(titleId: string): Promise<TitleInfo> {
    const response = await fetch(`${this.apiBase}/gallery/${titleId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`nhentai API error: HTTP ${response.status}`);
    }

    const gallery: NhentaiGallery = await response.json();
    return this.toTitleInfo(gallery);
  }

  private async toTitleInfo(gallery: NhentaiGallery): Promise<TitleInfo> {
    const title =
      gallery.title.japanese || gallery.title.pretty || gallery.title.english;

    const artists = gallery.tags
      .filter((t) => t.type === "artist")
      .map((t) => t.name);
    const groups = gallery.tags
      .filter((t) => t.type === "group")
      .map((t) => t.name);
    const author =
      [...groups, ...artists].join(" / ") || "Unknown";

    const tags = gallery.tags
      .filter((t) => t.type === "tag")
      .map((t) => t.name);

    const coverExt = IMAGE_TYPE_MAP[gallery.images.cover.t] || "jpg";
    const coverUrl = await this.resolveCoverUrl(gallery.media_id, coverExt);

    return {
      titleId: String(gallery.id),
      title,
      seriesTitle: title,
      author,
      genres: tags,
      totalVolumes: 1,
      coverUrl,
      volumes: [
        {
          volume: 1,
          readerUrl: "",
          contentKey: String(gallery.id),
          thumbnailUrl: coverUrl,
        },
      ],
    };
  }

  /**
   * Resolve a working cover URL by trying the API-reported extension first,
   * then falling back to jpg (nhentai thumb servers are inconsistent).
   */
  private async resolveCoverUrl(mediaId: string, preferredExt: string): Promise<string> {
    const preferred = `${this.thumbBase}/${mediaId}/cover.${preferredExt}`;
    try {
      const res = await fetch(preferred, {
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return preferred;
    } catch { /* ignore */ }

    // Fallback: try jpg if that wasn't the preferred ext
    if (preferredExt !== "jpg") {
      const fallback = `${this.thumbBase}/${mediaId}/cover.jpg`;
      try {
        const res = await fetch(fallback, {
          method: "HEAD",
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return fallback;
      } catch { /* ignore */ }
    }

    // Return preferred URL even if unverified (might work later)
    return preferred;
  }

  async getVolumeInfo(titleId: string, _volume: number): Promise<VolumeInfo> {
    return {
      volume: 1,
      readerUrl: "",
      contentKey: titleId,
    };
  }

  /**
   * Get image URLs for downloading.
   * Uses the API to get media_id and page types, then constructs URLs.
   */
  async getImageUrls(titleId: string): Promise<string[]> {
    const response = await fetch(`${this.apiBase}/gallery/${titleId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`nhentai API error: HTTP ${response.status}`);
    }

    const gallery: NhentaiGallery = await response.json();

    return gallery.images.pages.map((page, idx) => {
      const ext = IMAGE_TYPE_MAP[page.t] || "jpg";
      return `${this.imageBase}/${gallery.media_id}/${idx + 1}.${ext}`;
    });
  }
}
