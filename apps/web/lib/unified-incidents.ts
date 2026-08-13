import type { BackupType } from "./backup-report";
import {
  getBackupIncidentContext,
  type BackupIncidentContext,
} from "./backup-incident-context";
import {
  getBackupCenterSnapshot,
  type BackupCenterSnapshot,
  type BackupHistoryRun,
  type BackupTargetSnapshot,
} from "./backups";
import {
  INCIDENT_RANGE_CONFIG,
  getIncidentCenterSnapshot,
  parseIncidentRange,
  type ActiveIncident as MonitoringActiveIncident,
  type IncidentEntityType as MonitoringIncidentEntityType,
  type IncidentRange,
  type IncidentSeverity,
  type RecoveredIncident as MonitoringRecoveredIncident,
} from "./incidents";

export { INCIDENT_RANGE_CONFIG, parseIncidentRange };
export type { IncidentRange, IncidentSeverity };

export type IncidentEntityType = MonitoringIncidentEntityType | "backup";

export type BackupActiveIncident = {
  id: string;
  entityType: "backup";
  severity: IncidentSeverity;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  containerName: null;
  backupTarget: string;
  gameMode: string;
  backupType: BackupType;
  currentStatus: "degraded";
  startedAt: string | null;
  durationSeconds: number | null;
  startReason: string;
  latestTransitionAt: string | null;
  latestTransition: string | null;
  relatedEventCount: number;
  exactStart: boolean;
  detailHref: string;
  eventsHref: string;
};

export type BackupRecoveredIncident = {
  id: string;
  entityType: "backup";
  severity: IncidentSeverity;
  hostId: string;
  serverId: string;
  hostDisplayName: string;
  containerName: null;
  backupTarget: string;
  gameMode: string;
  backupType: BackupType;
  startedAt: string;
  recoveredAt: string;
  durationSeconds: number;
  startReason: string;
  recoveryReason: string;
  relatedEventCount: number;
  detailHref: string;
  eventsHref: string;
};

export type ActiveIncident = MonitoringActiveIncident | BackupActiveIncident;
export type RecoveredIncident = MonitoringRecoveredIncident | BackupRecoveredIncident;

export type UnifiedIncidentCenterSnapshot = {
  generatedAt: string;
  range: IncidentRange;
  backupDataAvailable: boolean;
  active: ActiveIncident[];
  recovered: RecoveredIncident[];
  summary: {
    activeCount: number;
    activeCriticalCount: number;
    activeWarningCount: number;
    recoveredCount: number;
    criticalEventCount: number;
    warningEventCount: number;
    exactRecoveryCount: number;
    medianRecoverySeconds: number | null;
    longestRecoverySeconds: number | null;
    affectedEntityCount: number;
    latestRecoveredAt: string | null;
    backupActiveCount: number;
    backupRecoveredCount: number;
  };
};

type ExactCandidate = {
  at: string;
};

type BackupSignalName = "run_failure" | "checksum";

type BackupEpisode = {
  startedAt: string;
  severity: IncidentSeverity;
  startReason: string;
  eventCount: number;
};

type BackupSignalState = {
  activeSignals: Set<BackupSignalName>;
  episode: BackupEpisode | null;
  consecutiveFailures: number;
};

type BackupRunEpisodes = {
  recovered: BackupRecoveredIncident[];
  openStates: Map<string, BackupSignalState>;
};

function severityRank(severity: IncidentSeverity): number {
  return severity === "critical" ? 2 : 1;
}

function maxSeverity(left: IncidentSeverity, right: IncidentSeverity): IncidentSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function durationSeconds(startedAt: string | null, endedAt: string): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 1_000);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined
    ? null
    : Math.floor((left + right) / 2);
}

function backupEntityKey(
  hostId: string,
  backupTarget: string,
  gameMode: string,
  backupType: BackupType,
): string {
  return `backup:${hostId}:${backupTarget}:${gameMode}:${backupType}`;
}

function monitoringEntityKey(incident: MonitoringActiveIncident | MonitoringRecoveredIncident): string {
  return incident.containerName
    ? `${incident.hostId}:${incident.containerName}`
    : `host:${incident.hostId}`;
}

function targetKey(target: BackupTargetSnapshot): string {
  return backupEntityKey(
    target.hostId,
    target.backupTarget,
    target.gameMode,
    target.backupType,
  );
}

function runKey(run: BackupHistoryRun): string {
  return backupEntityKey(
    run.hostId,
    run.backupTarget,
    run.gameMode,
    run.backupType,
  );
}

function contextKey(context: BackupIncidentContext): string {
  return backupEntityKey(
    context.hostId,
    context.backupTarget,
    context.gameMode,
    context.backupType,
  );
}

function backupHref(
  range: IncidentRange,
  target: Pick<BackupTargetSnapshot, "hostId" | "backupTarget" | "gameMode" | "backupType">,
): string {
  return `/backups?range=${range}#backup-target-${target.hostId}-${target.backupTarget}-${target.gameMode}-${target.backupType}`;
}

function latestTransition(target: BackupTargetSnapshot): string | null {
  const latest = target.latest;
  if (!latest) return null;
  if (latest.outcome === "failed") {
    return `Backup failed: ${latest.failureCode ?? "unknown"}`;
  }
  if (latest.outcome === "success") {
    if (latest.sha256Verified === false) return "Backup success / SHA-256 Failed";
    if (latest.sha256Verified === true) return "Backup success / SHA-256 Verified";
    return "Backup success / SHA-256 Unknown";
  }
  return `Backup ${latest.outcome}`;
}

function firstStartReason(run: BackupHistoryRun): string {
  if (run.failureCode === "checksum_failed") return "Checksum検証を伴うBackup Runが失敗";
  if (run.outcome === "failed") return `Backup失敗: ${run.failureCode ?? "unknown"}`;
  if (run.sha256Verified === false) return "SHA-256検証失敗";
  return "Backup保護シグナル異常";
}

function seedSignalState(context: BackupIncidentContext | undefined): BackupSignalState {
  const activeSignals = new Set<BackupSignalName>();
  if (!context) {
    return { activeSignals, episode: null, consecutiveFailures: 0 };
  }

  if (context.failureStartedAt) activeSignals.add("run_failure");
  if (context.checksumStartedAt) activeSignals.add("checksum");
  const starts = [context.failureStartedAt, context.checksumStartedAt]
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const startedAt = starts[0] ?? null;
  if (!startedAt) {
    return { activeSignals, episode: null, consecutiveFailures: 0 };
  }

  const checksumFirst =
    context.checksumStartedAt !== null &&
    Date.parse(context.checksumStartedAt) <= Date.parse(context.failureStartedAt ?? context.checksumStartedAt);
  const severity: IncidentSeverity =
    context.checksumStartedAt !== null || context.consecutiveFailureCount >= 2
      ? "critical"
      : "warning";

  return {
    activeSignals,
    episode: {
      startedAt,
      severity,
      startReason: checksumFirst
        ? "SHA-256検証失敗が境界以前から継続"
        : "Backup失敗が境界以前から継続",
      eventCount: context.relatedRunCount,
    },
    consecutiveFailures: context.consecutiveFailureCount,
  };
}

function deriveRunEpisodes(
  backup: BackupCenterSnapshot,
  contexts: BackupIncidentContext[],
  rangeStart: number,
  range: IncidentRange,
): BackupRunEpisodes {
  const grouped = new Map<string, BackupHistoryRun[]>();
  for (const run of backup.history) {
    if (!run.completedAt || (run.outcome !== "success" && run.outcome !== "failed")) continue;
    const key = runKey(run);
    const current = grouped.get(key) ?? [];
    current.push(run);
    grouped.set(key, current);
  }

  const contextsByKey = new Map(contexts.map((context) => [contextKey(context), context]));
  const keys = new Set([...grouped.keys(), ...contextsByKey.keys()]);
  const recovered: BackupRecoveredIncident[] = [];
  const openStates = new Map<string, BackupSignalState>();

  for (const key of keys) {
    const runs = grouped.get(key) ?? [];
    runs.sort(
      (left, right) =>
        Date.parse(left.completedAt as string) - Date.parse(right.completedAt as string) ||
        left.rowId - right.rowId,
    );
    const state = seedSignalState(contextsByKey.get(key));

    for (const run of runs) {
      const occurredAt = run.completedAt as string;
      let transitioned = false;
      let recoveryReason = "Backup成功";

      if (run.outcome === "failed") {
        state.consecutiveFailures += 1;
        state.activeSignals.add("run_failure");
        const severity: IncidentSeverity = state.consecutiveFailures >= 2 ? "critical" : "warning";
        if (!state.episode) {
          state.episode = {
            startedAt: occurredAt,
            severity,
            startReason: firstStartReason(run),
            eventCount: 0,
          };
        } else {
          state.episode.severity = maxSeverity(state.episode.severity, severity);
        }
        transitioned = true;
      }

      const checksumFailed =
        run.failureCode === "checksum_failed" ||
        (run.outcome === "success" && run.sha256Verified === false);
      if (checksumFailed) {
        state.activeSignals.add("checksum");
        if (!state.episode) {
          state.episode = {
            startedAt: occurredAt,
            severity: "critical",
            startReason: firstStartReason(run),
            eventCount: 0,
          };
        } else {
          state.episode.severity = "critical";
        }
        transitioned = true;
      }

      if (run.outcome === "success") {
        state.consecutiveFailures = 0;
        if (state.activeSignals.delete("run_failure")) transitioned = true;
        if (run.sha256Verified === true && state.activeSignals.delete("checksum")) {
          transitioned = true;
          recoveryReason = "Backup成功 / SHA-256 Verified";
        }
      }

      if (state.episode && transitioned) state.episode.eventCount += 1;
      if (!state.episode || state.activeSignals.size > 0 || run.outcome !== "success") continue;

      const episode = state.episode;
      const started = Date.parse(episode.startedAt);
      const recoveredAt = Date.parse(occurredAt);
      if (
        Number.isFinite(started) &&
        Number.isFinite(recoveredAt) &&
        recoveredAt >= started &&
        recoveredAt >= rangeStart
      ) {
        const detailHref = backupHref(range, run);
        recovered.push({
          id: `recovered-backup:${runKey(run)}:${episode.startedAt}:${run.rowId}`,
          entityType: "backup",
          severity: episode.severity,
          hostId: run.hostId,
          serverId: run.serverId,
          hostDisplayName: run.hostDisplayName,
          containerName: null,
          backupTarget: run.backupTarget,
          gameMode: run.gameMode,
          backupType: run.backupType,
          startedAt: episode.startedAt,
          recoveredAt: occurredAt,
          durationSeconds: Math.floor((recoveredAt - started) / 1_000),
          startReason: episode.startReason,
          recoveryReason,
          relatedEventCount: episode.eventCount,
          detailHref,
          eventsHref: detailHref,
        });
      }
      state.episode = null;
    }

    if (state.episode && state.activeSignals.size > 0) openStates.set(key, state);
  }

  return { recovered, openStates };
}

function deriveActiveBackupIncidents(
  backup: BackupCenterSnapshot,
  runEpisodes: BackupRunEpisodes,
  range: IncidentRange,
): BackupActiveIncident[] {
  const historyByTarget = new Map<string, BackupHistoryRun[]>();
  for (const run of backup.history) {
    const key = runKey(run);
    const current = historyByTarget.get(key) ?? [];
    current.push(run);
    historyByTarget.set(key, current);
  }

  return backup.targets.flatMap((target): BackupActiveIncident[] => {
    if (target.health !== "warning" && target.health !== "critical") return [];

    const exactCandidates: ExactCandidate[] = [];
    let hasPolicyDependentSignal = false;
    const latest = target.latest;
    const success = target.latestSuccess;
    const now = Date.parse(backup.generatedAt);
    const runState = runEpisodes.openStates.get(targetKey(target));

    if (runState?.episode) exactCandidates.push({ at: runState.episode.startedAt });
    if (success?.sha256Verified === null) exactCandidates.push({ at: success.completedAt });
    if (success?.retentionExpiresAt && Date.parse(success.retentionExpiresAt) <= now) {
      exactCandidates.push({ at: success.retentionExpiresAt });
    }
    if (latest?.outcome === "running" || latest?.outcome === "unknown") {
      exactCandidates.push({ at: latest.startedAt });
    }

    if (
      target.backupAgeSeconds !== null &&
      target.backupAgeSeconds > target.warningAfterSeconds
    ) {
      hasPolicyDependentSignal = true;
    }
    if (
      target.remoteSyncPending &&
      success &&
      now - Date.parse(success.completedAt) > target.remoteSyncWarningSeconds * 1_000
    ) {
      hasPolicyDependentSignal = true;
    }
    if (target.restoreReadiness === "warning") hasPolicyDependentSignal = true;

    const exactStart = exactCandidates.length > 0 && !hasPolicyDependentSignal;
    const startedAt = exactStart
      ? exactCandidates
          .map((candidate) => candidate.at)
          .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
      : null;
    const latestTransitionAt = latest?.completedAt ?? latest?.startedAt ?? success?.completedAt ?? null;
    const relatedRuns = historyByTarget.get(targetKey(target)) ?? [];
    const detailHref = backupHref(range, target);

    return [{
      id: `active-backup:${target.policyId}`,
      entityType: "backup",
      severity: target.health,
      hostId: target.hostId,
      serverId: target.serverId,
      hostDisplayName: target.hostDisplayName,
      containerName: null,
      backupTarget: target.backupTarget,
      gameMode: target.gameMode,
      backupType: target.backupType,
      currentStatus: "degraded",
      startedAt,
      durationSeconds: durationSeconds(startedAt, backup.generatedAt),
      startReason: target.healthReasons.join(" / "),
      latestTransitionAt,
      latestTransition: latestTransition(target),
      relatedEventCount: relatedRuns.length + (runState?.episode?.eventCount ?? 0),
      exactStart,
      detailHref,
      eventsHref: detailHref,
    }];
  });
}

function sortActive(active: ActiveIncident[]): ActiveIncident[] {
  return active.sort((left, right) => {
    const severityDiff = severityRank(right.severity) - severityRank(left.severity);
    if (severityDiff !== 0) return severityDiff;
    const leftStart = left.startedAt ? Date.parse(left.startedAt) : Number.POSITIVE_INFINITY;
    const rightStart = right.startedAt ? Date.parse(right.startedAt) : Number.POSITIVE_INFINITY;
    return leftStart - rightStart;
  });
}

function backupContextBoundary(backup: BackupCenterSnapshot): string {
  const earliestStartedAt = backup.history
    .map((run) => run.startedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  return earliestStartedAt ?? backup.generatedAt;
}

export async function getUnifiedIncidentCenterSnapshot(
  range: IncidentRange,
): Promise<UnifiedIncidentCenterSnapshot> {
  const basePromise = getIncidentCenterSnapshot(range);
  const backupPromise = getBackupCenterSnapshot("30d")
    .then(async (backup) => {
      const context = await getBackupIncidentContext(backupContextBoundary(backup));
      return { ok: true as const, backup, context };
    })
    .catch((error: unknown) => {
      console.error("Incident CenterのBackup情報取得に失敗しました", error);
      return { ok: false as const, backup: null, context: [] as BackupIncidentContext[] };
    });

  const [base, backupResult] = await Promise.all([basePromise, backupPromise]);
  if (!backupResult.ok || !backupResult.backup) {
    return {
      ...base,
      backupDataAvailable: false,
      summary: {
        ...base.summary,
        backupActiveCount: 0,
        backupRecoveredCount: 0,
      },
    };
  }

  const backup = backupResult.backup;
  const rangeStart =
    Date.parse(base.generatedAt) -
    INCIDENT_RANGE_CONFIG[range].hours * 3_600_000;
  const runEpisodes = deriveRunEpisodes(backup, backupResult.context, rangeStart, range);
  const backupActive = deriveActiveBackupIncidents(backup, runEpisodes, range);
  const backupRecovered = runEpisodes.recovered;
  const active = sortActive([...base.active, ...backupActive]);
  const recovered: RecoveredIncident[] = [...base.recovered, ...backupRecovered].sort(
    (left, right) => Date.parse(right.recoveredAt) - Date.parse(left.recoveredAt),
  );
  const durations = recovered.map((incident) => incident.durationSeconds);
  const affected = new Set<string>();

  for (const incident of active) {
    affected.add(
      incident.entityType === "backup"
        ? backupEntityKey(
            incident.hostId,
            incident.backupTarget,
            incident.gameMode,
            incident.backupType,
          )
        : monitoringEntityKey(incident),
    );
  }
  for (const incident of recovered) {
    affected.add(
      incident.entityType === "backup"
        ? backupEntityKey(
            incident.hostId,
            incident.backupTarget,
            incident.gameMode,
            incident.backupType,
          )
        : monitoringEntityKey(incident),
    );
  }

  return {
    generatedAt: base.generatedAt,
    range,
    backupDataAvailable: true,
    active,
    recovered,
    summary: {
      activeCount: active.length,
      activeCriticalCount: active.filter((incident) => incident.severity === "critical").length,
      activeWarningCount: active.filter((incident) => incident.severity === "warning").length,
      recoveredCount: recovered.length,
      criticalEventCount: base.summary.criticalEventCount,
      warningEventCount: base.summary.warningEventCount,
      exactRecoveryCount: recovered.length,
      medianRecoverySeconds: median(durations),
      longestRecoverySeconds: durations.length ? Math.max(...durations) : null,
      affectedEntityCount: affected.size,
      latestRecoveredAt: recovered[0]?.recoveredAt ?? null,
      backupActiveCount: backupActive.length,
      backupRecoveredCount: backupRecovered.length,
    },
  };
}
