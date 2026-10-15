import type { ShrinkReport, ShrinkReportEntry, TargetTableCausalClosureArtifact } from "./artifact-contract.ts";

export interface TargetTableCausalHtmlOptions {
  readonly fieldLineageHtmlHref?: string;
}

function formatTier(title: string, entries: readonly ShrinkReportEntry[]): string[] {
  if (entries.length === 0) return [`${title}: (empty)`];
  return [
    `${title}:`,
    ...entries.map((entry) =>
      `  ${entry.taskId} ${entry.table ?? ""}  via ${entry.viaFields.join(",") || "(none)"}  witness ${entry.witness.slice(0, 3).join(",") || "(none)"}`,
    ),
  ];
}

function formatMultiplicity(entries: readonly ShrinkReportEntry[]): string[] {
  const header = `档三 倍增风险（默认折叠，不单独构成必查）: ${entries.length}`;
  if (entries.length === 0) return [header];
  return [
    header,
    ...entries.map((entry) =>
      `  ${entry.taskId} ${entry.table ?? ""}  JOIN ${entry.joinNode ?? "(none)"}  keys ${entry.viaFields.join(",") || "(none)"}  witness ${entry.witness.slice(0, 3).join(",") || "(none)"}`,
    ),
  ];
}

function formatPruned(report: ShrinkReport): string[] {
  const lines = [`档四 本轮证不出 / 未进入确定集: ${report.prunedCount}`];
  for (const reason of report.prunedReasons) {
    lines.push(`  ${reason.reasonCode} ${reason.count}`);
    for (const sample of reason.samples ?? []) {
      lines.push(`    ${sample.taskId ?? "(no-task)"} ${sample.table ?? ""}`.trimEnd());
    }
  }
  return lines;
}

export function formatTargetTableCausalSummary(artifact: TargetTableCausalClosureArtifact): string {
  const m = artifact.metrics;
  const rate = m.decisionCoverage.rate.toFixed(3);
  const report = artifact.shrinkReport;
  return [
    `Target table causal closure: ${artifact.targetWrite.identity.taskId} ${artifact.targetWrite.identity.targetTableKey}`,
    `status: assessments=${m.assessmentCount}, branches=${m.candidateBranchCount}, upstreamTasks=${m.upstreamTaskCount}`,
    `minimumCertainSet: ${artifact.minimumCertainTaskIds.join(",") || "(empty)"}`,
    `conservativeSafetySet: ${artifact.conservativeSafetyTaskIds.join(",") || "(empty)"}`,
    `decisionCoverage: ${m.decisionCoverage.numerator}/${m.decisionCoverage.denominator} (${rate})`,
    `evidenceClosure: ${m.evidenceClosureRate === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : `${(m.evidenceClosureRate * 100).toFixed(1)}%`}`,
    `writeScopedConfirmed: ${m.writeScopedConfirmedCount ?? "NOT_EVALUATED"}/${m.confirmedAssessmentCount ?? "NOT_EVALUATED"}`,
    `crossChannelConfirmedBranches: ${m.crossChannelConfirmedBranchCount ?? "NOT_EVALUATED"}`,
    `crossWriteScopeLeaks: ${m.crossWriteScopeLeakCount ?? "NOT_EVALUATED"}`,
    `unknownReasons: ${Object.entries(m.unknownReasonCounts ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => `${reason}=${count}`).join(",") || "(none)"}`,
    `runtimeRerunDecision: ${artifact.runtimeRerunDecision}`,
    `gaps: ${artifact.gaps.length}`,
    ...(report
      ? [
          "",
          ...formatTier("档一 值必达", report.valueCertain),
          ...formatTier("档二 行决定", report.rowDetermining),
          ...formatMultiplicity(report.multiplicityRisk),
          ...formatPruned(report),
        ]
      : []),
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatWitnessCell(witness: readonly string[]): string {
  if (witness.length === 0) return "(none)";
  const preview = witness.slice(0, 3).join(", ");
  const full = witness.join(", ");
  if (witness.length <= 3) return escapeHtml(full);
  return `<span title="${escapeHtml(full)}">${escapeHtml(preview)}…</span> <details><summary>+${witness.length - 3}</summary><pre>${escapeHtml(full)}</pre></details>`;
}

function renderShrinkTierTable(entries: readonly ShrinkReportEntry[], includeJoinNode: boolean): string {
  if (entries.length === 0) {
    return "<p>(empty)</p>";
  }
  const joinHeader = includeJoinNode ? "<th>JOIN 节点</th>" : "";
  const rows = entries.map((entry) => {
    const joinCell = includeJoinNode
      ? `<td>${entry.joinNode ? `<code title="${escapeHtml(entry.joinNode)}">${escapeHtml(entry.joinNode.length > 48 ? `${entry.joinNode.slice(0, 48)}…` : entry.joinNode)}</code>` : "(none)"}</td>`
      : "";
    return `<tr>
      <td>${escapeHtml(entry.taskId)}</td>
      <td>${escapeHtml(entry.table ?? "")}</td>
      <td>${escapeHtml(entry.viaFields.join(", ") || "(none)")}</td>
      <td>${escapeHtml(entry.channel)}</td>
      ${joinCell}
      <td>${formatWitnessCell(entry.witness)}</td>
    </tr>`;
  }).join("");
  return `<table><thead><tr><th>任务号</th><th>表</th><th>via 字段</th><th>通道</th>${joinHeader}<th>witness</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMetricsBlock(artifact: TargetTableCausalClosureArtifact): string {
  const m = artifact.metrics;
  const rate = m.decisionCoverage.rate.toFixed(3);
  const evidenceClosure = m.evidenceClosureRate === "NOT_APPLICABLE"
    ? "NOT_APPLICABLE"
    : `${(m.evidenceClosureRate * 100).toFixed(1)}%`;
  const rows = [
    ["assessments / branches / upstreamTasks", `${m.assessmentCount} / ${m.candidateBranchCount} / ${m.upstreamTaskCount}`],
    ["minimumCertainSet", artifact.minimumCertainTaskIds.join(", ") || "(empty)"],
    ["conservativeSafetySet", artifact.conservativeSafetyTaskIds.join(", ") || "(empty)"],
    ["decisionCoverage", `${m.decisionCoverage.numerator}/${m.decisionCoverage.denominator} (${rate})`],
    ["evidenceClosure", evidenceClosure],
    ["writeScopedConfirmed", `${m.writeScopedConfirmedCount ?? "NOT_EVALUATED"}/${m.confirmedAssessmentCount ?? "NOT_EVALUATED"}`],
    ["crossChannelConfirmedBranches", String(m.crossChannelConfirmedBranchCount ?? "NOT_EVALUATED")],
    ["crossWriteScopeLeaks", String(m.crossWriteScopeLeakCount ?? "NOT_EVALUATED")],
    ["runtimeRerunDecision", artifact.runtimeRerunDecision],
    ["gaps", String(artifact.gaps.length)],
  ];
  return `<table class="metrics"><tbody>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>`;
}

export function renderTargetTableCausalHtml(
  artifact: TargetTableCausalClosureArtifact,
  options: TargetTableCausalHtmlOptions = {},
): string {
  const report = artifact.shrinkReport;
  const identity = artifact.targetWrite.identity;
  const valueCertain = report?.valueCertain ?? [];
  const rowDetermining = report?.rowDetermining ?? [];
  const multiplicity = report?.multiplicityRisk ?? [];
  const prunedRows = (report?.prunedReasons ?? []).map((reason) => {
    const samples = (reason.samples ?? [])
      .map((sample) => `${sample.taskId ?? "(no-task)"} ${sample.table ?? ""}`.trim())
      .join("; ");
    return `<tr><td>${escapeHtml(reason.reasonCode)}</td><td>${reason.count}</td><td>${escapeHtml(samples || "(none)")}</td></tr>`;
  }).join("");
  const fieldLineageLink = options.fieldLineageHtmlHref
    ? `<p><a href="${escapeHtml(options.fieldLineageHtmlHref)}">字段血缘 HTML（含 Facts / SQL span 溯源）</a></p>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Target Table Causal Closure ${escapeHtml(identity.taskId)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #17212b; line-height: 1.45; }
    h1, h2 { margin-top: 1.5rem; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 0.75rem 0 1.25rem; }
    th, td { border: 1px solid #d9dee3; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #eef2f5; }
    table.metrics th { width: 16rem; font-weight: 600; }
    pre { background: #f4f6f8; padding: 0.75rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
    details { margin: 0.5rem 0; }
    summary { cursor: pointer; font-weight: 600; }
    .meta { color: #425466; }
    code { font-size: 12px; }
  </style>
</head>
<body>
  <h1>目标表上游因果闭包</h1>
  <p class="meta"><strong>taskId</strong>: ${escapeHtml(identity.taskId)} · <strong>目标表</strong>: ${escapeHtml(identity.targetTableKey)} · <strong>write-observation-id</strong>: ${escapeHtml(identity.writeObservationId)}</p>
  <p class="meta"><strong>档一</strong> = 根任务 + field-lineage <code>VALUE_FLOW</code> 上游（值必达） · <strong>档二</strong> = JOIN/WHERE 行集（行决定）</p>
  ${fieldLineageLink}
  ${renderMetricsBlock(artifact)}
  <h2>档一 值必达 (${valueCertain.length}，含根)</h2>
  ${renderShrinkTierTable(valueCertain, false)}
  <h2>档二 行决定 (${rowDetermining.length})</h2>
  ${renderShrinkTierTable(rowDetermining, false)}
  <details>
    <summary>档三 倍增风险（默认折叠）: ${multiplicity.length}</summary>
    ${renderShrinkTierTable(multiplicity, true)}
  </details>
  <h2>档四 本轮证不出 / 未进入确定集 (${report?.prunedCount ?? 0})</h2>
  <p>未进入确定集的候选，按原因分组展示计数与样本。</p>
  <table>
    <thead><tr><th>原因码</th><th>计数</th><th>样本</th></tr></thead>
    <tbody>${prunedRows}</tbody>
  </table>
</body>
</html>`;
}
