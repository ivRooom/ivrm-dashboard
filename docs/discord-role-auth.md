# Discord OAuth2・専用ロール認証

## 目的

`console.ivrm.jp`を匿名公開せず、ivRooomのDiscordサーバーに参加し、管理コンソール専用ロールを持つユーザーだけがログインできるようにする。

DiscordのWebロールとMinecraft LuckPermsグループは別管理とする。

## 認証フロー

```text
ブラウザ
  ↓ GET /api/auth/discord/start
IVRM Console
  ↓ state付きAuthorization Code Grant
Discord OAuth2
  ↓ code + state
GET /api/auth/discord/callback
  ↓ identify
/users/@me
  ↓ guilds.members.read
/users/@me/guilds/{guild_id}/member
  ↓ Guild・Membership Screening・Role ID確認
IVRM Console
  ↓ ランダムSession TokenをCookieへ保存
Supabase
  ↓ SHA-256 Hashだけを保存
Discord Console Session
```

Discord Access TokenとRefresh TokenはDBへ保存しない。Role判定後にAccess Tokenの失効を試み、失効に失敗した場合もToken値はログへ出さない。

## Discord Developer Portal

1. ivRooom用Discord Applicationを開く。
2. OAuth2のRedirectsへ以下を追加する。

```text
https://console.ivrm.jp/api/auth/discord/callback
```

3. Previewを実URLで検証する場合は、そのPreview専用Callback URLも一時追加する。
4. Client IDを確認する。
5. Client Secretを再生成または確認し、Vercelの暗号化済みEnvironment Variableへ保存する。
6. Client SecretをIssue、PR、ログ、チャットへ貼り付けない。

BotのGuild参加は不要。ログインしたユーザー自身のOAuth Tokenと`guilds.members.read` ScopeでCurrent User Guild Memberを取得する。

## Guild ID・Role ID

DiscordクライアントでDeveloper Modeを有効にし、対象サーバーとロールのIDをコピーする。

最低構成では、管理コンソール専用Roleを`viewer`へ割り当てる。

```json
{
  "viewer": ["DISCORD_CONSOLE_ROLE_ID"],
  "operator": [],
  "administrator": [],
  "owner": []
}
```

操作権限をDiscord側でも分離する場合は、各Console Roleに別のDiscord Role IDを割り当てる。

```json
{
  "viewer": ["VIEWER_ROLE_ID"],
  "operator": ["OPERATOR_ROLE_ID"],
  "administrator": ["ADMINISTRATOR_ROLE_ID"],
  "owner": ["OWNER_ROLE_ID"]
}
```

同じDiscord Role IDを複数のConsole Roleへ重複指定しない。複数の異なるRoleが一致した場合は、以下の順で最上位を採用する。

```text
owner
administrator
operator
viewer
```

## Vercel Environment Variables

Productionへ以下を設定する。

```text
IVRM_DISCORD_AUTH_MODE=report
DISCORD_CLIENT_ID=<Discord Application Client ID>
DISCORD_CLIENT_SECRET=<Discord Application Client Secret>
DISCORD_GUILD_ID=<ivRooom Guild ID>
DISCORD_REDIRECT_URI=https://console.ivrm.jp/api/auth/discord/callback
IVRM_DISCORD_ROLE_MAP_JSON={"viewer":["<専用Role ID>"],"operator":[],"administrator":[],"owner":[]}
IVRM_DISCORD_SESSION_TTL_SECONDS=14400
```

`DISCORD_CLIENT_SECRET`、`SUPABASE_SERVICE_ROLE_KEY`はProduction・Previewへ必要な範囲だけ設定する。公開用の`NEXT_PUBLIC_`変数にしない。

## 段階導入

### 1. disabled

```text
IVRM_DISCORD_AUTH_MODE=disabled
```

従来のCloudflare Access認証だけを使用する。Discordログインは開始できない。

### 2. report

```text
IVRM_DISCORD_AUTH_MODE=report
```

Discordログイン画面とOAuth Callbackを検証する。Discord Sessionがないユーザーは従来のCloudflare Accessへフォールバックするため、切替テスト中のロックアウトを避けられる。

確認項目：

- 専用Role保持者がログインできる
- 専用Roleなしのユーザーが拒否される
- 対象Guild未参加ユーザーが拒否される
- Membership Screening未完了ユーザーが拒否される
- Session Cookieへ`Secure`、`HttpOnly`、`SameSite=Lax`が付く
- DBにSession Token平文やDiscord OAuth Tokenがない
- `/api/health`とAgent Heartbeatが継続する

### 3. enforce

```text
IVRM_DISCORD_AUTH_MODE=enforce
```

`/login`とOAuth・Logoutルート、Health、Agent Heartbeat以外でDiscord Sessionを必須にする。

ProxyはCookieの有無だけを確認する。Session Token Hash、期限、失効、Console Roleの最終確認はServer側の`resolve_discord_console_session` RPCで行う。

## Session仕様

Cookie：

```text
__Host-ivrm_console_session
```

属性：

```text
Secure
HttpOnly
SameSite=Lax
Path=/
Domain属性なし
```

DBへ保存するもの：

- Session TokenのSHA-256 Hash
- Discord User ID
- Username・Global Name・Avatar Hash
- Guild ID
- 一致したRole ID
- Console Role
- 作成日時・期限・最終利用日時
- 失効日時・失効理由

DBへ保存しないもの：

- Discord Access Token
- Discord Refresh Token
- Client Secret
- Session Token平文
- Discordパスワード

同一Discord Userが再ログインした場合、既存の有効Sessionを`replaced`で失効する。初期実装は1ユーザー1有効Sessionとする。

## Role変更の反映

OAuth Tokenを長期保存しないため、Discord Role変更は次回ログイン時に再判定する。既定Session TTLは4時間。

即時に利用停止する場合は、該当SessionをDBの管理手順で`administrator`失効するか、Session TTLを短くする。将来、専用Botによる定期Role再検証を別Issueで追加できる。

## 公開ルート

```text
/login
/api/auth/discord/start
/api/auth/discord/callback
/api/auth/logout
/api/health
/api/agent/heartbeat
```

`/api/auth/session`を含むその他の画面・APIは認証対象。

## 監査ログ

成功：

```text
DISCORD_LOGIN_SUCCEEDED
```

拒否：

```text
DISCORD_LOGIN_DENIED
```

Session失効：

```text
DISCORD_SESSION_REVOKED
```

監査ログには理由、Console Role、一致Role件数、Session ID、期限を保存できる。OAuth Token、Cookie値、Client Secret、Role ID一覧は保存しない。

## ロールバック

ログイン障害時は、最初に以下へ戻す。

```text
IVRM_DISCORD_AUTH_MODE=report
```

従来Cloudflare Accessが使用できない場合は、一時的に以下へ戻す。

```text
IVRM_DISCORD_AUTH_MODE=disabled
```

DB MigrationやSession Tableを削除する必要はない。既存Sessionは期限切れまたはLogoutで失効する。
