# Backup Center

## 目的

仕様: [Backup Age一時停止](backup-age-pause-spec.md)。運用・変更・復元:
[バックアップ運用手順](runbooks/minecraft-backup-operations.md)、
[隔離復元手順](runbooks/minecraft-backup-restore.md)。
準備済みコードと本番への適用状態は[実装引継ぎ](backup-age-pause-handoff.md)で区別する。

IVRM Consoleの`/backups`で、Minecraft系バックアップの鮮度・成否・整合性・Remote Sync・Retention・Restore Testを読み取り専用で確認する。

Backup Centerはバックアップを実行・削除・復元しない。既存バックアップジョブが生成した構造化結果だけを受信する。

## データフロー

```text
Backup Job
  ↓ structured JSON
ivrm-backup-reporter.py
  ↓ HMAC-SHA256 / HTTPS
POST /api/agent/backups
  ↓ Service Role RPC
ingest_backup_report_v1
  ↓
backup_runs / backup_policies
  ↓ Service Role read RPC
/backups
```

Heartbeatとは別APIだが、Agentと同じ`IVRM_AGENT_SERVER_ID` / `IVRM_AGENT_TOKEN`を使う。新しいCredentialは不要。

## 送信Payload

Reporterへ渡すファイルは次の形式に限定する。

```json
{
  "runs": [
    {
      "runId": "018f6d0e-8f3f-7f2b-9c2c-2d705ba13d7d",
      "backupTarget": "mc-main",
      "gameMode": "survival",
      "backupType": "world",
      "destinationType": "s3",
      "startedAt": "2026-08-13T05:00:00Z",
      "completedAt": "2026-08-13T05:03:10Z",
      "outcome": "success",
      "durationSeconds": 190,
      "sizeBytes": 5368709120,
      "sha256Verified": true,
      "remoteSyncedAt": "2026-08-13T05:04:20Z",
      "restoreTestedAt": "2026-08-13T05:10:00Z",
      "retentionExpiresAt": "2026-08-20T05:03:10Z",
      "failureCode": null
    }
  ]
}
```

`serverId`と`reportedAt`はReporterが付与する。1リクエスト1〜20 Run。

### Enum

`backupType`:

```text
world
config
permissions
full
```

`destinationType`:

```text
local
s3
```

`outcome`:

```text
success
failed
running
unknown
```

`failureCode`:

```text
source_unavailable
archive_failed
checksum_failed
remote_sync_failed
retention_failed
timeout
permission_denied
insufficient_space
unknown
```

`failed`では`failureCode`必須。`success` / `running` / `unknown`では`failureCode=null`とする。

## 送信しない情報

次はPayload・DB・画面へ含めない。

- S3 Access Key / Secret Key
- Bucket内部Path
- ローカル絶対Path
- Pre-signed URL
- backup scriptのstdout / stderr
- Shell command
- Token / Cookie
- IPアドレス

APIは定義外キーを拒否するため、これらを誤ってPayloadへ追加しても保存しない。

## Reporter

環境変数:

```text
IVRM_AGENT_SERVER_ID=oci-minecraft-01
IVRM_AGENT_BACKUP_ENDPOINT=https://console.ivrm.jp/api/agent/backups
IVRM_AGENT_TOKEN=<existing agent secret>
```

実行例:

```bash
python3 /opt/ivrm/ivrm-backup-reporter.py --input /run/ivrm-agent/backup-report.json
```

Reporterは以下を行う。

1. 入力JSONの上限・Top-level key・Run件数を確認
2. `serverId`とUTC `reportedAt`を追加
3. 16-byte Random Nonceを生成
4. `timestamp.nonce.rawBody`をHMAC-SHA256署名
5. HTTPSで`POST /api/agent/backups`

SecretやPayload本文はログ出力しない。

## 冪等性

`runId`は同一バックアップ実行中は固定する。

例:

1. 開始時: `outcome=running`
2. 完了時: 同じ`runId`で`outcome=success`
3. 後からRemote Sync / Restore Testが完了: 同じ`runId`で追加情報を送信

DBは`(host_id, run_id)`をUniqueにし、同じRunを更新する。`success` / `failed`へ確定したOutcomeは`running` / `unknown`へ戻さない。

各HTTP RequestはNonceでもReplay防止する。

## Policy / SLA

初めて受信した`host + backupTarget + gameMode + backupType`は`backup_policies`へ自動登録する。

初期値:

```text
Warning Age        24h
Critical Age       48h
Remote Sync SLA     6h
Restore Test SLA   30d
```

SLAはDBのPolicy値で保持し、Webコードへ対象固有の値を散らさない。

## Health判定

判定理由は独立して収集する。Critical Age超過や最新Run失敗があっても、SHA-256未取得、Remote Sync遅延、Retention未取得、Restore Test未取得/期限超過を省略しない。Warning理由の追加によってCriticalを下げない。

Restore Testは同一Policy（host / backup target / game mode / type）内の成功Run全体から取得した最新の復元証跡の経過をPolicyと比較する。`get_backup_center_v1`はこの値を既存の`latest_success_restore_tested_at`へ返すため、Webでは`latestSuccess.restoreTestedAt`に格納されるが、最新成功artifactを復元した証明とは限らない。SHA-256・Remote Sync・Retentionは最新成功artifact自体の値。最新バックアップが新しくても復元テストの古さは解消しない。未来の復元テスト日時は時計の確認が必要であり、Readyの証明に使用しない。RetentionやRestore Testの証跡欠損もWarningにし、成功値を補完しない。

### 警告の調査順（Issue #138）

サービスのIncident復旧とバックアップの鮮度・完全性は別の受入条件。警告表示の修正だけで本番の原因解決とは扱わない。

1. 対象のpolicy、最新成功run ID/completedAt、warning/critical閾値と画面の取得時刻を照合する。
2. 所有hostでtimer実行→artifact生成→checksum検証→remote同期→report送信→DB受信の順に時刻とrun IDをread-onlyで追跡する。秘密・内部path・bucket名を公開Issueへ貼らない。
3. SHA-256 nullは未取得、falseは失敗。Reporterは入力JSONのrunsを署名して転送するもので、artifactを検証してtrueを生成する機能ではない。生成元の検証証跡を確認する。
4. 復元は本番worldを上書きしない隔離先で別途検証し、費用・maintenance条件がある場合は事前承認する。
5. 復元証跡の元Runは、同じPolicy条件で`backup_runs`の`outcome='success'`かつ`restore_tested_at is not null`を`restore_tested_at desc, id desc`で照合する。最新成功run IDへ証跡をコピーせず、実際に復元したRunを調査する。最新成功Runの証跡列だけを調べてPolicy全体の復元未実施とは判断しない。

`tests/backup-health.test.mjs`で複合異常、証跡欠損、古い/未来のRestore Test、SLA境界、重大度維持をCI検証する。本番のtimerやreport到達状態はこの単体テストでは証明できない。

`Critical`例:

- 最新Runがfailed
- 最新成功がCritical Age超過
- SHA-256検証がfalse
- Retention期限切れ

`Warning`例:

- 最新成功がWarning Age超過
- SHA-256検証結果が欠損
- Remote SyncがPolicy SLAを超えて未完了
- 最新Runがrunning / unknown
- Restore Testが長期間未実施

`Healthy`は構造化データから正常を証明できる場合だけ表示する。欠損値を成功扱いしない。

## Restore Ready

単なる`outcome=success`とは分離する。

Readyには少なくとも次を要求する。

- 最新成功Runが存在
- `sha256Verified=true`
- Retention期限が取得済みかつ未期限切れ
- Restore TestがPolicy期間内

これらを証明できない場合は`Unknown`または`Warning`。

## DBセキュリティ

- `backup_policies` / `backup_runs` / `backup_ingest_requests`はRLS + Force RLS
- anon / authenticatedへTable権限なし
- service_roleにも直接Table権限を付与せずSecurity Definer RPCだけを公開
- `ingest_backup_report_v1`はservice_roleのみEXECUTE
- `get_backup_center_v1` / `get_backup_runs_v1`もservice_roleのみEXECUTE
- Payload全Runを検証してからReplay記録・Run保存を開始

## 今後

構造化TelemetryがProductionで安定してから、別PRでIncident Centerへ以下を連携できる。

- Backup Age SLA超過
- 連続失敗
- Remote Sync遅延
- Checksum失敗

Recovered Incident / MTTRには、開始時刻と復旧時刻を構造化データで証明できるものだけを使用する。
