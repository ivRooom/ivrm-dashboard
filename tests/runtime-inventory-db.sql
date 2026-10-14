do $$ declare payload jsonb; result text; stamp timestamptz:=clock_timestamp(); begin
  select jsonb_agg(jsonb_build_object('name',name,'collection','ok','state','running','health','none','restartCount',0,'oomKilled',false,'exitCode',0,'image','registry.example/service:commit','imageId','sha256:'||repeat('a',64))) into payload
  from unnest(array['ivrm-admin','ivrm-api','ivrm-home','ivrm-member','ivrm-contact','ivrm-cloudflared','ivrm-runtime-caddy','ivrm-runtime-health']) name;
  result:=public.ingest_runtime_inventory_v1('aws-app-01',stamp,repeat('a',32),payload);
  if result<>'accepted' then raise exception 'expected accepted, got %',result; end if;
  if public.ingest_runtime_inventory_v1('aws-app-01',stamp,repeat('b',32),payload)<>'replayed_request' then raise exception 'observation replay accepted'; end if;
  if public.ingest_runtime_inventory_v1('aws-app-01',stamp+interval '1 second',repeat('b',32),payload)<>'rate_limited' then raise exception 'rate limit failed'; end if;
  if public.ingest_runtime_inventory_v1('lightsail-herta',stamp,repeat('b',32),payload)<>'unknown_agent' then raise exception 'disabled host accepted'; end if;
  if public.ingest_runtime_inventory_v1('unexpected-host',stamp,repeat('b',32),payload)<>'target_not_allowed' then raise exception 'unknown host accepted'; end if;
  if public.ingest_runtime_inventory_v1('aws-app-01',stamp,repeat('b',32),jsonb_set(payload,'{0,env}','"secret"'))<>'invalid_payload' then raise exception 'secret field accepted'; end if;
  if public.ingest_runtime_inventory_v1('aws-app-01',stamp,repeat('b',32),jsonb_set(payload,'{0,name}','"mc-main"'))<>'target_not_allowed' then raise exception 'cross-host target accepted'; end if;
  if public.ingest_runtime_inventory_v1('aws-app-01',stamp,repeat('b',32),payload-0)<>'invalid_payload' then raise exception 'missing observation accepted'; end if;
  if has_function_privilege('anon','public.ingest_runtime_inventory_v1(text,timestamptz,text,jsonb)','execute') or has_table_privilege('authenticated','public.runtime_inventory','select') then raise exception 'public access'; end if;
  update public.runtime_inventory set received_at=clock_timestamp()-interval '16 seconds';
  if public.ingest_runtime_inventory_v1('aws-app-01',stamp+interval '1 second',repeat('c',32),payload)<>'accepted' then raise exception 'update failed'; end if;
  if (select count(*) from public.runtime_inventory)<>1 then raise exception 'unbounded history'; end if;
end $$;
