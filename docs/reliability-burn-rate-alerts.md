# Reliability Burn Rate Alerts

## 目的

Reliability v2 Phase 3では、明示設定されたSLOのError Budget消費速度を1h / 6h / 24hで同時評価し、短時間の急激なBurnと持続的なBurnをNotification CenterへDurable Signalとして統合します。

Raw Incident / Raw Known Downtimeは変更しません。Burn RateはSLO計算レイヤーだけでScoped MaintenanceとのIntersectionを除外します。

## 評価Window

- 1h
- 6h
- 24h

SLO Targetは`reliability_slo_policies`で`enabled=true`かつTargetが明示設定されているサービスだけを評価します。アプリ側で99.9%などを仮定しません。

対象:

- Overall Reliability
- Host Platform
- Container Runtime
- Backup Protection

## Alert Policy

IVRMの初期Burn Alert Policyは次のとおりです。

```text
Critical / Fast Burn
1h >= 14.4x AND 6h >= 6x

Warning / Sustained Burn
6h >= 6x AND 24h >= 3x
```

Criticalは1hと6h、Warningは6hと24hの両方で条件を満たした場合だけ発火します。単一Windowだけの瞬間的なスパイクでは通知しません。

## Coverageの扱い

欠損Telemetryを正常扱いしません。

- Criticalに必要な1h / 6hが確定して条件成立: Criticalを証明可能
- Warningに必要な6h / 24hが確定して条件成立: Warningを証明可能
- 1h / 6h / 24hすべて確定して閾値未満: Healthy / Recoveryを確定可能
- 上記のどれにも該当せずCoverage不足: Coverage Unknown
- SLO Policy / Maintenance取得不能: Data unavailable

Coverage Unknown / Data unavailableではActive SignalをRecoveryしません。データが戻って正常を証明できるまで既存Signalを保持します。

## Maintenance

既存`buildReliabilityMaintenanceAdjustments()`をそのまま再利用します。

```text
Raw Incident interval
  - Applicable Scoped Maintenance intersection
  = SLO-counted interval
```

Service / Host / Container / Backup TargetのScopeを尊重します。別Entityで同時発生した障害を時間帯だけで誤除外しません。

OOMKilled起因Container Incidentは既存Reliability方針どおりMaintenance Windowと重なっても除外しません。

## Notification lifecycle

Signal Key:

```text
reliability:slo_burn_rate:<service-id>
```

Signal Source / Entity Type:

```text
source_type = reliability
entity_type = reliability
host_id = NULL
server_id = ivrm
```

既存Host / Container / Backup通知は引き続き`host_id NOT NULL`相当のStructure Checkで保護します。

Transition:

- Healthy -> Warning: Open
- Healthy -> Critical: Open
- Warning -> Critical: Escalated
- Critical -> Warning: Silent de-escalation
- Warning/Critical -> Healthy: Recovery
- Policy無効化: Active Burn Signalを終了
- Coverage Unknown / Data unavailable: 状態変更なし

Criticalが配送される前にWarningへ下がった場合、古いCritical Outbox Rowは`signal_deescalated_before_delivery`でSuppressedへ移します。

## Reconciler

Endpoint:

```text
POST /api/reliability/burn-reconcile
```

Authentication:

```text
x-ivrm-reliability-token: <scheduler token>
```

- TokenはMigration内で96文字のhexとして生成
- 平文はSupabase Vault `ivrm_reliability_burn_reconcile_token`だけに保存
- 通常TableはSHA-256だけ保存
- Web側は受信TokenをSHA-256化してRPCで照合
- Request bodyは実測1 KiB上限
- Responseは`Cache-Control: no-store`

新規Environment Variableはありません。既存`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`だけをServer側で利用します。

## Scheduler

Migration適用時はReconcilerを自動有効化しません。

```text
enabled = false
Cron job = none
```

ProductionアプリへPRがマージされ、EndpointがProductionで利用可能になった後だけ次を実行します。

```sql
select public.set_reliability_burn_reconciler_v1(true);
```

これにより1分ごとの`ivrm-reliability-burn-reconcile` Cronが作成されます。

停止:

```sql
select public.set_reliability_burn_reconciler_v1(false);
```

停止時はCronをUnscheduleし、Endpoint URLもStateから削除します。既存Signal / Outbox履歴は削除しません。

## Durable Notification

Reliability通知も既存Notification Centerの以下を再利用します。

- `notification_signal_state`
- `notification_outbox`
- Advisory Lock
- stale transition protection
- suppression reevaluation
- recovery-before-delivery suppression
- `FOR UPDATE SKIP LOCKED` Claim
- Retry / Failed lifecycle
- Discord Dispatcher

Host / Container / Backup用`apply_notification_signal_v1`は変更せず、Reliability専用`apply_reliability_burn_signal_v1`を追加します。

## Suppression

既存Scopeに`reliability`を追加します。

```text
global
host
container
backup
reliability
signal
```

Reliability Scope KeyにはSLO Service IDを使用します。

```text
overall
host
container
backup
```

## Discord

既存`notification-dispatch`をReliability Source対応にします。

Discord上のSource表示は`SLO`です。

既存の以下は変更しません。

- Webhook URL allowlist
- `allowed_mentions.parse=[]`
- Scheduler Token認証
- Claim直前 / 送信直前のSuppression Gate
- 10秒Timeout
- Delivery Retry

## Production確認

マージ後の有効化前:

1. Migration 006が適用済み
2. `reliability_burn_reconcile_state.enabled = false`
3. Cron jobが存在しない
4. 新規Reliability Signalが勝手に作成されていない
5. Host / Container / Backup既存Signalが正常に表示できる

有効化後:

1. Reconcilerが1分以内に`last_invoked_at`を更新
2. `last_success_at`が更新
3. SLO未設定ならSignalを新規作成しない
4. Coverage Unknownで既存SignalをRecoveryしない
5. Warning条件でReliability Signalが1件Open
6. Critical条件でEscalation
7. Critical -> WarningでDiscord追加通知なし
8. Healthy確定でRecovery
9. `/notifications`でSLO Sourceを表示
10. Discord ChannelがOFFの場合Outboxは既存ルールどおりSuppressed

テスト目的でProduction SLO TargetやIncidentデータを捏造しません。実データで条件が成立しない場合はDB構造・Reconciler state・UI表示までを確認し、Alert lifecycleの強制テストはstaging/branch DBで行います。
