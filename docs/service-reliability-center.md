# Service Reliability Center

`/reliability` は Host / Container / Backup / Notification を横断して現在Health、Incident履歴、明示設定されたSLOから稼働品質とError Budgetを確認する画面です。

## 集計期間

- 24時間
- 7日
- 30日

## 基本指標

- Overall Health
- Active / Recovered Incident
- Known Downtime
- Incident-free ratio
- Median / Longest / Latest Recovery
- Affected Services

Known Downtimeは同時に発生したIncident区間をUnionして二重計上しません。開始時刻を構造化データから証明できないActive Incidentがある場合、Incident-free ratioは確定値ではなく上限値として`≤`を付けて表示します。

## SLO Policy

SLO目標値はアプリ側で仮定しません。`reliability_slo_policies`へ明示設定されたTargetだけをError Budget計算へ使用します。

対象は次の4スコープです。

- Overall Reliability
- Host Platform
- Container Runtime
- Backup Protection

初期状態はすべて`target_percent = null`、`enabled = false`です。Migration適用だけで99.9%などの目標が勝手に有効になることはありません。

Notification Deliveryは、期間内に「配送されるべきだった通知」の完全な分母が現在のTelemetryだけでは証明できないため、SLO対象へ含めません。既存のNotification Health判定は継続します。

## Error Budget

選択期間の許容停止時間は次の式で計算します。

```text
allowed downtime = range seconds × (1 - SLO target / 100)
```

Budget Burnは次の式です。

```text
budget burn = known downtime / allowed downtime
```

- `1.00x`未満: Budget内。ただしCoverageが不完全な場合は確定扱いしません。
- `1.00x`以上: Known DowntimeだけでBudget超過を証明できます。
- Budget Usedは`budget burn × 100`です。

開始時刻不明のActive Incidentがある場合、未知Downtimeを0秒として正常扱いしません。表示は次のように不確実性を明示します。

- Observed Availability: `≤` 表示値
- Budget Used: `≥` 表示値
- Budget Burn: `≥` 表示値
- Remaining Budget: `≤` 表示値

これにより、欠損Telemetryから「SLO達成」と誤判定することを避けます。

## SLO Policy管理

Administrator以上のConsole RoleだけがReliability画面からSLO Policyを変更できます。

更新APIは`POST /api/reliability/slo`です。

- 同一OriginのPOSTのみ許可
- Server側でConsole Sessionを再検証
- `administrator`以上が必要
- 対象serviceIdをAllowlist検証
- Targetは`0 < target < 100`、小数4桁以内
- SLOを有効にする場合はTarget必須
- Service Role KeyはServer側だけで使用

30秒の自動更新によって入力途中のPolicy Editorが消えないよう、共通`AutoRefresh`はInput / Textarea / Select / contenteditableへフォーカス中、または非表示タブでは更新をスキップします。

## Maintenanceの扱い

既存Incident Centerが持つメンテナンス考慮ロジックはそのまま利用します。

一方、任意の「サービス横断Maintenance Window」を後から単純にKnown Downtimeから差し引く処理は実装していません。スコープの異なるMaintenanceを無条件に差し引くと、別サービスで同時発生した実障害までSLOから除外する危険があるためです。

将来のMaintenance Window対応では、少なくとも次のスコープを明示してからIncident区間とのIntersectionを計算します。

- service
- host
- container
- backup target

## Notification Delivery

Reliability CenterはNotification CenterのSummary RPCだけを読み込みます。Signals / Deliveries / Suppressionsの補助取得が失敗しても、Summaryが正常ならNotification Reliabilityを継続判定できます。

状態は次の優先順で評価します。

1. Channel OFF: `Disabled`。意図した停止なので障害扱いしません。
2. Channel ONで未設定、Channel / Dispatcher Error、Dispatcher未起動または最終起動から3分超、配送失敗あり: `Critical`
3. Pending / Retryあり: `Degraded`
4. 上記以外: `Operational`

Active Suppression数も表示し、通知が抑制されている状態を確認できます。

## データ欠損

BackupまたはNotificationのデータ取得に失敗した場合、取得できたサービスは継続表示します。欠損サービスは`Unknown`とし、SidebarでもOnline表示しません。

SLO Policyの取得だけに失敗した場合、既存Reliability指標は継続表示し、SLO / Error Budgetだけを未設定または取得不可として扱います。

## Database

Migration:

- `202608140001_reliability_slo_policies.sql`

`reliability_slo_policies`はRLSを有効化し、`anon` / `authenticated`のTable権限を剥奪します。読み書きはServer-side Service Roleだけに限定します。

## セキュリティ

- `SUPABASE_SERVICE_ROLE_KEY`はServer側だけで使用します。
- Production Service Role KeyをVercel Previewへ配布しません。
- Secret、Player IP、raw log本文はReliabilityデータへ含めません。
- SLO Policy更新はSame-Origin + Administrator Roleの二重検証を行います。

## Production確認

PRマージ後は以下を確認します。

1. `/reliability?range=24h`
2. `/reliability?range=7d`
3. `/reliability?range=30d`
4. SLO未設定時にTargetを推測しないこと
5. AdministratorでPolicyを設定・無効化できること
6. Viewer / OperatorではPolicy Editorが表示されず、API直接POSTも403になること
7. `/incidents`とのActive / Recovery / Known Downtime整合性
8. Coverage不完全時の`≤` / `≥`表示
9. `/notifications`とのDispatcher / Queue状態整合性
10. Backup Telemetry導入後のBackup Protection反映
