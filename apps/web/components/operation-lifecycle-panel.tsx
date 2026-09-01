"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import styles from "../app/operations/operations.module.css";

type JobStatus = "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
type Action = "start_backend" | "restart_backend" | "stop_backend";

type Job = {
  id: string;
  action: Action;
  status: JobStatus;
  confirmationVerified: boolean;
  phase: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type ActionConfig = {
  action: Action;
  label: string;
  description: string;
  allowed: boolean;
  confirmationPhrase: string | null;
  requiredRoleLabel: string;
};

type Props = {
  initialJobs: Job[];
  actions: ActionConfig[];
  requestsEnabled: boolean;
};

const ACTIVE = new Set<JobStatus>(["queued", "leased", "running"]);
const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "QUEUED",
  leased: "LEASED",
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  expired: "EXPIRED",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

export function OperationLifecyclePanel({ initialJobs, actions, requestsEnabled }: Props) {
  const [jobs, setJobs] = useState(initialJobs);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const hasActiveJob = useMemo(() => jobs.some((job) => ACTIVE.has(job.status)), [jobs]);

  const refresh = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    const response = await fetch("/api/operations/jobs", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const body = await response.json() as { jobs?: Job[] };
    if (Array.isArray(body.jobs)) setJobs(body.jobs);
  }, []);

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, refresh]);

  function submit(config: ActionConfig) {
    startTransition(async () => {
      setMessage(null);
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/operations/jobs", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          target: "mc-main",
          action: config.action,
          confirmation: config.confirmationPhrase ? confirmations[config.action] ?? "" : null,
          payload: {},
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setMessage(response.status === 409 ? "別のMinecraft排他操作が実行中です。" : `操作要求を受理できませんでした (${body.error ?? response.status})`);
        await refresh();
        return;
      }
      setMessage("Operation Jobを受け付けました。状態を追跡します。");
      setConfirmations((current) => ({ ...current, [config.action]: "" }));
      await refresh();
    });
  }

  return (
    <div className={styles.lifecycleStack}>
      <div className={styles.operationGrid}>
        {actions.map((config) => {
          const confirmationMatches = !config.confirmationPhrase || confirmations[config.action] === config.confirmationPhrase;
          const disabled = !requestsEnabled || !config.allowed || isPending || hasActiveJob || !confirmationMatches;
          return (
            <article className={styles.operationCard} key={config.action}>
              <div>
                <p className={styles.capabilityType}>{config.action}</p>
                <h3>{config.label}</h3>
                <p className={styles.capabilityDescription}>{config.description}</p>
                <p className={styles.operationMeta}>対象: mc-main / 必要ロール: {config.requiredRoleLabel}</p>
              </div>
              {config.confirmationPhrase ? (
                <label className={styles.confirmationField}>
                  <span>確認文字列: {config.confirmationPhrase}</span>
                  <input
                    autoComplete="off"
                    value={confirmations[config.action] ?? ""}
                    onChange={(event) => setConfirmations((current) => ({ ...current, [config.action]: event.target.value }))}
                    disabled={!requestsEnabled || !config.allowed || isPending || hasActiveJob}
                  />
                </label>
              ) : null}
              <button className={styles.operationButton} disabled={disabled} onClick={() => submit(config)} type="button">
                {requestsEnabled ? (config.allowed ? "実行要求" : "権限なし") : "Production gate OFF"}
              </button>
            </article>
          );
        })}
      </div>

      {message ? <p className={styles.operationMessage} role="status">{message}</p> : null}

      <div className={styles.progressPanel}>
        <div className={styles.progressHeader}>
          <div>
            <p className={styles.capabilityType}>OPERATION PROGRESS</p>
            <h3>最近のmc-main操作</h3>
          </div>
          <a href="/logs?source=mc-main">Read-only Log Viewer</a>
        </div>
        {jobs.length === 0 ? (
          <p className={styles.emptyProgress}>Operation Jobはまだありません。</p>
        ) : (
          <div className={styles.jobList}>
            {jobs.map((job) => (
              <article className={styles.jobRow} key={job.id}>
                <div>
                  <strong>{job.action}</strong>
                  <span>{formatTime(job.createdAt)}</span>
                </div>
                <div>
                  <span className={`${styles.jobStatus} ${ACTIVE.has(job.status) ? styles.jobStatusActive : ""}`}>{STATUS_LABEL[job.status]}</span>
                  <span>{job.phase && job.errorCode ? `${job.phase} / ${job.errorCode}` : job.phase ?? job.errorCode ?? "—"}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
