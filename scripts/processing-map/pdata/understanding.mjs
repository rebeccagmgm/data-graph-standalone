import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Reading records for this fixed batch, not a new lineage or classification contract.
export async function loadUnderstanding(root, region, evidence) {
  const records = [];
  for (const name of ["analysis-foundation.json", "analysis-sales.json", "analysis-results.json"]) {
    const source = `scripts/processing-map/pdata/${name}`;
    const entries = JSON.parse(await readFile(resolve(root, source), "utf8"));
    for (const entry of entries) {
      const task = region.tasks.find((item) => item.id === entry.taskId);
      const sql = evidence[entry.taskId];
      if (!task?.outputs.includes(entry.output) || sql?.sha256 !== entry.sha256)
        throw new Error(`UNDERSTANDING_SOURCE_MISMATCH: ${entry.taskId}`);
      const lineCount = sql.sql.split(/\r?\n/).length;
      for (const reference of [...entry.inputs, ...entry.stages]) {
        const [start, end] = reference.lines;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lineCount)
          throw new Error(`UNDERSTANDING_RANGE_INVALID: ${entry.taskId}`);
      }
      records.push({ ...entry, source });
    }
  }
  if (new Set(records.map((r) => `${r.taskId}:${r.output}`)).size !== records.length)
    throw new Error("UNDERSTANDING_DUPLICATE_WRITE");
  const standardsRoot = resolve(root, "../数综基础信息/数据开发规范-整理版/gf-data-assistant/knowledge");
  const selections = [
    { file: "L3-standards/warehouse-layer-architecture.md", title: "模型层与公共加工层的职责", ranges: [[52, 72]], use: "用来对照当前加工职责；实际 SQL 可能与规范预期存在差异。" },
    { file: "L3-standards/table_naming_standards.md", title: "模型主题命名：保留整理稿冲突", ranges: [[31, 59], [71, 84]], use: "两处对 T01、T03 的解释不同。前缀只作查找线索，当前业务分支不据此前缀直接定类；T98 也不能证明发生聚合。" },
    { file: "L2-architecture/field-caliber-fingerprint.md", title: "对象、时间和加工规则分别描述", ranges: [[17, 53]], use: "借用粒度、Join、筛选、去重和聚合的说明要素，回到每项实际写入核对。" },
    { file: "L3-standards/date-parameter-standards.md", title: "来源过滤与目标日期分开", ranges: [[89, 123]], use: "逐来源检查时间条件，不把采集快照、有效区间和结果业务日混为一谈。" },
  ];
  const standards = await Promise.all(selections.map(async (selection) => {
    const original = await readFile(resolve(standardsRoot, selection.file), "utf8");
    const lines = original.split(/\r?\n/);
    return { ...selection, sha256: createHash("sha256").update(original).digest("hex"),
      excerpts: selection.ranges.map(([start, end]) => ({ start, end, text: lines.slice(start - 1, end).join("\n") })) };
  }));
  return { records, standards };
}

export function understandingMarkdown(region, records, standards) {
  const lines = ["# PDATA 区域认识与加工问题对照", "", "本稿由当前成员、关联与已核 SQL 阅读记录共同生成。分支是待持续核对的业务阅读组织；一项说明仅覆盖绑定任务与具体输出，不代表全表或全部生产体系。", "", "范围：284 个表节点，132 个有写入、151 个只见读取、1 个无读写关系；263 个输出关联任务。", "", `本轮 ${records.length} 项任务输出有分阶段说明；其余仍保留原加工说明或 SQL，不能视为已逐项解释。`, ""];
  for (const branch of region.branches) {
    const readings = records.filter((r) => branch.tables.includes(r.output));
    lines.push(`## ${branch.title}`, "", branch.result || branch.summary, "", `成员：${branch.tables.length} 张可见产出表；${branch.taskIds.length} 个写任务。`, "", `当前职责解释：${branch.change}`, "", `范围边界：${branch.boundary}`, "");
    for (const item of readings) lines.push(`### ${item.taskId} · ${item.title}`, "", `输出：\`${item.output}\``, "", item.summary, "", ...item.stages.map((stage, i) => `${i + 1}. ${stage.title}：${stage.detail}（SQL ${stage.lines.join("–")} 行）`), "", `行含义：${item.grain.object}`, "", `时间：${item.grain.time}`, "", `关联键：${item.grain.keys}`, "", `未确认：${item.grain.limitation}`, "", ...item.questions.map((q) => `- ${q}`), "", `依据：${item.source}；SQL SHA-256 \`${item.sha256}\`。`, "");
    if (!readings.length) lines.push("本分支尚无分阶段说明。下一步应先分析实际写任务和消费路线，再确定职责与粒度。", "");
  }
  lines.push("## 规范来源", "", ...standards.map((s) => `- ${s.title}：\`${s.file}\`；SHA-256 \`${s.sha256}\`。${s.use}`), "", "## 完整成员对照", "", "表名和读写计数来自固定网络。已分析任务不等于该表全部写入都已分析。", "", "| 对象 | 当前阅读位置 | 写任务 / 读任务 | 已分析写入 |", "|---|---|---|---|");
  for (const table of region.tables) {
    const branch = region.branches.find((b) => b.id === table.branchId);
    const scope = branch?.title || (table.scope === "read-only" ? "只读边界" : "无读写关系");
    lines.push(`| \`${table.name}\` | ${scope} | ${table.writers.length} / ${table.readers.length} | ${records.filter((r) => r.output === table.name).map((r) => r.taskId).join("、") || "尚未分阶段解释"} |`);
  }
  return lines.join("\n") + "\n";
}
