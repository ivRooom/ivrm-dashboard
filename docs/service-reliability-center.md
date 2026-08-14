# Service Reliability Center

`/reliability` は Host / Container / Backup / Notification を横断して、Raw Incident、明示設定されたSLO、スコープ付き計画停止から稼働品質とError Budgetを確認する画面です。

## 集計期間

- 24時間
- 7日
- 30日

## Raw Reliability

基本指標は次のとおりです。

- Overall Health
- Active / Recovered Incident
- Raw Known Downtime
- Raw Incident-free ratio
- Median / Longest / Latest Recovery
- Affected Services

Raw Known Downtimeは同時に発生したIncident区間をUnionして二重計上しません。開始時刻を構造化データから証明できないActive Incidentがある場合、Incident-free ratioは確定値ではなく上限値として`≤`を付けて表示します。

**Maintenance WindowはRaw Incident / Raw Known Downtime / Raw Incident-free ratioを書き換えません。** 計画停止中に実際に起きたIncidentはReliability CenterとIncident Centerへ残ります。

## SLO Policy

SLO目標値はアプリ側で仮定しません。`reliability_slo_policies`へ明示設定されたTargetだけをError Budget計算へ使用します。

対象は次の4スコープです。

- Overall Reliability
- Host Platform
- Container Runtime
- Backup Protection

初期状態はすべて`target_percent = null`、`enabled = false`です。Migration適用だけで99.9%などの目標が勝手に有効になることはありません。

Notification Deliveryは、期間内に「配送されるべきだった通知」の完全な分母が現在のTelemetryだけでは証明できないため、SLO対象へ含めません。既存のNotification Health判定は継続します。

## Scoped Maintenance Window

Reliability v2 Phase 2では、計画停止をSLO計算から除外するための`reliability_maintenance_windows`を追加します。

Maintenance Windowは次の4種類のScopeを持ちます。

- `service`: Overall / Host / Container / Backupのサービス単位
- `host`: 対象Hostと、そのHost上のContainer / Backup Incident
- `container`: 対象Host上の特定Container Incidentのみ
- `backup`: Host + Backup Target + Game Mode + Backup Typeが一致するIncidentのみ

`service=overall`は全SLO対象Incidentへ適用される最も広いScopeです。Host Scopeも配下Container / Backupへ適用されるため、UIでは広いScopeとして注意を表示します。

### SLO停止時間の計算

単純な`Raw Downtime - Maintenance Window総時間`では計算しません。次の順序でIncident単位に処理します。

1. Incident区間を選択期間へclipする
2. そのIncidentへ適用されるMaintenance Windowだけ抽出する
3. `Incident ∩ Applicable Maintenance`の区間だけIncidentから除外する
4. 各Incidentに残った区間をすべてUnionする
5. Union後の時間を`SLO-counted Downtime`とする

```text
Raw Incident intervals
  - applicable maintenance intersections
  -> remaining incident intervals
  -> union
  -> SLO-counted Downtime
```

この順序にすることで、例えばHost Aの計画停止中にHost Bで同時発生した実障害を誤ってSLOから除外しません。重複するIncidentや重複するMaintenance Windowも二重控除しません。

画面では各SLOについて以下を並べて表示します。

- Raw Downtime
- Maintenance Excluded
- SLO-counted Downtime

### 取消

Maintenance Windowの取消は削除ではなく`cancelled_at`を記録します。SLO除外の有効終了時刻は次の早い方です。

```text
effective end = min(ends_at, cancelled_at)
```

そのため、取消前まで既に実施された計画停止は履歴として保持し、取消後の時間だけ除外対象から外れます。

### 後付け禁止

発生済み障害を後からMaintenance扱いにしてSLOを書き換えることを防ぐため、新規Windowの開始時刻は原則として現在以降だけを許可します。HTTP処理やUI操作の時刻差として5分だけ過去を許容します。

- 開始: 現在 - 5分以降
- 最大予約: 365日先
- 1 Windowの最大長: 7日

既存Windowの開始・終了時刻やScopeを直接UPDATEする権限はService Roleにも付与しません。変更が必要な場合は取消して新しいWindowを登録します。

### 既存Operational Maintenanceとの違い

`container_expectations.maintenance_mode`は監視・運用上のContainer Maintenance状態です。`reliability_maintenance_windows`はSLO計算上の計画停止です。

この2つは自動同期しません。SLO Maintenanceを作成しただけでContainer監視を抑制したり、Container Maintenanceを開始しただけでSLO除外を発生させたりしません。

既存監視でMaintenance中でもCritical扱いするSignalなどの運用ルールはそのまま維持されます。

## Error Budget

選択期間の許容停止時間は次の式で計算します。

```text
allowed downtime = range seconds × (1 - SLO target / 100)
```

Budget BurnはRaw DowntimeではなくSLO-counted Downtimeで計算します。

```text
budget burn = SLO-counted downtime / allowed downtime
```

- `1.00x`未満: Budget内。ただしCoverageが不完全な場合は確定扱いしません。
- `1.00x`以上: KnownなSLO-counted DowntimeだけでBudget超過を証明できます。
- Budget Usedは`budget burn × 100`です。

開始時刻不明のActive Incidentがある場合、未知Downtimeを0秒として正常扱いしません。

- Observed Availability: `≤` 表示値
- Budget Used: `≥` 表示値
- Budget Burn: `≥` 表示値
- Remaining Budget: `≤` 表示値

SLO PolicyまたはMaintenance Windowの取得に失敗した場合も0件と仮定せず、設定済みSLOカードを`Data unavailable`にします。Raw Reliabilityは継続表示します。

## SLO Policy管理

Administrator以上のConsole RoleだけがReliability画面からSLO Policyを変更できます。

更新APIは`POST /api/reliability/slo`です。

- 同一OriginのPOSTのみ許可
- Server側でConsole Sessionを再検証
- `administrator`以上が必要
- serviceId Allowlist
- Targetは`0 < target < 100`、小数4桁以内
- SLOを有効にする場合はTarget必須
- Service Role KeyはServer側だけで使用

Policy更新は`update_reliability_slo_policy_v2` RPCを使用し、更新と`append_audit_log()`へのHash chain監査ログ追加を同一トランザクションで行います。Service RoleからもPolicy Tableの直接UPDATE権限は剥奪しています。

## Maintenance Window管理

Administrator以上だけがReliability画面からWindowを登録・取消できます。

APIは`POST /api/reliability/maintenance`です。

- Same-Origin POST
- Server側Console Session再検証
- Administrator / Ownerのみ
- request body上限8 KiB
- Scope / TargetをServerとDBの双方で検証
- datetime-localはJSTとして明示的に解釈
- 理由は1〜200文字
- SLO計算だけから除外することへの明示確認checkboxが必須
- 過去5分より前の後付け登録を拒否
- 最大7日 / 最大365日先

Mutationは次の監査付きRPCだけを許可します。

- `create_reliability_maintenance_window_v1`
- `cancel_reliability_maintenance_window_v1`

TableはServer-side Service RoleからSELECTできますが、INSERT / UPDATE / DELETEはできません。作成・取消とHash chain監査ログは同一DBトランザクションです。

監査主体は認証方式に応じて追跡します。

- Email / Cloudflare系Session: `actor_email`
- Discord Session: `metadata.discordUserId`

自由入力Reasonは監査Metadataへ複製せず、Window本体にだけ保存します。監査MetadataにはScope、対象識別子、開始・終了・取消時刻を保存します。

## Auto Refresh / UX

Reliability画面は30秒ごとに更新します。ただしInput / Textarea / Select / contenteditableへフォーカス中、またはブラウザタブが非表示の場合は共通`AutoRefresh`が更新をスキップします。

Maintenanceフォームも44px以上の操作領域、明示label、focus-visible、モバイル1カラムを維持します。

## Notification Delivery

Reliability CenterはNotification CenterのSummary RPCだけを読み込みます。Signals / Deliveries / Suppressionsの補助取得が失敗しても、Summaryが正常ならNotification Reliabilityを継続判定できます。

1. Channel OFF: `Disabled`
2. Channel ONで未設定、Channel / Dispatcher Error、Dispatcher未起動または最終起動から3分超、配送失敗あり: `Critical`
3. Pending / Retryあり: `Degraded`
4. 上記以外: `Operational`

## データ欠損

- Backup取得失敗: Backup Raw Reliabilityを`Unknown`
- Notification取得失敗: Notification Raw Reliabilityを`Unknown`
- SLO Policy取得失敗: SLOカードを`Data unavailable`
- Maintenance Window取得失敗: 計画停止を0件と仮定せず、設定済みSLOカードを`Data unavailable`
- Maintenance Target Catalog取得失敗: 既存Window表示・取消は継続し、新規作成フォームだけ無効化

## Database

Migrations:

- `202608140001_reliability_slo_policies.sql`
- `202608140002_reliability_slo_audited_update.sql`
- `202608140003_reliability_slo_discord_audit_identity.sql`
- `202608140004_reliability_scoped_maintenance_windows.sql`

`reliability_maintenance_windows`はRLS / FORCE RLSを有効化し、`anon` / `authenticated` / Service Roleの直接Mutation権限を付与しません。Service RoleはSELECTと監査付きCreate/Cancel RPC実行だけを許可します。

## セキュリティ

- `SUPABASE_SERVICE_ROLE_KEY`はServer側だけで使用
- Production Service Role KeyをVercel Previewへ配布しない
- Secret、Player IP、raw log本文をReliabilityデータへ含めない
- Same-Origin + Administrator Roleの二重検証
- Scope / Target / Timestamp / ReasonをServer・DB両方で検証
- DB MutationはHash chain監査付きRPCで原子的に記録
- EmailまたはDiscord User IDの監査主体を必須化
- 過去障害への恣意的な後付けMaintenance登録を拒否

## Production確認

PRマージ後は以下を確認します。

1. `/reliability?range=24h` / `7d` / `30d`
2. Raw Known DowntimeがMaintenance登録前後で変わらないこと
3. 対象IncidentとMaintenanceが重なる部分だけ`Maintenance Excluded`へ反映されること
4. 別Host / 別Container / 別Backupの同時障害が除外されないこと
5. 重複Maintenance Windowでも二重控除されないこと
6. Window取消後は`cancelled_at`以降が除外されないこと
7. 過去5分より前のWindow作成がServer / DBで拒否されること
8. Viewer / Operatorでは作成UI非表示、API直接POSTも403になること
9. Create / CancelとHash chain Auditが対になること
10. Discord管理者操作で`metadata.discordUserId`が記録されること
11. Maintenance取得障害時に設定済みSLOが`Data unavailable`となること
12. SLO未設定時にTargetを推測しないこと
13. Coverage不完全時の`≤` / `≥`表示
14. `/incidents`とのRaw Active / Recovery / Known Downtime整合性
15. `/notifications`とのDispatcher / Queue状態整合性
