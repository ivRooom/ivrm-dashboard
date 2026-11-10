# ivrm-dashboard 現行設計 v0.1

- 文書ID: DOC-DASH-ARC-001
- 版: v0.1.0
- 状態: Current（登録時点の現行構成。repo 内 `docs/architecture.md` が詳細設計の正本で、本書は索引と要点）
- 根拠: `ivRooom/ivrm-dashboard` README.md（SHA 099228a8、HEAD 74255e80、最新コミット 2026-10-31）全文と apps/・supabase/ の実列挙（2026-11-10）
- 最終更新 / Last Reviewed: 2026-11-10

## 現在の状態
- 統合運用コンソールの公開面は `console.ivrm.jp`（Next.js on Vercel）。Minecraft・Web サービス・クラウド基盤をひとつの画面から監視・管理する。
- Agent の現行コードは 0.6.0。Production hardening は Issue #54 で管理中。

## 構成
```text
Browser → console.ivrm.jp (Next.js / Vercel)
        → Supabase Postgres / Realtime（状態ストア）
IVRM Agent (Go) on OCI / Lightsail / EC2
        → 外向き HTTPS のみ: Console の /api/agent/heartbeat（ほか /api/agent/backups・/api/agent/logs）へ送信し、Supabase への保存は Console 経由
        → ローカルのみ: Docker / Minecraft / systemd / backup scripts
```
- Docker Socket・SSH・RCON は外部公開しない。Agent 認証は Agent ID・Timestamp・Nonce・HMAC-SHA256 署名。Supabase Service Role Key の利用先は Vercel 上の Console（apps/web の Server-side）と Supabase Edge Function `notification-dispatch`（`supabase/functions/notification-dispatch/index.ts` が Deno.serve 内で利用する実装上の利用先。Production への配置状況は未確認）。Console の認証境界は Discord Session / RBAC。
- apps/ は実在5件: `web`（Next.js 管理画面）、`agent`（Go 監視 Agent）、`cloud-collector`、`minecraft-metrics-bridge`、`runtime-collector`。
  - **乖離メモ**: README の構成図に載っているのは web と agent の2件だけで、collector 系3件は未記載。役割の詳細は今回未取得（名称からの推測で埋めない）。Phase 4 で README 側の更新候補。
- supabase/ に config.toml、functions/、migrations/、tests/ がある（＝ dashboard 独自の Supabase 利用）。
  - **未検証**: この Supabase が ivrm-core と同一プロジェクトか別プロジェクトかは未確認。Supabase 廃止予定の成立条件（残存利用の棚卸し）に直結するため、棚卸しタスクとして明記する。

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
