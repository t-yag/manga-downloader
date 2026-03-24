# Manga Downloader

日本の電子書籍サイトからマンガをダウンロード・管理するセルフホスト型アプリケーション。

## 対応サイト

| プラグイン | サイト | 認証 | 備考 |
|-----------|--------|------|------|
| booklive | BookLive | メール/パスワード | binbエンジン |
| cmoa | コミックシーモア | メール/パスワード | binbエンジン |
| piccoma | ピッコマ | メール/パスワード | タイル復号 |
| kindle | Amazon Kindle | ブラウザログイン / Cookie | Canvas キャプチャ |
| momonga | momon:GA | 不要 | |
| nhentai | nhentai | 不要 | |

## 技術スタック

- **バックエンド**: TypeScript + Fastify + Drizzle ORM + SQLite
- **フロントエンド**: React Native (Expo) — Web / iOS / Android 対応
- **ブラウザ自動化**: Puppeteer (ダウンロード・ビューワー操作)
- **画像処理**: Sharp (ストリップ結合・リサイズ)

## 主な機能

- **ライブラリ管理** — URLを貼るだけでタイトル追加、メタデータ自動取得
- **巻の可用性チェック** — 購入済み・無料キャンペーン・待てば無料を自動判定
- **ダウンロードキュー** — ジョブキューによる並列ダウンロード、進捗表示
- **セッション自動復旧** — credentials認証のプラグインは期限切れ時に自動再ログイン
- **パステンプレート** — `{title}/{volume:3}` のようなDSLで出力パスをカスタマイズ
- **タグルール** — ジャンルの表示/非表示/マッピングを設定
- **ZIP出力** — ページ順を保持したZIPアーカイブで保存

## セットアップ

### Docker (推奨)

```bash
# 全体起動（backend + frontend）
docker-compose up -d

# バックエンドのみ
docker-compose up -d backend

# フロントエンドのみ
docker-compose up -d frontend

# 停止
docker-compose down
```

| URL | 用途 |
|-----|------|
| `http://localhost:3000` | バックエンド API |
| `http://localhost:8080` | フロントエンド Web UI |

ポートは `.env` で変更可能です（`.env.example` 参照）。

#### データ永続化

`./data/` がコンテナの `/app/data` にバインドマウントされます。

```
data/
  db/          # SQLite データベース
  cookies/     # セッション cookie
  downloads/   # ダウンロード済みファイル
```

#### フロントエンドからバックエンドへの接続

フロントエンドの設定画面でサーバーURLを指定します。

- 同一マシンで起動: `http://localhost:3000`
- 別マシンのバックエンド: `http://<host>:<port>`

#### マルチアーキテクチャ

`linux/amd64` と `linux/arm64` に対応しています。ローカルではネイティブアーキで自動ビルドされます。

### ローカル開発

#### 必要なもの

- Node.js 20+
- pnpm

#### バックエンド

```bash
cd backend
pnpm install
pnpm dev
```

APIサーバーが `http://localhost:3000` で起動します。

#### フロントエンド

```bash
cd frontend
pnpm install
pnpm web      # ブラウザで開く場合
pnpm start    # Expo Dev Server
```

## プロジェクト構成

```
backend/
  src/
    api/          # REST APIルート
    db/           # スキーマ定義・マイグレーション
    plugins/      # サイト別プラグイン
      binb/       # BookLive/cmoa共有エンジン
      booklive/
      cmoa/
      piccoma/
      kindle/
      momonga/
      nhentai/
    queue/        # ジョブキュー・ワーカー
    storage/      # ファイル管理・パステンプレート
    tags/         # タグルールシステム
  data/           # SQLite DB・Cookie・ダウンロードファイル

frontend/
  app/            # Expo Router (ファイルベースルーティング)
    (tabs)/       # ライブラリ・タグ・ジョブ・設定
    library/      # タイトル詳細
  src/
    api/          # バックエンドAPIクライアント
    components/   # 共通UIコンポーネント
    theme.ts      # デザイントークン
```

## Discord 連携（オプション）

BOTをサーバーに招待し、設定画面で Bot Token と Channel ID を入力すると以下の機能が使えます：

- チャンネルにURLを貼るだけでライブラリに追加
- スラッシュコマンドでキュー操作
- ダウンロード完了・失敗の通知

**[BOTを招待する](https://discord.com/oauth2/authorize?client_id=1485246396209696909&permissions=76864&integration_type=0&scope=bot+applications.commands)**

## ライセンス

個人利用を目的としたプロジェクトです。
