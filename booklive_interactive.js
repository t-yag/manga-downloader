import 'dotenv/config';
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import BookLiveScraper from './booklive_scraper.js';
import { BinbScraper } from './binb_scraper.js';
import { sanitizeFilename, formatTime } from './utils.js';

class BookLiveInteractive {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    this.scraper = new BookLiveScraper();
  }

  /**
   * 質問を表示して入力を受け取る
   */
  async question(prompt) {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  /**
   * タイトルIDを取得
   */
  async getTitleId() {
    console.log('╔═════════════════════════════════════╗');
    console.log('║     BookLive ダウンローダー         ║');
    console.log('╚═════════════════════════════════════╝\n');

    const titleId = await this.question('📖 タイトルID を入力してください（例: 2122098）: ');

    if (!titleId || !/^\d+$/.test(titleId)) {
      console.log('❌ 無効なタイトルIDです');
      return null;
    }

    return titleId.trim();
  }

  /**
   * タイトル情報を取得して表示
   */
  async fetchTitleInfo(titleId) {
    console.log('\n⏳ タイトル情報を取得中...\n');

    try {
      const titleInfo = await this.scraper.getTitleInfo(titleId);

      console.log('━'.repeat(60));
      console.log(`📚 タイトル: ${titleInfo.title}`);
      console.log(`✍️  著者: ${titleInfo.author}`);
      console.log(`📗 総巻数: ${titleInfo.totalVolumes}巻`);

      if (titleInfo.genres.length > 0) {
        console.log(`🏷️  ジャンル: ${titleInfo.genres.slice(0, 3).join(', ')}`);
      }

      console.log('━'.repeat(60));

      return titleInfo;
    } catch (error) {
      console.error(`❌ エラー: ${error.message}`);
      return null;
    }
  }

  /**
   * 巻を選択
   */
  async selectVolume(titleInfo) {
    console.log('\n📖 利用可能な巻:');

    // 巻のリストを表示（10巻ごとに改行）
    const volumes = titleInfo.volumes;
    for (let i = 0; i < volumes.length; i++) {
      process.stdout.write(`  ${String(volumes[i].volume).padStart(3, ' ')}巻`);
      if ((i + 1) % 10 === 0 || i === volumes.length - 1) {
        console.log('');
      }
    }

    console.log('\n💡 ヒント: "all" で全巻、"1-5" で範囲指定、"1,3,5" で複数選択');
    const input = await this.question('\n📥 ダウンロードする巻を選択してください: ');

    return this.parseVolumeSelection(input.trim(), titleInfo.totalVolumes);
  }

  /**
   * 巻の選択をパース
   */
  parseVolumeSelection(input, maxVolume) {
    if (input === 'all') {
      return Array.from({ length: maxVolume }, (_, i) => i + 1);
    }

    const selected = new Set();

    // カンマで分割
    const parts = input.split(',').map(s => s.trim());

    for (const part of parts) {
      // 範囲指定（例: 1-5）
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(s => parseInt(s.trim()));
        if (!isNaN(start) && !isNaN(end) && start <= end && start >= 1 && end <= maxVolume) {
          for (let i = start; i <= end; i++) {
            selected.add(i);
          }
        }
      }
      // 単一の巻
      else {
        const vol = parseInt(part);
        if (!isNaN(vol) && vol >= 1 && vol <= maxVolume) {
          selected.add(vol);
        }
      }
    }

    return Array.from(selected).sort((a, b) => a - b);
  }

  /**
   * 出力ディレクトリを決定
   */
  async getOutputDirectory(titleInfo, volume) {
    // デフォルト: ./downloads/シリーズ名/第X巻
    const baseDir = './downloads';
    const titleDir = sanitizeFilename(titleInfo.seriesTitle);
    const volumeDir = `vol_${String(volume).padStart(3, '0')}`;

    return path.join(baseDir, titleDir, volumeDir);
  }

  /**
   * メタデータを保存
   */
  async saveMetadata(titleInfo, volume, outputDir) {
    const volumeInfo = titleInfo.volumes.find(v => v.volume === volume);

    const metadata = {
      title: titleInfo.title,
      titleId: titleInfo.titleId,
      author: titleInfo.author,
      volume: volume,
      cid: volumeInfo.cid,
      readerUrl: volumeInfo.readerUrl,
      genres: titleInfo.genres,
      downloadDate: new Date().toISOString(),
      outputDirectory: outputDir
    };

    const metadataPath = path.join(outputDir, 'metadata.json');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    return metadataPath;
  }

  /**
   * 巻をダウンロード
   */
  async downloadVolume(titleInfo, volume) {
    const volumeInfo = titleInfo.volumes.find(v => v.volume === volume);

    if (!volumeInfo) {
      console.log(`❌ 第${volume}巻が見つかりません`);
      return false;
    }

    console.log(`\n${'━'.repeat(60)}`);
    console.log(`📥 第${volume}巻をダウンロード中...`);
    console.log(`🔗 ${volumeInfo.readerUrl}`);
    console.log('━'.repeat(60));

    // アクセス権限確認（簡易実装）
    console.log('🔍 コンテンツアクセス権限を確認中...');
    try {
      const contentInfo = await this.scraper.getContentInfo(titleInfo.titleId, volume);

      if (!contentInfo.isFullAccess) {
        console.error('❌ エラー: このコンテンツは試し読みモードです');
        console.error('   このタイトルを購入していないか、認証に問題がある可能性があります');
        return false;
      }

      console.log('✅ 全ページアクセス可能（※モック実装による仮判定）');
      console.log('   実際のアクセス権限はダウンロード時に確認されます');
    } catch (error) {
      console.error(`⚠️  コンテンツ情報の取得に失敗: ${error.message}`);
      console.error('   ダウンロードを続行しますが、試し読みモードの可能性があります');
    }

    const outputDir = await this.getOutputDirectory(titleInfo, volume);

    // メタデータを保存
    try {
      const metadataPath = await this.saveMetadata(titleInfo, volume, outputDir);
      console.log(`💾 メタデータを保存: ${metadataPath}`);
    } catch (error) {
      console.error(`⚠️  メタデータの保存に失敗: ${error.message}`);
    }

    // BinbScraperを使用してダウンロード（認証Cookieを渡す）
    const cookies = this.scraper.auth.getCookies();
    const binbScraper = new BinbScraper(volumeInfo.readerUrl, outputDir, true, cookies);

    try {
      await binbScraper.init();
      await binbScraper.loadReader();

      // すべてのページをダウンロード
      const result = await binbScraper.downloadAll();

      console.log(`✅ 第${volume}巻のダウンロード完了!`);
      console.log(`📄 ${result.totalPages} pages | ⏱️  ${formatTime(result.totalTime)} | 🚀 ${result.finalSpeed} p/s (avg: ${formatTime(Math.round(result.avgTimePerPage))}/page)`);
      console.log(`📁 ${outputDir}\n`);

      return true;
    } catch (error) {
      console.error(`❌ ダウンロードエラー: ${error.message}`);
      return false;
    } finally {
      await binbScraper.close();
    }
  }

  /**
   * メインフロー
   */
  async run() {
    try {
      // 認証を初期化
      console.log('\n🔐 認証を初期化中...');
      const email = process.env.BOOKLIVE_EMAIL || '';
      const password = process.env.BOOKLIVE_PASSWORD || '';

      // モックモードでは環境変数は不要
      console.log('ℹ️  モックモード: 環境変数は不要です');

      const authenticated = await this.scraper.initialize(email, password);
      if (!authenticated) {
        console.error('❌ 認証に失敗しました');
        this.rl.close();
        return;
      }
      console.log('✅ 認証成功\n');

      // タイトルIDを取得
      const titleId = await this.getTitleId();
      if (!titleId) {
        this.rl.close();
        return;
      }

      // タイトル情報を取得
      const titleInfo = await this.fetchTitleInfo(titleId);
      if (!titleInfo) {
        this.rl.close();
        return;
      }

      // 巻を選択（有効な選択があるまでループ）
      let selectedVolumes = [];
      while (selectedVolumes.length === 0) {
        selectedVolumes = await this.selectVolume(titleInfo);

        if (selectedVolumes.length === 0) {
          console.log('❌ 有効な巻が選択されていません。もう一度入力してください。\n');
        }
      }

      console.log(`\n📦 選択された巻: ${selectedVolumes.join(', ')}`);
      console.log('📥 ダウンロードを開始します...\n');

      // 各巻をダウンロード
      const results = [];
      for (const volume of selectedVolumes) {
        const success = await this.downloadVolume(titleInfo, volume);
        results.push({ volume, success });
      }

      // 結果サマリー
      const successCount = results.filter(r => r.success).length;
      const failedVolumes = results.filter(r => !r.success).map(r => r.volume);

      console.log('\n' + '═'.repeat(60));
      if (successCount === selectedVolumes.length) {
        console.log('🎉 すべてのダウンロードが完了しました！');
      } else if (successCount > 0) {
        console.log(`⚠️  一部のダウンロードが完了しました（${successCount}/${selectedVolumes.length}巻）`);
        console.log(`❌ 失敗した巻: ${failedVolumes.join(', ')}`);
      } else {
        console.log('❌ すべてのダウンロードが失敗しました');
      }
      console.log('═'.repeat(60));

    } catch (error) {
      console.error('❌ エラーが発生しました:', error.message);
      console.error(error.stack);
    } finally {
      await this.scraper.close();
      this.rl.close();
    }
  }

  async close() {
    await this.scraper.close();
    this.rl.close();
  }
}

// メイン実行
async function main() {
  const interactive = new BookLiveInteractive();
  await interactive.run();
}

main().catch(console.error);
