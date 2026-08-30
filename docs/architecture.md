# IVRM Dashboard アーキテクチャ

## 責務

- `apps/web`: Next.js管理画面とHeartbeat受信API。Vercelへ配置する。
- `apps/agent`: 各ホストでメトリクスを収集し、外向きHTTPSで送信する。
- `supabase`: 監視状態・履歴・Incident・Backup・Notification・Reliabilityの構造化データを管理する。

```text
OCI / Lightsail / EC2
  └─ IVRM Agent
       ├─ /proc/loadavg
       ├─ /proc/meminfo
       ├─ /proc/uptime
       └─ statfs
            ↓ HMAC署名付きHTTPS
       POST /api/agent/heartbeat
            ↓
       Supabase Postgres
            ↓
       console.ivrm.jp
```

## Console Shell / Navigation

認証済み管理画面はRoot Layoutの共通Console Shellで描画する。

```text
Root Layout
  └─ Console Shell
      ├─ Desktop Sidebar
      ├─ Top Context Bar
      │   ├─ Current section / page
      │   ├─ Environment
      │   ├─ User / Console Role
      │   └─ Logout
      └─ Page Content
```

MobileではDesktop SidebarをCompact Header + menuへ切り替える。Desktop / Mobileはともに`apps/web/app/console-navigation.ts`をNavigation Source of Truthとして利用し、Page Componentは原則としてPage header・filter・content・contextual actionだけを担当する。

Navigation IAは以下とする。

- Overview: Overview
- Minecraft: Minecraft / Operations
- Infrastructure: Hosts / Containers / Inventory / Capacity
- Observability: Incidents / Events / History / Reliability
- Protection: Backups / Notifications
- Administration: Security

`/logs`はIssue #68でRouteが実装されるまでNavigationへ追加しない。Active判定は詳細Routeを含むprefix matchingとし、`/hosts/{serverId}`、`/containers/...`、`/security/sessions`、`/security/audit`でも親項目をActive表示する。

`/login`など`isPublicConsoleRoute()`でPublicと判定されるRouteにはConsole Shellを表示しない。Navigationのために監視データ取得をClientへ移さず、Client ComponentはPath判定とMobile interactionなど必要最小限に限定する。

## Console Design System

Consoleの視覚仕様は、大型Theme libraryを追加せずCSS custom propertiesと小さなShared Componentで段階的に統一する。

- `apps/web/app/design-tokens.css`: Surface / Border / Text / State / Spacing / Radius / Typography / Focus / Interactive / Layout rhythmのSemantic Tokenを定義する。
- `apps/web/app/globals.css`: 既存Primitive TokenとLegacy page styleを保持し、既存Routeを一括変更せず段階移行する。
- `apps/web/components/console-ui.tsx`: `PageHeader`、`SectionHeader`、`MetricCard`、`StatusBadge`、`ActionLink`、`StatePanel`、`TableShell`など、データ取得や認証へ依存しない表示Primitiveを提供する。
- Statusはラベルを必ず表示し、色だけへ意味を依存させない。
- Interactive要素は`focus-visible`を持ち、`prefers-reduced-motion`では共通transition tokenを0msへ落とす。
- Page Componentの認証、RBAC、Server-side data fetching、mutationはShared Componentへ移さない。

Phase Bでは代表Routeから段階移行し、Overviewの情報設計変更はPhase Cへ分離する。

## Heartbeat認証

Agentは毎回、次のヘッダーを付与する。

```text
X-IVRM-Agent-ID
X-IVRM-Timestamp
X-IVRM-Nonce
X-IVRM-Signature
```

署名対象は次のバイト列とする。

```text
<timestamp>.<nonce>.<raw request body>
```

受信APIは次を検証する。

1. 本文サイズが32KiB以下
2. JSONスキーマと数値範囲
3. Headerと本文のServer ID一致
4. Timestampが現在時刻から5分以内
5. Nonceが16バイト乱数の16進表現
6. HMAC-SHA256署名を定時間比較
7. HostがDB上で有効
8. Host行ロック内で最終受信から8秒以上経過していることを確認
9. NonceのDB一意制約による再送拒否

## Secret管理

- Agent側: `IVRM_AGENT_TOKEN`
- Web側: `IVRM_AGENT_SECRETS_JSON`
- Supabase Service Role Key: `SUPABASE_SERVICE_ROLE_KEY`

すべてGitHubへ保存せず、OCIの権限制限済み環境ファイルとVercelの暗号化済みEnvironment Variablesへ保存する。

## セキュリティ

- Discord Session / RBAC / Server-side authorizationをConsole Shell変更でも維持する。
- Service Role Key、Discord OAuth Token、Session Token / Hash、RCON credentialをBrowserへ渡さない。
- Docker Socket、Docker API、SSH、RCONをインターネットへ公開しない。
- 任意Shell・任意Dockerコマンド・任意RCONを実装しない。
- Agent Secretをログへ出力しない。
- SupabaseテーブルはRLSを有効化し、必要なServer-side処理だけがService Roleを利用する。
- Heartbeat保存はPostgres関数内でHostロック、レート制限確認、Nonce重複判定、INSERTを原子的に行う。
- APIエラーでSecret、署名、本文、Supabaseレスポンスを返却しない。

## OCIへのAgent導入準備

1. 32文字以上のランダムSecretを生成する。
2. Supabaseの`hosts`へ`server_id = oci-minecraft-01`を登録する。
3. WebとAgentへ同じSecretを安全に設定する。
4. Supabase migrationを適用する。
5. VercelへWebをデプロイする。
6. Agentをsystemdで起動する。
7. Heartbeat保存とStale判定を確認する。

## 現在の開発順

1. Issue #71 Phase A: Console Shell / Navigation
2. Issue #71 Phase B: Design Token / Shared Components
3. Issue #71 Phase C: Overview UX Refresh
4. Issue #68: Logs / Lifecycle Operations
5. Issue #70: Activity ingestion / Queue Health

GitHub Issue / Pull Request / Actionsを動的な開発状態のSource of Truthとし、この文書へSHA・CI状態・PR状態を固定値として持たせない。
