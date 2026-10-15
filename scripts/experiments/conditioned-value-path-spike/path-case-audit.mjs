// Independently reviewed SQL expectations for this fixed experiment sample.
// Never imported by the evidence walker; these are acceptance oracles only.
const price = 'pdata_n.t98_sb_otc_opt_sub_trd_prcg_indx';
const priceRead = 'root.(child).poepm.read.t98_sb_otc_opt_sub_trd_prcg_indx';
const p = (role, column) => [role, price, column, priceRead];
const groups = ['prcg_date', 'undrl_pric_shift_prop', 'vola_shift_prop'].map(c => p('GROUP_KEY', c));
const arithmetic = [p('VALUE', 'pv'), ...groups, p('VALUE', 'pv'), p('GROUP_KEY', 'prcg_date')];
const union = [...arithmetic, p('VALUE', 'delta'), ...groups,
  ['VALUE', 'pdata_n.t98_otc_deri_undrl_trd_lmt_idx', 'actl_idx_val', 'root.casttable.setop.b1.read.t98_otc_deri_undrl_trd_lmt_idx']];
export const expectedPaths = {
  direct: [['VALUE', 'titans_otcclearing.pos_otc_position_daily', 'id', 'root.read.pos_otc_position_daily']],
  rename: [['VALUE', 'titans_otcclearing.pos_otc_position_daily', 'busi_date', 'root.read.pos_otc_position_daily']],
  'join-alias': [['VALUE', 'pdata_n.t03_agt_stati_info_h', 'stati_cont_desc', 'root.c.read.t03_agt_stati_info_h']],
  aggregate: [p('VALUE', 'pv'), ...groups], arithmetic, union, 'write-union': union,
  'conditional-literals': [
    ['BRANCH_SELECTOR', 'odata_n_tit.d_ref_trs', 'key_otc_trade_id', 'root.b.read.d_ref_trs'],
    ['BRANCH_SELECTOR', 'odata_n_tit.d_ref_otc_option_deal', 'key_otc_trade_id', 'root.c.read.d_ref_otc_option_deal'],
    ['BRANCH_SELECTOR', 'odata_n_tit.d_ref_fx_forward', 'key_otc_trade_id', 'root.d.read.d_ref_fx_forward'],
    ['BRANCH_SELECTOR', 'odata_n_tit.d_ref_fast_trs', 'key_otc_trade_id', 'root.e.read.d_ref_fast_trs'],
  ],
  window: [
    ['WINDOW_PARTITION', 'odata_n_tit.d_trd_daily_accrual_fee', 'key_instrument_id', 'root.fee.t.read.d_trd_daily_accrual_fee'],
    ['WINDOW_ORDER', 'odata_n_tit.d_trd_daily_accrual_fee', 'calc_date', 'root.fee.t.read.d_trd_daily_accrual_fee'],
  ],
  constant: [], 'empty-string': [], 'date-parameter': [], 'parameter-transform': [], 'hive-clock': [], 'oracle-clock': [],
};
const canonical = rows => JSON.stringify(rows.map(r => JSON.stringify(r)).sort());
export function auditPathCase(id, result) {
  if (!(id in expectedPaths)) throw new Error('CASE_EXPECTATION_MISSING');
  const observed = result.paths.map(p => [p.role, p.table, p.column, p.readOccurrenceId.split('relation:')[1]]);
  const inputsMatchSql = canonical(observed) === canonical(expectedPaths[id]);
  const failures = [];
  if (!inputsMatchSql) failures.push('SQL_EXPECTED_INPUTS_MISMATCH');
  if (result.status === 'NOT_EVALUABLE') failures.push(result.reason);
  const valuePaths = result.paths.filter(p => p.role === 'VALUE');
  if (['arithmetic', 'union', 'write-union'].includes(id)) {
    const pv = valuePaths.filter(p => p.column === 'pv');
    if (pv.length !== 2 || !['PVS', 'BP'].every((alias, i) =>
      pv[i]?.route.some(s => s.operator === 'JOIN_INPUT' && s.alias === alias))) failures.push('OPERAND_ROUTES_MISMATCH');
  }
  if (['union', 'write-union'].includes(id)) {
    const branches = valuePaths.map(p => p.route.filter(s => s.operator === 'UNION_BRANCH').map(s => s.ordinal));
    if (JSON.stringify(branches) !== JSON.stringify([[0, 0], [0, 0], [0, 1], [1]])) failures.push('BRANCH_ROUTES_MISMATCH');
  }
  return { status: failures.length ? 'FAIL' : result.status === 'PARTIAL' ? 'PARTIAL' : 'PASS_WITHIN_SCOPE',
    inputsMatchSql, failures, expectedInputs: expectedPaths[id], observedInputs: observed };
}
