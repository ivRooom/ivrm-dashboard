revoke all on function public.refresh_observability_rollup_counts(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

comment on function public.refresh_observability_rollup_counts(timestamptz, timestamptz) is
  'ロールアップ更新Function内部専用。PostgRESTやService Roleから直接実行しない。';
