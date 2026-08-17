# Observability Retention

## 目的

`agent_heartbeats` / `container_samples` の15秒Rawデータを無期限に保持せず、長期表示に必要な5分Rollupを残したままDB容量と履歴Query負荷を抑える。

Issue #12の期間切替・5分RollupはPR #25で実装済み。本Runbookは残タスクだったRetentionをProductionへ安全に導入するための手順を定義する。

## 保持ポリシー

初期値:

| データ | 保持期間 | 備考 |
| --- | ---: | --- |
| `agent_heartbeats` | 7日 | 1h / 6h / 24h表示のRaw source |
| `container_samples` | 7日 | 対応する5分Rollupが存在する行だけ削除 |
| `minecraft_samples` | 7日 | 現時点では長期Rollupを持たないRaw telemetry |
| `host_metric_rollups_5m` | 90日 | 現在の7d / 30d表示を十分に包含 |
| `container_metric_rollups_5m` | 90日 | 現在の7d / 30d表示を十分に包含 |
| `monitoring_events` | 本Retention対象外 | Sample削除時は`sample_id`のみ`NULL`化 |
| `host_monitoring_events` | 本Retention対象外 | Heartbeat削除時は`heartbeat_id`のみ`NULL`化 |

保持期間はDB管理者専用Functionで変更できるが、Rawは2〜45日、Rollupは31〜730日の範囲に制限する。

## 安全設計

### Rollup存在確認

`container_samples`は、同じHost / Container / 5分Bucketの`container_metric_rollups_5m`が存在する場合だけ削除する。

`agent_heartbeats`は、同じHost / 5分Bucketの`host_metric_rollups_5m`が存在し、かつ削除対象外の`container_samples` / `minecraft_samples`が残っていない場合だけ削除する。

Rollup生成障害が発生している区間はRawが残るため、Retentionによって復旧用データまで失わない。

### Bounded Delete

1回の実行で各Tableから削除する件数を`batch_size`で制限する。初期値は50,000件。

Cronは6時間ごとに実行するため、大量の初期Backlogを1Transactionで一括削除せず段階的に収束させる。

### 排他

`run_observability_retention_v1()`はTransaction Advisory Lockを取得する。同じRetention Jobが重複して実行された場合、後続は`already_running`で終了する。

### Event Timeline保持

- `monitoring_events.sample_id -> container_samples.id` は `ON DELETE SET NULL`
- `host_monitoring_events.heartbeat_id -> agent_heartbeats.id` は `ON DELETE SET NULL`

RetentionでRawを削除しても構造化済みイベント履歴自体は保持する。

親DELETE時のFK参照確認を高速化するため、`monitoring_events.sample_id`と`host_monitoring_events.heartbeat_id`へIndexを追加する。

## 権限

- Retention設定TableはRLS + FORCE RLS
- `anon` / `authenticated` / `service_role`へTable直接権限を付与しない
- `get_observability_retention_state_v1()`だけ`service_role`から実行可能
- `run_observability_retention_v1()`は`service_role`から直接実行不可
- `configure_observability_retention_v1()`はDB管理者専用
- BrowserからRetentionの有効化・削除実行はできない

## Migration適用時の状態

Migrationを適用しただけではRetentionは開始しない。

```text
enabled = false
Cron = 未登録
```

Migration末尾で既存の`ivrm-observability-retention-v1` Jobも解除するため、コードレビュー前に削除が始まることはない。

## Production有効化

### 1. 初期状態確認

```sql
select * from public.get_observability_retention_state_v1();
```

想定:

```text
enabled = false
raw_retention_days = 7
rollup_retention_days = 90
batch_size = 50000
last_run_at = null
```

Cron未登録確認:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'ivrm-observability-retention-v1';
```

0件であることを確認する。

### 2. Rollup coverage確認

7日より古いRawについて、削除前に対応Rollup欠損がないことを確認する。

```sql
with cut as (
  select statement_timestamp() - interval '7 days' as raw_cutoff
)
select
  (
    select count(*)
    from public.agent_heartbeats h, cut
    where h.received_at < cut.raw_cutoff
      and not exists (
        select 1
        from public.host_metric_rollups_5m r
        where r.host_id = h.host_id
          and r.bucket_at = to_timestamp(
            floor(extract(epoch from h.received_at) / 300) * 300
          )
      )
  ) as heartbeat_missing_rollup,
  (
    select count(*)
    from public.container_samples s, cut
    where s.received_at < cut.raw_cutoff
      and not exists (
        select 1
        from public.container_metric_rollups_5m r
        where r.host_id = s.host_id
          and r.container_name = s.container_name
          and r.bucket_at = to_timestamp(
            floor(extract(epoch from s.received_at) / 300) * 300
          )
      )
  ) as container_missing_rollup;
```

0 / 0が理想。0でなくてもRetention Function側のGuardにより該当Rawは削除されないが、先にRollup復旧を優先する。

### 3. 有効化

PR mergeとProduction確認後、DB管理者として実行する。

```sql
select *
from public.configure_observability_retention_v1(
  true,
  7,
  90,
  50000
);
```

Cron:

```text
17 */6 * * *
```

6時間ごとの17分に実行する。

### 4. 初回実行確認

Cronを待たず初回を確認する場合はDB管理者として実行する。

```sql
select * from public.run_observability_retention_v1();
```

`run_status = completed`と削除件数を確認する。

### 5. UI / API非回帰

- `/history?range=1h`
- `/history?range=6h`
- `/history?range=24h`
- `/history?range=7d`
- `/history?range=30d`
- `/api/health`
- Agent Heartbeat ingest
- `/incidents`

を確認する。

7d / 30dは5分Rollupから取得するため、Raw削除後も表示できることを確認する。

## 無効化 / Rollback

新しい削除を直ちに止める場合:

```sql
select *
from public.configure_observability_retention_v1(
  false,
  7,
  90,
  50000
);
```

これにより`enabled=false`となり、Retention Cronを解除する。

削除済みRawはFunction無効化だけでは復元されない。必要なRaw復旧はDatabase Backup / PITRの復旧手順として扱う。

5分RollupとEvent Timelineは別保持なので、通常の履歴表示・Incident調査はRaw削除後も継続できる。

## Production導入前スナップショット（2026-08-17）

確認時点:

- Heartbeat: 約93,000件、うち7日超 約53,500件
- Container Sample: 約299,000件、うち7日超 約159,000件
- Minecraft Sample: 約19,000件、7日超 0件
- 7日超HeartbeatのRollup欠損: 0件
- 7日超Container SampleのRollup欠損: 0件

初回有効化後は`batch_size=50000`で段階削除し、1回の巨大Transactionを避ける。