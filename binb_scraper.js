import 'dotenv/config';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { formatTime, ProgressBar, clearLine } from './utils.js';

class BinbScraper {
  constructor(readerUrl, outputDir = './output', headless = true, cookies = null) {
    this.readerUrl = readerUrl;
    this.browser = null;
    this.page = null;
    this.imageRequests = []; // すべてのblob URLリクエストを記録
    this.currentImageIndex = 0; // 現在のインデックス
    this.outputDir = outputDir;
    this.headless = headless;
    this.cookies = cookies; // 認証Cookie
  }

  async init() {
    console.log('🚀 Initializing BINB Scraper ...');

    await fs.mkdir(this.outputDir, { recursive: true });

    // ブラウザ起動オプション
    const launchOptions = {
      headless: this.headless ? "new" : false,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    // 環境変数でChrome実行パスが指定されている場合のみ使用
    if (process.env.CHROME_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.CHROME_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    // 認証Cookieをセット
    if (this.cookies && this.cookies.length > 0) {
      await this.page.setCookie(...this.cookies);
      console.log(`✅ Authentication cookies set: ${this.cookies.length} cookies`);
    }

    // HTTPレスポンスを監視してblob URLリクエストを記録
    this.page.on('response', async (response) => {
      const url = response.url();

      // blob URLのリクエストのみ記録（デスクランブル済み画像）
      if (url.startsWith('blob:') && response.headers()['content-type']?.includes('image/')) {
        try {
          const buffer = await response.buffer();
          const timestamp = Date.now();

          this.imageRequests.push({
            url,
            buffer,
            size: buffer.length,
            timestamp
          });

          // ログは削除（冗長なため）
        } catch (e) {
          console.error(`  ⚠️  Failed to capture blob: ${e.message}`);
        }
      }
    });

    console.log('✅ Browser initialized with HTTP monitoring');
  }

  async loadReader() {
    console.log(`\n🌐 Loading reader: ${this.readerUrl}`);
    await this.page.goto(this.readerUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('⏳ Waiting for initial images...');

    // 最初の3枚の画像が読み込まれるまで待機（最大6秒）
    const startTime = Date.now();
    const timeout = 6000;
    const targetImages = 3;

    while (this.imageRequests.length < targetImages) {
      if (Date.now() - startTime > timeout) {
        console.log(`  ⚠️  Timeout waiting for initial images (got ${this.imageRequests.length}/${targetImages})`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50)); // 50msごとにチェック
    }

    const elapsed = Date.now() - startTime;
    console.log(`✅ Reader loaded in ${elapsed}ms. Total images captured: ${this.imageRequests.length}`);
  }

  async extractPageImages(pageNumber) {
    // 現在のインデックスから3枚取得
    const startIndex = this.currentImageIndex;
    const endIndex = Math.min(startIndex + 3, this.imageRequests.length);

    if (startIndex >= this.imageRequests.length) {
      return { images: [] };
    }

    const pageImages = this.imageRequests.slice(startIndex, endIndex);

    // インデックスを進める
    this.currentImageIndex = endIndex;

    return {
      images: pageImages
    };
  }

  async combineImages(imageBuffers, pageNumber) {
    const startTime = Date.now();

    // オーバーラップ値（調査結果より）
    const OVERLAP_1_TO_2 = 7; // 画像1→2の境界: 7px
    const OVERLAP_2_TO_3 = 6; // 画像2→3の境界: 6px

    // 各画像のメタデータを取得
    const metadatas = await Promise.all(
      imageBuffers.map(buffer => sharp(buffer).metadata())
    );

    // オーバーラップを考慮した高さを計算
    // 画像1 + (画像2 - overlap1) + (画像3 - overlap2)
    let totalHeight = metadatas[0].height;
    if (metadatas.length >= 2) {
      totalHeight += metadatas[1].height - OVERLAP_1_TO_2;
    }
    if (metadatas.length >= 3) {
      totalHeight += metadatas[2].height - OVERLAP_2_TO_3;
    }

    const maxWidth = Math.max(...metadatas.map(meta => meta.width));

    // 空のキャンバスを作成
    let composite = sharp({
      create: {
        width: maxWidth,
        height: totalHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    });

    // 各画像を配置（オーバーラップを考慮）
    const compositeImages = [];
    let yOffset = 0;

    for (let i = 0; i < imageBuffers.length; i++) {
      compositeImages.push({
        input: imageBuffers[i],
        top: yOffset,
        left: 0
      });

      // 次の画像のオフセットを計算（オーバーラップを引く）
      if (i === 0) {
        yOffset += metadatas[i].height - OVERLAP_1_TO_2;
      } else if (i === 1) {
        yOffset += metadatas[i].height - OVERLAP_2_TO_3;
      } else {
        yOffset += metadatas[i].height;
      }
    }

    // 画像を結合して保存
    const outputPath = path.join(this.outputDir, `page_${String(pageNumber).padStart(3, '0')}.jpg`);
    await composite
      .composite(compositeImages)
      .jpeg({ quality: 95 })
      .toFile(outputPath);

    const elapsed = Date.now() - startTime;
    return { outputPath, width: maxWidth, height: totalHeight, elapsed };
  }

  async nextPage() {
    const currentImageCount = this.imageRequests.length;
    const targetImageCount = currentImageCount + 3; // 3枚の新しい画像を待つ

    // ArrowLeftキーでページ送り
    await this.page.keyboard.press('ArrowLeft');

    // 3枚の新しい画像が読み込まれるまで待機（最大10秒）
    const startTime = Date.now();
    const timeout = 10000;

    while (this.imageRequests.length < targetImageCount) {
      if (Date.now() - startTime > timeout) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50)); // 50msごとにチェック（より高速に）
    }

    const newImagesCount = this.imageRequests.length - currentImageCount;
    return newImagesCount > 0; // 新しい画像が読み込まれたかを返す
  }

  async downloadAll(numPages = null) {
    // プログレスバー用の変数
    const startTime = Date.now();
    let pageNumber = 1;
    let continueProcessing = true;
    const progressBar = new ProgressBar();

    const updateProgress = () => {
      const elapsed = progressBar.getElapsedTime();
      const pagesCompleted = pageNumber - 1;
      const pagesPerSec = pagesCompleted > 0 ? (pagesCompleted / (elapsed / 1000)).toFixed(1) : '0';
      clearLine();
      process.stdout.write(`${progressBar.getSpinnerFrame()} Processing... P${pagesCompleted}${numPages ? `/${numPages}` : ''} | ${formatTime(elapsed)} | ${pagesPerSec} p/s`);
    };

    // プログレスバー開始
    progressBar.start(updateProgress);

    while (continueProcessing) {
      // numPagesが指定されている場合はそれを超えない
      if (numPages !== null && pageNumber > numPages) {
        break;
      }

      // 次のページに必要な画像が足りない場合、ページめくりを実行
      const imagesNeeded = pageNumber * 3;
      if (this.imageRequests.length < imagesNeeded) {
        const hasMorePages = await this.nextPage();

        if (!hasMorePages) {
          progressBar.stop();
          break;
        }
      }

      // ページ画像を抽出
      const { images } = await this.extractPageImages(pageNumber);

      if (images.length > 0) {
        await this.combineImages(images.map(img => img.buffer), pageNumber);
        pageNumber++;
      } else {
        progressBar.stop();
        continueProcessing = false;
      }
    }

    progressBar.stop();
    const totalPages = pageNumber - 1;
    const totalTime = Date.now() - startTime;
    const avgTimePerPage = totalPages > 0 ? totalTime / totalPages : 0;
    const finalSpeed = totalPages > 0 ? (totalPages / (totalTime / 1000)).toFixed(1) : '0';

    return {
      totalPages,
      totalTime,
      avgTimePerPage,
      finalSpeed
    };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('\n👋 Browser closed');
    }
  }
}

async function main() {
  // 引数をパース
  const args = process.argv.slice(2);
  let readerUrl = null;
  let numPages = null;
  let outputDir = './output';
  let headless = true; // デフォルトはheadless

  // オプション引数をパース
  const positionalArgs = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (arg === '--show-browser' || arg === '--no-headless') {
        headless = false;
      } else if (arg.startsWith('--headless=')) {
        const value = arg.split('=')[1];
        headless = value !== 'false';
      }
    } else {
      positionalArgs.push(arg);
    }
  }

  // 位置引数を処理
  if (positionalArgs[0]) readerUrl = positionalArgs[0];
  if (positionalArgs[1]) numPages = parseInt(positionalArgs[1]);
  if (positionalArgs[2]) outputDir = positionalArgs[2];

  // readerUrlが指定されていない場合はエラー
  if (!readerUrl) {
    console.error('❌ エラー: リーダーURLが指定されていません\n');
    console.log('使用方法:');
    console.log('  node binb_scraper.js <READER_URL> [NUM_PAGES] [OUTPUT_DIR] [OPTIONS]\n');
    console.log('引数:');
    console.log('  READER_URL   - BINBリーダーのURL（必須）');
    console.log('  NUM_PAGES    - ダウンロードするページ数（省略時: 全ページ）');
    console.log('  OUTPUT_DIR   - 出力ディレクトリ（省略時: ./output）\n');
    console.log('オプション:');
    console.log('  --show-browser, --no-headless  - ブラウザを表示する');
    console.log('  --headless=false               - ブラウザを表示する\n');
    console.log('例:');
    console.log('  node binb_scraper.js "https://www.cmoa.jp/reader/browserviewer/?content_id=100000994730001"');
    console.log('  node binb_scraper.js "https://example.com/reader" 50 ./my-output --show-browser');
    process.exit(1);
  }

  console.log('╔══════════════════════════╗');
  console.log('║   BINB Reader Scraper    ║');
  console.log('╚══════════════════════════╝\n');
  console.log(`📚 URL: ${readerUrl}`);
  console.log(`📄 Pages to extract: ${numPages || 'All pages (until end)'}`);
  console.log(`📁 Output directory: ${outputDir}`);
  console.log(`🖥️  Browser mode: ${headless ? 'Headless' : 'Visible'}\n`);

  const scraper = new BinbScraper(readerUrl, outputDir, headless);

  try {
    await scraper.init();
    await scraper.loadReader();

    console.log('━'.repeat(50));
    console.log('  EXTRACTING PAGES');
    console.log('━'.repeat(50));

    // すべてのページをダウンロード
    const result = await scraper.downloadAll(numPages);

    console.log('✅ Completed!');
    console.log(`📄 ${result.totalPages} pages | ⏱️  ${formatTime(result.totalTime)} | 🚀 ${result.finalSpeed} p/s (avg: ${formatTime(Math.round(result.avgTimePerPage))}/page)`);
    console.log(`📁 ${scraper.outputDir}`);

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);

    // Puppeteerのブラウザ起動エラーの場合、詳細なヘルプを表示
    if (error.message.includes('Failed to launch') || error.message.includes('browser process')) {
      console.error('\n💡 ブラウザの起動に失敗しました。以下を確認してください：');
      console.error('   1. Puppeteerを最新版にアップデート: npm install puppeteer@latest');
      console.error('   2. .envファイルでシステムのChromeを指定:');
      console.error('      CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      console.error('   3. macOS 15 (Sequoia)の場合、Puppeteer 23以降が必要です\n');
    }

    if (process.env.DEBUG) {
      console.error('\nスタックトレース:');
      console.error(error.stack);
    }

    process.exit(1);
  } finally {
    await scraper.close();
  }
}

// Export the class for use in other modules
export { BinbScraper };

// Only run main if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
