# 操作ジョブ・監査ログ基盤

## 目的

Minecraft管理操作をOCIで実行する前に、Webコンソール側で以下を保証する。

- 許可リストにない操作を作成しない
- 同一要求の二重送信でJobを重複作成しない
- 再起動・停止・バックアップなどを同時実行しない
- Job状態遷移を追跡する
- 操作要求・競合・拒否・結果を監査する
- Secretや任意コマンドを保存しない

この段階ではDocker、RCON、Shell、バックアップ処理を実行しない。

## DB構成

### operation_jobs

操作要求の現在状態を保持する。

状態：

```text
queued
  ├─ leased → running → succeeded
  │                    └→ failed
  ├─ cancelled
  └─ expired

leased
  ├─ queued
  ├─ failed
  └─ expired
```

不正な順序の状態遷移は`transition_operation_job`が拒否する。

### 冪等性

Web APIで受け取ったIdempotency Keyは平文保存せず、SHA-256へ変換して`idempotency_key_hash`へ保存する。

一意条件：

```text
requested_by
+ host_id
+ operation_type
+ idempotency_key_hash
```

同じ条件で再要求された場合は、新規Jobを作成せず既存Jobを返す。

### 排他制御

実行中として扱う状態：

```text
queued
leased
running
```

`host_id + lock_scope`の部分一意インデックスと、同じ値を使うPostgreSQL Transaction Advisory Lockの両方で競合を防ぐ。

初期排他区分：

| 区分 | 操作 |
|---|---|
| `minecraft:world` | ワールド保存 |
| `minecraft:exclusive` | 起動、停止、再起動、Velocity再起動、バックアップ作成・検証 |
| `minecraft:maintenance` | メンテナンス開始・終了 |

競合時は新規Jobを作成せず、既存の競合Job IDと`conflict`を返す。

### operation_events

Job状態遷移を追記専用で記録する。UPDATE、DELETE、TRUNCATEはトリガーで拒否する。

### audit_logs

監査ログは追記専用で、各レコードに以下を保存する。

- Request ID
- 操作者ID・メール・Webロール
- 操作者IP
- 操作種別
- 対象種別・対象ID
- 結果
- 機密情報を含まないMetadata
- 直前レコードのハッシュ
- 現在レコードのSHA-256

挿入時は`audit_log_chain_state`を行ロックし、ハッシュチェーンを直列化する。Webアプリは`append_audit_log` RPC以外から追加できず、UPDATE、DELETE、TRUNCATEもできない。

## 許可済み操作

| 操作 | 最低ロール | 確認文字列 | 排他区分 |
|---|---|---|---|
| `save_world` | operator | 不要 | world |
| `restart_backend` | operator | 必須 | exclusive |
| `restart_proxy` | administrator | 必須 | exclusive |
| `start_backend` | operator | 不要 | exclusive |
| `stop_backend` | administrator | 必須 | exclusive |
| `maintenance_start` | operator | 不要 | maintenance |
| `maintenance_end` | operator | 不要 | maintenance |
| `create_backup` | operator | 不要 | exclusive |
| `verify_backup` | operator | 不要 | exclusive |

Web側の`operation-catalog.ts`とDB RPCの両方で同じ制約を持つ。

## 権限

全テーブルでRLSとForce RLSを有効化する。

- `anon`: 権限なし
- `authenticated`: 権限なし
- `service_role`: Job、Event、Audit LogのSELECTのみ
- Job作成・状態遷移・監査追記: Security Definer RPCのみ
- Audit Chain State: Webアプリから直接参照不可

## 機密情報

以下をPayload、Result、監査Metadataへ保存しない。

- RCONパスワード
- forwarding secret
- PCF secret
- Access JWT
- API Token
- 任意Shellコマンド
- 任意Dockerコマンド
- 完全なRCONコマンド

## 次の段階

1. Cloudflare Accessを`report`から`enforce`へ移行
2. 専用Minecraft管理AgentのJob Lease APIを追加
3. AgentとWeb API間のHMAC認証を追加
4. 最初は`save_world`だけを接続
5. Health・Minecraft Ping・監査結果を確認
6. 安全な再起動へ拡張
