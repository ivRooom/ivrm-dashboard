# Service Reliability Center

`/reliability` は Host / Container / Backup / Notification を横断して現在HealthとIncident履歴から稼働品質を確認する画面です。

## 集計期間

- 24時間
- 7日
- 30日

## 指標

- Overall Health
- Active / Recovered Incident
- Known Downtime
- Incident-free ratio
- Median / Longest / Latest Recovery
- Affected Services

Known Downtimeは同時に発生したIncident区間をUnionして二重計上しません。開始時刻を構造化データから証明できないActive Incidentがある場合、Incident-free ratioは確定値ではなく上限値として`≤`を付けて表示します。

SLO目標値は現時点で未設定です。99.9%などの目標をアプリ側で仮定せず、実測できるIncident情報だけを表示します。

## Notification Delivery

Reliability CenterはNotification CenterのSummary RPCだけを読み込みます。Signals / Deliveries / Suppressionsの補助取得が失敗しても、Summaryが正常ならNotification Reliabilityを継続判定できます。

- Channel OFF: `Disabled`。意図した停止なので障害扱いしません。
- Channel ONかつ未設定: `Critical`
- Dispatcher未起動、または最終起動から3分超: `Critical`
- Channel / Dispatcher Error: `Critical`
- Pending / Retry / Failedあり: `Degraded`
- その他: `Operational`

Active Suppression数も表示し、通知が抑制されている状態を確認できます。

## データ欠損

BackupまたはNotificationのデータ取得に失敗した場合、取得できたサービスは継続表示します。欠損サービスは`Unknown`とし、SidebarでもOnline表示しません。

## セキュリティ

- `SUPABASE_SERVICE_ROLE_KEY`はServer側だけで使用します。
- Production Service Role KeyをVercel Previewへ配布しません。
- Secret、Player IP、raw log本文はReliabilityデータへ含めません。

## Production確認

PRマージ後は以下を確認します。

1. `/reliability?range=24h`
2. `/reliability?range=7d`
3. `/reliability?range=30d`
4. `/incidents`とのActive / Recovery整合性
5. `/notifications`とのDispatcher / Queue状態整合性
6. Backup Telemetry導入後のBackup Protection反映
