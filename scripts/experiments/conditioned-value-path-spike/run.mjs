import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveWorkspacePaths } from '../../config/workspace-paths.js';
import { loadCurrentTaskBundle } from '../../query/current-task-bundle.ts';
import { adaptOutput } from './facts-adapter.mjs';
import { proveConditionalValues } from './proof.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(repo, 'tmp/conditioned-value-path-spike-20260909');
const frozenFile = path.join(directory, 'frozen-208983.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(directory, { recursive: true });
if (!fs.existsSync(frozenFile)) {
  const p = resolveWorkspacePaths({ cwd: repo });
  const b = loadCurrentTaskBundle(p.factsRoot, '208983');
  if (b.issues.length || !b.manifest || !['CURRENT_L1', 'LEGACY_NOT_L1'].includes(b.state))
    throw new Error('SOURCE_BUNDLE_NOT_READABLE');
  const sqlFile = path.join(p.inputPackRoot, b.manifest.inputs.input_pack.sql_locator);
  if (sha(sqlFile) !== b.manifest.inputs.input_pack.sql_sha256) throw new Error('SQL_CHANGED');
  const projectionFile = path.join(p.projectionRoot, 'tasks/208983/task-local-projection.json');
  const projection = JSON.parse(fs.readFileSync(projectionFile, 'utf8'));
  if (projection.cacheKeyParts.factsManifestSha256 !== b.manifestSha256)
    throw new Error('BASELINE_FACTS_MISMATCH');
  const sourceFiles = [sqlFile, projectionFile, path.join(b.bundleDir, 'manifest.json'),
    ...fs.readdirSync(b.bundleDir).filter(n => n.endsWith('.jsonl.gz') || n.endsWith('.jsonl'))
      .map(n => path.join(b.bundleDir, n))];
  const sourceHashes = Object.fromEntries(sourceFiles.map(f => [f, sha(f)]));
  const frozen = { capturedAt: new Date().toISOString(), state: b.state,
    manifestSha256: b.manifestSha256, sourceHashes,
    records: b.records, baseline: projection, sql: fs.readFileSync(sqlFile, 'utf8') };
  const rechecked = loadCurrentTaskBundle(p.factsRoot, '208983');
  if (rechecked.issues.length || rechecked.manifestSha256 !== b.manifestSha256)
    throw new Error('BUNDLE_CHANGED_DURING_CAPTURE');
  for (const [f, hash] of Object.entries(sourceHashes)) if (sha(f) !== hash) throw new Error('INPUT_CHANGED_DURING_CAPTURE');
  fs.writeFileSync(frozenFile, JSON.stringify(frozen), { flag: 'wx' });
}
const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8'));
const results = [];
for (const field of ['cdp000809', 'cdp000802']) {
  try {
    const contract = adaptOutput(frozen, field);
    const proof = proveConditionalValues(contract);
    results.push({ field, baselineEdges: frozen.baseline.projection.edges
      .filter(e => e.properties.outputColumn === field).length,
      branchCount: contract.branches.length, setopCount: contract.setopCount,
      prefix: contract.prefix, controls: contract.controls, ...proof });
  } catch (error) {
    results.push({ field, status: 'NOT_EVALUABLE', reason: error.message });
  }
}
const originalsUnchanged = Object.entries(frozen.sourceHashes).every(([f, hash]) =>
  fs.existsSync(f) && sha(f) === hash);
const report = { experiment: 'CONDITIONED_VALUE_PATH_SPIKE', generatedAt: new Date().toISOString(),
  snapshotSha256: sha(frozenFile), sourceFactsState: frozen.state,
  sourceFactsManifestSha256: frozen.manifestSha256, originalsUnchanged,
  publicationEligible: false, limitations: [
    'Only two outputs of one real task; not whole-task or cross-task acceptance.',
    'JOIN/FILTER/group membership, implicit type coercion and Hive runtime behavior are not evaluated.',
    'Metamorphic tests mutate frozen structured records; they do not test SQL reparsing.',
    'The adapter is an experimental proof of evidence sufficiency, not a proposed second production SQL engine.',
  ], results };
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: path.join(directory, 'report.json'), originalsUnchanged,
  results: results.map(r => ({ field: r.field, baselineEdges: r.baselineEdges,
    branches: r.branchCount, status: r.status, reason: r.reason,
    valuePaths: r.paths?.map(p => ({ table: p.table, column: p.column, certainty: p.certainty })),
    excluded: r.exclusions?.length, gaps: r.gaps })) }, null, 2));
if (!originalsUnchanged || results.some(r => r.status !== 'PROVEN_WITHIN_SCOPE')) process.exitCode = 1;
