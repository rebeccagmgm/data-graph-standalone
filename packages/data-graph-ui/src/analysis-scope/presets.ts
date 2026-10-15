import type { ScopeRef } from "./model";
export interface ScopePreset {
  id: string;
  name: string;
  label?: string;
  description?: string;
  members: ScopeRef[];
}
const taskRefs = (values: string[]): ScopeRef[] =>
  values.map((value) => ({
    kind: "TASK",
    value,
    id: `task:${value}`,
    enabled: true,
  }));
// TIT modelling tasks are preset seeds; their actual tables are discovered, not enumerated.
export const PRESETS: ScopePreset[] = [
  {
    id: "custody-main",
    name: "托管 · 监控供数主链",
    members: taskRefs([
      "156181",
      "164968",
      "156192",
      "156763",
      "228530",
      "228532",
    ]),
    description:
      "产品清单、托管产品资料与监控结果进入整理任务，再推送 TIT。当前只覆盖私募估值监控这一簇；共享模型的全部上游不等于全部字段都进入 TIT。TIT 和运管（gf_otc）均属我们负责，本簇已确认接收端为 TIT。推送调度的当前启用状态未核验。",
  },
  {
    id: "custody-monitor",
    name: "托管 · 监控结果来源",
    members: taskRefs(["101329", "200759"]),
    description:
      "CPS 监控结果与账户、码值信息进入托管监控结果模型。这是监控供数主链的一个支撑模型；投监产品清单更上游的生产 SQL 尚未完整取得。",
  },
  {
    id: "custody-product",
    name: "托管 · 产品资料来源",
    members: taskRefs(["71716"]),
    description:
      "查看共享托管产品基本信息模型的直接输入。各表参与该模型构建，不代表每张表的所有字段均进入 TIT；其他业务对该模型的消费没有自动纳入此范围。",
  },
  {
    id: "tit-party-types",
    label: "当事人分类 · 2 个调度",
    name: "TIT → T01 · 当事人分类",
    members: [
      {
        kind: "TASK",
        value: "76984",
        id: "task:76984",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "77078",
        id: "task:77078",
        enabled: true,
      },
    ],
  },
  {
    id: "tit-party-all",
    label: "TIT → T01 全部",
    name: "TIT → T01 · 全部",
    members: [
      {
        kind: "TASK",
        value: "104298",
        id: "task:104298",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "104299",
        id: "task:104299",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "104300",
        id: "task:104300",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "104301",
        id: "task:104301",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105075",
        id: "task:105075",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105076",
        id: "task:105076",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105077",
        id: "task:105077",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105079",
        id: "task:105079",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105379",
        id: "task:105379",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105380",
        id: "task:105380",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "105518",
        id: "task:105518",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "114401",
        id: "task:114401",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "114423",
        id: "task:114423",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "150755",
        id: "task:150755",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "150757",
        id: "task:150757",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "150759",
        id: "task:150759",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "173975",
        id: "task:173975",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "200060",
        id: "task:200060",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "219164",
        id: "task:219164",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "219175",
        id: "task:219175",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "229973",
        id: "task:229973",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "76984",
        id: "task:76984",
        enabled: true,
      },
      {
        kind: "TASK",
        value: "77078",
        id: "task:77078",
        enabled: true,
      },
    ],
  },
];

export function presetFromSearch(search: string): ScopePreset | undefined {
  const params = new URLSearchParams(search);
  const legacy =
    params.get("topic") === "custody"
      ? `custody-${["monitor", "product"].includes(params.get("view") ?? "") ? params.get("view") : "main"}`
      : undefined;
  return PRESETS.find(
    (preset) => preset.id === (params.get("scope") ?? legacy),
  );
}

export function analysisScopeUrl(current: string, presetId?: string): string {
  const url = new URL(current);
  url.searchParams.set("analysis", "1");
  url.searchParams.delete("topic");
  url.searchParams.delete("view");
  if (presetId) url.searchParams.set("scope", presetId);
  else url.searchParams.delete("scope");
  return url.toString();
}
