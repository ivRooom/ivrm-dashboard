-- Issue #184 是正スライス追補: 共通関数の owner / ACL を既存の評価器に揃える
--
-- 202611110002 で新規作成した notification_container_state_violation_v1 は、
-- 適用を実行したロール（postgres）の所有となり、ACL もそのロールの既定に
-- なっていた。reconcile は SECURITY DEFINER で owner（ivrm_dashboard_owner）
-- として実行されるため、新規関数への EXECUTE が無く permission denied に
-- なった（本番適用後の確認で検出）。
-- 既存の評価経路の関数（classify / trigger / reconcile 等）と同じ
-- owner + ACL（PUBLIC / runtime / service に EXECUTE）に揃える。
-- 本番へは 2026-11-11 の適用セッションで直接適用済み。本ファイルは記録。

alter function public.notification_container_state_violation_v1(text, text)
  owner to ivrm_dashboard_owner;

grant execute on function public.notification_container_state_violation_v1(text, text)
  to public, ivrm_dashboard_runtime, ivrm_dashboard_service;
