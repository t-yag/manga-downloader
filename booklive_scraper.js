import * as cheerio from 'cheerio';
import axios from 'axios';
import BookLiveAuth from './booklive_auth.js';

/**
 * BookLiveのスクレイパークラス
 */
class BookLiveScraper {
  constructor(timeout = 30000, cookieFile = 'booklive_cookies.json') {
    this.timeout = timeout;
    this.baseUrl = 'https://booklive.jp';
    this.auth = new BookLiveAuth(cookieFile);
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
   * @param {string} titleId - タイトルID（例: "2122098"）
   * @returns {Promise<Object>} タイトル情報
   */
  async getTitleInfo(titleId) {
    const url = `${this.baseUrl}/product/index/title_id/${titleId}`;

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
      const { title, seriesTitle } = this._extractTitle($);

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
        title,          // 巻数含む（metadata用）
        seriesTitle,    // 巻数なし（ディレクトリ名用）
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
    // h1から取得（巻数が含まれる） - metadata用
    let title =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '不明';

    // .book_titleから取得（巻数が含まれない） - ディレクトリ名用
    let seriesTitle =
      $('.book_title').first().text().trim() ||
      title;  // フォールバック

    // 明確に不要なプレフィックスのみを削除
    title = title
      .replace(/【期間限定[^】]*】/g, '')
      .replace(/【無料[^】]*】/g, '')
      .replace(/【お試し[^】]*】/g, '')
      .replace(/【試し読み[^】]*】/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    seriesTitle = seriesTitle
      .replace(/【期間限定[^】]*】/g, '')
      .replace(/【無料[^】]*】/g, '')
      .replace(/【お試し[^】]*】/g, '')
      .replace(/【試し読み[^】]*】/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return { title, seriesTitle };
  }

  /**
   * 著者名を抽出
   */
  _extractAuthor($) {
    const authors = $('.author a, .product_author a')
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
      /(\d+)巻セット/,
      /(\d+)冊/
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return parseInt(match[1]);
      }
    }

    // 巻数のリストから推測
    const volumeLinks = $('a[href*="/product/"][href*="/vol."]');
    let maxVol = 0;

    volumeLinks.each((i, el) => {
      const href = $(el).attr('href');
      const volMatch = href.match(/\/vol\.(\d+)\//);
      if (volMatch) {
        maxVol = Math.max(maxVol, parseInt(volMatch[1]));
      }
    });

    if (maxVol > 0) {
      return maxVol;
    }

    // デフォルト: 単行本として扱う
    return 1;
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
      $('.book_description').first().text().trim() ||
      $('.product_description').first().text().trim() ||
      $('.description').first().text().trim() ||
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
      const urlInfo = BookLiveScraper.generateReaderUrl(titleId, volNum);
      volumes.push({
        volume: volNum,
        url: urlInfo.detailUrl,
        cid: urlInfo.cid,
        readerUrl: urlInfo.readerUrl
      });
    }

    return volumes;
  }

  /**
   * 認証済みでコンテンツ情報を取得（簡易実装）
   * @param {string} titleId - タイトルID（例: "2122098"）
   * @param {number} volume - 巻番号（例: 1）
   * @returns {Promise<Object>} コンテンツ情報
   */
  async getContentInfo(titleId, volume) {
    if (!this.auth.getCookies()) {
      throw new Error('認証が必要です。先に initialize() を呼び出してください。');
    }

    // BookLiveの場合、cidは タイトルID_巻番号(3桁ゼロ埋め)
    const cid = `${titleId}_${String(volume).padStart(3, '0')}`;

    // 注意: BookLiveにはcmoaのような簡易的なAPI確認エンドポイントがない可能性があるため、
    // ここでは基本情報のみ返す簡易実装とします。
    // 実際のアクセス権限確認は、binb_scraperでのダウンロード試行時に判明します。

    return {
      cid: cid,
      titleId: titleId,
      volume: volume,
      readerUrl: `${this.baseUrl}/bviewer/?cid=${cid}`,
      // モック実装として常に全ページアクセス可能とする
      isFullAccess: true,
      viewMode: 1, // 1: 全ページ（仮）
      note: 'BookLive版は簡易実装のため、実際のアクセス権限はダウンロード時に判明します'
    };
  }

  /**
   * ブラウザを閉じてリソースをクリーンアップ
   */
  async close() {
    await this.auth.close();
  }

  /**
   * 特定の巻のリーダーURLを生成
   * @param {string} titleId - タイトルID（例: "2122098"）
   * @param {number} volume - 巻番号（例: 1）
   * @returns {Object} リーダーURL情報
   */
  static generateReaderUrl(titleId, volume) {
    const baseUrl = 'https://booklive.jp';

    // cidを生成: タイトルID_巻番号(3桁ゼロ埋め)
    const cid = `${titleId}_${String(volume).padStart(3, '0')}`;

    // リーダーURLを生成
    const readerUrl = `${baseUrl}/bviewer/?cid=${cid}`;

    // 詳細ページのURL
    const detailUrl = volume === 1
      ? `${baseUrl}/product/index/title_id/${titleId}`
      : `${baseUrl}/product/index/title_id/${titleId}/vol.${volume}`;

    return {
      titleId,
      volume,
      cid,
      readerUrl,
      detailUrl
    };
  }
}

export default BookLiveScraper;
