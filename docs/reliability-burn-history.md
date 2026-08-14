# Reliability Burn Rate History / Reconciler Health

## 目的

Reliability v2 Phase 4では、Phase 3で導入した1h / 6h / 24h Burn Rateの現在値に加えて、次を運用画面から確認できるようにします。

- Burn Rateがいつ悪化したか
- Coverage欠損がいつ発生したか
- 1分Burn Reconcilerが現在も正常に動いているか

履歴は**観測用**です。Alert判定のSource of Truthは引き続きUnified Incident / Scoped Maintenanceから毎回計算する現在値であり、履歴テーブルからAlertを再計算しません。

## Reconciler Health

`get_reliability_burn_reconcile_state_v1()`の状態をReliability Centerへ表示します。

判定:

- `disabled`: Reconcilerが明示停止
- `critical`: Endpoint未設定、最新実行失敗、または最終成功から3分超
- `degraded`: 初回成功待ち、または最終成功/起動から2分超
- `operational`: 1分Cronが鮮度範囲内で成功
- `unknown`: 状態取得または基準時刻を確定できない

表示項目:

- Enabled
- Endpoint configured
- Last success
- Last invoked
- Evaluated service count
- Last error

Reconciler状態取得に失敗しても、Raw Reliability / SLO / Burn Rate現在値は継続表示します。

## 履歴保存

テーブル:

```text
reliability_burn_rate_samples_5m
```

1分ごとのReconcile結果をそのまま全件保存せず、サービスごとに5分バケットへ圧縮します。同一5分内では、短いFast BurnやCoverage欠損を後続Healthyで消さないよう安全側に統合します。

- Burn Rate: 1h / 6h / 24hそれぞれ最大値
- state: `critical > warning > data_unavailable > coverage_unknown > healthy > unconfigured` のWorst状態
- exact coverage: logical AND
- downtime: 最大値
- target_percent: 最新観測値
- observed_at: 最新観測時刻

保存対象:

- service_id
- state
- target_percent
- 1h / 6h / 24h Burn Rate
- 各Windowのexact coverage
- SLO-counted downtime
- Maintenance excluded downtime

保持期間は30日です。履歴保存RPCの実行時に30日より古いバケットを削除します。

## 表示粒度

選択期間に応じて読み出し時だけ集約します。

```text
24h -> 5分
7d  -> 30分
30d -> 120分
```

長期間表示でDOM/SVG点数が無制限に増えないようにしています。

表示集約でも各バケット内の最大Burn Rateを採用し、短時間の悪化を平均化で隠しません。Coverageは`bool_and`で集約し、1つでも不完全なサンプルがあれば確定Coverageとして線を接続しません。SLO Targetは最大値ではなく、その表示バケットで最後に観測したPolicy値を表示します。

状態は安全側に次の優先順位で集約します。

```text
critical
warning
data_unavailable
coverage_unknown
healthy
unconfigured
```

## グラフの意味

Reliability Centerのグラフは1h / 6h / 24hを別系列として表示します。

- exact coverageの点だけを線で接続
- 欠損区間をまたいで補間しない
- inexact値は最新値表示では`>=`相当として扱う
- SLO未設定時はBurn値を捏造せず、状態履歴だけを保持

これにより「Telemetryが欠けている期間」を正常なBurn 0xのように見せません。

## Fail-soft

履歴記録はAlert lifecycleと分離します。

```text
Burn Snapshot計算
  |-- Durable Signal評価 / 更新  <- primary
  `-- 5分履歴Upsert              <- observational
```

履歴RPCが失敗した場合:

- Reconcile APIはAlert評価を続行
- Durable Signalを勝手にRecoveryしない
- `historyRecorded=false`をReconcileレスポンスへ返す
- サーバーログへ履歴失敗を記録
- Reconciler自体の成功/失敗はAlert評価結果を基準に記録

履歴障害によって通知機能そのものを停止させません。

## Security

`reliability_burn_rate_samples_5m`はServer-onlyです。

- RLS enabled
- FORCE RLS
- Service Roleでも直接SELECT不可
- Service Roleはrecord/list RPCだけ実行可能
- anon/authenticatedはrecord/list不可
- Secret、Token、Webhook URL、生ログ、Player IPを保存しない

書き込みRPCは次を検証します。

- 4サービスが1件ずつ存在
- service/state enum
- target範囲
- Burn Rate範囲
- downtimeのWindow上限
- observed_atが現在時刻から大きく逸脱していない

## Retention

初期保持期間は30日です。

Phase 4では履歴記録時のpruneで実装します。将来Reconcilerを長期間停止するケースや、履歴保存頻度を変更する場合は、既存Issue #12のRetention Jobへ統合するのが次の候補です。

## Production rollout

Migration 008〜010はアプリより先に適用可能です。mainのPhase 3 Reconcilerはrecord RPCを呼ばないため、Migration適用だけでは履歴行は生成されません。

Phase 4マージ後:

1. Production VercelがREADYであることを確認
2. 1分Reconcilerが引き続き成功していることを確認
3. 5分以内に4サービス分の履歴バケットが生成されることを確認
4. `/reliability?range=24h#burn-observability`でReconciler HealthがOperationalになることを確認
5. SLO未設定ならBurn値が`—`のまま状態履歴だけ記録されることを確認
6. SLO TargetやIncidentをテスト目的で捏造しない
