import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveWorkspacePaths } from '../../config/workspace-paths.ts';
import { runInputPackMachineFacts } from '../../machine-facts/input-pack-machine-facts.ts';
import { loadCurrentTaskBundle } from '../../query/current-task-bundle.ts';
import { projectTaskLocalBatch } from '../../project-graph/task-local/project-task-local-batch.ts';
import { multiCases, selectCase } from './multi-cases.mjs';
import { provePath } from './path-witness.mjs';
import { auditPathCase } from './path-case-audit.mjs';
import { adaptOutput } from './facts-adapter.mjs';
import { proveConditionalValues } from './proof.mjs';

const codeRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Permit verification of a clean release tree against the same read-only Pack.
const repo = process.env.REPLAY_WORKSPACE ? path.resolve(process.env.REPLAY_WORKSPACE) : codeRoot;
const base = path.join(repo, 'tmp/conditioned-value-path-spike-20260909');
const stage = process.argv[2];
if (!stage || !/^[a-z][a-z0-9-]{0,40}$/.test(stage)) throw new Error('EXPLICIT_REPLAY_STAGE_REQUIRED');
const output = path.join(base, 'sql-replay', stage);
if (fs.existsSync(output)) throw new Error('REPLAY_STAGE_EXISTS');
const workspace = resolveWorkspacePaths({ cwd: repo, configPath: path.join(repo, 'config/workspace-paths.json') });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = new Map(['34901', '86840', '155157', '119044', '105387', '208983'].map(t => [t,
  JSON.parse(fs.readFileSync(t === '208983' ? path.join(base, 'frozen-208983.json')
    : path.join(base, `multi-case/frozen-${t}.json`), 'utf8'))]));
const verifyOriginals = () => [...originals.values()].every(f =>
  Object.entries(f.sourceHashes).every(([file, hash]) => fs.existsSync(file) && sha(file) === hash));
if (!verifyOriginals()) throw new Error('ORIGINAL_SOURCE_CHANGED_BEFORE_REPLAY');
fs.mkdirSync(output, { recursive: true });
const factsRoot = path.join(output, 'facts');
const run = runInputPackMachineFacts({ dataRoot: workspace.inputPackRoot, outputRoot: factsRoot,
  taskIds: [...originals.keys()], noWriterCatalog: true, indexMode: 'rebuild' });
fs.writeFileSync(path.join(output, 'run.json'), JSON.stringify(run, null, 2));
console.log(JSON.stringify({ stage, tasks: run.tasks.map(t => ({ task: t.task_id, state: t.state, failures: t.failures })) }));
const loaded = new Map([...originals.keys()].map(t => [t, loadCurrentTaskBundle(factsRoot, t)]));
for (const [task, b] of loaded) {
  if (!b.manifest || b.issues.length) throw new Error(`REPLAY_BUNDLE_UNREADABLE:${task}:${JSON.stringify(b.issues)}`);
  const old = originals.get(task);
  const oldManifest = JSON.parse(fs.readFileSync(Object.keys(old.sourceHashes).find(f => f.endsWith('manifest.json'))));
  const currentSources = b.manifest.inputs.input_pack.sql_sources;
  if (JSON.stringify(currentSources) !== JSON.stringify(oldManifest.inputs.input_pack.sql_sources))
    throw new Error(`SQL_INPUTS_DRIFTED:${task}`);
}
const projected = projectTaskLocalBatch({ factsRoot, dataRoot: workspace.inputPackRoot,
  taskIds: [...originals.keys()], scheduleCacheRoot: workspace.evidenceRoot,
  outputRoot: path.join(output, 'existing-projection') });
const freshByTask = new Map([...loaded].map(([task, b]) => {
  const f = { ...originals.get(task), records: b.records, manifestSha256: b.manifestSha256,
    state: b.state, baseline: { projection: projected.results.find(r => r.taskId === task).projection } };
  fs.writeFileSync(path.join(output, `fresh-${task}.json`), JSON.stringify(f));
  return [task, f];
}));
const cases = [...multiCases, { id: 'write-union', task: '155157', field: 'Actl_Idx_Val', tail: 'root.project' }];
const results = cases.map(c => {
  const f = freshByTask.get(c.task), x = selectCase(f, c);
  const evidence = provePath(f, c.id === 'write-union' ? c.field : { relationId: x.relation.relation_id, field: c.field },
    { bindingMode: stage === 'baseline' ? 'legacy' : 'explicit' });
  const audit = auditPathCase(c.id, evidence);
  const bs = f.records['output-field-bindings.jsonl'].filter(b => b.expression_id === x.expression?.expression_id);
  const ids = new Set(bs.map(b => b.binding_id));
  const oldEdges = originals.get(c.task).baseline.projection.edges.filter(e => ids.has(e.properties.bindingId));
  const newEdges = f.baseline.projection.edges.filter(e => ids.has(e.properties.bindingId));
  const edgeState = es => es.map(e => ({ read: e.properties.sourceReadOccurrenceId ?? null,
    status: e.properties.sourceReadOccurrenceStatus ?? null }));
  return { id: c.id, task: c.task, field: c.field, audit, evidence,
    expression: x.raw?.expr_text, oldProjection: edgeState(oldEdges), rebuiltProjection: edgeState(newEdges) };
});
const pivots = ['CDP000809', 'CDP000802'].map(field => {
  const evidence = proveConditionalValues(adaptOutput(freshByTask.get('208983'), field));
  return { field, status: evidence.status, paths: evidence.paths, exclusions: evidence.exclusions.length };
});
const summary = { stage, tasks: loaded.size, sqlSourcesUnchanged: true, originalsUnchanged: verifyOriginals(),
  codeSha256: Object.fromEntries(['scripts/machine-facts/machine-facts.ts', 'scripts/machine-facts/machine-facts-contract.ts',
    'scripts/machine-facts/input-pack-machine-facts.ts', 'scripts/machine-facts/plan-scope-bindings.ts',
    'scripts/plans/source-semantics.ts'].filter(file => fs.existsSync(path.join(codeRoot, file)))
    .map(file => [file, sha(path.join(codeRoot, file))])),
  passedWithinScope: results.filter(r => r.audit.status === 'PASS_WITHIN_SCOPE').length,
  partial: results.filter(r => r.audit.status === 'PARTIAL').length,
  failed: results.filter(r => r.audit.status === 'FAIL').map(r => ({ id: r.id, failures: r.audit.failures })),
  pivotOutputs: pivots.map(r => ({ field: r.field, status: r.status, paths: r.paths.length })),
  wholeArchitectureAccepted: false };
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ summary, results, pivots }, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!summary.originalsUnchanged) process.exitCode = 1;
