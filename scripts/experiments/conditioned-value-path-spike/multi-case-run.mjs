import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveWorkspacePaths } from '../../config/workspace-paths.js';
import { loadCurrentTaskBundle } from '../../query/current-task-bundle.ts';
import { adaptOutput } from './facts-adapter.mjs';
import { proveConditionalValues } from './proof.mjs';
import { describeOutput } from './output-description.mjs';
import { multiCases, selectCase } from './multi-cases.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(repo, 'tmp/conditioned-value-path-spike-20260909/multi-case');
const p = resolveWorkspacePaths({ cwd: repo });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(directory, { recursive: true });
const frozenByTask = new Map();
for (const task of new Set(multiCases.map(c => c.task))) {
  const file = path.join(directory, `frozen-${task}.json`);
  if (!fs.existsSync(file)) {
    const b = loadCurrentTaskBundle(p.factsRoot, task);
    if (b.issues.length || !b.manifest) throw new Error(`SOURCE_NOT_READABLE:${task}`);
    const sqlFile = path.join(p.inputPackRoot, b.manifest.inputs.input_pack.sql_locator);
    if (sha(sqlFile) !== b.manifest.inputs.input_pack.sql_sha256) throw new Error(`SQL_CHANGED:${task}`);
    const projectionFile = path.join(p.projectionRoot, `tasks/${task}/task-local-projection.json`);
    const baseline = JSON.parse(fs.readFileSync(projectionFile, 'utf8'));
    if (baseline.cacheKeyParts.factsManifestSha256 !== b.manifestSha256) throw new Error(`BASELINE_STALE:${task}`);
    const files = [sqlFile, projectionFile, path.join(b.bundleDir, 'manifest.json'),
      ...fs.readdirSync(b.bundleDir).filter(n => n.endsWith('.jsonl.gz') || n.endsWith('.jsonl'))
        .map(n => path.join(b.bundleDir, n))];
    const sourceHashes = Object.fromEntries(files.map(f => [f, sha(f)]));
    const again = loadCurrentTaskBundle(p.factsRoot, task);
    if (again.issues.length || again.manifestSha256 !== b.manifestSha256) throw new Error('CAPTURE_CHANGED');
    const frozen = { task, state: b.state, manifestSha256: b.manifestSha256,
      records: b.records, baseline, sourceHashes, sql: fs.readFileSync(sqlFile, 'utf8') };
    if (!files.every(f => sha(f) === sourceHashes[f])) throw new Error('CAPTURE_CHANGED');
    fs.writeFileSync(file, JSON.stringify(frozen), { flag: 'wx' });
  }
  frozenByTask.set(task, JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function describeUnion(frozen, r, field) {
  const byId = new Map(frozen.records['relation-nodes.jsonl'].map(r => [r.relation_id, r]));
  const names = r.relation.output_columns;
  const ordinals = names.flatMap((n, i) => n.toLowerCase() === field.toLowerCase() ? [i] : []);
  if (ordinals.length !== 1) throw new Error('UNION_OUTPUT_NOT_UNIQUE');
  const branches = [], active = new Set();
  function visit(id, path) {
    if (active.has(id)) throw new Error('UNION_CYCLE');
    active.add(id);
    const n = byId.get(id);
    if (!n || n.statement_id !== r.statement_id) throw new Error('UNION_BRANCH_MISSING');
    if (n.relation_type === 'setop') {
      if (n.relation.setop !== 'union' || n.relation.all !== true) throw new Error('UNION_KIND_UNSUPPORTED');
      n.relation.branches.forEach((b, i) => visit(b, [...path, i]));
    } else {
      const raw = (n.relation.expressions ?? [])[ordinals[0]];
      if (!raw) throw new Error('UNION_EXPRESSION_MISSING');
      branches.push({ relationId: id, branchPath: path, expression: raw.expr_text,
        ...describeOutput(raw.structured_expression) });
    }
  }
  visit(r.relation_id, []);
  return { generation: 'UNION_OUTPUT', branches, physicalPaths: 'NOT_EVALUATED', publicationEligible: false };
}

const results = multiCases.map(c => {
  const f = frozenByTask.get(c.task), { relation, expression, raw } = selectCase(f, c);
  const description = c.relationOnly ? describeUnion(f, relation, c.field)
    : describeOutput(raw?.structured_expression, expression.window_spec);
  const bindings = f.records['output-field-bindings.jsonl'].filter(b => b.expression_id === expression?.expression_id);
  const bindingIds = new Set(bindings.map(b => b.binding_id));
  const sameOutputEdges = f.baseline.projection.edges.filter(e => e.properties.outputColumn === c.field.toLowerCase());
  const exactEdges = sameOutputEdges.filter(e => bindingIds.has(e.properties.bindingId));
  let pathExperiment;
  if (description.fieldPathApplicability === 'NO_PHYSICAL_FIELD_INPUT'
      && description.generation === c.expected) {
    pathExperiment = { status: 'NOT_APPLICABLE', reason: 'NO_PHYSICAL_FIELD_INPUT' };
  } else {
    try {
      pathExperiment = proveConditionalValues(adaptOutput(f, c.field));
    } catch (error) { pathExperiment = { status: 'NOT_EVALUABLE', reason: error.message }; }
  }
  return { ...c, factExpressionId: expression?.expression_id ?? null, relationId: relation.relation_id,
    sqlExpression: expression?.expression_text ?? null, locus: bindings.length ? 'WRITE_OUTPUT' : 'INTERNAL_RELATION',
    description, expressionShapeMatchesExpected: description.generation === c.expected,
    physicalSummaryCount: expression?.input_fields?.length ?? null,
    oldProjection: { exactBindingEdges: exactEdges.length, sameNamedOutputEdges: sameOutputEdges.length,
      statuses: [...new Set(exactEdges.map(e => e.properties.sourceReadOccurrenceStatus))] },
    pathExperiment: { status: pathExperiment.status, reason: pathExperiment.reason ?? null },
  };
});
const originalsUnchanged = [...frozenByTask.values()].every(f =>
  Object.entries(f.sourceHashes).every(([file, hash]) => fs.existsSync(file) && sha(file) === hash));
const report = { generatedAt: new Date().toISOString(), taskCount: frozenByTask.size, caseCount: results.length,
  originalsUnchanged, wholeArchitectureAccepted: false,
  descriptionMatches: results.filter(r => r.expressionShapeMatchesExpected).length,
  semanticMismatches: results.filter(r => !r.expressionShapeMatchesExpected).map(r => r.id),
  additionalFullPathProofs: results.filter(r => r.pathExperiment.status === 'PROVEN_WITHIN_SCOPE').length,
  limitations: ['Expression description checks are not end-to-end path acceptance.',
    'The original MAX/CASE/UNION proof is deliberately not extended with case-specific fallbacks.',
    'SYSDATE column interpretation is retained as a detected upstream error, not repaired in presentation.'], results };
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
const lines = ['# 多类型真实案例验证', '',
  `新增 ${report.taskCount} 个任务、${report.caseCount} 个案例。正式输入和投影未变：${originalsUnchanged}。`, '',
  '**这是一轮覆盖面和缺口验证，不是通用路径引擎验收。**', '',
  '表达式说明能否从 Facts 提取，与新路径算法能否完整接通，分别记录。', '',
  '| 类型 | 任务 / 字段 | 预期生成方式 | Facts 结构识别 | 原投影对应绑定的边数 | 新路径实验 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...results.map(r => `| ${r.label} | ${r.task} / ${r.field} | ${r.expected} | ${r.description.operation === 'DIRECT_ASSIGNMENT' ? `DIRECT_ASSIGNMENT / ${r.description.generation}` : r.description.generation}${r.expressionShapeMatchesExpected ? '' : '（不符）'} | ${r.locus === 'INTERNAL_RELATION' ? '内部表达式，不按边数判缺失' : r.oldProjection.exactBindingEdges} | ${r.pathExperiment.status} |`), '',
  '## 关键结论', '',
  '- 简单复制和改名的旧投影已有正确读取绑定，可作为后续回归基线。',
  '- 固定值、空字符串、日期参数等没有物理源字段，但仍需要输出生成说明，不能因零输入而省略。',
  '- 参数直接赋值是正常且可完整描述的生成方式；不需要当次参数值。不适用物理来源追踪（NOT_APPLICABLE），不是解析失败或缺口。',
  '- 34901 的 SYSDATE 在结构树和字段摘要中被当成表列，不能由投影擅自改写成时钟函数。',
  '- 155157 的 PVS.PV 与 BP.PV 是两个逻辑输入，物理摘要合为一个 pv；生成说明保留两个引用，但完整读取路径尚未由新实验验证。',
  '- CASE 的常量结果与判断条件字段、窗口序号与分区/排序字段需要分别保留。',
  '- 原 MAX/CASE/UNION 实验未覆盖这些新增加工形态；本轮没有继续堆特判来刷通过数。', '',
  'Oracle 当前时间语义依据：[Oracle SYSDATE](https://docs.oracle.com/en/database/oracle/oracle-database/18/sqlrf/SYSDATE.html)。', '',
  '## 复现', '', '```powershell',
  'npm run prepare:deps',
  'node --import tsx scripts/experiments/conditioned-value-path-spike/multi-case-run.mjs',
  'node --import tsx --test scripts/experiments/conditioned-value-path-spike/output-description.test.mjs scripts/experiments/conditioned-value-path-spike/multi-case.test.mjs',
  '```', '',
  '测试通过只说明检查器和记录的证据符合预期；已知语义问题仍在 report.json 中标记，不计为业务通过。',
];
fs.writeFileSync(path.join(directory, 'report.md'), lines.join('\n'));
console.log(JSON.stringify({ taskCount: report.taskCount, caseCount: report.caseCount,
  descriptionMatches: report.descriptionMatches, semanticMismatches: report.semanticMismatches,
  additionalFullPathProofs: report.additionalFullPathProofs, originalsUnchanged,
  report: path.join(directory, 'report.md') }, null, 2));
if (!originalsUnchanged) process.exitCode = 1;
