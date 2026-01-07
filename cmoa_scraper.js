import * as cheerio from 'cheerio';

/**
 * コミックシーモアのスクレイパークラス
 */
class CmoaScraper {
  constructor(timeout = 30000) {
    this.timeout = timeout;
    this.baseUrl = 'https://www.cmoa.jp';
  }

  /**
   * タイトルIDから漫画の情報を取得
   * @param {string} titleId - タイトルID（例: "299367"）
   * @returns {Promise<Object>} タイトル情報
   */
  async getTitleInfo(titleId) {
    const url = `${this.baseUrl}/title/${titleId}/`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // タイトル名を取得
      const title = this._extractTitle($);

      // 著者を取得
      const author = this._extractAuthor($);

      // 総巻数を取得
      const totalVolumes = this._extractTotalVolumes($, html);

      // ジャンルを取得
      const genres = this._extractGenres($);

      // 説明文を取得
      const description = this._extractDescription($);

      // 各巻のURLを生成
      const volumes = this._generateVolumeUrls(titleId, totalVolumes);

      return {
        titleId,
        title,
        author,
        totalVolumes,
        genres,
        description,
        volumes,
        url
      };
    } catch (error) {
      throw new Error(`ページの取得に失敗しました: ${error.message}`);
    }
  }

  /**
   * タイトル名を抽出
   */
  _extractTitle($) {
    const title = 
      $('.title_details_main_box_b_box h1').first().text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '不明';

    return title;
  }

  /**
   * 著者名を抽出
   */
  _extractAuthor($) {
    const authors = $('.title_details_main_box_b_box .author a')
      .map((i, el) => $(el).text().trim())
      .get();

    return authors.length > 0 ? authors.join(', ') : '不明';
  }

  /**
   * 総巻数を抽出
   */
  _extractTotalVolumes($, html) {
    // 「全○巻」「○巻配信中」などのテキストを探す
    const patterns = [
      /全(\d+)巻/,
      /(\d+)巻配信中/,
      /(\d+)巻セット/
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return parseInt(match[1]);
      }
    }

    // 巻数のリストから推測
    const volumeLinks = $('a[href*="/title/"][href*="/vol/"]');
    let maxVol = 0;

    volumeLinks.each((i, el) => {
      const href = $(el).attr('href');
      const volMatch = href.match(/\/vol\/(\d+)\//);
      if (volMatch) {
        maxVol = Math.max(maxVol, parseInt(volMatch[1]));
      }
    });

    if (maxVol > 0) {
      return maxVol;
    }

    return 1; // デフォルト
  }

  /**
   * ジャンルを抽出
   */
  _extractGenres($) {
    const genres = [];
    $('a[href*="/genre/"]').each((i, el) => {
      const genre = $(el).text().trim();
      if (genre && !genres.includes(genre)) {
        genres.push(genre);
      }
    });

    return genres;
  }

  /**
   * 説明文を抽出
   */
  _extractDescription($) {
    return (
      $('.description').first().text().trim() ||
      $('.summary').first().text().trim() ||
      $('meta[property="og:description"]').attr('content') ||
      ''
    );
  }

  /**
   * 各巻のURL情報を生成
   */
  _generateVolumeUrls(titleId, totalVolumes) {
    const volumes = [];

    for (let volNum = 1; volNum <= totalVolumes; volNum++) {
      const urlInfo = CmoaScraper.generateReaderUrl(titleId, volNum);
      volumes.push({
        volume: volNum,
        url: urlInfo.detailUrl,
        contentId: urlInfo.contentId,
        readerUrl: urlInfo.readerUrl
      });
    }

    return volumes;
  }

  /**
   * 特定の巻のリーダーURLを生成
   * @param {string} titleId - タイトルID（例: "299367"）
   * @param {number} volume - 巻番号（例: 1）
   * @returns {Object} リーダーURL情報
   */
  static generateReaderUrl(titleId, volume) {
    const baseUrl = 'https://www.cmoa.jp';
    
    // content_idを生成
    const contentId = `1000${String(titleId).padStart(7, '0')}${String(volume).padStart(4, '0')}`;

    // リーダーURL（サンプル）を生成
    const readerUrl = `${baseUrl}/reader/sample/?title_id=${titleId}&content_id=${contentId}`;

    // 詳細ページのURL
    const detailUrl = volume === 1
      ? `${baseUrl}/title/${titleId}/`
      : `${baseUrl}/title/${titleId}/vol/${volume}/`;

    return {
      titleId,
      volume,
      contentId,
      readerUrl,
      detailUrl
    };
  }
}

export default CmoaScraper;
