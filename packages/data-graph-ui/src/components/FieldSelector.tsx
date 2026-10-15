import { selectedFieldCount } from "../field-object";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "../types";

export interface TaskOption {
  taskId: string;
  count: number;
}
export interface FieldChoice {
  field: GraphNode;
  members: GraphNode[];
  tableKey: string;
  occurrenceLabel?: string;
}
const taskIdentity = (field: GraphNode) => field.taskId || "未标注";
const tableIdentity = (field: GraphNode) => {
  const identity = field.metadata?.identity;
  return JSON.stringify([taskIdentity(field), identity?.platform ?? "", identity?.dataSource ?? "",
    (identity?.qualifiedName ?? field.table ?? field.id).toLowerCase()]);
};

export function taskOptions(fields: GraphNode[]): TaskOption[] {
  const counts = new Map<string, number>();
  for (const { field } of fieldChoices(fields, "", ""))
    counts.set(taskIdentity(field), (counts.get(taskIdentity(field)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([taskId, count]) => ({ taskId, count }))
    .sort((a, b) =>
      a.taskId.localeCompare(b.taskId, "zh-CN", { numeric: true }),
    );
}

export function fieldChoices(
  fields: GraphNode[],
  taskId: string,
  fieldSearch: string,
): FieldChoice[] {
  const needle = fieldSearch.trim().toLowerCase();
  const filtered = [...fields]
    .filter((field) => !taskId || taskIdentity(field) === taskId)
    .sort((a, b) => {
      const task = taskIdentity(a).localeCompare(taskIdentity(b), "zh-CN", {
        numeric: true,
      });
      return (
        task ||
        tableIdentity(a).localeCompare(tableIdentity(b)) ||
        String(a.column ?? "").localeCompare(String(b.column ?? ""), "zh-CN") ||
        String(a.writeId ?? a.id).localeCompare(String(b.writeId ?? b.id))
      );
    });
  const siblings = new Map<string, GraphNode[]>();
  for (const field of filtered) {
    const key = `${tableIdentity(field)}\u0000${String(field.column ?? field.id).toLowerCase()}`;
    const group = siblings.get(key) ?? [];
    if (!group.some(item => item.id === field.id)) group.push(field);
    siblings.set(key, group);
  }
  return [...siblings.values()].filter(group => !needle || group.some(field =>
    [field.column, field.metadata?.field?.comment].some(value => String(value ?? "").toLowerCase().includes(needle)),
  )).map((group) => {
    const field = group.find(item => item.metadata?.field?.comment) ?? group[0]!;
    return {
      field,
      members: group,
      tableKey: tableIdentity(field),
    };
  });
}

export function toggleAllVisible(
  selectedIds: string[],
  visibleIds: string[],
  checked: boolean,
): string[] {
  const visible = new Set(visibleIds);
  if (!checked) return selectedIds.filter((id) => !visible.has(id));
  return [
    ...selectedIds,
    ...visibleIds.filter((id) => !selectedIds.includes(id)),
  ];
}

export function selectedTaskFields(fields: GraphNode[], selectedIds: string[], taskId: string): GraphNode[] {
  const selected = new Set(selectedIds);
  const task = taskId.trim();
  return fields.filter(field => selected.has(field.id) && (!task || taskIdentity(field) === task));
}

export function FieldSelector(props: {
  fields: GraphNode[];
  selectedIds: string[];
  hasMore: boolean;
  onChange: (ids: string[]) => void;
  onLoadMore: () => void;
  taskId: string;
  onTaskChange: (taskId: string) => void;
}) {
  const [fieldSearch, setFieldSearch] = useState(""),
    [open, setOpen] = useState(false);
  const taskId = props.taskId;
  const options = useMemo(() => taskOptions(props.fields), [props.fields]);
  const choices = useMemo(
    () => fieldChoices(props.fields, taskId.trim(), fieldSearch),
    [props.fields, taskId, fieldSearch],
  );
  const selected = new Set(props.selectedIds);
  const selectedCount = fieldChoices(props.fields, "", "").filter(choice => choice.members.some(field => selected.has(field.id))).length;
  const visibleSelected = choices.filter(choice => choice.members.some(field => selected.has(field.id))).length,
    hiddenSelected = selectedCount - visibleSelected;
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const allVisibleSelected =
    choices.length > 0 && choices.every(choice => choice.members.every(field => selected.has(field.id)));
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate =
        visibleSelected > 0 && !allVisibleSelected;
  }, [allVisibleSelected, visibleSelected]);
  const toggle = (members: GraphNode[]) => props.onChange(toggleAllVisible(
    props.selectedIds, members.map(field => field.id), !members.every(field => selected.has(field.id)),
  ));
  let currentTask = "";
  let currentTable = "";
  return (
    <div className="field-picker">
      <button
        type="button"
        className="field-picker-trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        本次已选 {selectedFieldCount(selectedTaskFields(props.fields, props.selectedIds, taskId))} 个字段
      </button>
      {open && (
        <div className="field-picker-popover">
          <label className="field-search">
            <span>起点调度 ID（限制本次展开）</span>
            <input
              list="loaded-task-ids"
              value={taskId}
              onChange={(event) => props.onTaskChange(event.target.value)}
              placeholder="输入精确调度 ID"
            />
            <datalist id="loaded-task-ids">
              {options.map((option) => (
                <option key={option.taskId} value={option.taskId}>
                  {option.count} 个字段
                </option>
              ))}
            </datalist>
          </label>
          <label className="field-search">
            <span>字段名或中文注释（当前已加载字段）</span>
            <input
              value={fieldSearch}
              onChange={(event) => setFieldSearch(event.target.value)}
              placeholder="搜索字段名或中文注释"
            />
          </label>
          <p className="field-selection-summary">
            {taskId.trim() && <>本次仅展开调度 {taskId.trim()} 的已选字段；其他调度的选择保留但不参与查询。<br /></>}
            当前已加载范围匹配 {choices.length} 个，已选 {visibleSelected} 个
            {hiddenSelected
              ? `；另有 ${hiddenSelected} 个已选字段被筛选隐藏`
              : ""}
          </p>
          <div className="field-picker-actions">
            <label className="select-all-fields">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected}
                disabled={!choices.length}
                onChange={(event) =>
                  props.onChange(
                    toggleAllVisible(
                      props.selectedIds,
                      choices.flatMap(({ members }) => members.map(field => field.id)),
                      event.target.checked,
                    ),
                  )
                }
              />
              全选当前筛选（已加载）
            </label>
            <button type="button" onClick={() => props.onChange([])}>
              清空全部选择
            </button>
          </div>
          <div className="field-picker-list">
            {choices.map(({ field, members, tableKey }) => {
              const nextTask = taskIdentity(field),
                heading = nextTask !== currentTask;
              currentTask = nextTask;
              const tableHeading = currentTable !== tableKey;
              currentTable = tableKey;
              return (
                <div key={field.id}>
                  {heading && (
                    <div className="field-task-heading">调度 ID {nextTask}</div>
                  )}
                  {tableHeading && <div className="field-table-heading">{field.table ?? "表身份未明确"}</div>}
                  <label>
                    <input
                      type="checkbox"
                      checked={members.every(item => selected.has(item.id))}
                      ref={element => { if (element) element.indeterminate = members.some(item => selected.has(item.id)) && !members.every(item => selected.has(item.id)); }}
                      disabled={false}
                      onChange={() => toggle(members)}
                    />
                    <span>
                      <b>{field.column}</b>
                      {field.metadata?.field?.comment && (
                        <small>{field.metadata.field.comment}</small>
                      )}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
          {props.hasMore && (
            <button
              type="button"
              className="load-more"
              onClick={props.onLoadMore}
            >
              加载更多字段
            </button>
          )}
          {!choices.length && (
            <p className="muted">
              当前已加载范围未匹配，可调整调度 ID 或加载更多字段。
            </p>
          )}
        </div>
      )}
      {!props.selectedIds.length && (
        <span className="field-empty-prompt">
          尚未选择字段，勾选后点击“展开”查询
        </span>
      )}
    </div>
  );
}
