# 複数クラウドの常時監視・通知

Issue #120。クラウドの状態参照を、対話用MCP認証から独立したCollectorへ分離する。

## 適用承認と現状（2026-10-14）

ユーザー承認は「追加料金0円と確認できる範囲だけ本番適用」。費用データが取得できないことを0円の根拠にはしない。Vercelの契約・残枠確認、専用Collector認証、Discord Webhook設定が済むまで、本番移行・収集Timer・追加Cronは未適用。

Discordの指定先はサーバー`964326043420872704`、チャンネル`1042774690227306517`。IDだけでは配送できないため、同チャンネルのWebhookを秘密情報として設定し、配送先を確認する。Webhook URLはGit・ドキュメント・チャットへ記載しない。

Supabaseは確認時Free、DB約334MiB。Vercel請求APIは`costs_not_found`で、ブラウザの契約画面はログイン待ち。Discordもログイン待ち。ローカルの本番ビルド、JavaScript 13件、Python 12件、使い捨てPostgreSQLの状態遷移試験、ブラウザでの認証境界・PC/モバイル・自動更新試験は成功。本番の通知配送・継続稼働は未検証。

## 構成

```text
既存EC2 (ivrm-app-01)
  ├─ IVRM Agent → Host heartbeat
  └─ cloud-collector (非特権systemd oneshot / 5分間隔)
       ├─ AWS EC2 + Lightsail (既存Instance Roleの読み取り権限)
       ├─ OCI Compute (専用読み取りAPI key)
       ├─ Vercel / Netlify (専用トークン)
       ├─ Cloudflare DNS / Tunnel (専用読み取りトークン)
       └─ 明示許可したHTTPS外形監視
            ↓ HMAC + timestamp + nonce、状態コードのみ
       POST /api/agent/cloud
            ↓ service_roleはVercel内だけ
       cloud_monitor_targets / cloud_monitor_samples
            ├─ /cloud → 現在状態・未受信・認証失敗・収集停止
            └─ 既存notification_signal_state / notification_outbox
                 ↓ 既存通知Dispatcher → Discord
```

新規VMは作らない。既存EC2へAgentを登録することでEC2のゲストメモリ・ディスク・Heartbeatも既存Host画面へ収集できる。Lightsailのゲストメトリクスも必要な場合は同じ既存Agentを別IDで配置する。Cloud CollectorはProvider側の状態と公開HTTPSを担当し、ゲスト内メトリクスを推定しない。CI用の一時EC2はこの固定対象へ登録せず、別のfleet監視要件で管理する。

## 収集と判定

`deploy/cloud/targets.example.json` は10対象の初期案。ID・DNS期待値・URLは適用時にProviderから再確認する。

- EC2: instance stateとsystem/instance status checks。
- Lightsail / OCI: インスタンスのライフサイクル状態。
- Vercel / Netlify: 最新ビルドではなく公開中の本番deployment。過去の失敗ビルドだけで本番障害にしない。
- Cloudflare: ConsoleのDNSレコード内容・Proxy設定の一致、Runtime Tunnelの状態。
- HTTP: Console / ivmz-home / HertaのHTTPS到達性。任意URLのリモート入力は受け付けず、設定済みホストだけを対象にし、private IP・資格情報付きURL・非HTTPS・redirectを拒否する。
- 未設定・認証失敗・権限不足・応答不正は`error`/`unknown`。サービス停止と区別し、正常へ補完しない。
- 最新受信から900秒超は`stale`。Collectorが停止しても、独立したDB Cronが収集停止Signalを開く。
- 公開中deploymentが見つからなければ`unknown`。未観測から可用性率を算出しない。

クラウド内でリソースを作成・変更・再起動するAPIはCollectorに実装しない。通知理由は列挙したコードのみ。Provider応答・ログ本文・トークン・環境変数は送信も記録もしない。

## 認証と入力境界

既存Agent HMAC形式を使い、`kind=cloud-monitor-v1`と本文schemaで他のAgent APIから分離。16KiB / 50対象まで、±300秒・未来30秒、nonce replay、15秒の送信間隔を検証する。DBは全件を先に検証し、登録済み・有効・Collector ID一致の対象だけを原子的に更新する。古い観測は状態を巻き戻さない。

cloud系テーブルにRLSを有効化し、anon/authenticatedへ権限を与えない。CollectorへSupabase service_roleを渡さない。ブラウザにもProvider認証を渡さない。Console Session/RBACは既存Layout境界を継承する。

Cloud状態も既存の通知配送に接続するため、再送・チャネル無効化・global/signal/cloud抑制・同一Signalの配送順序を利用する。対象無効化では未配送を抑止し、偽の復旧通知を作らない。

## 適用前に必要なもの

1. 本番変更・追加利用量への明示承認。PR push時のGitHub CI / Vercel Previewも含め、無料枠と予算を確認する。
2. Terraform側でEC2 Instance Roleの`ec2:DescribeInstances`、`ec2:DescribeInstanceStatus`、`lightsail:GetInstance`を確認する。不足権限をアプリやMCPから直接追加しない。
3. OCIのComputeを対象範囲で参照できる専用API key、Cloudflare DNS/Tunnel読み取り、Vercel/Netlifyの対象Project/Site参照用トークン。対話用の管理者セッションや個人CLIの所有者トークンを常時処理へコピーしない。
4. 認証は秘密管理またはSSH経由で対象ホストの権限制限済みファイルへ設定。チャット・Issue・PRへ貼らない。Cloudflare OAuthのdns.writeは定期収集に不要。
5. `aws-app-01`として既存EC2にGo Agentを配置し、`hosts`登録とVercelのAgent secret mapへ既存値を保持して追加する。ランダムsecretを生成し、`agent.env`はivrm-agentだけが読めるようにする。
6. Supabaseの既存通知チャネルがenabled/configuredでDispatcher正常であること、宛先が意図する運用チャネルであることを確認する。テスト送信と通知開始は承認された適用時に行う。

## 配置・有効化

承認後に以下の順で適用する。各段階で失敗したら次の有効化へ進まない。

1. DB backup/rollback手順を確認し、`202610140001_cloud_monitoring.sql`を適用。テーブル・関数追加のみでCronは開始しない。
2. Webとnotification-dispatch Edge FunctionをPR/CI経由で配布。既存Host/Backup通知も回帰確認。
3. AgentのHeartbeat到着を確認後、`register-targets.sql`を適用。初期状態は全対象disabled。
4. Python 3.10以上のvenvを`/opt/ivrm-cloud-collector/venv`へ用意し、固定requirementsを導入。collector.pyを配置。
5. `cloud.env.example`とtargets JSONを`/etc/ivrm-agent/`へ配置。認証ファイルはroot所有・ivrm-agentグループ読み取り(0640)、ディレクトリ0750。systemdのProtectHomeによりhome配下の認証は使わず、OCI設定とkey_fileも`/etc/ivrm-agent/oci/`へ配置する。
6. `--dry-run`で10対象を確認。error/unknownがあれば認証/期待値を修正する。API読み取りも利用量が発生するので適用承認後に行う。
7. 対象のenabledをtrueへ更新し、最初の手動oneshotを実行。HMAC受信・DB保存・/cloud表示まで確認。
8. `enable-schedules.sql`を適用し、Collectorのtimerをenable/start。Dispatcherの既存スケジュールは変更しない。
9. 2周期分の受信・監視履歴・Cron成功を確認。承認済みのテスト対象で障害→復旧通知を検証し、本番を停止して試験しない。

systemd unitは`deploy/cloud/`を使用。Collectorユーザーをdockerグループへ追加せず、Docker socketを渡さない。既存OCIのMinecraft/Collectorを更新・再起動する必要はない。

## 追加利用量と費用承認

初期10対象・5分間隔・30日間の概算（画面閲覧・再送・テスト・異常時の追加分を除く）:

| 項目 | 追加利用量の目安 |
| --- | --- |
| 新規VM・既存VMのサイズ変更 | 0台 / 変更なし |
| Collector実行・Vercel取り込み | 約8,640回/月 |
| Provider API参照 | EC2約17,280、Lightsail/OCI/Vercel/Netlify各約8,640、Cloudflare約17,280回/月 |
| HTTPS外形監視 | 約25,920回/月 |
| DB観測履歴 | 約86,400行/月、7日保持で約20,160行＋index |
| DBの収集停止評価Cron | 約43,200回/月＋保持期間削除30回 |
| Discord配送 | 状態変化・重大化・復旧時のみ。正常継続時は送信なし |

Supabase組織は確認時free。Vercel/他Providerの契約・既存利用量・無料枠超過条件は適用時に再確認する。無料と断定せず、追加料金・予算上限が確定するまで本番Cron/Collectorを有効化しない。OCIリソースは増設せず原則無料枠を維持する。

## 無効化・復旧

- `systemctl disable --now ivrm-cloud-collector.timer`で新規収集を止める。実行中oneshotがあれば完了を確認する。
- `deploy/cloud/disable-schedules.sql`でcloud専用Cronだけ停止し、対象を無効化・未配送cloud通知を抑止する。既存Host/Container/Backup通知には触れない。
- Web/Edge Functionを前版へ戻す前にCloud対象を無効化し、cloud sourceのOutbox/signalを旧版から見えない状態へ退避する。旧版はcloud sourceを解釈できないため、DBだけ残したまま古いWebへ戻さない。
- DBテーブル・履歴は緊急削除せず保持して原因を調査する。認証漏えい時は該当Provider tokenとAgent secretをローテーションする。
- DB自体が停止するとDB内の通知も停止する。既存の外部監視経路と運用チャネルを残し、監視停止を別系統で検知する。

## 検証

`tests/cloud-monitor-core.test.mjs`、`apps/cloud-collector/test_collector.py`、`tests/cloud-monitor-db.sql`をCIで実行する。DBテストは使い捨てPostgreSQLだけに適用し、本番へfixtureを適用しない。
本番適用が終わるまでは「常時監視・通知が稼働済み」と報告しない。
