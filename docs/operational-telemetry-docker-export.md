# Docker JSON exportの読み込み（本番未導入）

Tracking: #135 / #136 / #142。PR150をbaseにした追加変更。

## 対象

管理されたexporterが出力したDocker JSON形式のコピーを、既存capture/spoolへ接続する。入力は厳密に `log` / `stream` / `time` の3field。各行の `time` を発生時刻として保持し、本文を保存前にmaskする。

Dockerの[json-file仕様](https://docs.docker.com/engine/logging/drivers/json-file/)はこの3fieldを示し、daemon内部fileへの外部アクセスを避けるよう記載している。本機能は**エクスポート済みコピーのparser**であり、Docker内部storageの直読を導入するものではない。Docker socket、CLI subprocess、SSH、provider API、exporterの配置・起動は含まない。

```json
{
  "path": "/var/log/ivrm-exported/container.jsonl",
  "format": "docker-json-export",
  "source": {
    "sourceId": "fixture-container-log",
    "serviceId": "fixture-service",
    "type": "container",
    "provider": "other",
    "hostId": "fixture-host",
    "resourceId": "fixture-container"
  }
}
```

設定は管理者が固定し、実行は既存 `capture-once PRIVATE_DIRECTORY PRODUCER_ID SOURCE_CONFIG_JSON`。source typeはcontainer、resourceId必須。本文にあるcontainer名等からsourceの識別子を上書きしない。

```json
{"log":"application event\n","stream":"stdout","time":"2026-10-18T00:00:00.123456789Z"}
```

`stream` はstdout/stderrのみ。messageにstreamを付け、level=info / kind=log / outcome=observedとする。stderrはseverityや攻撃判定の根拠にしない。actor/clientIpは生成しない。ナノ秒の文字列表現は保持するが、receiverの鮮度計算は既存のミリ秒精度を使う。

## 拒否・互換性

- attrs/label/env等の追加fieldは取り込まない。形式が違う場合はcheckpointを進めず失敗する。exporterは秘密を含めず、許可した3fieldのみ出力する必要がある。
- 1行8KiB、1回64KiB/5行、本文2048文字、時刻7日/未来30秒の既存制限を維持。大きなDocker log chunkやmulti-lineの元の形状を完全保存する用途には使わない。本文中の改行は既存redactorで正規化される。
- formatはsource bindingに含める。既存sourceの読み取り途中でprojectedとDockerを切り替えない。従来のformat省略と明示的projected-jsonlは同じbindingを維持する。
- このexporter自身のcheckpoint、Docker API認証、再起動、元ログ保持、欠測通知、全container自動登録は未実装。全環境ログ収集完了と扱わない。

## テスト・導入境界

captureテストでナノ秒時刻、stderrをinfoとして保持、保存前mask、attrs/偽stream/古い時刻/source不備/format付替え拒否を確認。core10＋sender12＋capture16を実行する。

Producer=今後の管理されたDocker exporter→file parser→spool、Consumer=dashboard、Contract operational-telemetry.v1 candidate。Merge順contracts18→merged pin/PR147→PR148→PR149→PR150→本変更。先行merge後mainへretarget。既存Minecraft経路を変更しない。

本番導入にはexporter設計、権限・負荷・保持期間・通信/保存費用、rotation handoff、通知、S3の確認と対象別承認が必要。Rollbackはexporter/collector/送信停止と元ログ・export・queue・cursorの保全。削除なし。本変更で本番配置/起動/Secret/DB/課金変更はしていない。
