alter table public.notification_signal_state
  drop constraint if exists notification_signal_href_check;
alter table public.notification_signal_state
  add constraint notification_signal_href_check
  check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/[A-Za-z0-9_./?=&%:+#-]*$'
  );

alter table public.notification_outbox
  drop constraint if exists notification_outbox_href_check;
alter table public.notification_outbox
  add constraint notification_outbox_href_check
  check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/[A-Za-z0-9_./?=&%:+#-]*$'
  );

do $$
declare
  v_old text := 'p_detail_href !~ ''^/[A-Za-z0-9_./?=&%:+#-]{0,1000}$''';
  v_new text := '(char_length(p_detail_href) > 1001 or p_detail_href !~ ''^/[A-Za-z0-9_./?=&%:+#-]*$'')';
  v_function text;
begin
  v_function := pg_get_functiondef(
    'public.enqueue_notification_v1(text,text,text,uuid,text,text,text,text,text,text,text,text,text,timestamptz)'::regprocedure
  );
  if position(v_old in v_function) = 0 then
    raise exception 'enqueue_notification_v1 href validation pattern not found';
  end if;
  execute replace(v_function, v_old, v_new);

  v_function := pg_get_functiondef(
    'public.apply_notification_signal_v1(text,text,uuid,text,text,text,text,text,boolean,text,timestamptz,text,text,text)'::regprocedure
  );
  if position(v_old in v_function) = 0 then
    raise exception 'apply_notification_signal_v1 href validation pattern not found';
  end if;
  execute replace(v_function, v_old, v_new);
end;
$$;

comment on constraint notification_signal_href_check on public.notification_signal_state is
  'detail_hrefは相対URLのみ。長さ上限と許可文字を別々に検証し、PostgreSQL regexの反復上限へ依存しない。';
comment on constraint notification_outbox_href_check on public.notification_outbox is
  'detail_hrefは相対URLのみ。長さ上限と許可文字を別々に検証し、PostgreSQL regexの反復上限へ依存しない。';