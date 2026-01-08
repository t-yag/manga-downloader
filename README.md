# コミックシーモア ダウンローダー

コミックシーモアのBINB Readerから漫画のページ画像を抽出・結合するツールです。

## 特徴

- ✅ **対話的インターフェース**: タイトルIDを入力するだけで簡単ダウンロード
- ✅ **自動メタデータ取得**: タイトル名、著者、巻数を自動取得
- ✅ **複数巻対応**: 範囲指定や複数選択で一括ダウンロード
- ✅ **高品質画像結合**: 3分割画像を継ぎ目なく結合
- ✅ **モジュール設計**: 再利用可能なクリーンなコード構造

## インストール

```bash
npm install
```

### 依存パッケージ
- `puppeteer` - ブラウザ自動化
- `sharp` - 高速画像処理
- `cheerio` - HTMLパース

## 使用方法

### 🚀 対話モード（推奨）

最も簡単な使い方です：

```bash
node cmoa_interactive.js
```

対話的にタイトルID、ダウンロードする巻を選択できます。

**例：**
```
📖 タイトルID を入力してください（例: 99473）: 99473

⏳ タイトル情報を取得中...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 タイトル: ワンピース
✍️  著者: 尾田栄一郎
📗 総巻数: 105巻
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 利用可能な巻:
    1巻    2巻    3巻  ...

💡 ヒント: "all" で全巻、"1-5" で範囲指定、"1,3,5" で複数選択

📥 ダウンロードする巻を選択してください: 1-3
```

### 📖 BINB Scraperを直接使用

特定のリーダーURLから直接ダウンロード：

```bash
node binb_scraper.js [URL] [ページ数] [出力先]
```

**例：**
```bash
# 最初の5ページをダウンロード
node binb_scraper.js 'https://www.cmoa.jp/reader/sample/?title_id=99473&content_id=10000994730001' 5

# 全ページをダウンロード
node binb_scraper.js 'https://www.cmoa.jp/reader/sample/?title_id=99473&content_id=10000994730001'

# ブラウザを表示してダウンロード
node binb_scraper.js 'https://...' --no-headless
```

## プロジェクト構成

```
.
├── cmoa_interactive.js       # 対話的インターフェース（メイン）
├── cmoa_scraper.js           # コミックシーモアのメタデータ取得
├── binb_scraper.js           # BINB Reader画像抽出エンジン
├── utils.js                  # 共通ユーティリティ
├── package.json              # 依存関係
├── .gitignore               # Git除外設定
└── output/                   # 出力ディレクトリ
    └── [titleId]_[title]/   # タイトルごとのフォルダ
        └── vol_001/          # 巻ごとのフォルダ
            ├── metadata.json
            ├── page_001.jpg
            ├── page_002.jpg
            └── ...
```

## モジュール説明

### 📦 `cmoa_interactive.js`
対話的なメインインターフェース。ユーザー入力を処理し、他のモジュールを連携させます。

### 🔍 `cmoa_scraper.js`
コミックシーモアのウェブサイトから以下の情報を取得：
- タイトル名
- 著者
- 総巻数
- ジャンル
- リーダーURL生成

### 🖼️ `binb_scraper.js`
BINB Reader専用のスクレイパー：
- Blob URLから画像を直接キャプチャ
- 3分割画像を正確なオーバーラップで結合
- プログレスバー表示

### 🛠️ `utils.js`
共通ユーティリティ関数：
- `Spinner` - スピナーアニメーション
- `ProgressBar` - プログレスバー管理
- `formatTime()` - 時間フォーマット
- `sanitizeFilename()` - ファイル名サニタイズ

## 出力形式

ダウンロードされた画像は以下の構造で保存されます：

```
output/
└── 99473_ワンピース/
    ├── vol_001/
    │   ├── metadata.json
    │   ├── page_001.jpg
    │   ├── page_002.jpg
    │   └── ...
    ├── vol_002/
    │   ├── metadata.json
    │   ├── page_001.jpg
    │   └── ...
    └── ...
```

### メタデータ（metadata.json）

```json
{
  "title": "ワンピース",
  "titleId": "99473",
  "author": "尾田栄一郎",
  "volume": 1,
  "contentId": "10000994730001",
  "readerUrl": "https://www.cmoa.jp/reader/sample/...",
  "genres": ["少年マンガ", "冒険"],
  "downloadDate": "2026-01-08T12:34:56.789Z",
  "outputDirectory": "./output/99473_ワンピース/vol_001"
}
```

## 技術的詳細

### 画像結合アルゴリズム

BINB Readerは1ページを3枚の画像に分割し、以下のオーバーラップで表示します：

- **画像1 → 画像2**: 7px
- **画像2 → 画像3**: 6px

結合式：
```
最終高さ = 画像1.高さ + (画像2.高さ - 7) + (画像3.高さ - 6)
```

### content_idの生成規則

コミックシーモアのcontent_idは以下のパターンで生成されます：

```
1000 + [titleId(7桁)] + [volume(4桁)]

例: タイトルID 99473、第1巻
→ 1000 + 099473 + 0001 = 10000994730001
```

## オプション

### binb_scraper.js のオプション

```bash
node binb_scraper.js [URL] [pages] [outputDir] [options]

--no-headless      ブラウザを表示
--show-browser     ブラウザを表示（同上）
--headless=false   ブラウザを表示（同上）
```

## トラブルシューティング

### Chrome が見つからない

`binb_scraper.js` の `executablePath` を環境に合わせて変更：

```javascript
// macOS
executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Linux
executablePath: '/usr/bin/google-chrome'

// Windows
executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
```

### タイトル情報が取得できない

- タイトルIDが正しいか確認
- ネットワーク接続を確認
- コミックシーモアのサイト構造が変更された可能性

### 画像のダウンロードが途中で止まる

- `--no-headless` オプションでブラウザを表示して確認
- ネットワーク速度が遅い場合、タイムアウト値を増やす

