# Notification Center 運用ガイド

## 目的

Notification Centerは、Host / Container / BackupのStructured Signalを通知配送から分離し、障害の発生・重大化・復旧とDiscord配送結果をDurableに追跡するための基盤です。

## 構成

```text
Monitoring Event / Backup Run ── Trigger ──┐
                                          ├─ notification_signal_state
Container Snapshot ─────────── pg_cron ───┤
Agent Heartbeat / Backup SLA ─ pg_cron ───┘
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

ContainerはStructured Monitoring Eventに加え、最新45秒以内のSnapshotからState / Healthを毎分再評価します。これによりNotification Center導入前から継続している異常もSignalへ同期できます。古いContainer SnapshotはHost Heartbeat Signalに委ねます。

BackupはBackup Age / Remote Sync / Retention / Restore Testを毎分再評価し、Backup Run failed / Checksum failedは`backup_runs`のTriggerで即時反映します。Signalは現在観測より古いイベントを無視するため、古いBackup Successが新しいFailureを誤ってRecoveryさせません。

## Outbox

`notification_outbox`は配送のSource of Truthです。

- `pending`: 配送待ち
- `sending`: Claim済み
- `retry`: 配送失敗後のBackoff待ち
- `sent`: Discord送信完了
- `failed`: 5回Retry後も失敗
- `suppressed`: Channel無効・未設定・Maintenance・明示抑制・Lifecycle上の送信不要

Claimは`FOR UPDATE SKIP LOCKED`を使い、複数Dispatcherが同時実行されても同じ行を二重送信しません。`sending`のまま5分以上残ったClaimは次回Claim時に`retry`へ戻します。

Signalの初回OpenはSignal Key単位のtransaction advisory lockで直列化し、存在しない行への同時Insert競合も防ぎます。

### Transition順序

同一`signal_key`の未配送Transitionは時系列順を維持します。また、SignalがRecoveryした時点で未配送の`opened / escalated`は`signal_recovered_before_delivery`としてSuppressedへ移し、復旧後に古いCriticalが届くことを防ぎます。

Opening / Escalationが一度も`sent`にならなかったEpisodeでは、Recoveryだけを単独送信せず`recovered_before_first_delivery`としてSuppressedへ記録します。新しいEpisodeがすでに開始している古いRecoveryは`superseded_by_new_incident`として送信しません。

### Channel停止・再開時の扱い

ChannelをOFFまたは未設定へ切り替えると、`pending / retry / sending`のRowを即座に`status=suppressed`へ移し、Claimも解除します。これにより停止中のRowが再有効化直後に古い通知として一括配送されることを防ぎます。

再びChannelがReadyになった場合は、現在もActiveなSignalについて、現在のMaintenance / Suppression条件が解除されているときだけ、そのIncident内で最新の`opened / escalated` Suppressed Rowを1件だけ`pending`へ戻します。

- 継続中の障害: 通知再開後に最新状態を1件だけ配送可能
- OOMKilled / RestartCountなどone-shot: 古いイベントを後追い再送しない
- すでにRecovery済みのSignal: 再送しない

### 動的Suppression

`pending / retry`はClaim時にもMaintenance / Global / Host / Container / Backup / Signal Suppressionを再評価します。Row作成後にMaintenanceやSuppressionが始まった場合でも、その期間中はDiscordへ配送しません。

Dispatcherも各RowのDiscord送信直前にClaim・Channel・Suppression・Signal lifecycleを再確認します。Claim後に状態が変わった場合は、Discordへ送らずSuppressedへ戻します。

### Backup Policy無効化

Backup Policyを`enabled=false`へ変更、または削除した場合、そのPolicy由来の以下のSLA Signalを退役します。

- `backup_age`
- `remote_sync`
- `retention`
- `restore_test`

未配送Rowは`backup_policy_disabled`としてSuppressedへ移し、Signal Stateは削除します。Policyを再度有効化した場合は現在のBackup状態から新しいEpisodeとして再評価されます。

## Secret / 環境設定

次の情報はGitHub、通常DBテーブル、Outboxへ保存しません。

- Discord Webhook URL
- Scheduler Token平文
- Supabase Service Role Key

Scheduler TokenはMigration 020がDB内部で自動生成します。

- 平文: Supabase Vault `ivrm_notification_dispatch_token`
- SHA-256: `notification_dispatch_credentials`

通常のセットアップでScheduler Tokenを手動生成・コピーする必要はありません。

Dispatcher URLは環境固有なので、Supabase Vault `ivrm_notification_dispatch_url`へ**現在ProjectのEdge Function URLを必ず登録してからChannelを有効化**します。MigrationにはProduction Project IDを埋め込みません。

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/notification-dispatch',
  'ivrm_notification_dispatch_url',
  'IVRM Notification Center dispatcher URL',
  null
);
```

既に同名Secretがある場合は新規作成せず、Supabase Vaultの更新手段で現在ProjectのURLへ更新します。別ProjectのURLを設定しないでください。

Discord WebhookはEdge Function Secret `DISCORD_WEBHOOK_URL`へ保存します。DispatcherはDiscord公式Webhook URLだけを許可し、`allowed_mentions.parse=[]`を常に付与します。

## Edge Functionのデプロイ

`notification-dispatch`はSupabase GatewayのJWT検証ではなく、Notification Center専用Scheduler TokenをSHA-256で照合します。Repoの`supabase/config.toml`にはSupabase CLI用の`project_id`とFunction単位の設定を明示しています。

```toml
project_id = "ivrm-dashboard"

[functions.notification-dispatch]
verify_jwt = false
```

CLIから個別にDeployする場合も同等にJWT検証OFFを維持してください。Custom Token照合を削除しないでください。

## Discord配送を有効化する

初期状態では安全のためChannelは`enabled=false / configured=false`です。SignalとOutboxは動作しますが、配送候補は`channel_disabled`としてSuppressedになります。

1. `ivrm_notification_dispatch_url`が現在ProjectのFunction URLを指していることを確認する。
2. Supabase DashboardでEdge Function `notification-dispatch`へSecretを追加する。

```text
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

3. Secret登録後、Service Role権限でChannelを有効化する。

```sql
select public.set_notification_channel_v1(true, true, 'Discord Alerts');
```

4. `/notifications`で以下を確認する。

- Enabled = ON
- Webhook Secret = Configured
- Dispatcherが数分以内に更新
- Last Errorが`—`
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
5. `dispatcher_url_missing`ならVaultの`ivrm_notification_dispatch_url`を確認
6. `channel_unconfigured`ならEdge Function Secret `DISCORD_WEBHOOK_URL`とChannel状態を確認
7. `failed`は最大5回Retry済みなので、Discord Webhook設定・Discord側障害を確認

Webhook URLやレスポンス本文をログへ貼り付けないでください。

## セキュリティ

- NotificationテーブルはRLSを有効化し、`anon` / `authenticated`から直接参照不可
- Web UIはServer ComponentからService Role RPCだけを利用し、`apps/web/lib/notifications.ts`は`server-only`でClient importを禁止
- DispatcherのClaim / Complete / Suppress / Delivery Gate / Token Verify RPCもService Roleのみ
- Edge FunctionはGateway JWTをOFFにする代わりにCustom Scheduler Tokenを必須化し、SHA-256で照合
- Dispatcher URLはVaultから取得し、別ProjectへScheduler Tokenを送らない
- `detail_href`は単一`/`始まりの相対URLだけを許可し、`//host`形式を拒否
- arbitrary URL配送なし
- Player IP、Cookie、Session Token、Webhook Token、生ログ本文は通知へ含めない
- Discord Mentionは無効化
