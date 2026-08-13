# Discord Session管理・認証監査

## 目的

Discord OAuth2で発行したWebコンソールSessionをAdministrator／Ownerが確認し、不審・不要なSessionを失効できるようにする。

同時に、Discordログイン成功・拒否・Logout・管理失効を検索可能な監査画面として提供する。

## 権限

| Webロール | Session一覧 | 認証監査 | Session強制失効 |
|---|---:|---:|---:|
| viewer | × | × | × |
| operator | × | × | × |
| administrator | ○ | ○ | viewer / operator / administrator |
| owner | ○ | ○ | 全ロール |

AdministratorはOwner Sessionを失効できない。DB RPCが現在のSession Token Hashを再照合し、Web側から渡されたロール文字列だけを信用しない。

## 画面

### Session管理

```text
/security/sessions
```

表示項目：

- Discord Global Name／Username／User ID
- Webコンソールロール
- 有効・期限切れ・失効済み
- 作成日時
- 最終利用日時
- Session期限
- 失効日時・失効理由
- 現在のSessionかどうか

表示しない項目：

- Discord OAuth Access Token
- Discord OAuth Refresh Token
- Session Cookie値
- Session Token Hash
- Discord Role ID一覧
- Client Secret
- IPアドレス

### 認証監査

```text
/security/audit
```

対象操作：

```text
DISCORD_LOGIN_SUCCEEDED
DISCORD_LOGIN_DENIED
DISCORD_SESSION_REVOKED
DISCORD_SESSION_ADMIN_REVOKED
```

操作・結果で絞り込み、50件単位のCursor Paginationで表示する。

## API

```text
GET /api/security/discord-sessions
GET /api/security/auth-audit
POST /api/security/discord-sessions/{sessionId}/revoke
```

全APIでServer側のDiscord Sessionを照合し、Administrator以上を要求する。

POSTは同一Originを必須とし、確認文字列として次を要求する。

```text
REVOKE
```

## 強制失効

失効理由はDB上で次として記録する。

```text
administrator
```

Ownerが実行した場合も、Session失効理由の分類は`administrator`を使用し、監査ログの`actorRole`で実行者権限を区別する。

結果：

- `revoked`: 新たに失効した
- `unchanged`: 既に失効済み、または期限切れ
- `denied`: AdministratorがOwner Sessionを操作しようとした
- `not_found`: 対象Sessionが存在しない

同じSessionへ複数回要求しても、2回目以降は`unchanged`となり、破壊的な二重処理を行わない。

## 自分自身のSessionを失効した場合

対象が現在のSessionだった場合：

1. DB Sessionを失効する
2. `__Host-ivrm_console_session` Cookieを削除する
3. `/login`へ303 Redirectする
4. 再ログインするまで保護画面へアクセスできない

## 監査ログ

強制失効成功：

```text
Action: DISCORD_SESSION_ADMIN_REVOKED
Result: success
```

AdministratorがOwner Sessionを操作しようとした場合：

```text
Action: DISCORD_SESSION_ADMIN_REVOKED
Result: denied
Reason: owner_session_protected
```

監査Metadataには、実行者Discord User ID、対象Discord User ID、対象Webロール、自己失効かどうかを保存する。Token、Cookie、Hash、Role ID一覧は保存しない。

## DBセキュリティ

- `discord_console_sessions`はRLS・Force RLS有効
- `anon`・`authenticated`・Service Roleに直接Table権限を付与しない
- 一覧・失効・監査取得はSecurity Definer RPCのみ
- RPC実行権限はService Roleだけ
- 現在の管理Session HashをRPC内で再照合
- Sessionが失効済み・期限切れの場合は管理RPCを使用できない

## Production検証

Migration適用時は、トランザクション内で次を確認し、最後にRollbackする。

- AdministratorによるSession一覧取得
- Administratorによるviewer Session失効
- 再失効の`unchanged`
- AdministratorによるOwner Session失効拒否
- 拒否後もOwner Sessionが有効
- OwnerによるAdministrator Session失効
- 失効済みAdministrator Sessionの管理RPC拒否
- Ownerによる自己Session失効
- 自己失効後のSession再利用拒否
- 管理失効の成功・拒否監査ログ
- 永続テストSession 0件
