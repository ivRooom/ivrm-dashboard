# 全システムTelemetry受信基盤（有効化前）

関連: dashboard #135 / #136 / #137 / #142、ivrm-contracts #17 / PR #18。

## 実装範囲

`POST /api/agent/telemetry` に送信元別HMAC署名、時刻制限、永続nonce、64KiB上限、契約Schema検証を追加する。既存Minecraft専用受信処理と署名形式を共有しない。送信元IDと本文producerIdを一致させる。

DBの送信元登録でservice/type/provider/host/resourceを固定し、イベント種別、actor情報、IPの取得根拠を個別に許可する。計画用source inventoryを自動で許可リストへ登録しない。IP取得だけで本人・攻撃・侵入成功と判断しない。

本文とactor表示名は既存の機密情報マスキング後に保存する。重複判定にはマスキング前イベントの正規化SHA-256、同一batchの比較には生本文SHA-256を使う。原文は保存しない。任意文字列に含まれるすべての機密情報を完全検出する保証はないため、送信側でも秘密情報を除外する。

イベント、受領結果、nonce、容量カウンターを単一トランザクションで保存した後にACKする。送信元単位の行ロックで複数Webインスタンス間の競合を防ぐ。保存障害は503、容量超過は429とし、未保存の成功応答を返さない。送信側の再送・ローカルspoolは別実装。

## 現在は有効化できない

契約bundleはPR #18のcandidateをrevisionとSHA-256で固定している。`releaseState=candidate` の間は環境変数だけで有効化できず404になる。DB migrationにも送信元の登録データは含まれない。本番DB適用、Secret登録、送信側設定、収集、S3保存は未実施。

## 保存と負荷の境界

既定値は送信元ごとに60要求/分、2,000新規イベント/分、累計10,000イベント・10,000batch・64MiBのイベントJSONである。物理DB容量には索引・行・受領結果・nonce等も加算されるため、64MiBはディスク使用量の保証ではない。nonceは10分間保存し、当該送信元の次回要求で期限切れを削除する。送信元の登録数は管理側で制限する必要がある。

アーカイブと削除処理は含まない。上限到達時は受信を停止し、自動削除しない。長期稼働の前に、送信側spool上限、再送期限、S3保存検証、アーカイブ済みデータ整理、カウンター整合性を実装・検証する必要がある。DBのstatement_timeout設定だけで実行時間の厳密な上限が保証されるとは扱わない。HTTP側は8秒で中断し、不明な結果は同一batchを新しいnonceで再送して照合する。

## 検証

`pnpm --filter @ivrm/web exec tsx --test ../../tests/telemetry-core.test.mjs` で実際の契約fixture、署名、拒否、マスキング、ACK境界を確認する。

DBテストは破棄可能なローカルPostgreSQLのみで実行する。`tests/telemetry-db-fixture.sql` とmigrationを適用し、`TELEMETRY_TEST_DATABASE_URL` にloopbackの `telemetry_test` DBを指定する。または `ivrm.task=telemetry-foundation` ラベル付き専用Dockerを `TELEMETRY_TEST_CONTAINER` で指定する。テストは実テーブルを変更するため本番へ接続しない。

実DBテストは同一batchの8並列送信、容量境界の8並列送信、途中INSERT障害の全件ロールバック、匿名・認証済み・service roleの権限を確認する。ローカルテストはPostgRESTの代わりにpsqlから同じRPC関数を実行するため、実PostgREST経由の確認は別途必要。

## Merge / Deploy / Rollback

- Producer: 各環境のcollector（未実装）。Consumer: dashboard受信API。Contract: operational-telemetry.v1 candidate。
- Merge順: contracts PR #18をレビュー後merge → dashboardの契約pinをmerged revisionへ更新 → dashboard基盤。collectorはその後。既存Minecraft APIには変更なし。
- Deploy順: 実容量・送信量・個人情報保持期間と費用見積りを提示 → 対象を限定したhuman approval → 本番migration → private source登録/Secret設定 → 受信側 → 1送信元で試験 → collectorを段階展開。
- Rollback: 収集側を停止し、受信flagを無効化する。既存APIを維持する。保存済み証跡は保持し、テーブルdropやデータ削除は行わない。migrationの逆適用はバックアップと別途承認が必要。
- Production DB、IAM、Secret、timer、flagや新規費用の承認はこのPRに含まれない。無料枠内であるとの判断もしていない。

残件: collector、ログ検索UI、S3定期保存、保持期間、エクスポート監査、通知設定、認証強化、全環境の操作アダプター。
