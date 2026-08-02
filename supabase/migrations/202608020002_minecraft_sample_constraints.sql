alter table public.minecraft_samples
  drop constraint if exists minecraft_samples_public_values_check;

alter table public.minecraft_samples
  add constraint minecraft_samples_public_values_check check (
    (
      public_reachable
      and public_latency_ms is not null
      and public_version is not null
      and public_online is not null
      and public_max is not null
      and public_latency_ms between 0 and 60000
      and char_length(public_version) between 1 and 128
      and public_online between 0 and 1000000
      and public_max between 1 and 1000000
      and public_online <= public_max
    )
    or (
      not public_reachable
      and public_latency_ms is null
      and public_version is null
      and public_online is null
      and public_max is null
    )
  );

alter table public.minecraft_samples
  drop constraint if exists minecraft_samples_backend_values_check;

alter table public.minecraft_samples
  add constraint minecraft_samples_backend_values_check check (
    (
      backend_reachable
      and backend_latency_ms is not null
      and backend_version is not null
      and backend_online is not null
      and backend_max is not null
      and backend_latency_ms between 0 and 60000
      and char_length(backend_version) between 1 and 128
      and backend_online between 0 and 1000000
      and backend_max between 1 and 1000000
      and backend_online <= backend_max
    )
    or (
      not backend_reachable
      and backend_latency_ms is null
      and backend_version is null
      and backend_online is null
      and backend_max is null
    )
  );
