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
├─ deploy/
│  └─ oci/          # OCI向けsystemd・Docker状態収集
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
4. コンテナの期待状態・計画停止・メンテナンス表示
5. MinecraftのOnline・TPS・MSPT・Player count表示
6. 最終バックアップ状態表示
7. Online / Offline / Stale / Error / Standby / Maintenanceの区別
8. 認証済みユーザーだけが内部メトリクスを閲覧可能

## コンテナ状態の判定

コンテナの実状態だけでなく、`container_expectations`に登録した期待状態と比較して運用状態を判定します。

- `running`: 稼働を期待する。停止・異常終了・Unhealthyは異常扱い
- `stopped`: 停止を期待する。`exited`または`created`なら待機中
- `absent`: 未作成を期待する。`not_found`なら待機中
- `maintenance_mode`: 有効期限内はメンテナンス扱い

初期設定は次のとおりです。

| コンテナ | 期待状態 |
| --- | --- |
| `mc-main` | 稼働 |
| `mc-resource` | 停止 |
| `mc-resource-router` | 稼働 |

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

Docker状態監視のOCI配置手順は[`docs/oci-docker-monitoring.md`](docs/oci-docker-monitoring.md)を参照してください。

## セキュリティ方針

- Agentから外向きHTTPS通信だけを許可する
- Docker Socket、Docker API、SSH、RCONを外部公開しない
- 非特権Agentを`docker`グループへ追加しない
- rootの短時間Collectorと非特権Agentを分離する
- Dockerから取得した環境変数、Mount、IP、ログ本文を送信しない
- MVPでは読み取り専用とする
- 任意Shell・任意Dockerコマンド・任意RCONは実装しない
- 将来の操作機能は許可リスト・権限確認・監査ログを必須とする
- Supabase Service Role KeyはVercelのServer Componentからのみ利用する
- `container_expectations`は`anon`・`authenticated`から参照できない
- 実メトリクスの公開前にCloudflare Accessで閲覧者を制限する

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

- Supabase: `ivrm-core`へホスト・Docker状態・期待状態Migration適用済み
- Vercel: `ivrm-dashboard`をProduction Deployment済み
- Health Check: `https://console.ivrm.jp/api/health`でHTTP 200を確認済み
- `console.ivrm.jp`: Cloudflare経由で接続済み
- OCI Agent: `0.3.0`をOracle Linux ARM64へsystemdサービスとして配置済み
- Docker Collector: 10秒間隔、Heartbeat: 15秒間隔で継続稼働
- Agent認証: Agent ID・Timestamp・Nonce・HMAC-SHA256署名を検証
- ホスト画面: Supabaseの最新HeartbeatをServer Componentから取得
- Docker状態監視: State・Health・RestartCount・OOMKilledを3コンテナで本番表示済み
- 期待状態: `mc-resource`の計画停止を待機中として区別する実装を追加中

## 次の開発項目

1. コンテナ期待状態・メンテナンス表示をProductionへ反映する
2. Docker CPU・メモリ・Network I/O・Block I/O・PIDsを保存・表示する
3. Minecraft TPS・MSPT・プレイヤー数を取得する
4. Stale / Offline / Error判定の通知と履歴表示を追加する
