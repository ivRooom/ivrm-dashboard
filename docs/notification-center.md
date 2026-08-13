# Notification Center 運用ガイド

## 目的

Notification Centerは、Host / Container / BackupのStructured Signalを通知配送から分離し、障害の発生・重大化・復旧とDiscord配送結果をDurableに追跡するための基盤です。

## 構成

```text
Monitoring Event / Backup Run ── Trigger ──┐
                                          ├─ notification_signal_state
Agent Heartbeat / Backup SLA ─ pg_cron ──┘
                                          ↓
                                  notification_outbox
                                          ↓ claim / retry
Supabase Cron ─ pg_net ─ notification-dispatch Edge Function
                                          ↓
                                  Discord Incoming Webhook
```

Host OfflineはAgent自身に依存せず、Supabase Cronが最新Heartbeatを毎分評価します。

- 45秒超: Warning
- 180秒超: CriticalへEscalation
- 新しいHeartbeat受信: Recovery

BackupはBackup Age / Remote Sync / Retention / Restore Testを毎分再評価し、Backup Run failed / Checksum failedは`backup_runs`のTriggerで即時反映します。

## Outbox

`notification_outbox`は配送のSource of Truthです。

- `pending`: 配送待ち
- `sending`: Claim済み
- `retry`: 配送失敗後のBackoff待ち
- `sent`: Discord送信完了
- `failed`: 5回Retry後も失敗
- `suppressed`: Channel無効・未設定・Maintenance・明示抑制

Claimは`FOR UPDATE SKIP LOCKED`を使い、複数Dispatcherが同時実行されても同じ行を二重送信しません。`sending`のまま5分以上残ったClaimは次回Claim時に`retry`へ戻します。

## Secret

次の情報はGitHub、通常DBテーブル、Outboxへ保存しません。

- Discord Webhook URL
- Scheduler Token平文
- Supabase Service Role Key

Scheduler Tokenは平文をSupabase Vaultの`ivrm_notification_dispatch_token`へ保存し、通常テーブルにはSHA-256だけを保持します。

Discord WebhookはEdge Function Secret `DISCORD_WEBHOOK_URL`へ保存します。DispatcherはDiscord公式Webhook URLだけを許可し、`allowed_mentions.parse=[]`を常に付与します。

## Discord配送を有効化する

初期状態では安全のためChannelは`enabled=false / configured=false`です。SignalとOutboxは動作しますが、配送候補は`channel_disabled`としてSuppressedになります。

1. Supabase DashboardでEdge Function `notification-dispatch`へSecretを追加する。

```text
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

2. Secret登録後、Service Role権限でChannelを有効化する。

```sql
select public.set_notification_channel_v1(true, true, 'Discord Alerts');
```

3. `/notifications`で以下を確認する。

- Enabled = ON
- Webhook Secret = Configured
- Dispatcherが数分以内に更新
- Failed / Retryが増加していない

Channelを止める場合はSecretを削除する前に先にOFFにします。

```sql
select public.set_notification_channel_v1(false, false, 'Discord Alerts');
```

## Suppression

明示的な通知抑制は`notification_suppressions`で管理します。対象範囲は以下です。

- `global`
- `host`
- `container`
- `backup`
- `signal`

Containerは既存`container_expectations.maintenance_mode`も自動的に配送抑制へ反映します。抑制中でもSignal lifecycleは保持し、Outboxへ`status=suppressed`として記録します。

## 障害時の確認順

1. `/notifications`のNotification Healthを確認
2. Active SignalとDelivery Historyを確認
3. `retry`ならHTTP status / error codeを確認
4. Dispatcherが3分以上更新されない場合はSupabase Cron / `pg_net` / Edge Functionを確認
5. `failed`は最大5回Retry済みなので、Discord Webhook設定・Discord側障害を確認

Webhook URLやレスポンス本文をログへ貼り付けないでください。

## セキュリティ

- NotificationテーブルはRLSを有効化し、`anon` / `authenticated`から直接参照不可
- Web UIはServer ComponentからService Role RPCだけを利用
- DispatcherのClaim / Complete / Token Verify RPCもService Roleのみ
- Edge FunctionはCustom Scheduler TokenをSHA-256で照合
- arbitrary URL配送なし
- Player IP、Cookie、Session Token、Webhook Token、生ログ本文は通知へ含めない
- Discord Mentionは無効化
