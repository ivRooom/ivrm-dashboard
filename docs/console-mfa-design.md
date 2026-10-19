# Consoleのパスキー・認証アプリ2FA設計

2026-10-17 / Issue #133、親 #142。ユーザー決定: パスキーまたは認証アプリの2FAを必須。設計段階であり、有効化・移行・本番gate切替は未実施。

## 現在の境界

現行はDiscord OAuth→Guild/Role検証→独自Console session。Supabase Auth sessionへ自動移行しない。既存sessionのtoken hash・失効・RBAC境界を維持し、追加のfactor proofをserver-sideでsessionに結び付ける。将来のapi.ivrm.jp SSO統合では認証強度の共通契約を別途定義する。

## 目標状態

- Discord一次認証後、WebAuthn/passkeyまたはTOTPの二次検証に成功するまで管理情報の閲覧API・画面と操作を拒否する。
- 未登録者が通れるのは最小限の登録/復旧/ログアウト経路のみ。一次sessionだけで全ユーザーのfactor一覧や監視情報を返さない。
- 登録challenge/proofはuser ID、一次session、目的、期限に結び付け、単回使用とする。入力のuser IDやbrowser申告のMFA済み値を信頼しない。
- factor追加・削除、通知先変更、session管理、停止/再起動/復元等の重要操作は短命のstep-upを要求。既存のRBAC、Origin/CSRF、冪等性、排他、auditを維持。
- role変更/退会/失効、factor削除、account recovery時は必要なsession/proofを失効。MFA成功がGuild/Role確認を置き換えることはない。

## 登録・検証

WebAuthn: 専用RP ID/originを明示、challengeの乱数/TTL/用途を検証、user verification必須、credential IDと公開鍵を主体へ結び付ける。カウンターやbackup状態の扱いは利用する保守済みライブラリと同期passkey仕様を確認する。自作の署名検証は実装しない。RP/origin変更とpreviewでの登録を本番credentialと分離する。

TOTP: 秘密をserverで生成し、登録者への一時表示後に正しいコードを検証して有効化。秘密は暗号化保存し、鍵はDBと分離したserver secret管理へ置く。秘密・QR/URI・コード・復旧コードをログ/監査/URLへ残さない。小さい許容windowと共有rate limitを定義し、同じtime stepの再利用を原子的に拒否する。鍵rotationと復号失敗はfail closedで扱う。

既存独自sessionへ追加するため、まずDBのfactor/challenge/proof/recovery modelと権限、原子性、RPCの実行者を設計する。DB migrationは別PRで準備し、本番適用は別change-control。service-roleをbrowserへ渡さず、直接table参照も許可しない。

## 移行と復旧

1. 既存所有者の登録・複数端末・代替factor・復旧経路を非本番で確認。enforce前に移行対象と登録済みcoverageを確認する。
2. owner承認のbootstrap手順で初回登録を認可する。既存sessionを盗んだ攻撃者が無条件にfactorを追加できる移行にしない。
3. 通常ログインは一次認証→二次検証→通常API利用。重要操作は再認証。移行modeをクライアントから変更できないようにする。
4. 高entropyの単回復旧コードはhashのみ保存し、消費を原子的に行う。復旧は一次認証と合わせて行い、再登録・session失効・監査・所有者への通知を伴う。メール/Discord問い合わせだけで本人確認を省略しない。
5. 全factor紛失時は別管理のbreak-glass手順。利用は短時間・監査付き、平常時の恒久バイパスにしない。ロックアウト時にenforce→disabledを通常rollbackとしない。

## 実装PRの順番

1. factor/challenge/proofのデータモデル、暗号化鍵の運用、復旧/初回登録、endpoint権限表と脅威境界を確定。ライブラリの現行仕様・依存評価を記録。
2. 非本番でWebAuthn/TOTP登録・検証、共有rate limit、replay拒否、session binding、復旧を実装し統合テストする。本番gateは切り替えない。
3. 共通server authorizationにMFA proof検証を統合。人のsessionで利用する全page/API/mutationと旧Cloudflare Access fallback経路を一覧で検証し、いずれかの認証経路だけが抜けないことを確認する。非対話の`/api/agent/*`は既存machine credential・HMAC/nonce/source allowlist、`/api/reliability/burn-reconcile`は専用machine認証で保護し、人のMFA proofを要求して収集/reconcileを止めない。`/api/public/status-feed`は公開用の許可済みprojectionだけを返し、認証不要のまま管理情報やmutationを公開しない。route例外はこの固定用途に限定し、人が操作する管理APIを例外へ追加しない。
4. 移行coverage、管理者の紛失復旧と重要操作step-upを受入後、認証設定変更の専用change-controlで本番必須化する。

## 必須の否定テスト

一次認証なし、MFA未完了、別user/sessionのchallenge、期限切れ/再利用、origin/RP不一致、user verificationなし、TOTP総当たり/再利用、未確認factor、factor削除後のproof、role失効、直接API、旧認証fallback、復旧コードの同時消費、復号鍵なし、DB/依存障害のすべてを拒否する。失敗時も秘密を含まない監査を残す。

本設計だけで2FA対応済みとは扱わない。外部provider導入や有料機能、鍵管理の課金が必要な場合は対象・費用・rollbackを具体化して事前承認を得る。
