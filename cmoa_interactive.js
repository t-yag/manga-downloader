import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import CmoaScraper from './cmoa_scraper.js';
import { BinbScraper } from './binb_scraper.js';
import { sanitizeFilename, formatTime } from './utils.js';

class CmoaInteractive {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    this.scraper = new CmoaScraper();
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
    console.log('║  コミックシーモア ダウンローダー    ║');
    console.log('╚═════════════════════════════════════╝\n');

    const titleId = await this.question('📖 タイトルID を入力してください（例: 299367）: ');
    
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
    // デフォルト: ./output/タイトルID/第X巻
    const baseDir = './output';
    const titleDir = `${titleInfo.titleId}_${sanitizeFilename(titleInfo.title)}`;
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
      contentId: volumeInfo.contentId,
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

    const outputDir = await this.getOutputDirectory(titleInfo, volume);
    
    // メタデータを保存
    try {
      const metadataPath = await this.saveMetadata(titleInfo, volume, outputDir);
      console.log(`💾 メタデータを保存: ${metadataPath}`);
    } catch (error) {
      console.error(`⚠️  メタデータの保存に失敗: ${error.message}`);
    }

    // BinbScraperを使用してダウンロード
    const binbScraper = new BinbScraper(volumeInfo.readerUrl, outputDir, true);

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

      // 巻を選択
      const selectedVolumes = await this.selectVolume(titleInfo);
      
      if (selectedVolumes.length === 0) {
        console.log('❌ 有効な巻が選択されていません');
        this.rl.close();
        return;
      }

      console.log(`\n📦 選択された巻: ${selectedVolumes.join(', ')}`);
      
      const confirm = await this.question(`\n⚠️  ${selectedVolumes.length}巻をダウンロードしますか? (Y/n): `);
      
      if (confirm.toLowerCase() === 'n' || confirm.toLowerCase() === 'no') {
        console.log('❌ キャンセルしました');
        this.rl.close();
        return;
      }

      // 各巻をダウンロード
      for (const volume of selectedVolumes) {
        await this.downloadVolume(titleInfo, volume);
      }

      console.log('🎉 すべてのダウンロードが完了しました！');

    } catch (error) {
      console.error('❌ エラーが発生しました:', error.message);
      console.error(error.stack);
    } finally {
      this.rl.close();
    }
  }

  close() {
    this.rl.close();
  }
}

// メイン実行
async function main() {
  const interactive = new CmoaInteractive();
  await interactive.run();
}

main().catch(console.error);
