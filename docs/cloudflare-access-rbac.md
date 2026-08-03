# Cloudflare Access・WebコンソールRBAC導入

`console.ivrm.jp`の認証境界としてCloudflare Accessを使用し、Access JWTをNext.js側でも検証します。WebコンソールのロールはMinecraft LuckPermsグループと分離して`console_users`で管理します。

## セキュリティ方針

- `Cf-Access-Authenticated-User-Email`だけを信用しない
- `Cf-Access-Jwt-Assertion`のRS256署名を検証する
- Issuer、Application Audience、期限、`sub`、メールを検証する
- 生JWT、`CF_Authorization` Cookie、Access Tokenを保存・表示・ログ出力しない
- 外部から渡された`x-ivrm-access-*`ヘッダーはProxyで削除する
- Agent Heartbeatは既存のHMAC認証を継続する
- `/api/health`は既存のHealth Check用途を維持する
- 書き込みAPIは認証済みのWebロールを必須にし、段階導入中のバイパスを許可しない

## 導入モード

`IVRM_ACCESS_MODE`は次の3段階です。

| 値 | 動作 |
| --- | --- |
| `disabled` | JWT検証を行わず、既存の読み取り画面を維持する。既定値 |
| `report` | JWTを検証して認証状態を表示するが、未認証でも読み取り画面は維持する |
| `enforce` | 有効なAccess JWTと有効な`console_users`登録がなければ画面・管理APIを拒否する |

不正なモード値、または`enforce`でTeam Domain・AUDが不足している場合は503で安全側へ拒否します。

## Cloudflare Access設定

Cloudflare Zero TrustでSelf-hosted Applicationを作成します。

- Application domain: `console.ivrm.jp`
- Session duration: 運用方針に合わせて短めに設定
- Policy: 許可するメール、グループ、Identity Providerを明示
- Application Audience (AUD): Applicationの設定画面から取得
- Team Domain: `https://<team-name>.cloudflareaccess.com`

Cloudflare Accessが付与する`Cf-Access-Jwt-Assertion`をアプリで検証するため、Vercel Productionへ次を設定します。

```env
IVRM_ACCESS_MODE=report
CF_ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
CF_ACCESS_AUD=<application-audience-tag>
```

値はGitHub、Issue、ログ、スクリーンショットへ貼り付けません。Team DomainとAUDはSecret同等に慎重に扱い、AUDの取り違えを防ぎます。

## 認証状態の確認

Productionを再デプロイ後、Cloudflare Access経由で次を開きます。

```text
https://console.ivrm.jp/security
https://console.ivrm.jp/api/auth/session
```

期待する状態:

```json
{
  "mode": "report",
  "accessState": "verified",
  "status": "unregistered",
  "email": "認証した本人のメール",
  "displayName": null,
  "role": null
}
```

レスポンスに生JWT、Access subject、Cookie、Team Domain、AUDは含めません。

## 初期owner登録

Access JWT検証後、Cloudflare Accessの検証済み`sub`と正規化メールを管理者がSupabaseへ登録します。値をチャットやIssueへ貼らず、管理者のローカル環境またはSupabase SQL Editorで実行します。

```sql
insert into public.console_users (
  access_subject,
  email,
  display_name,
  role,
  is_active
)
values (
  '<verified-access-sub>',
  lower('<verified-email>'),
  '<display-name>',
  'owner',
  true
);
```

登録後、`/security`で`認証済み`・`所有者`になることを確認します。

## ロール

| ロール | 用途 |
| --- | --- |
| `viewer` | 状態・プレイヤー情報の閲覧 |
| `operator` | ホワイトリスト、member付与、安全な再起動 |
| `administrator` | moderator付与、BAN、停止、運用管理 |
| `owner` | admin・owner付与、復元など最重要操作 |

WebロールとMinecraftの`default / member / moderator / admin / owner`は別管理です。Minecraft ownerであってもWeb ownerには自動昇格しません。

## enforceへの切替

次をすべて確認してから`IVRM_ACCESS_MODE=enforce`へ変更します。

1. Cloudflare Access経由でJWTが`verified`
2. 初期ownerが`authenticated`
3. `/api/agent/heartbeat`が継続
4. `/api/health`が200
5. `console.ivrm.jp`の概要・Minecraft・履歴が表示可能
6. 直接Vercel Deployment URLでは未認証アクセスが403
7. 生JWTやCookieがRuntime Logへ出ていない

切替後はProductionを再デプロイし、Cloudflare Accessを通らない直接アクセスが拒否されることを確認します。

## 障害時

### Access設定不足

`enforce`でTeam DomainまたはAUDが不足すると503になります。値を確認し、緊急時だけ`report`へ戻します。`disabled`へ戻す場合も、操作APIは追加しません。

### 利用者未登録

JWT検証済みでも`console_users`に一致する`access_subject`がなければ`unregistered`です。自動登録は行いません。

### Identity不一致

登録済み`access_subject`とJWTメールが一致しない場合は拒否します。既存行を安易に上書きせず、Cloudflare Identityと変更履歴を確認します。

### 利用停止

`is_active=false`にするとAccess認証が成功していても利用できません。
