# 監視履歴・ロールアップ運用仕様

## 目的

`console.ivrm.jp/history`で、短期の詳細確認と長期の傾向確認を同じ画面から行えるようにする。

新しいSecretや外部時系列DBは使用せず、既存のSupabaseとAgent収集データだけを利用する。

## 表示期間

| range | 表示 | 集約粒度 | 取得元 |
| --- | --- | --- | --- |
| `1h` | 直近1時間 | 1分 | 生データ |
| `6h` | 直近6時間 | 2分 | 生データ |
| `24h` | 直近24時間 | 5分 | 生データ |
| `7d` | 直近7日 | 30分 | 5分ロールアップ |
| `30d` | 直近30日 | 1時間 | 5分ロールアップ |

Webから任意の時間数やBucket秒数を渡さない。許可する`range`は上記5種類だけとする。

## ホスト履歴

- Load Average 1分
- Load Average 5分
- Load Average 15分
- Memory使用率
- Disk使用率

Memory / Disk使用率はAgentが送信したTotalとAvailableからDB側で算出する。

## Docker履歴

- CPU使用率
- Memory使用率
- PIDs
- RestartCount
- Network RX rate
- Network TX rate
- Block Read rate
- Block Write rate

### Network / Block I/O

Docker Collectorが送信する値は累積Counterであるため、その値自体をグラフ化しない。

連続Sample間の差分を経過秒数で割り、`bytes/sec`へ変換する。

次の場合はrateを`null`として欠損扱いにする。

- 前回Sampleがない
- Sample間隔が1秒未満または120秒超
- Counterが取得できない
- 現在値が前回値より小さい

最後の条件はコンテナ再作成・再起動等によるCounter resetを負の通信量として表示しないためのもの。

## 欠損値

監視データが存在しない区間を0として補完しない。

グラフ側は期待Bucket間隔を超えるGapで線を分割する。

これにより次を区別する。

- 実際に0だった
- Collector / Agent / Network等でSampleがなかった
- 停止コンテナのリソース値が取得されなかった

## 5分ロールアップ

テーブル:

```text
host_metric_rollups_5m
container_metric_rollups_5m
```

用途:

- 7日 / 30日画面の読み取り負荷を下げる
- 長期表示で15秒Sampleを毎回全走査しない
- 将来のRetention導入前に長期履歴を保持できる基盤を用意する

Migration適用時に既存データを最大45日分Backfillする。

### 有効Sample件数

平均値が`null`になり得るメトリクスは、5分Bucketの総Sample数だけではなく、メトリクスごとの有効Sample件数も保存する。

例:

```text
cpu_sample_count
memory_sample_count
network_rx_sample_count
network_tx_sample_count
block_read_sample_count
block_write_sample_count
```

7日 / 30日の再集約では、5分平均を総Sample数で一律に重み付けしない。

```text
Σ(5分平均 × そのメトリクスの有効Sample件数)
──────────────────────────────────────────
Σ(そのメトリクスの有効Sample件数)
```

これにより、Counter resetや停止コンテナなどで一部Sampleだけが`null`だったBucketを過大評価しない。

## 増分更新

Supabase `pg_cron`で5分ごとに直近20分を再集約する。

Job名:

```text
ivrm-observability-rollup-5m
```

Cron:

```text
*/5 * * * *
```

遅延到着や実行タイミング境界を吸収するため、最新1Bucketだけではなく直近20分をUpsertする。

外部HTTP、API Token、Webhook、追加環境変数は使用しない。

## セキュリティ

ロールアップテーブルは以下を満たす。

- RLS有効
- Force RLS有効
- `anon`直接アクセス不可
- `authenticated`直接アクセス不可
- `service_role`もTable直接権限なし

取得・更新はSecurity Definer RPCに限定する。

Webバックエンドから利用するRPC:

```text
get_host_metric_history_v3
get_container_metric_history_v3
refresh_observability_rollups_v2
```

実行権限は`service_role`だけに付与する。

以下は内部Helperまたは旧実装としてService Roleから直接実行できない。

```text
refresh_observability_rollup_counts
refresh_observability_rollups
get_host_metric_history_v2
get_container_metric_history_v2
```

履歴へ以下は含めない。

- IPアドレス
- Secret
- Environment Variable
- RCON情報
- Docker Mount
- ログ本文
- プレイヤー情報

## Retention

本対応では生データを削除しない。

長期保持・自動削除は、ロールアップの継続動作と復旧手順を確認してから別Issueで導入する。

想定方針はIssue #12を正本とする。

## 障害時確認

### Cron

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'ivrm-observability-rollup-5m';
```

### 最新ロールアップ

```sql
select max(bucket_at)
from public.host_metric_rollups_5m;

select max(bucket_at)
from public.container_metric_rollups_5m;
```

### 手動再集約

必要な期間だけService Role相当の管理経路から正式入口を実行する。

```sql
select *
from public.refresh_observability_rollups_v2(
  statement_timestamp() - interval '1 hour',
  statement_timestamp()
);
```

最大45日を超える再集約要求は拒否される。
