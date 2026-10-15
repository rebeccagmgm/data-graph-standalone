// Independently chosen expectations from the SQL, not inferred from the old graph.
export const multiCases = [
  { id: 'direct', task: '34901', label: '字段原样复制', tail: 'root.project', field: 'ID', expected: 'FIELD_COPY' },
  { id: 'rename', task: '34901', label: '字段改名', tail: 'root.project', field: 'Busi_date_raw', expected: 'FIELD_COPY' },
  { id: 'oracle-clock', task: '34901', label: 'Oracle 当前时间', tail: 'root.project', field: 'DATA_TIME', expected: 'CURRENT_TIME' },
  { id: 'constant', task: '86840', statement: 'statement:8:', label: '固定值赋值', tail: 'root.project', field: 'Busi_Type', expected: 'FIXED_VALUE' },
  { id: 'empty-string', task: '86840', statement: 'statement:8:', label: '空字符串赋值', tail: 'root.project', field: 'Undrl_Type_Desc', expected: 'FIXED_VALUE' },
  { id: 'date-parameter', task: '86840', statement: 'statement:8:', label: '参数直接赋值', tail: 'root.project', field: 'Data_Etl_Date', expected: 'TEMPLATE_PARAMETER' },
  { id: 'parameter-transform', task: '86840', statement: 'statement:8:', label: '参数加工', tail: 'root.project', field: 'Task_Name', expected: 'PARAMETER_TRANSFORMATION' },
  { id: 'hive-clock', task: '155157', label: 'Hive 当前时间', tail: 'root.casttable.setop.b0.setop.b0.project', field: 'data_time', expected: 'CURRENT_TIME' },
  { id: 'aggregate', task: '155157', label: '聚合与默认值', tail: 'root.casttable.setop.b0.setop.b0.pvs.aggregate', field: 'PV', expected: 'AGGREGATION' },
  { id: 'arithmetic', task: '155157', label: 'JOIN 两侧同名字段相减', tail: 'root.casttable.setop.b0.setop.b0.project', field: 'Actl_Idx_Val', expected: 'CALCULATION' },
  { id: 'join-alias', task: '119044', label: '多表 JOIN 中的别名引用', tail: 'root.project', field: 'Inr_Ord_Id', expected: 'FIELD_COPY' },
  { id: 'conditional-literals', task: '105387', label: 'CASE 按条件选择固定值', tail: 'root.project', field: 'Agt_Modifr1', statement: 'statement:1:', expected: 'CONDITIONAL_VALUE' },
  { id: 'window', task: '86840', statement: 'statement:8:', label: '窗口序号生成', tail: 'root.fee.t.project', field: 'rn', expected: 'WINDOW_GENERATION' },
  { id: 'union', task: '155157', label: 'UNION 三种加工分支', tail: 'root.casttable.setop', field: 'Actl_Idx_Val', expected: 'UNION_OUTPUT', relationOnly: true },
];

export function selectCase(frozen, c) {
  const rs = frozen.records['relation-nodes.jsonl'].filter(r => r.relation_id.endsWith(`relation:${c.tail}`)
    && (!c.statement || r.relation_id.includes(c.statement)));
  if (rs.length !== 1) throw new Error(`CASE_RELATION_NOT_UNIQUE:${c.id}`);
  if (c.relationOnly) return { relation: rs[0], expression: null, raw: null };
  const es = frozen.records['field-expression-nodes.jsonl'].filter(e => e.relation_id === rs[0].relation_id
    && e.output_name?.toLowerCase() === c.field.toLowerCase());
  if (es.length !== 1) throw new Error(`CASE_EXPRESSION_NOT_UNIQUE:${c.id}`);
  const raw = (rs[0].relation.expressions ?? rs[0].relation.measures ?? [])
    .find(e => e.output?.toLowerCase() === c.field.toLowerCase());
  return { relation: rs[0], expression: es[0], raw };
}
