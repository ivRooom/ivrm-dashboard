# Discord OAuth Production Rollout

## 目的

`console.ivrm.jp` のDiscord OAuth2 + Guild Role認証を、安全にProductionへロールアウトする。

対象実装:

- `GET /api/auth/discord/start`
- `GET /api/auth/discord/callback`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `IVRM_DISCORD_AUTH_MODE=disabled | report | enforce`

## Discord Applicationの境界

### Production推奨

`console.ivrm.jp` はDashboard専用Discord Applicationを使用する。

```text
admin.ivrm.jp / member.ivrm.jp
  -> 既存 Discord Application: discord Auth

console.ivrm.jp
  -> Dashboard専用 Discord Application
```

理由:

- `ivrm-web` と `ivrm-dashboard` は別Repository
- Admin / MemberとDashboardは別Deployment境界
- DashboardはVercelへClient Secretを保持する
- DashboardはSupabase上に独自Session / RBAC / Auditを持つ
- Client Secret漏えい時の影響範囲を分離できる
- Client Secret rotationをDashboard単独で実施できる

### 既存Application共有について

既存 `discord Auth` のClient ID / Client Secretを共有しても、OAuth2としては動作可能。

共有する場合は、既存ApplicationのOAuth2 Redirectsへ次を追加する。

```text
https://console.ivrm.jp/api/auth/discord/callback
```

ただし、Productionの恒久構成ではSecret共有範囲が広がるため推奨しない。
短期検証・緊急切替だけの互換案として扱う。

## Discord Developer Portal設定

1. Discord Developer Portalを開く。
2. `New Application` でDashboard専用Applicationを作成する。
3. Application名は用途が判別できる名前にする。

例:

```text
IVRM Console Auth
```

4. `OAuth2` を開く。
5. `Redirects` に次を追加する。

```text
https://console.ivrm.jp/api/auth/discord/callback
```

6. Save Changesを実行する。
7. Client IDを控える。
8. Client Secretを生成または確認する。
9. Client SecretはGitHub、Linear、Notion、チャット、ログへ貼り付けない。

BotのGuild参加はこのログインフローには不要。
ユーザー自身のOAuth Access TokenでCurrent User Guild Member APIを取得する。

## Discord側で取得するID

Developer Modeを有効にし、次を取得する。

- ivRooom Guild ID
- Console Viewer Role ID
- Console Operator Role ID（使用する場合）
- Console Administrator Role ID（使用する場合）
- Console Owner Role ID（使用する場合）

Role IDは1つのConsole Roleにだけ割り当てる。

最低構成:

```json
{
  "viewer": ["VIEWER_ROLE_ID"],
  "operator": [],
  "administrator": [],
  "owner": []
}
```

管理操作を段階的に許可する場合:

```json
{
  "viewer": ["VIEWER_ROLE_ID"],
  "operator": ["OPERATOR_ROLE_ID"],
  "administrator": ["ADMINISTRATOR_ROLE_ID"],
  "owner": ["OWNER_ROLE_ID"]
}
```

## Vercel Production Environment Variables

Vercel Project `ivrm-dashboard` のProduction Scopeへ設定する。

```text
IVRM_DISCORD_AUTH_MODE=report
DISCORD_CLIENT_ID=<Dashboard専用Application Client ID>
DISCORD_CLIENT_SECRET=<Dashboard専用Application Client Secret>
DISCORD_GUILD_ID=<ivRooom Guild ID>
DISCORD_REDIRECT_URI=https://console.ivrm.jp/api/auth/discord/callback
IVRM_DISCORD_ROLE_MAP_JSON={"viewer":["<VIEWER_ROLE_ID>"],"operator":[],"administrator":[],"owner":[]}
IVRM_DISCORD_SESSION_TTL_SECONDS=14400
```

注意:

- `DISCORD_CLIENT_SECRET`へ`NEXT_PUBLIC_`を付けない
- `SUPABASE_SERVICE_ROLE_KEY`もBrowserへ公開しない
- Production SecretをPreviewへコピーしない
- PreviewでOAuth E2Eが必要ならPreview専用Application / Secret / Supabase stagingを使う

## ロールアウト順序

### Phase 1: disabled

```text
IVRM_DISCORD_AUTH_MODE=disabled
```

Discord認証を強制しない。
既存のCloudflare Access経路を維持する。

### Phase 2: report

```text
IVRM_DISCORD_AUTH_MODE=report
```

Discord OAuthを実環境で検証する。
Discord Sessionがなくても既存Cloudflare Accessを使用できるため、ロックアウトを避けられる。

確認:

- 専用Role保持者がログイン成功
- Roleなしユーザーが`required_role_missing`で拒否
- Guild未参加ユーザーが`guild_membership_required`で拒否
- Membership Screening未完了が拒否
- Callbackのstate検証が成功
- Session CookieがSecure / HttpOnly / SameSite=Lax / Path=/ / Domainなし
- Session Token平文をDBへ保存していない
- Discord OAuth Access TokenをDBへ保存していない
- `/security/sessions` でSessionを確認できる
- `/security/audit` で成功・拒否を確認できる
- `/api/health` が継続してHTTP 200
- Agent Heartbeat / Backup Reportが継続する

### Phase 3: enforce

`report` のProduction Smoke Test完了後にだけ切り替える。

```text
IVRM_DISCORD_AUTH_MODE=enforce
```

確認:

- 未認証Browserが保護画面へ入れない
- 有効Discord SessionでDashboardへ入れる
- Logout後は再利用できない
- 失効済みSessionはServer側RPCで拒否される
- `/api/health` とAgent公開ルートは非回帰

## ロールバック

認証障害が発生したら、DB Migrationを戻さずModeだけを段階的に戻す。

```text
enforce -> report -> disabled
```

通常は最初に`report`へ戻す。
Cloudflare Access側も利用できない場合だけ`disabled`へ戻す。

## Client Secret Rotation

Dashboard専用Applicationに分離している場合、Dashboardだけでrotationできる。

1. Discord Developer Portalで新しいClient Secretを発行
2. Vercel Production `DISCORD_CLIENT_SECRET`を更新
3. Productionをredeploy
4. `report`でログインSmoke
5. 問題がなければ`enforce`を維持
6. Secret値をチケット・ログへ残さない

## 将来の統合方針

Admin / Member側のCanonical Authを `api.ivrm.jp` に集約し、Dashboardも同じ認証主体・Permission APIを利用する設計へ移行できた時点で、Discord Applicationを再統合する余地がある。

その場合も、単にClient Secretだけを共有するのではなく、以下を同時に統合する。

- OAuth callback
- Session issuance
- Session validation
- Role / Permission source of truth
- Logout / Revoke
- Audit identity

Secretだけ共有しSession境界が別の状態は、中間状態として長期運用しない。

## 関連

- GitHub Issue #54
- GitHub PR #21
- GitHub PR #27
- `docs/discord-role-auth.md`
- `docs/discord-session-admin.md`
