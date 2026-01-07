import puppeteer from 'puppeteer';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';

class BinbScraper {
  constructor(readerUrl) {
    this.readerUrl = readerUrl;
    this.browser = null;
    this.page = null;
    this.imageRequests = []; // すべてのblob URLリクエストを記録
    this.currentImageIndex = 0; // 現在のインデックス
    this.outputDir = './output';
  }

  async init() {
    console.log('🚀 Initializing BINB Scraper ...');

    await fs.mkdir(this.outputDir, { recursive: true });

    this.browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 800 },
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    this.page = await this.browser.newPage();

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
      await this.page.waitForTimeout(50); // 50msごとにチェック
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
      await this.page.waitForTimeout(50); // 50msごとにチェック（より高速に）
    }

    const newImagesCount = this.imageRequests.length - currentImageCount;
    return newImagesCount > 0; // 新しい画像が読み込まれたかを返す
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('\n👋 Browser closed');
    }
  }
}

async function main() {
  const readerUrl = process.argv[2] || 'https://www.cmoa.jp/reader/sample/?title_id=299367&content_id=100002993670001';
  const numPages = process.argv[3] ? parseInt(process.argv[3]) : null; // nullの場合は全ページ

  console.log('╔══════════════════════════╗');
  console.log('║   BINB Reader Scraper    ║');
  console.log('╚══════════════════════════╝\n');
  console.log(`📚 URL: ${readerUrl}`);
  console.log(`📄 Pages to extract: ${numPages || 'All pages (until end)'}\n`);

  const scraper = new BinbScraper(readerUrl);

  try {
    await scraper.init();
    await scraper.loadReader();

    console.log('\n' + '━'.repeat(50));
    console.log('  EXTRACTING PAGES');
    console.log('━'.repeat(50) + '\n');

    // 初期ロードで先読みされたページを処理
    // imageRequests配列から順番に3枚ずつ取得していく
    let pageNumber = 1;
    let continueProcessing = true;

    while (continueProcessing) {
      // numPagesが指定されている場合はそれを超えない
      if (numPages !== null && pageNumber > numPages) {
        break;
      }

      // 次のページに必要な画像が足りない場合、ページめくりを実行
      const imagesNeeded = pageNumber * 3;
      if (scraper.imageRequests.length < imagesNeeded) {
        const hasMorePages = await scraper.nextPage();
        if (!hasMorePages) {
          console.log(`\n⚠️  Reached end of book at page ${pageNumber - 1}`);
          break;
        }
      }

      // ページ画像を抽出
      const { images } = await scraper.extractPageImages(pageNumber);

      if (images.length > 0) {
        const result = await scraper.combineImages(images.map(img => img.buffer), pageNumber);
        // シンプルな1行ログ
        console.log(`Page ${String(pageNumber).padStart(3, ' ')} ✓  ${result.width}x${result.height}  (${result.elapsed}ms)`);
        pageNumber++;
      } else {
        console.log(`\n⚠️  No more images available (reached end at page ${pageNumber})`);
        continueProcessing = false;
      }
    }

    const totalPages = pageNumber - 1;
    console.log('\n' + '━'.repeat(50));
    console.log(`✅ Completed! ${totalPages} pages extracted`);
    console.log(`📁 ${scraper.outputDir}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
