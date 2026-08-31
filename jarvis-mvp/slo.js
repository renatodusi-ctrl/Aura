export const PRESENCE_SLO_TARGETS = {
  statusP95Ms: 250,
  nowP95Ms: 250,
  cancelP95Ms: 1500,
  stuckProcesses: 0,
  inconsistentSnapshots: 0
};

export function percentile(values, percentileRank) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[index];
}

export function summarizeLatencies(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values.length ? Math.max(...values) : 0
  };
}

export function evaluatePresenceSlo(report, targets = PRESENCE_SLO_TARGETS) {
  const failures = [];
  if (report.status?.p95Ms > targets.statusP95Ms) {
    failures.push(`status p95 ${report.status.p95Ms}ms acima de ${targets.statusP95Ms}ms`);
  }
  if (report.now?.p95Ms > targets.nowP95Ms) {
    failures.push(`now p95 ${report.now.p95Ms}ms acima de ${targets.nowP95Ms}ms`);
  }
  if (report.cancel?.p95Ms > targets.cancelP95Ms) {
    failures.push(`cancel p95 ${report.cancel.p95Ms}ms acima de ${targets.cancelP95Ms}ms`);
  }
  if ((report.stuckProcesses || 0) > targets.stuckProcesses) {
    failures.push(`${report.stuckProcesses} processo(s) preso(s) apos cancelamento`);
  }
  if ((report.inconsistentSnapshots || 0) > targets.inconsistentSnapshots) {
    failures.push(`${report.inconsistentSnapshots} snapshot(s) /api/status vs /api/now inconsistente(s)`);
  }
  return {
    pass: failures.length === 0,
    failures,
    targets
  };
}

export function buildPresenceSloReport(samples = [], cancelSamples = [], processSummary = {}) {
  const statusLatencies = samples.filter((sample) => sample.endpoint === "/api/status").map((sample) => sample.latencyMs);
  const nowLatencies = samples.filter((sample) => sample.endpoint === "/api/now").map((sample) => sample.latencyMs);
  return {
    generatedAt: new Date().toISOString(),
    status: summarizeLatencies(statusLatencies),
    now: summarizeLatencies(nowLatencies),
    cancel: summarizeLatencies(cancelSamples),
    stuckProcesses: processSummary.total || 0,
    activeProcesses: processSummary,
    inconsistentSnapshots: samples.filter((sample) => sample.consistent === false).length
  };
}
