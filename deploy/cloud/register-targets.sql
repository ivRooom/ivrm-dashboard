-- Revalidate provider IDs and configure the existing EC2 Agent before use.
-- This registers observations, not servers. All targets remain disabled.
insert into public.cloud_monitor_targets(id,provider,display_name,collector_server_id,enabled) values
  ('aws-app','aws','AWS EC2 / IVRM App','aws-app-01',false),
  ('lightsail-herta','lightsail','Lightsail / Herta','aws-app-01',false),
  ('oci-minecraft','oci','OCI / Minecraft','aws-app-01',false),
  ('vercel-console','vercel','Vercel / Console','aws-app-01',false),
  ('netlify-home','netlify','Netlify / ivmz-home','oci-minecraft-01',false),
  ('cloudflare-console-dns','cloudflare','Cloudflare / Console DNS','aws-app-01',false),
  ('cloudflare-runtime-tunnel','cloudflare','Cloudflare / Runtime Tunnel','aws-app-01',false),
  ('http-console','http','Console HTTP','aws-app-01',false),
  ('http-home','http','ivmz-home HTTP','oci-minecraft-01',false),
  ('http-member','http','Member HTTP','aws-app-01',false),
  ('http-admin','http','Admin HTTP','aws-app-01',false),
  ('http-ivrm-home','http','IVRM Home HTTP','aws-app-01',false),
  ('http-api','http','IVRM API Health','aws-app-01',false),
  ('http-status','http','Public Status HTTP','oci-minecraft-01',false),
  ('http-herta','http','Herta HTTP','aws-app-01',false)
on conflict(id) do nothing;
