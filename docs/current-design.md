# ivrm-dashboard 現行設計 v0.2

- 文書ID: DOC-DASH-ARC-001
- 版: v0.2.0
- 状態: Current（登録時点の現行構成。repo 内 `docs/architecture.md` が詳細設計の正本で、本書は索引と要点）
- 根拠: `ivRooom/ivrm-dashboard` README.md（SHA 099228a8、HEAD 74255e80、最新コミット 2026-10-31）全文と apps/・supabase/ の実列挙（2026-11-10）。v0.2.0 改版では `apps/dispatch-worker/README.md`（SHA bcce5735）と apps/ の再列挙（main HEAD 924d7c45、2026-11-13）を追加根拠とする
- 最終更新 / Last Reviewed: 2026-11-13
- 改版履歴（最新）: v0.2.0（2026-11-13、Issue #210）— 状態ストアの記述を Supabase 前提から PG17 `ivrm_dashboard` の実態へ改版。変更箇所の詳細は末尾「改版履歴」を参照

## 現在の状態
- 統合運用コンソールの公開面は `console.ivrm.jp`（Next.js on Vercel）。Minecraft・Web サービス・クラウド基盤をひとつの画面から監視・管理する。
- 状態ストアは PG17 の `ivrm_dashboard` データベースへ移行済み（v0.1.0 時点の「Supabase Postgres / Realtime（状態ストア）」という記述は陳腐化していたため、本改版で是正した。移行の根拠は `apps/dispatch-worker/README.md` の PG17 stack の記述）。
- Agent の現行コードは 0.6.0。Production hardening は Issue #54 で管理中。

## 構成
```text
Browser → console.ivrm.jp (Next.js / Vercel)
        → PG17 Postgres `ivrm_dashboard`（状態ストア）
IVRM Agent (Go) on OCI / Lightsail / EC2
        → 外向き HTTPS のみ: Console の /api/agent/heartbeat（ほか /api/agent/backups・/api/agent/logs）へ送信し、PG17 への保存は Console 経由
        → ローカルのみ: Docker / Minecraft / systemd / backup scripts
```
- Docker Socket・SSH・RCON は外部公開しない。Agent 認証は Agent ID・Timestamp・Nonce・HMAC-SHA256 署名。Console の認証境界は Discord Session / RBAC。
- 通知配送は `apps/dispatch-worker` が担う。Supabase Edge Function `notification-dispatch` の置換であり、PG17 上で claim / deliver / complete のサイクルを毎分ポーリングで直接実行する（Supabase 時代の pg_cron → pg_net → Edge Function という経路は PG17 stack には無い）。接続時は PostgREST authenticator ロールで認証し `ivrm_dashboard_service`（BYPASSRLS）を assume する（いずれも `apps/dispatch-worker/README.md` の記述による）。Console（apps/web）側の DB 接続方式の詳細は本改版では未確認。
- Supabase Service Role Key に関する v0.1.0 の記述（利用先は Vercel 上の Console と Edge Function `notification-dispatch`）は移行前の構成のもので、現行の通知配送には当てはまらない。Edge Function の Production への配置状況は引き続き未確認。
- apps/ は実在6件: `web`（Next.js 管理画面）、`agent`（Go 監視 Agent）、`cloud-collector`、`dispatch-worker`（通知配送 worker。v0.2.0 で追加確認）、`minecraft-metrics-bridge`、`runtime-collector`。
  - **乖離メモ**: README の構成図に載っているのは web と agent の2件だけで、collector 系3件は未記載。役割の詳細は今回未取得（名称からの推測で埋めない）。Phase 4 で README 側の更新候補。（v0.1.0 時点のメモ。v0.2.0 では dispatch-worker を実在アプリとして追記したのみで、このメモ自体は未解消）
- supabase/ に config.toml、functions/、migrations/、tests/ が残存している（移行前の構成の残存物。現行の状態ストアは PG17 `ivrm_dashboard` であり、Supabase は現行の保存経路ではない）。
  - `supabase/functions/notification-dispatch`（Edge Function）は dispatch-worker へ置換済みだが repo 内に残存し、二重実装の状態になっている。処分（削除可否）の判断は Issue #210 の項目2で扱い、削除の実施は別ゲートとする。
  - **未検証**: この Supabase が ivrm-core と同一プロジェクトか別プロジェクトかは未確認のままである。Supabase 廃止予定の成立条件（残存利用の棚卸し）に直結するため、棚卸しタスクとして明記する。

## 監視対象と判定
- 表示: ホストと Agent の Heartbeat、Docker コンテナの CPU・メモリ・Network/Block I/O・PIDs、コンテナ状態・Health・RestartCount・OOMKilled、Minecraft の Online・TPS・MSPT・プレイヤー数、最終バックアップ状態。
- 状態判定は実状態と `container_expectations` の期待状態の比較で行う（running / stopped / absent / maintenance_mode）。初期対象は mc-main（稼働期待）、mc-resource（停止期待）、mc-resource-router（稼働期待）。
- 画面: Overview `/`・`/services`、Minecraft `/minecraft`・`/logs`・`/operations`、Infrastructure `/hosts`・`/containers`・`/inventory`・`/cloud`・`/capacity`、Observability `/incidents`・`/events`・`/history`・`/reliability`、Protection `/backups`・`/notifications`、Administration `/status-center`・`/security`。Navigation の正本は `apps/web/app/console-navigation.ts`。

## 開発・運用の正本
- 詳細設計は repo 内 `docs/architecture.md`、OCI 配置手順は `docs/oci-docker-monitoring.md`。
- Production の現在状態・CI・Deployment・Agent rollout は README に固定せず、GitHub と接続サービスで確認する（README の方針を継承）。

## 改版履歴
| 版 | 日付 | 変更内容 | 変更者 | 承認者 |
|---|---|---|---|---|
| v0.1.0 | 2026-11-10 | 初版。README と構成実測から現行設計を登録し、README との乖離2件（collector 未記載、Supabase の同一性未検証）を明記 | Muse | 未（Phase 4 配置時） |
| v0.1.0 | 2026-11-10 | 初版マージ前のレビュー指摘対応（いずれも実コードで裏取り済み）: 構成図の Agent 経路を Console の /api/agent/heartbeat 経由へ是正、Service Role Key の利用先に Edge Function notification-dispatch を追記、画面一覧へ /services・/logs・/cloud・/status-center の4画面を追加 | Muse | Kanata |
| v0.2.0 | 2026-11-13 | Issue #210 項目1に基づく改版（文書のみ）: 状態ストアの記述を Supabase 前提から PG17 `ivrm_dashboard` へ是正（「現在の状態」に移行済みの明記、構成図の保存先を PG17 へ変更、通知配送を dispatch-worker の PG17 ポーリング方式として記述し Service Role Key の旧記述を移行前のものと明示、apps/ に dispatch-worker を追加して6件に更新、supabase/ を移行前の残存物と位置づけ Edge Function の処分は Issue #210 項目2・別ゲートと明記）。根拠は `apps/dispatch-worker/README.md` と apps/ の再列挙。Supabase の同一性（ivrm-core と同一か）は未検証のまま据え置いた | Muse | 未（Draft PR でレビュー待ち） |
