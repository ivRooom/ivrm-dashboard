alter table public.minecraft_metric_rollups_5m
  drop constraint if exists minecraft_metric_rollups_5m_values_check;

alter table public.minecraft_metric_rollups_5m
  add constraint minecraft_metric_rollups_5m_values_check check (
    (public_online_avg is null or public_online_avg >= 0)
    and (backend_online_avg is null or backend_online_avg >= 0)
    and (public_latency_ms_avg is null or public_latency_ms_avg >= 0)
    and (backend_latency_ms_avg is null or backend_latency_ms_avg >= 0)
    and (tps_1m_avg is null or tps_1m_avg between 0 and 1000)
    and (tps_5m_avg is null or tps_5m_avg between 0 and 1000)
    and (tps_15m_avg is null or tps_15m_avg between 0 and 1000)
    and (mspt_median_1m_avg is null or mspt_median_1m_avg between 0 and 60000)
    and (mspt_p95_1m_avg is null or mspt_p95_1m_avg between 0 and 60000)
    and (mspt_max_1m_max is null or mspt_max_1m_max between 0 and 60000)
    and performance_sample_count <= sample_count
    and (
      (
        performance_sample_count = 0
        and tps_1m_avg is null
        and tps_5m_avg is null
        and tps_15m_avg is null
        and mspt_median_1m_avg is null
        and mspt_p95_1m_avg is null
        and mspt_max_1m_max is null
      )
      or (
        performance_sample_count > 0
        and tps_1m_avg is not null
        and tps_5m_avg is not null
        and tps_15m_avg is not null
        and mspt_median_1m_avg is not null
        and mspt_p95_1m_avg is not null
        and mspt_max_1m_max is not null
        and mspt_median_1m_avg <= mspt_p95_1m_avg
        and mspt_p95_1m_avg <= mspt_max_1m_max
      )
    )
  );
