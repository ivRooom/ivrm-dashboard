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

## Dockerリソースメトリクス

rootの短時間Collectorが許可済みかつ稼働中のコンテナだけに`docker stats --no-stream`を実行し、次の値を取得します。

- CPU使用率
- メモリ使用量・上限
- Network RX / TX累計
- Block Read / Write累計
- PIDs

停止中・未作成・Stats取得失敗時はリソース値を未取得として扱い、State・Healthなどの状態監視は継続します。Collectorが取得したDockerのSI・IEC単位はバイトへ変換して保存します。

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

Docker監視のOCI配置・更新手順は[`docs/oci-docker-monitoring.md`](docs/oci-docker-monitoring.md)を参照してください。

## セキュリティ方針

- Agentから外向きHTTPS通信だけを許可する
- Docker Socket、Docker API、SSH、RCONを外部公開しない
- 非特権Agentを`docker`グループへ追加しない
- rootの短時間Collectorと非特権Agentを分離する
- Collectorは許可済みコンテナ名だけを対象にする
- Dockerから取得した環境変数、Mount、IP、ログ本文を送信しない
- 任意Shell・任意Dockerコマンド・任意RCONは実装しない
- 操作機能は許可リスト・権限確認・監査ログを必須とする
- Supabase Service Role KeyはVercelのServer-side処理からのみ利用する
- `container_expectations`と監視メトリクスは`anon`・`authenticated`から直接参照できない
- Discord Session / RBAC / Server-side authorizationを管理Consoleの境界として維持する

## Console Navigation

認証済み画面は共通Console Shellを利用し、Desktop / Mobileとも`apps/web/app/console-navigation.ts`をNavigation Source of Truthとします。

- Overview: `/`
- Minecraft: `/minecraft`, `/operations`
- Infrastructure: `/hosts`, `/containers`, `/inventory`, `/capacity`
- Observability: `/incidents`, `/events`, `/history`, `/reliability`
- Protection: `/backups`, `/notifications`
- Administration: `/security`

`/login`などPublic Routeには管理Console Shellを表示しません。未実装の`/logs`はIssue #68でRouteが実装されるまでNavigationへ追加しません。

詳細は[`docs/architecture.md`](docs/architecture.md)を参照してください。

## 開発方針

- ドキュメント・Issue・PR・コミットメッセージは日本語
- Web: Next.js / TypeScript
- Agent: Go
- 状態ストア: Supabase Postgres
- Webデプロイ: Vercel
- Agent配布: GitHub ActionsでLinux ARM64 / AMD64をビルド
- Repository / GitHub Issue / Pull Request / Actionsを動的な状態のSource of Truthとする

## 現在の実装基盤

- Vercel: `ivrm-dashboard`を`console.ivrm.jp`へデプロイ
- Health Check: `/api/health`
- Agent: 現行コードは`0.6.0`
- Agent認証: Agent ID・Timestamp・Nonce・HMAC-SHA256署名
- Monitoring: Host / Container / Minecraft Status / TPS / MSPT / History
- Operations data: Incident / Backup / Notification / Reliability / Inventory / Capacity
- Auth: Discord Console Session / RBAC。Production hardeningはIssue #54で管理

Productionの現在状態、CI、PR、Deployment、Agent rollout状況はREADMEへ固定せず、GitHubと接続サービスをSource of Truthとして確認します。

## 次の開発項目

1. Issue #71 Phase A — Console Shell / Navigation
2. Issue #71 Phase B — Design Token / Shared Components
3. Issue #71 Phase C — Overview UX Refresh
4. Issue #68 — Logs / Lifecycle Operations
5. Issue #70 — Activity ingestion / Queue Health
