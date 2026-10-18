# 書込終了済み投影ログのrotation drain（本番未導入）

Tracking: #135 / #142。PR149に依存する追加変更。

## 対象

管理されたprojectorが書き込みを終了し、renameした旧JSONLだけを扱う。projector/operatorが旧writerを閉じてから絶対パス・byte数・SHA-256をsealとして作成する。collector自身はsealを自動生成せず、任意directoryの探索もしない。通常の `capture-once` はrotationで引き続き停止する。

```json
{
  "config": {
    "path": "/var/log/ivrm-projected/service.jsonl",
    "source": {"sourceId":"fixture-app-log","serviceId":"fixture-app","type":"application","provider":"other"}
  },
  "seal": {
    "path": "/var/log/ivrm-projected/service.jsonl.1",
    "bytes": 123,
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256"
  }
}
```

これは形式例で、本番設定ではない。管理者だけが書ける設定を次のローカルCLIに渡す。

```text
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts drain-once ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID ABSOLUTE_SEAL_CONFIG_JSON
```

## 読み継ぎ条件

1. 元sourceのcheckpointが存在し、active fileとは異なる旧device/inodeを指していること。
2. 指定旧fileがcheckpointのdevice/inodeと一致し、regular file・single hardlink・final symlinkなしであること。
3. 旧fileは最大1MiB。サイズと全file SHA-256を読み取り前後に検証し、checkpointの直前prefixも一致すること。
4. 既存上限の64KiB/5行ずつを旧fileからqueueへ保存する。batchとcursorは同一transaction。
5. 旧fileが完全な改行で終わり、未読byteが0になった回だけactiveのdevice/inodeを再確認し、offset=0へのhandoffを同一DB transactionで行う。

`queued` の間は同じsealで繰り返す。`rotated` 後は通常 `capture-once` へ戻す。同じsealをもう一度渡すと `rotation_already_completed` を返す。新fileがさらにrotationした場合は新しい旧fileのsealが必要。旧fileの不完全な末尾は `sealed_partial_line` として停止し、勝手に破棄しない。handoff時のDB失敗は旧cursorを保ち、再試行できる。

初回が空/partial行でも、通常captureはdevice/inodeとoffset=0を保存してidleを返す。これにより初回からrotationを検知する。offset=0の保存で未読行を処理済みにはしない。

## 制約と負荷

sealは「信頼されたprojectorが書込を終えた」という運用上の宣言。SHA-256だけでは将来のlate writeや改ざんを防げない。writerのclose/rename/sealの順序と、旧fileを変更しない権限・保持ルールを別途保証する。copytruncate、圧縮済みfile、1MiB超、未観測のrotation世代を飛ばす復旧には使わない。旧fileはcollectorが削除しない。

1回あたりseal検証で旧fileを最大2MiB再読する（通常行読み取り等は別）。無制限busy loopで回さず、実配置前にディスクI/O・CPU・収集間隔・元file保持期間を測る。新しいfileへのhandoffは旧fileの**queueへの永続保存完了**が条件で、ネットワークACKまで待つものではない。キュー満杯では止まり、source側の保持期間を超えると復元不能になるため欠測・queue通知は別工程で必要。

同じ最古イベント時刻のbatchはローカル登録順で送信する。HTTP再試行や複数workerによる受信順の保証はしない。

## 検証と境界

captureテストは旧12行を複数batchで読み切ってから新fileを読む流れ、seal違い/サイズ違い/別inode/late append/partial末尾の拒否、満杯時の保全、handoff INSERT/UPDATE障害を検証する。sender/coreと型チェックも実行する。

Producer=管理されたprojector→collector、Consumer=spool→dashboard、Contract=operational-telemetry.v1 candidate。Merge順はcontracts18→merged pin/PR147→PR148→PR149→本変更。本変更はPR149をbaseとするstacked PR。deployはprojectorと書込終了手順、権限、負荷・費用、通知、S3保管を確認し対象別承認後。Rollbackはcollector/送信停止、旧/新ログとqueue/cursorの保全。DBや証跡を削除しない。本番配置・起動・Secret・DB・課金変更は行っていない。
