import { Browser, Page } from "puppeteer";
import { logger } from "../../logger.js";
import { launchBrowser } from "../browser.js";
import type {
  MetadataProvider,
  TitleInfo,
  VolumeInfo,
} from "../base.js";

const log = logger.child({ module: "PiccomaScraper" });

const PICCOMA_BASE = "https://piccoma.com/web";

/**
 * Piccoma metadata scraper.
 * Uses Puppeteer to load product pages and extract episode/volume data
 * from the DOM (data attributes contain product_id and episode_id).
 * No session needed — public pages have all metadata.
 */
export class PiccomaScraper implements MetadataProvider {
  private async createPage(): Promise<{ browser: Browser; page: Page }> {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    return { browser, page };
  }

  async getTitleInfo(titleId: string): Promise<TitleInfo> {
    const url = `${PICCOMA_BASE}/product/${titleId}`;
    log.info(`Fetching title info: ${url}`);

    const { browser, page } = await this.createPage();

    try {
      // Step 1: Product page — metadata only (title, author, cover, tags)
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 3000));

      const meta: any = await page.evaluate(`(function() {
        var titleEl = document.querySelector(".PCM-productTitle");
        var title = titleEl ? titleEl.textContent.trim() : "";

        var authorEls = document.querySelectorAll(".PCM-productAuthor a");
        var authors = [];
        for (var i = 0; i < authorEls.length; i++) authors.push(authorEls[i].textContent.trim());

        var genreEl = document.querySelector(".PCM-productGenre a");
        var genre = genreEl ? genreEl.textContent.trim() : "";

        var coverEl = document.querySelector(".PCM-productThum_img");
        var coverImg = coverEl ? coverEl.getAttribute("src") : "";
        if (!coverImg) {
          var ogImg = document.querySelector("meta[property='og:image']");
          coverImg = ogImg ? ogImg.getAttribute("content") : "";
        }

        var tagEls = document.querySelectorAll(".PCM-productDesc_tagList a");
        var tags = [];
        for (var i = 0; i < tagEls.length; i++) tags.push(tagEls[i].textContent.trim());

        return { title: title, authors: authors, genre: genre, coverImg: coverImg, tags: tags };
      })()`);

      const coverUrl = meta.coverImg
        ? (meta.coverImg.startsWith("//") ? `https:${meta.coverImg}` : meta.coverImg)
        : undefined;

      // Step 2: Fetch episodes (話読み) from dedicated episode list page
      let episodeInfos: VolumeInfo[] = [];
      try {
        episodeInfos = await this.fetchEpisodeList(page, titleId);
      } catch (err: any) {
        log.warn(`Failed to fetch episode list: ${err.message}`);
      }

      // Step 3: Fetch volumes (巻読み) from dedicated volume list page
      let volumeInfos: VolumeInfo[] = [];
      try {
        volumeInfos = await this.fetchVolumeList(page, titleId);
      } catch (err: any) {
        log.warn(`Failed to fetch volume list: ${err.message}`);
      }

      const allInfos = [...episodeInfos, ...volumeInfos];
      log.info(`Total: ${episodeInfos.length} episode(s), ${volumeInfos.length} volume(s)`);

      return {
        titleId,
        title: meta.title,
        seriesTitle: meta.title,
        author: meta.authors.join(", "),
        genres: meta.tags.length > 0 ? meta.tags : (meta.genre ? [meta.genre] : []),
        totalVolumes: allInfos.length,
        coverUrl,
        volumes: allInfos,
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * Fetch the episode (話読み) list page and return VolumeInfo entries with unit="ep".
   * Directly opens /product/{id}/episodes?etype=E instead of relying on product page DOM.
   */
  private async fetchEpisodeList(page: Page, titleId: string): Promise<VolumeInfo[]> {
    const url = `${PICCOMA_BASE}/product/${titleId}/episodes?etype=E`;
    log.info(`Fetching episode list: ${url}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    const episodes = (await page.evaluate(`(function() {
      var links = document.querySelectorAll("a[data-episode_id]");
      var seen = {};
      var result = [];
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var epId = a.getAttribute("data-episode_id") || "";
        if (!epId || seen[epId]) continue;
        seen[epId] = true;
        var titleEl = a.querySelector(".PCM-epList_title h2, [class*='title']");
        var imgEl = a.querySelector(".PCM-epList_thum img");
        var thumbUrl = "";
        if (imgEl) {
          thumbUrl = imgEl.getAttribute("data-original") || imgEl.getAttribute("src") || "";
          if (thumbUrl.indexOf("/icon_") !== -1 || thumbUrl.indexOf("/bm/") !== -1) thumbUrl = "";
        }
        result.push({
          productId: a.getAttribute("data-product_id") || "",
          episodeId: epId,
          thumbnailUrl: thumbUrl,
        });
      }
      return result;
    })()`)) as any[];

    log.info(`Episode list: ${episodes.length} episodes`);

    return episodes.map((ep: any, idx: number) => ({
      volume: idx + 1,
      unit: "ep",
      readerUrl: `${PICCOMA_BASE}/viewer/${ep.productId}/${ep.episodeId}`,
      contentKey: ep.episodeId,
      thumbnailUrl: ep.thumbnailUrl
        ? (ep.thumbnailUrl.startsWith("//") ? `https:${ep.thumbnailUrl}` : ep.thumbnailUrl)
        : undefined,
    }));
  }

  /**
   * Fetch the volume (巻読み) list page and return VolumeInfo entries with unit="vol".
   */
  private async fetchVolumeList(page: Page, titleId: string): Promise<VolumeInfo[]> {
    const url = `${PICCOMA_BASE}/product/${titleId}/episodes?etype=V`;
    log.info(`Fetching volume list: ${url}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    const volumes = (await page.evaluate(`(function() {
      var items = document.querySelectorAll(".PCM-productSaleList_volume li");
      var seen = {};
      var result = [];
      for (var i = 0; i < items.length; i++) {
        var li = items[i];
        var titleEl = li.querySelector(".PCM-prdVol_title h2");
        var imgEl = li.querySelector(".PCM-prdVol_cvrImg img");

        // Priority: freeBtn (free campaign) > readBtn (purchased) > buyBtn > trialBtn
        var freeBtn = li.querySelector(".PCM-prdVol_freeBtn[data-episode_id]");
        var readBtn = li.querySelector(".PCM-prdVol_readBtn[data-episode_id]");
        var buyBtn = li.querySelector(".PCM-prdVol_buyBtn[data-episode_id]");
        var trialBtn = li.querySelector(".PCM-prdVol_trialBtn[data-episode_id]");
        var bestBtn = freeBtn || readBtn || null;
        var fallbackBtn = buyBtn || trialBtn || null;

        // Use the best readable button, fall back to buy/trial for metadata
        var btn = bestBtn || fallbackBtn;
        if (!btn) {
          // Last resort: any element with data-episode_id
          btn = li.querySelector("[data-episode_id]");
        }

        var epId = btn ? (btn.getAttribute("data-episode_id") || "") : "";
        var prodId = btn ? (btn.getAttribute("data-product_id") || "") : "";

        if (!epId || seen[epId]) continue;
        seen[epId] = true;

        result.push({
          title: titleEl ? titleEl.textContent.trim() : "",
          productId: prodId || "",
          episodeId: epId,
          thumbnailUrl: imgEl ? (imgEl.getAttribute("data-original") || imgEl.getAttribute("src") || "") : "",
        });
      }
      return result;
    })()`)) as any[];

    log.info(`Volume list: ${volumes.length} volumes`);

    return volumes.map((vol: any, idx: number) => ({
      volume: idx + 1,
      unit: "vol",
      readerUrl: `${PICCOMA_BASE}/viewer/${vol.productId}/${vol.episodeId}`,
      contentKey: vol.episodeId,
      thumbnailUrl: vol.thumbnailUrl
        ? (vol.thumbnailUrl.startsWith("//") ? `https:${vol.thumbnailUrl}` : vol.thumbnailUrl)
        : undefined,
    }));
  }

  async getVolumeInfo(titleId: string, volume: number): Promise<VolumeInfo> {
    // Volume number is 1-indexed, maps to episode index
    // We'd need to fetch the title info to get the actual episode ID
    // For now, return a placeholder that the caller should resolve via getTitleInfo
    return {
      volume,
      readerUrl: `${PICCOMA_BASE}/viewer/${titleId}/unknown`,
      contentKey: "unknown",
    };
  }
}
