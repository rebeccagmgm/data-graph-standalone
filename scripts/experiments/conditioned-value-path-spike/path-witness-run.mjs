import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { multiCases, selectCase } from './multi-cases.mjs';
import { provePath } from './path-witness.mjs';
import { auditPathCase } from './path-case-audit.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(repo, 'tmp/conditioned-value-path-spike-20260909');
const destination = path.join(base, 'path-validation');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const frozenByTask = new Map([...new Set(multiCases.map(c => c.task))].map(t =>
  [t, JSON.parse(fs.readFileSync(path.join(base, `multi-case/frozen-${t}.json`), 'utf8'))]));
const cases = [...multiCases, { id: 'write-union', task: '155157', field: 'Actl_Idx_Val',
  tail: 'root.project', label: '从写入字段贯穿 UNION 三分支' }];
const results = cases.map(c => {
  const f = frozenByTask.get(c.task), x = selectCase(f, c);
  const result = provePath(f, c.id === 'write-union' ? c.field : { relationId: x.relation.relation_id, field: c.field });
  const audit = auditPathCase(c.id, result);
  const bs = f.records['output-field-bindings.jsonl'].filter(b => b.expression_id === x.expression?.expression_id);
  const ids = new Set(bs.map(b => b.binding_id));
  const oldEdges = f.baseline.projection.edges.filter(e => ids.has(e.properties.bindingId));
  const baseline = { edgeCount: oldEdges.length, resolved: oldEdges.filter(e => e.properties.sourceReadOccurrenceStatus === 'RESOLVED').length,
    unresolved: oldEdges.filter(e => e.properties.sourceReadOccurrenceStatus === 'UNRESOLVED').length };
  if (['direct', 'rename', 'join-alias'].includes(c.id)) {
    baseline.exactOccurrencePreserved = oldEdges.length === 1 && result.paths.length === 1
      && oldEdges[0].properties.sourceReadOccurrenceId === result.paths[0].readOccurrenceId;
    if (!baseline.exactOccurrencePreserved) { audit.status = 'FAIL'; audit.failures.push('OLD_CORRECT_OCCURRENCE_REGRESSION'); }
  }
  return { id: c.id, task: c.task, field: c.field, label: c.label,
    locus: bs.length ? 'WRITE_OUTPUT' : 'INTERNAL_RELATION', relationId: x.relation.relation_id,
    expression: x.raw?.expr_text ?? 'UNION ALL (positional output)',
    display: expectedAssignment(c.id) ? `赋值：${x.raw?.expr_text}` : x.raw?.expr_text ?? 'UNION ALL',
    audit, baseline, evidence: result };
});
function expectedAssignment(id) {
  return ['constant', 'empty-string', 'date-parameter', 'parameter-transform', 'hive-clock', 'oracle-clock'].includes(id);
}
const changedSourceFiles = [...frozenByTask.values()].flatMap(f => Object.entries(f.sourceHashes)
  .filter(([file, hash]) => !fs.existsSync(file) || sha(file) !== hash).map(([file]) => file));
const report = { generatedAt: new Date().toISOString(), taskCount: frozenByTask.size, caseCount: results.length,
  scope: 'TASK_LOCAL_EXPRESSION_AND_REFERENCE_PATHS', wholeArchitectureAccepted: false,
  productionModifiedByExperiment: false, originalsUnchanged: changedSourceFiles.length === 0, changedSourceFiles,
  frozenSha256: Object.fromEntries([...frozenByTask.keys()].map(t => [t, sha(path.join(base, `multi-case/frozen-${t}.json`))])),
  summary: { passedWithinScope: results.filter(r => r.audit.status === 'PASS_WITHIN_SCOPE').length,
    partial: results.filter(r => r.audit.status === 'PARTIAL').length, failed: results.filter(r => r.audit.status === 'FAIL').length,
    correctBaselineOccurrencesPreserved: results.filter(r => r.baseline.exactOccurrencePreserved === true).length },
  limitations: [
    'These are overlapping case checks, not an accuracy estimate or 15 independent SQL templates.',
    'JOIN/FILTER row-set semantics and runtime causality are NOT_EVALUATED; GROUP_KEY paths do not prove group membership.',
    'Derived JOIN alias binding still uses immediate lexical scope encoding, not a formal reference-to-relation ID contract.',
    'Structural mutations do not test SQL reparsing. SQLite oracles cover reduced shapes, not Hive/Oracle execution.',
    'Connectivity can faithfully reproduce erroneous Facts. Independent SQL expectations reject the SYSDATE case.',
    'Window partition/order paths were resolved; UNKNOWN frame metadata and actual tie ordering remain unaccepted.',
    'No cross-task continuation, production publication, or full task coverage was accepted.',
  ], results };
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));
const notes = {
  direct: '物理字段、读取实例与旧投影相同。', rename: '改名后仍回到 busi_date，读取实例与旧投影相同。',
  'join-alias': '回到 C 的读取；同表 K 读取未被混入。', aggregate: 'SUM/NVL → t → POEPM → pv；另保留三个分组字段。',
  arithmetic: '保留 PVS、BP 两条聚合及左右操作数；最终物理读取相同也不去重。',
  union: '三分支依次为相减、SUM(delta)、直接引用；保留四条值路径。',
  'write-union': '从最终写入绑定开始贯穿三分支；原投影 3 边中 2 条读取未解析。',
  'conditional-literals': '结果是固定值；B/C/D/E 四条条件路径单独保留，含顺序和 ELSE。',
  window: '分区、排序两条字段路径正确；frame 在 Facts 中 UNKNOWN，未通过完整窗口语义验收。',
  'oracle-clock': 'SQL 预期无物理上游，Facts 却给出 sysdate 表列：独立验收失败，禁止据此发布。',
};
const lines = ['# 多类型完整引用路径验证', '',
  `本轮 ${report.taskCount} 个任务、${report.caseCount} 个检查项：${report.summary.passedWithinScope} 项在限定范围通过、${report.summary.partial} 项部分验证、${report.summary.failed} 项失败。`, '',
  '**支持继续隔离验证，不支持整体替换投影。** 原始 SQL、Facts、正式投影文件保持一致：' + report.originalsUnchanged + '。', '',
  '“通过”指表达式到物理读取的结构路径与 SQL 独立预期一致；无物理输入时检查赋值表达式。JOIN/FILTER 行集语义、跨任务因果均未验收。', '',
  '| 加工 | 任务 / 字段 | 范围 | 本轮结果 | 具体证据 |',
  '| --- | --- | --- | --- | --- |',
  ...results.map(r => `| ${r.label} | ${r.task} / ${r.field} | ${r.locus === 'WRITE_OUTPUT' ? '写入输出' : '内部关系'} | ${r.audit.status} | ${notes[r.id] ?? '原赋值表达式保留，物理上游为零；不要求运行时参数值。'} |`), '',
  '## 简化展示', '',
  '常量、参数、当前时间统一用“赋值：原表达式”展示即可。本实验保留内部证据用于验收，不要求在产品中新增一套复杂分类。',
  '`SYSDATE` 也是给目标字段赋值；本例失败原因是错误的表字段来源，不是这种赋值方式有问题。', '',
  '## 风险与架构判断', '',
  '1. 复制、改名、JOIN 的三个正确旧读取绑定均保住；复杂加工也可以保留完整路径，说明方向值得继续。',
  '2. 现有 scope 字符串仍参与派生表别名绑定；实验并未证明现有 Facts 已有完备的直接引用合同。',
  '3. SYSDATE 证明单纯“原样投影 Facts”仍会搬运上游错误；要在语义生成侧修正，投影不能按案例偷偷纠错。',
  '4. ROW_NUMBER 的分区/排序路径已核对，但该样例不能替代带 frame 的累计窗口、窗口聚合、并列排序等类型验收。',
  '5. 这份 walker 是隔离验证器，未接入生产；其 scope 绑定逻辑不应直接成为第二套正式 SQL 解析器。', '',
  '## 验证方式', '',
  '真实冻结输入与 SQL 独立预期对照；复制类对照旧读取实例；加入缺失证据、错 scope、循环、UNION 变形、聚合镜像不一致等反例；简化 SQLite 执行核对相减两侧变化、NULL 默认、UNION ALL 重复行、窗口序号和 CASE 先匹配行为。', '',
  '简化 SQL 执行不代表 Hive/Oracle 原 SQL 执行结果；变形测试也不代表 SQL 重新解析通过。测试程序通过与真实案例通过分别统计。', '',
  '## 复现', '', '```powershell', 'npm run prepare:deps',
  'node scripts/experiments/conditioned-value-path-spike/path-witness-run.mjs',
  'node --test scripts/experiments/conditioned-value-path-spike/copy-path.test.mjs scripts/experiments/conditioned-value-path-spike/path-witness.test.mjs scripts/experiments/conditioned-value-path-spike/path-case-audit.test.mjs', '```', '',
  '逐路径证据、独立预期和快照哈希见同目录 report.json。此前 208983 的两个 MAX/CASE/UNION 输出结果单独保留，本报告不重复计数。', ''];
fs.writeFileSync(path.join(destination, 'report.md'), lines.join('\n'));
console.log(JSON.stringify({ ...report.summary, originalsUnchanged: report.originalsUnchanged,
  report: path.join(destination, 'report.md') }, null, 2));
if (!report.originalsUnchanged) process.exitCode = 1;
