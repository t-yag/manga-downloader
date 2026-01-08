import 'dotenv/config';
import fs from 'fs/promises';

/**
 * BookLive 認証管理クラス（モック実装）
 * Cookie保存・再利用機能付き（将来の実装用）
 */
class BookLiveAuth {
  constructor(cookieFile = 'booklive_cookies.json') {
    this.browser = null;
    this.cookies = null;
    this.cookieFile = cookieFile;
    this.isMockMode = true; // モックモードフラグ
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
   * Cookieの有効性を確認（モック実装：常に有効）
   */
  async validateCookies() {
    if (this.isMockMode) {
      console.log('✅ Cookie有効（モックモード）');
      return true;
    }

    if (!this.cookies || this.cookies.length === 0) {
      console.log('ℹ️  検証するCookieがありません');
      return false;
    }

    console.log('\n🔍 Cookie有効性チェック中...');

    // TODO: 実際のBookLive APIでCookie検証を実装
    // 現時点ではモック実装として常にtrueを返す

    console.log('✅ Cookie有効：ログイン状態を確認（モック）');
    return true;
  }

  /**
   * ログイン（必要な場合のみ）
   * モック実装：常に成功する
   */
  async ensureLogin(email, password, forceLogin = false) {
    console.log('\n🔐 認証状態の確認...');

    if (this.isMockMode) {
      console.log('ℹ️  モックモード: 認証処理をスキップ');
      // ダミーCookieを設定
      this.cookies = [
        { name: 'BL_SESSION', value: 'mock_session_id_' + Date.now(), domain: '.booklive.jp' },
        { name: 'BL_AUTH', value: 'mock_auth_token', domain: '.booklive.jp' }
      ];
      console.log('✅ モック認証成功（ダミーCookie設定済み）');
      return true;
    }

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

    // TODO: 実際のログイン処理を実装
    console.log('\n⚠️  実際のログイン処理は未実装です');
    console.log('   現在はモックモードで動作します');

    return false;
  }

  /**
   * ブラウザでログイン実行（未実装）
   */
  async loginWithBrowser(email, password) {
    // TODO: Puppeteerを使ったBookLiveログイン実装
    throw new Error('loginWithBrowser は未実装です');
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

export default BookLiveAuth;
