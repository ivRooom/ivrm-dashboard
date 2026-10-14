# サービス単位の監視・操作

Tracking: [Issue #127](https://github.com/ivRooom/ivrm-dashboard/issues/127)。操作基盤の既存範囲は #68、Minecraftの復元・停止受け入れは #117 を参照する。

## サービスと実行基盤

`apps/web/lib/service-catalog.ts` がレビュー対象の対応表。DNSだけでコンテナ名を推測せず、実ホストのコンテナ一覧とCaddyルーティングを照合する。

| サービス | 実行基盤 | 主なコンテナ |
| --- | --- | --- |
| mc.ivrm.jp | OCI / oci-minecraft-01 | mc-main, ivrm-velocity |
| status.ivrm.jp | OCI / oci-minecraft-01 | ivrm-status-api, caddy |
| member.ivrm.jp | EC2 / aws-app-01 | ivrm-member, ivrm-api |
| admin.ivrm.jp | EC2 / aws-app-01 | ivrm-admin, ivrm-api |
| herta.ivrm.jp | Lightsail / lightsail-herta（Agent接続予定ID） | herta-api-1, herta-studio-1, herta-worker-1, herta-bot-1 |
| ivrm.jp | EC2 / aws-app-01 | ivrm-home |
| api.ivrm.jp | EC2 / aws-app-01 | ivrm-api |
| console.ivrm.jp | Vercel | マネージド |
| ivmz.ivrm.jp | Netlify | マネージド |

EC2の共通依存はTunnelとCaddy。HertaはPostgres・Redis・Caddy・nginxも対象。完了済みmigratorや停止予定のmc-resourceを稼働必須に含めない。未分類のコンテナは削除・再起動せず、所有関係を別途確認する。

`/services` は既存のサーバー側監視データを統合する。取得失敗、未登録、未受信、無効な監視から正常を作らない。一つでも異常があれば要確認、必須情報が欠ける場合は監視未完了。Minecraftは既存のTCP・Backend Probeを利用する。EC2/Lightsailのコンテナ収集や追加HTTP監視が未導入の間、その項目を未受信として表示する。

## 追加収集の容量設計

追加の18コンテナを既存の30秒間隔・7日保持へ無条件に加えない。2026-10-15の参照結果ではDB約353MB、container_samples約94MB/16.5万行。1行あたりのテーブル・インデックス使用量を約569Bとすると、追加18対象×2,880回/日×7日＝362,880行、約206MB増となり、現契約のDB枠を超える見込み。

次の変更では最新状態をhost/container単位の固定行へupsertし、追加対象の履歴は5分間隔・7日保持へ分離する案を検証する。履歴36,288行は概算約21MBだが、実スキーマ・インデックス・VACUUM・既存集計・egressの余裕も確認する。既存OCI履歴を削除して空きを作らない。既存収集の鮮度や通知を壊さない。

## Runtime Inventoryの実装

履歴方式を増やす前に、最新状態だけを保存する経路を追加した。

- `apps/runtime-collector/snapshot.py`: 固定3ホスト・21コンテナだけをローカルDocker socketから参照する。Docker側で状態・health・restart・OOM・exit code・image・local image IDへ射影し、環境変数や任意ラベルを取得しない。完了済みmigratorと停止予定mc-resourceは必須対象から除外する。
- `report.py`: Docker権限のないivrm-agentユーザーで、rootが書き出した最大32KiBの正規化JSONだけを読む。120秒を超えるファイルは送らず、送信先はConsoleの固定HTTPS URL。HMACとnonceで署名し、redirectを拒否する。
- `/api/agent/runtime`: 32KiB制限、既存Agent HMAC、ホストごとの全対象リスト、数値範囲、秘密情報など余分なフィールドの拒否。default offの`IVRM_RUNTIME_INVENTORY_ENABLED=true`でのみ有効。
- `runtime_inventory`: RLS + Force RLS。public/anon/authenticatedはアクセス不可。service_roleも必要列のSELECTと専用RPCだけ。ホスト行ロック内で単調な観測時刻・nonce・15秒rate limitを確認し、ホストごとに最新1行をupsertする。許可ホスト3個のため履歴行数が増えない。
- `/services`: 既存AgentのサンプルがないコンテナについてRuntime Inventoryを表示する。15分以上の観測・受信停止を正常としない。配備イメージの詳細を開ける。local image IDはECR/GHCRのmanifest digestとは別物として表示する。

3ホストでsnapshotをSSH標準入力経由で一度ずつ実行し、21対象を参照できた。常駐ファイル・Timerの配備、DB migration、本番flagは未適用。CPU/RAM/ネットワークの新しい時系列収集や、Runtime Inventory由来の新規通知はまだ含まない。既存OCIのメトリクス・通知はそのまま利用する。

### 本番適用前の確認

1. migrationをレビュー・テストする。existingのhosts/heartbeat/履歴やFeedを削除しない。
2. `runtime_inventory_host_scope` migration後、3ホストの`runtime_inventory_enabled=true`を個別に設定する。Lightsailの`lightsail-herta`はlegacy Heartbeat監視の`enabled=false`を維持し、5分Runtime収集だけ登録する。ivrm-agent専用ユーザー・権限制限した`/etc/ivrm-agent/runtime.env`を準備する。Vercelの`IVRM_RUNTIME_HERTA_SECRET`はRuntime APIだけで使い、既存Agent用Secret mapを変更しない。Herta専用drop-in（ivrm-runtime-herta.conf）でEnvironmentFileを切り替える。既存aws/ociのキーは既存の範囲で再利用し、ブラウザ・Git・ログへ出さない。
3. `/opt/ivrm-runtime-collector`へPythonスクリプト2個をroot所有で配置。ivrm-runtime.confのtmpfiles定義で`/run/ivrm-agent`をroot:ivrm-agent/0750として作成する（既存OCIも同じ所有・権限）。ivrm-agentグループを準備し、既存のサービス設定を上書きしない。root snapshotは64MiB/CPU10%、送信側も64MiB/CPU10%。Docker socketを送信ユーザーへ渡さない。
4. `deploy/runtime/`のtemplate unitを配置するが、まずTimerは無効のままにする。既存MinecraftやHertaを再起動しない。
5. 既存契約と集計使用量から追加料金0円を確認後、API flag→手動1回の受け入れ→5分Timerの順で有効化する。3ホスト×月8,640回＝月25,920回のAPIリクエスト増。DBは3行だが、API・DB更新・egress・既存サービスの合計枠とVACUUM余裕を確認する。固定料金のVMを増設する変更はない。
6. OCIは無料枠の資格・既存利用量を再確認する。追加費用が不明なままTimerを有効化しない。

既存OCI Operation Workerの待機時claimが5秒の場合、専用`operation-poll.env`と`ivrm-operation-worker-idle.conf`のdrop-inで30秒へ調整する。既存Secretやexecution gateを編集しない。30日あたり最大518,400→86,400リクエストとなり、新しいRuntime収集25,920回を加えても差し引き約406,080回減る。実行中のIPC結果確認（250ms）と225秒timeout/300秒leaseは変えない。適用前にDBのactive job=0とIPCのrequest/state/resultが空であることを確認し、Workerだけを再起動する。Minecraft・既存Agentは再起動しない。操作開始待ちは通常最大30秒程度になる。戻す場合は追加drop-inとpoll.envだけを除去しWorkerを再起動する。

ロールバックは3つの`ivrm-runtime-report@<server-id>.timer`を無効化して停止し、API flagを外す。既存Agent・Collector・Minecraft・Hertaは止めない。新テーブルは残しても3行が上限で、復旧のために削除を必要としない。

## Status CMSの編集入口

Adminの本番画面でOwner/AdminのIncident/Maintenance/Announcement作成・公開・更新/Archive UIとread modelの読み込みを確認した（投稿は実行しない）。稼働中ivrm-apiのSupabase hostnameはConsoleと同じ`drazbrcqnjxjuygfxmlz.supabase.co`。APIの実装は同じ`create/publish/archive_status_announcement_v1`等のRPCを使う。

OCIのstatus.ivrm.jpはCaddyが静的サイトを配信し、公開APIをivrm-status-apiへreverse proxyする。稼働イメージのsource commitにあるデフォルトFeedは`https://console.ivrm.jp/api/public/status-feed`で、コンテナにoverrideはない。したがってConsoleの公開FeedやDBを削除しない。

編集入口は`https://admin.ivrm.jp/status`、Consoleはread modelと監視・通知の参照に寄せた。旧Consoleフォームはdefault off、`IVRM_STATUS_LEGACY_EDITOR_ENABLED=true`で元のRBACのまま復帰できる。既存mutation APIとDBの互換性は維持する。APIの完全廃止やRPCの所有リポジトリ一本化は別変更として扱う。

### イメージ配布の照合

EC2のWeb系5イメージはECR、Hertaとstatus-apiはGHCR。adminの実Docker RepoDigestとECRの同じコミットタグのmanifest digestが一致することを確認した。ECRのadmin/api/home/memberはIMMUTABLE、contactはMUTABLEであり、タグだけで将来のイメージ同一性を判断しない。ECRをpull/build/pushしたりscanを新規開始したりはしていない。

## 操作拡張の境界

既存のMinecraft操作はDiscord認証・RBAC・Origin/Host検証・Idempotency・Lease・排他・監査・実行側Gateを持つ。サービスのリンク追加を実行可能な操作の追加と扱わない。

次の実装で必要な契約:

- サーバー側のservice/host/container対応表から対象を決める。ブラウザ入力をShellやDockerの引数へ直接流さない。
- 参照診断は状態、リソース、制限されたredact済みログを構造化して返す。環境変数やフルinspectを返さない。
- 変更操作は対象・影響範囲・要求者・確認・費用承認・期限・結果を監査する。権限や期限が変われば再判定する。
- 共通依存（API/Tunnel/DB等）を再起動する場合、影響するサービスを提示する。
- サーバー起動やサイズ・構成変更は料金発生の可能性を判定し、事前承認なしで実行しない。承認できた具体的リソースと条件だけに適用する。
- 停止/再起動はバックアップと復旧方法を確認する。本番の停止を動作確認目的で自動実行しない。
- 任意Shellを必要とする場合は、既存の固定操作キューと分離した権限・短期セッション・出力制限・秘密情報の扱いを設計する。現状は未実装。

Runtime Inventoryのコードと配備定義を追加したが、本番取り込み・Timerは未接続。汎用のサーバー操作も未接続であり、Issue #127を完了扱いにしない。ivrm-statusにはops-gateの固定操作・SSM文書定義もあるが、実AWSでは専用SSM文書が見つからない。EC2とLightsailはSSM Online、OCIは既存のMinecraft worker経路を維持する。別の操作ゲートを重複作成する前に既存契約と統合する。

## 検証とロールバック

`node --experimental-strip-types --test tests/service-catalog.test.mjs tests/runtime-inventory-core.test.mjs`、Python unittest 6件、`pnpm typecheck`、`pnpm build`を実行。使い捨てPostgreSQL 17でmigrationとDBのスコープ・再送・rate limit・権限・最新1行制約を検証した。3実ホストでsnapshot参照に成功。ローカルでデータ取得不可時に9サービスが未確認となり、390px viewportでも横方向overflowなし（clientWidth/scrollWidthとも375px）。Status CenterのAdminリンクと旧フォーム非表示を確認。正常なRuntimeデータを含むUIと本番取り込みの受け入れ検証は別途必要。

WebはPRをrevertしてロールバックできる。新しいmigration・常駐処理はまだ本番未適用。Runtime Inventoryのロールアウト/停止手順は上記を参照。
