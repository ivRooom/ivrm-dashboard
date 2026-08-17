# 監視履歴・ロールアップ運用仕様

## 目的

`console.ivrm.jp/history`で、Minecraft・Host・Dockerの短期詳細と長期傾向を同じ時間軸で確認する。

新しいSecretや外部時系列DBは使用せず、既存SupabaseとAgent収集データを利用する。

## 表示期間

| range | 表示 | 集約粒度 | 取得元 |
| --- | --- | --- | --- |
| `1h` | 直近1時間 | 1分 | 生データ |
| `6h` | 直近6時間 | 2分 | 生データ |
| `24h` | 直近24時間 | 5分 | 生データ |
| `7d` | 直近7日 | 30分 | 5分Rollup |
| `30d` | 直近30日 | 1時間 | 5分Rollup |

Webから任意の時間数やBucket秒数を渡さない。許可する`range`は上記5種類だけとする。

## Minecraft履歴

現在のMinecraft Status Probeが実測している値だけを履歴化する。

- Public Endpoint Online人数
- Backend Online人数
- Public Status Probe Latency
- Backend Status Probe Latency

`minecraft_samples`には2026-08-13以降の実データが蓄積されているため、Migration適用時に保持中Rawを`minecraft_metric_rollups_5m`へBackfillする。

### TPS / MSPT

Minecraft標準Status ProtocolはTPS / MSPTを返さない。

そのため以下は行わない。

- Online人数やLatencyからTPS / MSPTを推定する
- 固定値を埋める
- Docker CPU使用率をTPSとして代用する
- RCON SecretをConsoleや履歴DBへ持ち込む

TPS / MSPTは、サーバー内部から正規の性能メトリクスを読み取る限定経路を実装した後に追加する。

## Host履歴

- Load Average 1分 / 5分 / 15分
- Memory使用率
- Disk使用率

Memory / Disk使用率はAgentが送信したTotalとAvailableからDB側で算出する。

## Docker履歴

- CPU使用率
- Memory使用率
- PIDs
- RestartCount
- Network RX / TX rate
- Block Read / Write rate

Docker CollectorのNetwork / Block値は累積Counterなので、連続Sample差分を経過秒数で割って`bytes/sec`へ変換する。

次の場合はrateを`null`として欠損扱いにする。

- 前回Sampleがない
- Sample間隔が1秒未満または120秒超
- Counterが取得できない
- 現在値が前回値より小さい

Counter resetを負の通信量として表示しない。

## 欠損値

監視データが存在しない区間を0として補完しない。

グラフは期待Bucket間隔を超えるGapで線を分割する。これにより「実際の0」と「未観測」を区別する。

## 状態期間Overlay

メトリクス背景にはStale / Offline / Error / Maintenance期間を表示する。

Minecraftグラフへ重ねるOverlayはMinecraft対象Hostと`ivrm-velocity` / `mc-main`だけに絞る。無関係なコンテナ障害をMinecraftメトリクスへ重ねない。

## 5分Rollup

テーブル:

```text
host_metric_rollups_5m
container_metric_rollups_5m
minecraft_metric_rollups_5m
```

用途:

- 7日 / 30日表示で15秒Rawを毎回全走査しない
- Raw Retention後も長期履歴を維持する
- 5分平均を30分 / 1時間へ再集約する

nullable metricはメトリクスごとの有効Sample件数を保存し、長期再集約では次の重み付き平均を使う。

```text
Σ(5分平均 × 有効Sample件数)
────────────────────────────
Σ(有効Sample件数)
```

MinecraftでもPublic / Backend Online人数・LatencyごとのSample件数を分ける。

## 増分更新

Supabase `pg_cron`で5分ごとに直近20分を再集約する。

```text
Job: ivrm-observability-rollup-5m
Cron: */5 * * * *
Entry: refresh_observability_rollups_v2
```

`refresh_observability_rollups_v2`はHost / Container / Minecraftを同一ジョブから更新する。既存Cronの名前と呼び出しシグネチャは変更しない。

遅延到着やBucket境界を吸収するため最新1Bucketだけでなく直近20分を冪等Upsertする。

## Retention

既定:

```text
Raw: 7日
5分Rollup: 90日
Batch: 50,000件
Cron: 6時間ごと
```

Raw削除は対応する5分Rollupが存在するSampleだけを対象にする。

- Container Raw → `container_metric_rollups_5m`確認
- Minecraft Raw → `minecraft_metric_rollups_5m`確認
- Heartbeat Raw → Host Rollup確認 + 子Sampleが残っていないことを確認

Host / Container / Minecraft Rollupは90日を超えたものからBounded Deleteする。

既存`run_observability_retention_v1()`の関数名・戻り値は互換維持し、Minecraft Rollup保護を内部追加する。Retention有効状態や既存CronをMigrationで無効化しない。

## Security

Rollup Tableは以下を満たす。

- RLS有効
- Force RLS有効
- `anon`直接アクセス不可
- `authenticated`直接アクセス不可
- `service_role`もTable直接権限なし

Console Serverから利用する読み取りRPC:

```text
get_host_metric_history_v3
get_container_metric_history_v3
get_minecraft_metric_history_v1
get_observability_retention_state_v2
```

内部更新HelperはService Roleから直接実行できない。

履歴へ以下を含めない。

- IPアドレス
- Secret
- Environment Variable
- RCON認証情報
- Docker Mount
- Command
- ログ本文
- プレイヤー名 / UUID / 個人識別情報

## 障害時確認

### Cron

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname in (
  'ivrm-observability-rollup-5m',
  'ivrm-observability-retention-v1'
)
order by jobname;
```

### 最新Rollup

```sql
select max(bucket_at) from public.host_metric_rollups_5m;
select max(bucket_at) from public.container_metric_rollups_5m;
select max(bucket_at) from public.minecraft_metric_rollups_5m;
```

### Minecraft Raw保護確認

```sql
select count(*)
from public.minecraft_samples as samples
where samples.received_at < statement_timestamp() - interval '7 days'
  and not exists (
    select 1
    from public.minecraft_metric_rollups_5m as rollups
    where rollups.host_id = samples.host_id
      and rollups.bucket_at = to_timestamp(
        floor(extract(epoch from samples.received_at) / 300) * 300
      )
  );
```

結果が0になることを確認してからRetentionを継続する。

### 手動再集約

DB管理経路から必要期間だけ正式入口を実行する。

```sql
select *
from public.refresh_observability_rollups_v2(
  statement_timestamp() - interval '1 hour',
  statement_timestamp()
);
```

最大45日を超える再集約要求は拒否する。
