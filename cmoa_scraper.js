import * as cheerio from 'cheerio';
import axios from 'axios';
import CmoaAuth from './cmoa_auth.js';

/**
 * コミックシーモアのスクレイパークラス
 */
class CmoaScraper {
  constructor(timeout = 30000, cookieFile = 'cmoa_cookies.json') {
    this.timeout = timeout;
    this.baseUrl = 'https://www.cmoa.jp';
    this.auth = new CmoaAuth(cookieFile);
  }

  /**
   * 認証を初期化（必要な場合のみログイン）
   * @param {string} email - メールアドレス
   * @param {string} password - パスワード
   * @param {boolean} forceLogin - 強制的に再ログイン
   * @returns {Promise<boolean>} 認証成功したか
   */
  async initialize(email, password, forceLogin = false) {
    return await this.auth.ensureLogin(email, password, forceLogin);
  }

  /**
   * タイトルIDから漫画の情報を取得
   * @param {string} titleId - タイトルID（例: "99473"）
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
   * 認証済みでコンテンツ情報を取得
   * @param {string} titleId - タイトルID（例: "99473"）
   * @param {number} volume - 巻番号（例: 2）
   * @returns {Promise<Object>} コンテンツ情報
   */
  async getContentInfo(titleId, volume) {
    if (!this.auth.getCookies()) {
      throw new Error('認証が必要です。先に initialize() を呼び出してください。');
    }

    // cidの生成: titleID部分を6桁にパディングして、全体で10桁にする
    const paddedTitleId = String(titleId).padStart(6, '0');
    const cid = `0000${paddedTitleId}_jp_${String(volume).padStart(4, '0')}`;
    const dmytime = Date.now();
    const k = 'testKey';

    try {
      const response = await axios.get(
        `${this.baseUrl}/bib/sws/bibGetCntntInfo.php?cid=${cid}&dmytime=${dmytime}&k=${k}&u0=0&u1=0`,
        {
          headers: {
            'Accept': '*/*',
            'Cookie': this.auth.getCookieString(),
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          },
          timeout: this.timeout
        }
      );

      const data = response.data;

      if (data.result === 0) {
        throw new Error('コンテンツ情報の取得に失敗しました（認証エラーの可能性があります）');
      }

      // 配列アクセス前のチェック
      if (!data.items || data.items.length === 0) {
        throw new Error('コンテンツ情報が見つかりませんでした（タイトルIDまたは巻番号が無効な可能性があります）');
      }

      const item = data.items[0];

      return {
        result: data.result,
        shopUserId: data.ShopUserID,
        contentId: item.ContentID,
        title: item.Title,
        authors: item.Authors,
        publisher: item.Publisher,
        viewMode: item.ViewMode, // 1: 全ページ, 2: 試し読み
        isFullAccess: item.ViewMode === 1 && item.LastPageURL.includes('sample_flg=0'),
        termForRead: item.TermForRead,
        lastPageUrl: item.LastPageURL,
        contentsServer: item.ContentsServer,
        rawData: data
      };
    } catch (error) {
      if (error.response) {
        throw new Error(`API エラー: ${error.response.status} ${error.response.statusText}`);
      }
      throw new Error(`コンテンツ情報の取得に失敗しました: ${error.message}`);
    }
  }

  /**
   * ブラウザを閉じてリソースをクリーンアップ
   */
  async close() {
    await this.auth.close();
  }

  /**
   * 特定の巻のリーダーURLを生成
   * @param {string} titleId - タイトルID（例: "99473"）
   * @param {number} volume - 巻番号（例: 1）
   * @returns {Object} リーダーURL情報
   */
  static generateReaderUrl(titleId, volume) {
    const baseUrl = 'https://www.cmoa.jp';

    // content_idを生成
    const contentId = `1000${String(titleId).padStart(7, '0')}${String(volume).padStart(4, '0')}`;

    // リーダーURLを生成
    const readerUrl = `${baseUrl}/reader/browserviewer/?content_id=${contentId}`;

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
