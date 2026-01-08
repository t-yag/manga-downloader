import 'dotenv/config';
import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

/**
 * コミックシーモア 認証管理クラス
 * Cookie保存・再利用機能付き
 */
class CmoaAuth {
  constructor(cookieFile = 'cmoa_cookies.json') {
    this.browser = null;
    this.cookies = null;
    this.cookieFile = cookieFile;
  }

  /**
   * Cookieをファイルに保存
   */
  async saveCookies() {
    if (!this.cookies || this.cookies.length === 0) {
      console.log('⚠️  保存するCookieがありません');
      return false;
    }

    try {
      await fs.writeFile(
        this.cookieFile,
        JSON.stringify(this.cookies, null, 2),
        'utf-8'
      );
      console.log('✅ Cookie保存成功:', this.cookieFile);
      return true;
    } catch (error) {
      console.error('❌ Cookie保存失敗:', error.message);
      return false;
    }
  }

  /**
   * Cookieをファイルから読み込み
   */
  async loadCookies() {
    try {
      const data = await fs.readFile(this.cookieFile, 'utf-8');
      this.cookies = JSON.parse(data);
      console.log(`✅ Cookie読み込み成功: ${this.cookies.length}個`);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('ℹ️  保存されたCookieが見つかりません');
      } else {
        console.error('❌ Cookie読み込み失敗:', error.message);
      }
      return false;
    }
  }

  /**
   * Cookieの有効性を確認
   * 簡単なAPIリクエストでログイン状態をチェック
   * @param {string} testTitleId - 検証用タイトルID（デフォルト: 環境変数 TEST_TITLE_ID または '99473'）
   * @param {number} testVolume - 検証用巻番号（デフォルト: 環境変数 TEST_VOLUME または 1）
   */
  async validateCookies(testTitleId = null, testVolume = null) {
    if (!this.cookies || this.cookies.length === 0) {
      console.log('ℹ️  検証するCookieがありません');
      return false;
    }

    console.log('\n🔍 Cookie有効性チェック中...');

    try {
      // Cookieを文字列に変換
      const cookieString = this.cookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

      // テスト用パラメータ（環境変数またはデフォルト値）
      const titleId = testTitleId || process.env.TEST_TITLE_ID || '99473';
      const volume = testVolume || parseInt(process.env.TEST_VOLUME || '1', 10);
      // cidの生成: titleID部分を6桁にパディングして、全体で10桁にする
      const paddedTitleId = String(titleId).padStart(6, '0');
      const cid = `0000${paddedTitleId}_jp_${String(volume).padStart(4, '0')}`;
      const dmytime = Date.now();
      const k = 'testKey';

      const response = await axios.get(
        `https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php?cid=${cid}&dmytime=${dmytime}&k=${k}&u0=0&u1=0`,
        {
          headers: {
            'Accept': '*/*',
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          },
          timeout: 10000
        }
      );

      const data = response.data;

      // APIの結果チェック（result=0は失敗）
      if (data.result === 0) {
        console.log('⚠️  Cookie検証失敗: コンテンツ情報の取得に失敗しました');
        return false;
      }

      // 配列アクセス前のチェック
      if (!data.items || data.items.length === 0) {
        console.log('⚠️  Cookie検証失敗: コンテンツ情報が取得できませんでした');
        return false;
      }

      const item = data.items[0];

      // デバッグ出力（環境変数DEBUGが設定されている場合）
      if (process.env.DEBUG) {
        console.log('   📋 APIレスポンス詳細:');
        console.log(`   - result: ${data.result}`);
        console.log(`   - Title: "${item.Title}"`);
        console.log(`   - ViewMode: ${item.ViewMode} (1=全ページ, 2=試し読み)`);
        console.log(`   - LastPageURL: ${item.LastPageURL}`);
      }

      // ログイン状態の確認
      // ViewMode: 1=全ページ, 2=試し読み
      const isFullAccess = item.ViewMode === 1;
      const hasSampleFlag = item.LastPageURL && item.LastPageURL.includes('sample_flg=0');

      if (isFullAccess && hasSampleFlag) {
        console.log('✅ Cookie有効：ログイン状態を確認');
        return true;
      } else if (isFullAccess && !hasSampleFlag) {
        // ViewMode=1なら有効とみなす（sample_flgチェックを緩和）
        console.log('✅ Cookie有効：ログイン状態を確認');
        return true;
      } else {
        console.log('⚠️  Cookie無効：試し読みモードです');
        return false;
      }

    } catch (error) {
      console.log('⚠️  Cookie検証失敗:', error.message);
      return false;
    }
  }

  /**
   * ログイン（必要な場合のみ）
   */
  async ensureLogin(email, password, forceLogin = false) {
    console.log('\n🔐 認証状態の確認...');

    // 強制ログインでない場合、既存のCookieをチェック
    if (!forceLogin) {
      const loaded = await this.loadCookies();
      if (loaded) {
        const isValid = await this.validateCookies();
        if (isValid) {
          console.log('✅ 既存のCookieが有効です（ログインスキップ）');
          return true;
        } else {
          console.log('⚠️  既存のCookieが無効です（再ログインします）');
        }
      }
    }

    // ログイン実行
    console.log('\n🌐 ブラウザでログイン実行中...');
    const loginSuccess = await this.loginWithBrowser(email, password);

    if (loginSuccess) {
      // Cookieを保存
      await this.saveCookies();
      return true;
    }

    return false;
  }

  /**
   * ブラウザでログイン実行
   */
  async loginWithBrowser(email, password) {
    // ブラウザ起動オプション
    const launchOptions = {
      headless: false, // OpenIDフロー完了のため非headlessモード
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    // 環境変数でChrome実行パスが指定されている場合のみ使用
    if (process.env.CHROME_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.CHROME_EXECUTABLE_PATH;
    }

    // ブラウザ起動
    this.browser = await puppeteer.launch(launchOptions);

    const page = await this.browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    try {
      // ログインページにアクセス
      await page.goto('https://www.cmoa.jp/auth/login/', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // 入力フィールド待機
      await page.waitForSelector('input[name="email"]', { timeout: 30000 });

      // メールアドレス・パスワード入力
      await page.type('input[name="email"]', email, { delay: 100 });
      await page.type('input[name="password"]', password, { delay: 100 });

      // ログインボタンをクリック
      const submitButton = await page.$('#submitButton');
      if (!submitButton) {
        throw new Error('ログインボタンが見つかりません');
      }

      await submitButton.click();

      try {
        await page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
      } catch (navError) {
        // ナビゲーションタイムアウトは無視
      }

      // OpenIDリダイレクトを待つ（最大15秒）
      const maxWaitTime = 15000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        const currentUrl = page.url();

        // www.cmoa.jp にリダイレクトされたら成功
        if (currentUrl.includes('www.cmoa.jp') && !currentUrl.includes('/auth/login')) {
          break;
        }

        // エラーページにいたら失敗
        if (currentUrl.includes('member.cmoa.jp/openid/provider')) {
          throw new Error('ログインエラー: OpenIDプロバイダーページで停止');
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Cookieを取得
      this.cookies = await page.cookies();

      const finalUrl = page.url();

      // ログイン成功の確認
      if (!finalUrl.includes('www.cmoa.jp') || finalUrl.includes('/auth/login')) {
        throw new Error('ログイン失敗: 正しいページにリダイレクトされませんでした');
      }

      console.log(`✅ ログイン成功（Cookie: ${this.cookies.length}個取得）`);

      return true;

    } catch (error) {
      console.error('❌ ログイン失敗:', error.message);
      return false;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch (e) {
          // ページクローズのエラーは無視
        }
      }
    }
  }

  /**
   * ブラウザを閉じる
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Cookieを取得（他のモジュールで使用）
   */
  getCookies() {
    return this.cookies;
  }

  /**
   * Cookie文字列を取得
   */
  getCookieString() {
    if (!this.cookies) return '';
    return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
}

export default CmoaAuth;
