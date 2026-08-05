# 操作ジョブ・監査ログ基盤

## 目的

Minecraft管理操作をOCIで実行する前に、Webコンソール側で以下を保証する。

- 許可リストにない操作を作成しない
- 同一要求の二重送信でJobを重複作成しない
- 再起動・停止・バックアップなどを同時実行しない
- Job状態遷移を追跡する
- 操作要求・競合・拒否・結果を監査する
- Agent停止後もJob Lockを自動解放できる
- Secretや任意コマンドを保存しない

この段階ではDocker、RCON、Shell、バックアップ処理を実行しない。

## DB構成

### operation_jobs

操作要求の現在状態を保持する。

状態：

```text
queued
  ├─ leased → running → succeeded
  │    │          ├────→ failed
  │    │          └────→ expired
  │    ├─ queued
  │    ├─ failed
  │    └─ expired
  ├─ cancelled
  └─ expired
```

不正な順序の状態遷移、NULL状態、権限のないActorによる遷移は`transition_operation_job`が拒否する。

### Leaseと障害復旧

Jobを取得した管理Agentは15〜300秒のLeaseを持つ。

- `leased`または`running`の間は、同じ`lease_owner`だけが処理を継続できる
- 長時間処理は`renew_operation_job_lease`でLeaseを延長する
- 別Agentによる延長、開始、完了は拒否する
- Lease期限前のSystem失効は拒否する
- `expire_stale_operation_jobs`は期限切れの`leased`・`running` Jobを`expired`へ遷移する
- `expired`になると部分一意インデックスの対象外になり、後続JobのLockが解放される

専用Minecraft管理Agentを本番接続する際は、以下を必須とする。

1. 実行中はLease期限の半分より短い間隔で更新する
2. Agent起動時と定期処理でReaper RPCを呼ぶ
3. Lease更新に失敗したJobのDocker・RCON操作を継続しない
4. `expired` Jobの遅延結果を成功として上書きしない

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

Job状態遷移とLease更新を追記専用で記録する。UPDATE、DELETE、TRUNCATEはトリガーで拒否する。

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

MetadataはObject・Arrayを再帰走査し、ネストされた機密キーも拒否する。

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
- Job作成・状態遷移・Lease更新・期限切れ処理・監査追記: Security Definer RPCのみ
- Audit Chain State: Webアプリから直接参照不可

## 機密情報

以下をPayload、Result、監査Metadataへ保存しない。

- RCONパスワード
- forwarding secret
- PCF secret
- Access JWT
- API Token
- Authorization Header
- Cookie
- 任意Shellコマンド
- 任意Dockerコマンド
- 完全なRCONコマンド

## 次の段階

1. Cloudflare Accessを`report`から`enforce`へ移行
2. 専用Minecraft管理AgentのJob Lease APIを追加
3. AgentとWeb API間のHMAC認証を追加
4. AgentへLease更新とReaper呼び出しを実装
5. 最初は`save_world`だけを接続
6. Health・Minecraft Ping・監査結果を確認
7. 安全な再起動へ拡張
