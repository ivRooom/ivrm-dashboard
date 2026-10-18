# Telemetry送信待ちキュー（本番未導入）

関連: #135 / #142、受信側PR #147、ivrm-contracts PR #18。

## 範囲

`apps/telemetry-sender` は正規化済みbatchを永続キューへ入れて送る共通部品。Docker、systemd、OS認証、proxy、Vercel、Cloudflareのログを読み出すアダプター、読み取り位置checkpoint、timer、配布artifactは未実装。これだけで全システムの収集は始まらない。

受信側と同じrevision固定Schemaでenqueue時に検証する。SQLiteで原文byte列とbatch IDを固定してcommit後にqueuedを返す。送信時は毎回nonce/時刻/HMACを作り直す。200/202のSchema・batch ID・件数・replayedを検証したときだけ本文を解放し、重複比較用hashを保持する。応答不明や接続切断では同じ本文を再送する。これはat-least-once送信と受信側の冪等性の組み合わせであり、ネットワーク上のexactly-onceを保証するものではない。

同じDBを利用するプロセスはSQLite transactionと30秒leaseで送信権を取得する。leaseを取り直した後の古いworkerは結果を書き込めない。既定20試行、7日超過、恒久拒否でblockedへ移し、本文を保管する。429/503はRetry-Afterと指数backoff＋jitterを適用する。404は未有効化として再試行する。blockedの自動再開・削除は行わない。

## 使用条件

開発用Node 22.23.0で検証。`node:sqlite` はこのruntimeでExperimentalWarningが出るため、実ホスト向け配布の前にruntime固定・互換性検証が必要。Webアプリの起動から自動実行されない。現在は同repoのWeb契約validatorと開発用tsxを参照する準備段階。

以下はrepo rootからのローカル検証用。パスは絶対パスに置き換える。

```text
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts enqueue ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID ABSOLUTE_BATCH_JSON
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts status ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID
```

`send-once` の署名鍵は環境変数 `IVRM_TELEMETRY_PRODUCER_SECRET` から読む。引数やDBへ保存しない。送信先は `https://console.ivrm.jp/api/agent/telemetry` 固定、リダイレクト禁止、8秒timeout。契約pinがcandidateの間、公開送信関数は通信を始めず拒否する。テストだけは注入transportを利用し、本番HTTPへ接続しない。merged pinへの更新だけで運用開始してよいという意味ではなく、設置・Secret・起動は別途承認対象。

エラー出力は固定文字列のみ。statusはstateごとの件数・byte数・最古イベント時刻を返し、本文や送信元個人情報を出さない。blocked件数やoldestの監視・通知接続は次工程で、現時点ではdashboardに自動表示されない。

## 保全・容量・セキュリティ

- 送信前の本文をローカル保存する。送信元アダプターは**enqueue前に秘密情報を除外・マスキング**する必要がある。受信側のマスキングだけでローカル原文が消えることはない。鍵は本文に含めない。
- 専用ユーザーのローカルディスクを使う。最終directoryはPOSIX 0700、DBは0600。最終directory/DBのsymlink、DBのhardlinkを拒否する。親directoryは信頼された管理下に置く。Windows ACLの安全性はこの実装では検証しないため、本番Windows配備は未対応。
- SQLite DELETE journal / synchronous FULL。既定上限は送信完了・blockedを含む10,000batchと未解放本文64MiB。複数プロセスで上限を変えられないよう設定をDBへ固定する。設定変更はqueueを保持したmigrationが必要。
- DBは32,768page上限（新規4KiB pageなら128MiB）。journal・一時ファイル・filesystem overheadは別なので専用ディスクquotaと空き容量監視も必要。SQLiteは暗号化されない。ディスク暗号化とbackupの保持制御を運用で用意する。
- 上限では新規enqueueを拒否し、既存証跡を自動で追い出さない。呼び出し元はqueued確認前に読み取りcheckpointを進めない。失敗を捨てずに通知するアダプター実装が必要。
- 成功した本文の領域はSQLiteの空きpageに残り得る。NULL化は安全な消去を意味しない。重複台帳やblockedの保持期間・明示的整理・暗号化鍵の扱いは別工程で決める。

## 検証と導入順

`pnpm --filter @ivrm/web exec tsc --project ../telemetry-sender/tsconfig.json` と `pnpm --filter @ivrm/web exec tsx --test ../../tests/telemetry-spool.test.mjs` をCIで実行。

Producerは将来の各環境アダプター、consumerはdashboard受信API、Contractはoperational-telemetry.v1 candidate。PR #147をbaseとするstacked PRで、contracts→受信側のmerged pin更新/PR147→本PRの順にmergeする。既存Minecraft senderを置き換えない。

本番導入前に、アダプターのrotation/checkpoint、送信量・ディスク/DB/通信費、S3保全、blocked通知、保持期間、Linuxでのプロセスkill/ディスク満杯試験を追加する。対象を限定した承認後に1送信元から開始する。Rollbackはアダプター/送信timer停止、queue保全、受信側flag無効化。SQLite削除・証跡削除は行わない。本PRで本番配置・起動・Secret・課金変更は行っていない。
