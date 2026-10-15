// Reviewed navigation membership for this region, not a general business classifier.
const names = (text) => text.trim().split(/\s+/);
export const groups = [
  {
    id: "contracts",
    title: "合约、结构与交易",
    color: "#8cc2d6",
    question: "一份合约、它的腿与条款，分别从哪里来？",
    summary:
      "期权、互换、结构腿、条款与交易事件分别接入；源表与指定批次版本并行供给。",
    change:
      "部分合约留存指定批次。已核的互换路线在下游补充合约属性与代码映射。",
    destinationsHint: "互换合约实体 · 合约与交易主题",
    families:
      names(`b_trd_deal b_trd_deal_otcoption d_dm_option_contract_info d_ks_contract_info d_ks_trade_comfirm_info d_ks_trs_for_risk
      d_ref_fast_trs d_ref_fast_trs_leg d_ref_fx_forward d_ref_fx_forward_structure d_ref_op_cumulator_schedule d_ref_op_deal_autocall_kidate d_ref_op_deal_autocall_kodate d_ref_op_deal_float_back_fee
      d_ref_option_attribute d_ref_option_autocall d_ref_option_autocall_cp d_ref_option_autocall_ki d_ref_option_autocall_ko d_ref_option_barrier_line d_ref_option_dailyrangeaccrual d_ref_option_deal_barrier d_ref_option_deal_barrier_line d_ref_option_deal_cr d_ref_option_deal_pr d_ref_option_deal_quote_reset d_ref_option_deal_strike d_ref_option_deal_structure d_ref_option_dra_obs d_ref_option_lizard_obs_date d_ref_otc_contr_precision_detail d_ref_otc_option_deal d_ref_sbl d_ref_sbl_leg d_ref_trs d_ref_trs_leg
      d_trd_bundle_info d_trd_cumulator_schedule_daily d_trd_deal d_trd_fast_trs_event d_trd_hedge_product_info d_trd_option_event d_trd_option_limit_audit d_trd_otc_contr_props d_trd_otc_trade d_trd_transfer d_trd_trs_event d_trd_trs_event_struc_detail d_trd_trs_limit_audit d_trd_trs_underlying_deal
      d_v_equity_autocall_obs_info d_v_equity_option_contract_info d_v_equity_option_event_info d_v_equity_option_transfer_info d_v_ks_cross_border_trs d_v_ks_trs_contract d_v_retail_option_param d_v_risk_contract_security_rela d_v_risk_cross_border_trs d_v_risk_option_basket_info d_v_risk_option_info d_v_risk_trs_contract_param d_v_trs_for_risk d_v_trs_param_for_risk
      f_eq_lend_info f_ref_op_deal_lizard_obsdate f_trd_option_limit_audit f_trd_otc_contr_files f_trd_otc_contr_initial_amt f_trd_otc_contr_props otc_o_option_parameter otc_o_otc_trs p_prd_notes p_prd_notes_trade_record p_prd_product p_prd_product_asset`),
  },
  {
    id: "positions",
    title: "持仓、估值与损益",
    color: "#b7a4d5",
    question: "持有什么，哪一天的价值与损益？",
    summary: "持仓、腿估值、标的估值和损益记录并存；对象粒度与日期各有区别。",
    change:
      "部分持仓留存批次；合约损益按合约＋账簿择日取最新，下游继续做日期窗口和汇总加工。",
    destinationsHint: "持仓数据 · 合约盈亏汇总",
    families:
      names(`d_ks_fin_trs_valuation d_ks_marketval_acc_for_risk d_ks_risk_long_short_acc d_ks_trs_eod_postion d_ks_trs_nav_acc_for_risk
      d_pos_bucket_vega_metrics d_pos_eod_calc_metrics d_pos_eod_fx_exposure d_pos_eod_position_view d_pos_fast_trs_leg_his_pos d_pos_fast_trs_leg_valuation d_pos_pd_clearing_position d_pos_position_daily d_pos_qg_clearing_greeks d_pos_trs_leg_current_pos d_pos_trs_leg_his_pos d_pos_trs_leg_valuation d_pos_trs_underlying_valuation
      d_pricing_bucket_metric d_pricing_eod_cross_metric d_pricing_eod_part_metric d_mkt_ins_op_eod_metric d_mkt_option_eod_pt_metric d_mkt_risk_daily_info
      d_risk_accumulated_notional d_risk_ctpty_limit_threshold d_risk_eod_report_metric_detail d_risk_eod_report_metric_value d_risk_equity_market_value_acc d_risk_equity_nav_acc d_risk_long_short_acc d_risk_option_initial_metric d_risk_pressure_test_loss_detail
      d_v_equity_plreport_contract d_v_ficc_trs_position d_v_greeks_pricing_rm_all d_v_greeks_pricing_rm d_v_marketval_acc_for_risk d_v_otc_plreport d_v_otc_plreport_trs d_v_otc_position_report_tit d_v_plreport d_v_risk_hedging_position_tit d_v_risk_limit_threshold d_v_risk_long_short_acc d_v_risk_option_cross_metric d_v_risk_option_part_metric d_v_risk_plreport d_v_risk_plreport_contract d_v_risk_plreport_contract_all d_v_risk_plreport_contract_tmp d_v_risk_plreport_contract_tmp_pb_h15risk d_v_risk_plreport_tit d_v_risk_presure_test_pd d_v_risk_pricing_bucket_metric d_v_risk_qis d_v_risk_rm_bundlereport_tit d_v_risk_tradereport_equity_tit d_v_risk_transferreport_tit d_v_trs_nav_acc_for_risk
      d_value_report_element_result v_pricing_option_eod_metric v_pricing_option_eod_pt_metric`),
  },
  {
    id: "cash",
    title: "资金、保证金与结算",
    color: "#d2b382",
    question: "账户余额、履保结果与资金变动怎样区分？",
    summary: "账户、合约映射、余额、履保结果和收付款流水分别保存。",
    change:
      "部分余额按记录业务日留存；保证金参数与账户另有来源拼接，其拼接结果在本图未见后续读者。",
    destinationsHint: "账户与余额模型 · 履保材料",
    families:
      names(`d_bundle_daily_contr_param d_bundle_margin_daily_result d_bundle_margin_underlying_type d_capital_account d_capital_account_ledger d_capital_acct_current_balance d_capital_acct_daily_balance d_capital_daily_actual_balance
      d_margin_account d_margin_account_ledger d_margin_acct_bundle_mapping d_margin_acct_contract_mapping d_margin_acct_current_balance d_margin_acct_daily_balance d_margin_acct_daily_no_calc d_margin_acct_daily_result d_margin_bundle_acct d_margin_bundle_contract_mapping d_margin_daily_contr_param d_margin_plan
      d_ref_otc_contr_margin_param d_trd_daily_accrual_fee d_trd_daily_rebate_interest d_trd_fee d_trd_option_deal_settlement d_trd_rebate_interest_param
      d_v_margin_account_for_risk d_v_margin_param_for_risk d_v_risk_capital_acct_info d_v_risk_contr_capital_mapping d_v_risk_contr_margin_mapping d_v_risk_county_capital_mapping d_v_risk_margin_acct_info d_v_risk_option_margin d_v_risk_otc_margin d_value_report_cap_flow
      f_ref_option_margin_trs_relation f_trd_fee f_trd_fee_payment_schedule g_margin_call_setting m_capital_account m_capital_acct_current_balance m_margin_account m_margin_acct_bundle_mapping m_margin_acct_current_balance n_ope_settle_notice n_ope_settle_notice_transfer o_liq_clearing_trans otc_o_margin_account otc_o_margin_parameter`),
  },
  {
    id: "market",
    title: "证券、行情与市场参数",
    color: "#89baac",
    question: "标的怎样识别，读到的是哪次报价？",
    summary:
      "证券代码、产品属性、每日行情及曲面曲线参数分别接入，服务多个业务方向。",
    change:
      "行情按标的＋报价日选择最新采集记录，再由下游衔接证券编码；参考信息也有指定批次版本。",
    destinationsHint: "证券基础信息 · 证券报价",
    families:
      names(`d_cfg_pricing_env_div_curve d_cfg_pricing_env_vol_surf d_mkt_ins_daily_info d_ref_basket_constituent d_ref_corporate_action_info d_ref_correlation_daily_info d_ref_curve d_ref_future_properties d_ref_implied_metrics d_ref_ins_option_info d_ref_instrument d_ref_instrument_code d_ref_instrument_pool_whitelist d_ref_instrument_tag d_ref_main_contract d_ref_rate_properites d_ref_rmb_midrate d_ref_vol_surface d_ref_vol_surface_structure d_ref_volsurface_instance d_ref_wind_yield_curve d_v_risk_correlation_info
      k_eq_equity_source m_ref_cbond_rate m_ref_instrument_daily_info m_ref_restricted_stock_daily r_cfg_ice_listedoption r_cfg_ins_be_share_proportion r_cfg_instrument_pool r_cfg_instrument_pool_props r_cfg_pricing_env_def r_ref_future_properties r_ref_instrument r_ref_instrument_code r_ref_listed_option_props r_ref_option_attribute r_ref_option_barrieroption r_ref_option_cumulator r_ref_option_digitaloption r_ref_option_general_info r_ref_option_history_info r_ref_option_quote_reset r_ref_option_quote_reset_rate r_ref_option_vanillaoption tit_r_ref_future_properties tit_r_ref_instrument_code_s tit_r_ref_instrument_wind_curve_s`),
  },
  {
    id: "parties",
    title: "交易对手、账簿与组织",
    color: "#9baecb",
    question: "数据归属哪个交易对手、账簿与组织？",
    summary:
      "交易对手、账簿、组合与组织用户资料，为多条加工路线提供身份和归属材料。",
    change:
      "账簿与交易对手部分对象保留批次版本；具体关联键与归属加工继续在消费任务中查看。",
    destinationsHint: "交易对手与账簿资料 · 业务对象关联",
    families: names(
      `a_adm_department a_adm_employee a_adm_function a_adm_function_menu_mapping a_adm_menu_permission a_adm_menu_role_mapping a_adm_role a_adm_role_access a_adm_user a_adm_user_role d_bk_book_mapping d_bk_book_mapping_rule d_bk_department_properties d_ref_book d_ref_counter_party d_ref_counterparty d_ref_ctpty_account d_ref_ctpty_auth_busi d_ref_ctpty_ext_param d_ref_ctpty_mapping d_ref_ctpty_trade_group d_v_risk_counter_party_tit t_bk_book t_ref_counter_party t_ref_portfolio t_ref_portfolio_element t_ref_qfii_product_info`,
    ),
  },
  {
    id: "operations",
    title: "运营、报备与公共配置",
    color: "#c99f94",
    question: "哪些是流程、报备和公共支撑材料？",
    summary:
      "财务视图、报备材料、流程记录、运营要素及配置并存，分别进入相关输出。",
    change:
      "从实际去向查看使用范围；本轮保留全量结构，尚未逐项解释这些任务的业务处理。",
    destinationsHint: "财务与报备材料 · 应用侧输出",
    families: names(
      `d_adm_audit_log d_cfg_calendar d_cfg_dictionary_desc d_ope_capital_acct_element d_ope_margin_acct_element d_ope_option_element d_ope_trs_element d_trd_otc_contr_report d_v_fin_capital_acct_mapping d_v_fin_capital_change d_v_fin_option_info d_v_fin_option_trade_record d_v_fin_trs d_v_fin_trs_plreport d_v_fin_trs_trade_record d_v_fin_trs_valuation d_v_otcm_se_report d_v_report_margin_a1020 d_v_report_margin_file_a1020 d_v_report_product_report d_value_report_element_config w_act_hi_procinst w_plc_process_def`,
    ),
  },
];

export const methods = {
  source_supply: {
    short: "接入落表",
    question: "业务源对象在仓库中的入口",
    change:
      "来源系统的对象进入本区。一个目标表可能有多个接入任务；具体过滤、字段表达式与目标配置需查看对应 SQL。",
    input: "源系统表或视图",
    output: "仓库内的接入目标",
    meaning: "先找到对象的入口，再比较其后续版本与消费路线。",
    evidenceIds: [],
  },
  dated_versions: {
    short: "指定批次留存",
    question: "同一业务对象，下游选择哪一版？",
    change:
      "选取指定输入批次，写入 grp_id 与日期分区。54 个任务中，5 个从记录日期派生结果日期，其余保留 SQL 使用日期字面量。",
    input: "带批次标识的采集数据",
    output: "可按日期与批次读取的数据",
    meaning:
      "输入 busi_date 可能表示 h15 等批次；输出 busi_date 表示日期，grp_id 保存批次。两端同名字段含义不同。",
    evidenceIds: ["144141", "198710", "160830", "152124", "218455"],
  },
  latest_quotes: {
    short: "最新行情选择",
    question: "同一标的、同一天，为什么留下这条报价？",
    change:
      "新批次与已有行情合并，以 key_instrument_id＋报价日期分组，按 data_time 倒序保留一条。",
    input: "新采集行情＋已有行情记录",
    output: "每标的、每报价日的最新采集记录",
    meaning:
      "选择的是采集时间最新的一条；报价日期仍是分组的一部分。下游继续关联证券基础信息，衔接证券编码。",
    evidenceIds: ["143404", "144765"],
  },
  latest_pnl: {
    short: "损益记录选择",
    question: "合约与账簿的损益，采用哪一天的源记录？",
    change:
      "限定目标日期及记录日期上界，再按 internal_reference＋book 分组，以 src_busi_date 倒序取一条。",
    input: "已有或新采集的损益结果",
    output: "满足日期条件的合约账簿损益记录",
    meaning:
      "这里解释已有损益记录的选择规则。损益金额的计算公式和下游日期窗口需要分别核查。",
    evidenceIds: ["200585", "244357", "244380"],
  },
  combined_sources: {
    short: "跨来源拼接",
    question: "放到一起之后，哪些差异仍然保留？",
    change:
      "对齐列、补缺省值、添加标记，以 UNION ALL 追加合约、账户或参数记录。",
    input: "Titans、OIS 及本区不同对象",
    output: "四类合约、账户或参数拼接结果",
    meaning:
      "记录追加保留输入记录，不代表跨来源去重。sys_area_code 的业务标记也不一定等于物理来源系统。",
    evidenceIds: ["41540", "41831", "75089", "42142"],
  },
};

export const observations = {
  103941: {
    title: "互换合约进入合约实体",
    text: "源 TRS 合约进入互换合约实体，补充合约属性并进行代码映射。",
    result: "pdata_n.t03_otc_swap_comp_info",
  },
  119640: {
    title: "TRS 腿历史持仓进入持仓数据",
    text: "读取 TRS 腿历史持仓，按日期选择数据后输出；此处的 SQL 并未重新计算持仓。",
  },
  144765: {
    title: "行情衔接证券编码",
    text: "读取整理后的行情，并关联证券基础信息，将来源标的代码衔接到证券编码。",
    result: "pdata_news_n.tyzx_exch_quot_h",
  },
  107284: {
    title: "合约损益进入盈亏汇总加工",
    text: "下游另有日期窗口和代码映射，源记录的选择与消费日期窗口需要分别看。",
    result: "pdata_n.t98_otc_opt_inr_comp_pal_sum",
  },
  244380: {
    title: "指定版本的损益进入盈亏汇总加工",
    text: "读取 h15risk 版本，并使用下游日期窗口继续加工。",
    result: "pdata_n.t98_otc_opt_inr_comp_pal_sum",
  },
  42142: {
    title: "拼接后的 TRS 结果对外输出",
    text: "按业务日期读取拼接结果，投影字段并填充部分缺省列。",
    result: "gfval.src_otc_trs",
  },
};
