/**
 * 共通ユーティリティ関数
 */

/**
 * スピナーアニメーション管理クラス
 */
export class Spinner {
  constructor() {
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.index = 0;
  }

  getFrame() {
    const frame = this.frames[this.index];
    this.index = (this.index + 1) % this.frames.length;
    return frame;
  }

  reset() {
    this.index = 0;
  }
}

/**
 * 時間をフォーマット (ミリ秒 → 人間が読める形式)
 * @param {number} ms - ミリ秒
 * @returns {string} フォーマットされた時間
 */
export function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * ファイル名として使える文字列にサニタイズ
 * @param {string} filename - 元のファイル名
 * @param {number} maxLength - 最大文字数（デフォルト: 100）
 * @returns {string} サニタイズされたファイル名
 */
export function sanitizeFilename(filename, maxLength = 100) {
  return filename
    .replace(/[<>:"\/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, maxLength);
}

/**
 * コンソールの現在行をクリア
 */
export function clearLine() {
  process.stdout.write('\r\x1b[K');
}

/**
 * プログレスバー管理クラス
 */
export class ProgressBar {
  constructor() {
    this.spinner = new Spinner();
    this.startTime = Date.now();
    this.interval = null;
  }

  /**
   * プログレスバーを開始
   * @param {Function} updateCallback - 更新時に呼ばれるコールバック
   */
  start(updateCallback) {
    this.startTime = Date.now();
    this.interval = setInterval(() => {
      updateCallback();
    }, 100);
  }

  /**
   * プログレスバーを停止
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      clearLine();
    }
  }

  /**
   * 経過時間を取得
   * @returns {number} ミリ秒
   */
  getElapsedTime() {
    return Date.now() - this.startTime;
  }

  /**
   * スピナーフレームを取得
   * @returns {string}
   */
  getSpinnerFrame() {
    return this.spinner.getFrame();
  }
}
