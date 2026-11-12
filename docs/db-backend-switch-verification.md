# DB バックエンド切替後の検証手順

版: v1.0.0 (2026-11-13 作成)
正本: このファイル (ivrm-dashboard repo)。関連: Issue #206、PR #205

## 背景

2026-11-11 の PG17 移行で `ivrm_dashboard` に pgcrypto が入っておらず、
Supabase 由来の `append_audit_log` が使う `digest()` が存在しないため、
監査を書く全ての RPC (コンソールログインのセッション作成を含む) が
2026-11-12 夜まで失敗していた。教訓は2つ:

1. 関数は「存在する」だけでは動かない。定義が要求する拡張・スキーマ
   (search_path 依存) が移行先に揃っているかを別途検証すること。
2. 監査系の失敗は呼び出し側で握り潰される設計 (`.catch(() => undefined)`)
   があり、障害が無音になる。切替後は合成スモークで書き込み経路を
   能動的に確認すること。

## 手順 1: 拡張依存の棚卸し (読み取りのみ)

移行先 DB で次を実行し、`status = 'MISSING'` の行が無いことを確認する。

```bash
psql -d <database> -f supabase/checks/extension_dependencies.sql
```

MISSING が出たら、関数が前提とするスキーマへ拡張を入れる
(例: pgcrypto は `CREATE EXTENSION pgcrypto SCHEMA extensions;` +
対象ロールへの `GRANT USAGE ON SCHEMA extensions`) か、関数側を
書き換える。適用は本番 DDL として Owner 承認を取ること。

## 手順 2: 監査付き mutation の合成スモーク (ロールバック)

実データに触れないよう、1 トランザクション内で実行して必ず
ROLLBACK する。サービス用ロールで監査記録と代表 RPC を通す。

```sql
begin;
set local role ivrm_dashboard_service;

-- 監査そのもの (digest を使う append_audit_log)
select public.append_audit_log(
  gen_random_uuid(), null, 'smoke@example.invalid', 'owner', null,
  'SMOKE_TEST', 'smoke', 'switch-verification', 'success', '{}'::jsonb);

-- 代表 RPC: コンソールセッション作成 (内部で監査を書く)
-- 注: token hash は 64 桁 hex、role ids は数値文字列を 1 件以上、
-- TTL は 14400 (4h) でないと検証エラーになる (2026-11-13 実測)。
select public.create_discord_console_session(
  gen_random_uuid(), repeat('0', 64), '111111111111111111',
  'smoke', 'smoke', null, '964326043420872704',
  array['123456789012345678']::text[], 'owner', 14400);

rollback;

-- ロールバック後に残件が無いこと (両方 0)
select count(*) from public.discord_console_sessions
  where discord_user_id = '111111111111111111';
select count(*) from public.audit_logs where action = 'SMOKE_TEST';
```

他の監査付き RPC (ステータス系 mutation、operation job、reliability)
は `append_audit_log` を共有するため、このスモークで共通依存は
カバーできる。個別ロジックの確認が必要な場合は同じ要領で
ロールバック付きで通す。

## 手順 3: 実経路の確認

- PostgREST 経由で対象 RPC が 200/期待応答を返すこと
  (スキーマキャッシュの再読込 `NOTIFY pgrst, 'reload schema'` を
  DDL 後に忘れない)。
- アプリ側の実フロー (コンソールなら Discord ログイン) を
  Owner 実機で 1 回通し、監査テーブルに成功行が積まれることを確認する。

## チェックリスト

- [ ] 手順 1 で MISSING が 0 件
- [ ] 手順 2 のスモークが全て成功し、残件 0 件
- [ ] 手順 3 の実経路確認が完了
- [ ] 結果を切替 Issue / PR に記録した
