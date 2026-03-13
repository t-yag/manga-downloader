# manga-downloader アーキテクチャ設計書

## 1. プロジェクト概要

**プロジェクト名**: manga-downloader

複数の電子書籍サイトからコンテンツをダウンロードし、一元管理するシステム。
バックエンドAPI + Web UI構成。シングルユーザー向け。自宅サーバーで常時稼働。

## 2. 対応サイト (プラグイン方式)

| サイト | リーダー方式 | 認証 | 優先度 |
|--------|-------------|------|--------|
| コミックシーモア (cmoa) | binb | Cookie (Puppeteer login) | 実装済み |
| BookLive | binb | Cookie (未実装) | 実装済み(部分) |
| Kindle | 独自 | Amazon認証 | 高 |
| ピッコマ | 独自 | Cookie | 高 |
| 各種Webサイト | 多様 | サイト依存 | 中 |

## 3. システム構成

```
┌─────────────────────────────────────────────────────┐
│              自宅サーバー (常時稼働)                   │
│                                                       │
│  ┌───────────────────────────────────────────────┐    │
│  │          Backend Container (Linux)             │    │
│  │                                                │    │
│  │  ┌─────────────┐   ┌───────────────────────┐  │    │
│  │  │  REST API    │   │  Download Worker      │  │    │
│  │  │  (Fastify)   │   │                       │  │    │
│  │  │              │   │  ┌─────────────────┐  │  │    │
│  │  │  - Jobs      │   │  │  Job Queue      │  │  │    │
│  │  │  - Library   │◄──┤  │  (SQLite-based) │  │  │    │
│  │  │  - Accounts  │   │  └─────────────────┘  │  │    │
│  │  │  - Settings  │   │                       │  │    │
│  │  │  - Plugins   │   │  ┌─────────────────┐  │  │    │
│  │  └──────┬───────┘   │  │ Plugin Registry │  │  │    │
│  │         │           │  │ - cmoa          │  │  │    │
│  │  ┌──────┴───────┐   │  │ - booklive     │  │  │    │
│  │  │  SQLite DB   │   │  │ - kindle       │  │  │    │
│  │  └──────────────┘   │  │ - piccoma      │  │  │    │
│  │                     │  │ - generic-web  │  │  │    │
│  │                     │  └─────────────────┘  │  │    │
│  │                     │                       │  │    │
│  │                     │  ┌─────────────────┐  │  │    │
│  │                     │  │  Puppeteer      │  │  │    │
│  │                     │  │ (Headless Chrome)│  │  │    │
│  │                     │  └─────────────────┘  │  │    │
│  │                     └───────────────────────┘  │    │
│  └───────────────────────────────────────────────┘    │
│           ▲                                           │
│           │ HTTP :3000                                │
│           │                                           │
│  ┌────────┴──────────────────────────────────────┐    │
│  │  Frontend (Expo)                               │    │
│  │  - スマホアプリ (iOS/Android)                   │    │
│  │  - Web (expo-web) ※同一コードベース             │    │
│  │  - DL指示 / 進捗確認                           │    │
│  │  - ライブラリ閲覧                              │    │
│  │  - 設定管理                                    │    │
│  └───────────────────────────────────────────────┘    │
│                                                       │
│  ┌───────────────────────────────────────────────┐    │
│  │  Storage (volume mount)                        │    │
│  │  /data/downloads → NAS or ローカル              │    │
│  │  /data/db        → SQLite + Cookies            │    │
│  └───────────────────────────────────────────────┘    │
└───────────────────────────┬───────────────────────────┘
                            │
                    自前VPN
                            │
                    ┌───────┴───────┐
                    │  スマホ (外出先) │
                    │  Expoアプリから  │
                    │  DL指示・確認    │
                    └───────────────┘
```

### 3.1 リモートアクセス

Webを公開せずに外出先からアクセスするため **自前VPN** を使用。

- 自宅サーバーにVPN環境を構築済み
- スマホからVPN経由でプライベートIPでアクセス
- ポート公開不要、セキュアなアクセス

## 4. バックエンド詳細設計

### 4.1 技術スタック

| 要素 | 技術 | 理由 |
|------|------|------|
| 言語 | TypeScript (Node.js) | 既存コードがJS、Puppeteerとの親和性 |
| API | Fastify | 高速、TypeScript親和性、スキーマバリデーション |
| DB | SQLite (better-sqlite3) | シングルユーザー、依存なし、コンテナ内完結、バックアップはファイルコピーだけ |
| Queue | 自前実装 (SQLite-based) | Redis不要でシンプル。将来BullMQ+Redisに移行可 |
| ORM | Drizzle ORM | 軽量、TypeScript-first |
| Browser | Puppeteer | 既存実装の活用 |
| Container | Docker | Linux-based |

### 4.2 ディレクトリ構成

```
manga-downloader/
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── packages/
│   ├── backend/                  # バックエンドAPI + Worker
│   │   ├── src/
│   │   │   ├── index.ts          # エントリポイント
│   │   │   ├── api/              # REST APIルート
│   │   │   │   ├── routes/
│   │   │   │   │   ├── jobs.ts
│   │   │   │   │   ├── library.ts
│   │   │   │   │   ├── accounts.ts
│   │   │   │   │   └── settings.ts
│   │   │   │   └── index.ts
│   │   │   ├── db/               # データベース
│   │   │   │   ├── schema.ts     # Drizzle schema
│   │   │   │   ├── migrate.ts
│   │   │   │   └── index.ts
│   │   │   ├── queue/            # ジョブキュー
│   │   │   │   ├── queue.ts
│   │   │   │   └── worker.ts
│   │   │   ├── plugins/          # ダウンロードプラグイン
│   │   │   │   ├── base.ts       # 基底クラス / インターフェース
│   │   │   │   ├── registry.ts   # プラグイン登録
│   │   │   │   ├── cmoa/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── scraper.ts
│   │   │   │   │   └── auth.ts
│   │   │   │   ├── booklive/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── scraper.ts
│   │   │   │   │   └── auth.ts
│   │   │   │   ├── kindle/
│   │   │   │   ├── piccoma/
│   │   │   │   └── binb/         # 共通binbエンジン (cmoa, bookliveが利用)
│   │   │   │       └── engine.ts
│   │   │   └── storage/          # ファイル保存管理
│   │   │       └── index.ts
│   │   ├── data/                # 永続データ (.gitignore, volume mount)
│   │   │   ├── db/              # SQLite DB + Cookies
│   │   │   └── downloads/       # ダウンロードファイル
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── frontend/                 # Expo (React Native) アプリ
│       ├── app/                  # Expo Router (ファイルベースルーティング)
│       │   ├── _layout.tsx       # ルートレイアウト
│       │   ├── index.tsx         # ホーム (ジョブ一覧)
│       │   ├── jobs/
│       │   │   ├── index.tsx     # DLジョブ一覧 + 新規DL指示
│       │   │   └── [id].tsx      # ジョブ詳細
│       │   ├── library/
│       │   │   ├── index.tsx     # ライブラリ一覧 (Phase 2)
│       │   │   └── [id].tsx      # タイトル詳細
│       │   └── settings.tsx      # 設定
│       ├── src/
│       │   ├── api/
│       │   │   └── client.ts     # バックエンドAPIクライアント
│       │   └── components/       # 共通コンポーネント
│       ├── app.json
│       ├── package.json
│       └── tsconfig.json
└── package.json                  # プロジェクトルート (メタ情報のみ)
```

### 4.3 プラグインインターフェース

```typescript
// plugins/base.ts

interface Plugin {
  manifest: PluginManifest;
  urlParser: UrlParser;                    // 必須: URL解析
  auth?: AuthProvider;                     // 認証が必要なサイト用
  metadata?: MetadataProvider;             // メタデータ取得
  availabilityChecker?: AvailabilityChecker; // DL可否チェック
  downloader: Downloader;                  // 必須: DL実行
  newReleaseChecker?: NewReleaseChecker;   // 新刊チェック
}

interface UrlParser {
  canHandle(url: string): boolean;         // このプラグインで処理可能か
  parse(url: string): ParsedUrl;           // URL → pluginId, titleId, volume?, type
}

interface AvailabilityChecker {
  checkAvailability(                       // 指定巻のDL可否を一括チェック
    titleId: string,
    volumes: number[],
    session: SessionData | null
  ): Promise<VolumeAvailability[]>;
}

// AuthProvider, MetadataProvider, Downloader, NewReleaseChecker は変更なし
```

### 4.4 データベーススキーマ

```
accounts
  id          INTEGER PRIMARY KEY
  plugin_id   TEXT NOT NULL        -- "cmoa", "booklive", ...
  label       TEXT                 -- ユーザーが付けるラベル
  credentials TEXT NOT NULL        -- JSON (暗号化)
  cookie_path TEXT                 -- Cookieファイルパス
  is_active   BOOLEAN DEFAULT 1
  created_at  DATETIME
  updated_at  DATETIME

library
  id          INTEGER PRIMARY KEY
  plugin_id   TEXT NOT NULL
  title_id    TEXT NOT NULL        -- サイト側のタイトルID
  title       TEXT NOT NULL
  author      TEXT
  description TEXT
  genres      TEXT                 -- JSON array
  total_volumes INTEGER
  cover_url   TEXT
  metadata    TEXT                 -- JSON (サイト固有情報)
  created_at  DATETIME
  updated_at  DATETIME
  UNIQUE(plugin_id, title_id)

volumes
  id          INTEGER PRIMARY KEY
  library_id  INTEGER REFERENCES library(id)
  volume_num  INTEGER NOT NULL
  status      TEXT DEFAULT 'none'  -- none / queued / downloading / done / error
  page_count  INTEGER
  file_path   TEXT                 -- 保存先パス
  file_size   INTEGER
  downloaded_at DATETIME
  metadata    TEXT                 -- JSON
  UNIQUE(library_id, volume_num)

jobs
  id          INTEGER PRIMARY KEY
  plugin_id   TEXT NOT NULL
  account_id  INTEGER REFERENCES accounts(id)
  volume_id   INTEGER REFERENCES volumes(id)
  status      TEXT DEFAULT 'pending'  -- pending / running / done / error / cancelled
  priority    INTEGER DEFAULT 0
  progress    REAL DEFAULT 0       -- 0.0 ~ 1.0
  message     TEXT                 -- 進捗メッセージ
  error       TEXT
  started_at  DATETIME
  finished_at DATETIME
  created_at  DATETIME

settings
  key         TEXT PRIMARY KEY
  value       TEXT                 -- JSON
  updated_at  DATETIME
```

### 4.5 REST API

```
# URL解析 (入口)
POST   /api/url/parse             # URL → plugin判定 + メタデータプレビュー

# ライブラリ管理 (タイトル単位)
GET    /api/library               # タイトル一覧 (巻サマリー付き)
POST   /api/library               # タイトル追加 (URL or pluginId+titleId)
GET    /api/library/:id           # タイトル詳細 + 全巻ステータス
DELETE /api/library/:id           # タイトル削除
POST   /api/library/:id/refresh   # メタデータ再取得 (新刊チェック)
POST   /api/library/:id/check-availability  # DL可否チェック (未DL巻のみ)
POST   /api/library/:id/download  # DLジョブ投入 (巻番号指定 / "available" / "all")

# ジョブ管理
GET    /api/jobs                  # ジョブ一覧 (フィルタ: status, plugin_id)
GET    /api/jobs/:id              # ジョブ詳細 + 進捗
DELETE /api/jobs/:id              # ジョブキャンセル

# アカウント
GET    /api/accounts              # アカウント一覧
POST   /api/accounts              # アカウント追加
PUT    /api/accounts/:id          # アカウント更新
DELETE /api/accounts/:id          # アカウント削除
POST   /api/accounts/:id/validate # セッション検証

# プラグイン
GET    /api/plugins               # 利用可能プラグイン一覧
GET    /api/plugins/:id           # プラグイン詳細 (対応機能など)
GET    /api/plugins/:id/title/:titleId  # タイトル情報取得

# 設定
GET    /api/settings              # 全設定
PUT    /api/settings              # 設定更新

# WebSocket (Phase 5)
WS     /api/ws                    # リアルタイム進捗通知
```

### 4.6 ユーザーフロー

```
URL入力 (例: https://www.cmoa.jp/title/99473/)
    │
    ▼ POST /api/url/parse
URL解析 → pluginId, titleId, type を返却
    │  + メタデータプレビュー (タイトル名, 著者, 全巻数)
    │
    ▼ POST /api/library
ライブラリに追加 (明示的)
    │  → 全巻エントリを status=unknown で作成
    │
    ▼ POST /api/library/:id/check-availability
DL可否チェック (未DL巻のみ)
    │  → 各巻を available / unavailable に更新
    │
    ▼ POST /api/library/:id/download
DLジョブ投入
    │  body: { volumes: [1,2,3] } or "available" or "all"
    │
    ▼ Worker がジョブを実行
ダウンロード → status=done に更新
```

### 4.7 巻ステータス遷移

```
unknown ──check──→ available ──queue──→ queued ──start──→ downloading ──done──→ done
   │                    │                                      │
   └──check──→ unavailable                                    └──fail──→ error
```

## 5. ストレージ構成

```
/data/downloads/
├── cmoa/
│   └── {seriesTitle}/
│       ├── vol_001/
│       │   ├── page_001.jpg
│       │   ├── page_002.jpg
│       │   └── ...
│       └── vol_002/
│           └── ...
├── booklive/
│   └── {seriesTitle}/
│       └── ...
├── kindle/
│   └── ...
└── piccoma/
    └── ...
```

メタデータはDBに集約し、ファイルシステムには画像のみ配置。
NASマウント時は `/data/downloads` をマウントポイントにする。

## 6. 設定項目 (settings)

| キー | 型 | 説明 |
|------|-----|------|
| download.basePath | string | ダウンロード先ベースパス (default: /data/downloads) |
| download.concurrency | number | 同時DL数 (default: 1) |
| download.retryCount | number | リトライ回数 (default: 3) |
| download.imageQuality | number | JPEG品質 (default: 95) |
| download.imageFormat | string | 出力形式 jpg/png/webp (default: jpg) |
| browser.headless | boolean | ヘッドレスモード (default: true) |
| browser.executablePath | string | Chrome パス (空=自動検出) |

## 7. フロントエンド (Expo)

Expo (React Native) で統一。1コードベースからスマホアプリ + Web を出力。
バックエンドとは完全分離 (API通信のみ)。

### 7.1 初期画面構成

| 画面 | 機能 | Phase |
|------|------|-------|
| Jobs | DLジョブ一覧、新規DL指示、進捗表示 | 1 |
| Settings | アカウント管理、DL設定、API接続先設定 | 1 |
| Library | タイトル一覧、巻管理 | 2 |

### 7.2 技術スタック

| 要素 | 技術 | 理由 |
|------|------|------|
| フレームワーク | Expo (SDK 52+) | iOS/Android/Web を1コードベースで |
| ルーティング | Expo Router | ファイルベース、Web対応 |
| スタイリング | NativeWind (Tailwind for RN) | レスポンシブ、RNネイティブ |
| API通信 | TanStack Query (React Query) | キャッシュ、自動再取得 |
| 状態管理 | Zustand (必要に応じて) | 軽量 |

### 7.3 対応プラットフォーム

- **iOS**: メインターゲット (Androidは対象外)
- **Web**: expo-web で補助的に対応

### 7.4 デプロイ

- **開発中**: Expo Go で実機確認
- **iOS配布**: EAS Build (`distribution: "internal"`) → 内部配布 (Ad Hoc)
- **Web**: `npx expo export:web` → 静的ファイルを任意のサーバーで配信
- バックエンドAPIのURLはアプリ内設定画面で変更可能

## 8. フェーズ計画

### Phase 1: バックエンド基盤 + 既存移植 + 最小UI
- monorepo構造作成 (TypeScript, npm workspaces)
- DB + マイグレーション (Drizzle + SQLite)
- プラグインインターフェース定義
- binb 共通エンジン整理
- cmoa プラグイン移植
- booklive プラグイン移植
- REST API (jobs, accounts, plugins, settings)
- ジョブキュー (SQLite-based)
- 最小フロントエンド Expo (Jobs + Settings画面)

### Phase 2: プラグイン拡充 + ライブラリ管理
- kindle プラグイン
- piccoma プラグイン
- generic-web プラグイン
- ライブラリ管理API + UI
- DL履歴表示

### Phase 3: コンテナ化
- Dockerfile (Puppeteer + Chrome on Linux)
- docker-compose.yml (backend + frontend)
- volume mount設定 (/data/downloads, /data/db)
- 設定の環境変数対応

### Phase 4: 運用整備
- VPN経由アクセスの動作確認
- ヘルスチェック / 自動再起動
- ログ管理
- バックアップ (SQLiteファイル)

### Phase 5: 高度な機能
- WebSocket リアルタイム進捗
- 新刊チェック + 通知 (プッシュ通知)
- 自動DLルール (新刊自動DL)
- EAS Build (distribution: internal) で iOS アプリ配布
