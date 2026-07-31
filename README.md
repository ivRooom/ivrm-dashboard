# IVRM Dashboard

IVRMが運用するMinecraft・Webサービス・クラウド基盤を、ひとつの画面から安全に監視・管理するための統合運用コンソールです。

## 目的

- OCI上のMinecraftコンテナ状態を可視化する
- ホストのCPU・メモリ・ディスク・ロード平均を確認する
- MinecraftのTPS・MSPT・オンライン人数・バックアップ状態を確認する
- 将来的にAWS Lightsail・EC2・Herta.などのサービス監視へ拡張する
- Docker Socket、SSH、RCONをインターネットへ直接公開しない

## 想定構成

```text
Browser
  ↓
console.ivrm.jp
Next.js on Vercel
  ↓
Supabase Postgres / Realtime
  ⇅ 外向きHTTPSのみ
IVRM Agent on OCI / Lightsail / EC2
  ↓ local only
Docker / Minecraft / systemd / backup scripts
```

## アプリケーション構成

```text
ivrm-dashboard/
├─ apps/
│  ├─ web/          # Next.js管理画面
│  └─ agent/        # Go製の監視Agent
├─ supabase/
│  └─ migrations/   # DBマイグレーション
└─ docs/            # 設計・セキュリティ・運用資料
```

## 初期対象

- `mc-main`
- `mc-resource`
- `mc-resource-router`

## MVP

1. ホストとAgentのHeartbeat表示
2. DockerコンテナのCPU・メモリ・Network I/O・Block I/O・PIDs表示
3. コンテナ状態・Health・RestartCount・OOMKilled表示
4. MinecraftのOnline・TPS・MSPT・Player count表示
5. 最終バックアップ状態表示
6. Online / Offline / Stale / Errorの区別
7. 認証済みユーザーだけが内部メトリクスを閲覧可能

## ローカル開発

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Agentは別ターミナルで起動します。

```bash
cd apps/agent
cp .env.example .env
set -a && source .env && set +a
go run ./cmd/ivrm-agent
```

## セキュリティ方針

- Agentから外向きHTTPS通信だけを許可する
- Docker Socket、Docker API、SSH、RCONを外部公開しない
- MVPでは読み取り専用とする
- 任意Shell・任意Dockerコマンド・任意RCONは実装しない
- 将来の操作機能は許可リスト・権限確認・監査ログを必須とする

## ドメイン

初期は単一アプリへ統合します。

- `console.ivrm.jp/overview`
- `console.ivrm.jp/minecraft`
- `console.ivrm.jp/hosts`
- `console.ivrm.jp/herta`
- `console.ivrm.jp/aws`

`mc.console.ivrm.jp`や`herta.console.ivrm.jp`は、独立した権限境界またはデプロイが必要になった段階で再評価します。

## 開発方針

- ドキュメント・Issue・PR・コミットメッセージは日本語
- Web: Next.js / TypeScript
- Agent: Go
- 状態ストア: Supabase Postgres
- リアルタイム更新: Supabase Realtime
- Webデプロイ: Vercel
- Agent配布: GitHub ActionsでLinux ARM64 / AMD64をビルド

## 実環境ステータス

- Supabase: `ivrm-core`へ監視用Migration適用済み
- Vercel: Node.js 22.xで`ivrm-dashboard`をデプロイ済み
- Health Check: `https://ivrm-dashboard.vercel.app/api/health`
- `console.ivrm.jp`: 未接続
- OCI Agent: 未配置
- 画面のサービス値: 現在はデモデータ

次はVercelのSecret設定、`console.ivrm.jp`の割り当て、OCI AgentとのEnd-to-End Heartbeat疎通を行います。
