// Focused reading content. Membership/status live only in the reviewed placement document.
const p = (name) => `pdata_n.${name}`;
export const reading = {
  base: p("t98_otc_deri_comp_sale_info"),
  management: p("t98_otc_comp_mng_rela_info"),
  daily: p("t98_otc_deri_comp_sale_adtnl_det"),
  fee: p("t98_otc_opt_comp_eday_prvs_fee"),
  reward: p("t98_otc_deri_undrl_income_rwd_sum"),
  // Selected relationships for learning, not an exhaustive graph or another membership list.
  categories: {
    party: {
      intro:
        "先有主体及其分散属性，再按主体身份组合成交易对手资料。158195 以交易对手为起点，用 Pty_Id 补名称、有效属性和代码描述；左侧其他主体、机构结果各自保留，并不都是这张整合表的加工阶段。",
      connections: [
        {
          id: "158195",
          inputs: [p("t01_pty_cutp"), p("t01_pty_name"), p("ref_dw_cd_val")],
        },
      ],
    },
    contract: {
      intro:
        "合约基础描述对象，结构腿描述合约内部构成，关系历史描述对象在某段有效期内怎样关联。107018 把互换合约、结构腿和各日持仓接到原账簿及映射账簿，形成交易标的结果；它也属于 R。这里选出这项加工的关键输入，其余属性和规则仍在正文及关联索引中。",
      connections: [
        {
          id: "107018",
          inputs: [
            p("t03_otc_swap_comp_info"),
            p("t03_otc_swap_comp_leg_info"),
            p("t03_otc_swap_comp_hold_info"),
            p("t03_agt_rela_h"),
          ],
        },
      ],
    },
    risk: {
      intro:
        "这一类包含持仓和源计算指标，也包含把合约、账簿与金额重新组装的结果。121575 承接已计算的日终指标，先确定待更新的报价日，再补模型标识和转码，按报价日写出；它不是在 PDATA 重新计算全部风险指标。互换交易标的、估值和保证金整合各有独立规则，不能按同类名称串成先后步骤。",
      connections: [{ id: "121575", inputs: "explained" }],
    },
    lifecycle: {
      intro:
        "账户余额、资金变动、组合履保和保证金整合表达不同事实。下图选出履保与资金怎样进入保证金整合的两条已读写入：176874 处理特定组合，176877 以期权合约及持仓为起点。同表还承接176873的互换风险视图记录；三支粒度不同，不能直接当成同一层面的金额累计。本批未见这张整合表的消费者。",
      connections: [
        {
          id: "176874",
          title: "176874 · 组合履保补账户资金",
          inputs: [
            p("t03_otc_cutp_marg_acct_perf_guar_rslt"),
            p("t03_ast_crrc_acct_bal"),
          ],
        },
        {
          id: "176877",
          title: "176877 · 期权持仓补履保与资金",
          inputs: [
            p("t03_otc_cutp_marg_acct_perf_guar_rslt"),
            p("t03_otc_opt_comp_stru_elmn_info"),
            p("t98_otc_book_hold_sum"),
          ],
        },
      ],
    },
    parameters: {
      intro:
        "基础系数与价差系数是经营计算取用的参数。118143 把适用参数组织成快照，118141 在自己的收入计算中匹配参数；两者并行读取，参数快照不是收入的必经上一步。下图只展开参数的作用，销售基础、管理归属、日明细和奖励等输入可回到 S 查看。参数的位置有消费依据，其生产写入仍未逐一解释。",
      connections: [
        { id: "118143", inputs: "members" },
        { id: "118141", inputs: "members" },
      ],
    },
    reporting: {
      intro:
        "财务合约资料与财务交易事件分别保存对象信息和发生事项。199176 为源财务互换资料补模型合约身份与状态；200199 再读取财务合约和事件，形成香港互换交割明细等消费结果。静态加工关系只说明材料怎样组成，不能据此认定已完成交割或报送。",
      connections: [
        {
          id: "200199",
          title: "200199 · 财务合约与事件形成交割明细",
          inputs: "members",
          source: "pdata调研v1.md:107",
        },
      ],
    },
    support: {
      intro:
        "公共规则为其他加工解释代码或选择口径。已读158195用代码字典补主体属性描述，176877也读取状态说明；因此同一规则对象可以支持多条路线。代码历史、精度参数及指标定义的生产职责仍按各自定位状态保留，不能因为都放在 C 就认为它们存在依赖。",
      connections: [
        { id: "158195", inputs: [p("ref_dw_cd_val")] },
        {
          id: "176877",
          title: "176877 · 保证金整合补状态说明",
          inputs: [p("ref_dw_cd_val")],
        },
      ],
    },
    records: {
      intro:
        "这一类保留权限、流程、操作记录及外围客户资料的位置，不是一条统一生产线。已解释的206853补条件单客户和机构，206855整理资金账户与客户对应关系，共用个人客户资料。两份结果在固定范围内均无读取任务，不能把它们自动接成 OTC 合约主线。其他成员的职责仍按左侧状态逐项查看。",
      connections: [
        {
          id: "206853",
          title: "206853 · 条件单补客户与机构",
          inputs: "members",
        },
        {
          id: "206855",
          title: "206855 · 资金账户补客户映射",
          inputs: "members",
        },
      ],
    },
  },
  products: [
    {
      id: "86840",
      title: "期权 · 01",
      detail:
        "交易连接合约、账簿、结构、标的与履保；按条件折算金额。初始、动态、绝对本金各有来源。",
    },
    {
      id: "86841",
      title: "普通互换 · 02",
      detail:
        "先按腿汇总持仓本金，再回接结构腿和非结构腿；最终未按合约重新收敛，多腿可能扩行。",
    },
    {
      id: "86842",
      title: "金仕达 · 03",
      detail:
        "按确认编号选最新业务记录并汇集持仓标的；多空互换的初始本金取动态本金，其余类型取源名义本金。",
    },
    {
      id: "220650",
      title: "极速互换 · 04",
      detail:
        "按产品汇总日终持仓；初始本金汇集各标的最早保留持仓，各标的首次持仓日未必相同。",
    },
  ],
  results: {
    [p("t98_otc_deri_comp_sale_info")]: {
      title: "销售合约基础",
      purpose:
        "把四类产品整理成共同的销售分析入口，供归属、逐日金额及经营消费分别取用。",
      row: "一条销售合约快照记录，保留产品、客户、标的和本金等资料。源腿及关联可能扩行，不能承诺一合约一天唯一一行。",
      identifiers:
        "期权、普通互换、极速互换：Agt_Id = INTERNAL_TRADE_ID，Inr_Seri_No = KEY_OTC_TRADE_ID。金仕达：Agt_Id = KEY_TRADE_COMFIRM_ID，Inr_Seri_No = CONTRACT_CODE。Grp_Id 的 01／02／03／04 区分四类写入。模型 Swap_Comp_Agt_Id 来自 KEY_OTC_TRADE_ID，不能直接与销售 Agt_Id 按同名含义关联。",
      dates:
        "Busi_Date 是本次销售快照日期；Strt_Pric_Date／End_Pric_Date 表示计价起止，Early_Term_Date 是提前终止日，三者不能代替快照日。",
      example:
        "示意，非真实数据：源技术 ID=K1001、内部合约号=SWAP-A001。模型合约号可为 K1001，销售 Agt_Id=SWAP-A001、Inr_Seri_No=K1001。",
      formation:
        "四项写入分别处理产品资料，再共同写入本表。105743 整理管理归属，107491 展开计提日；118143、118141、230202 也各自读取基础。",
      tasks: ["86840", "86841", "86842", "220650"],
      source: "pdata调研v2.md:76",
    },
    [p("t98_otc_comp_mng_rela_info")]: {
      title: "管理归属快照",
      purpose: "为销售合约提供人员、机构及分配比例，供参数展示和收入分配。",
      row: "销售合约与交易对手的归属快照；最多三组人员／机构／比例横向保存在一行。不是一位介绍人一行，DISTINCT 不证明候选键唯一。",
      identifiers:
        "Agt_Id 承接销售编号；Pty_Id 承接销售交易对手号。合约介绍关系以 Contract_Code 接 Agt_Id，客户关系按客户号连接，部分凭证有替代客户键。人员、机构、比例分别 COALESCE，可混合合约级与客户级来源。",
      dates:
        "Busi_Date 是加工日快照；机构补充另使用 SQL 中的交易日函数口径。不能直接当成历史计提日当时的人员机构。",
      example:
        "示意，非真实数据：甲／乙／丙比例 0.6／0.3／0.1 横向进入前三组。某个合约级机构字段为 NULL 时可取客户级机构，已有人员和比例仍保留；空字符串不会自动回退。",
      formation:
        "105743 先排序、补人员机构并写 otc_div_temp，再回接销售、逐字段回退。118143 与 118141 分别消费归属。",
      tasks: ["105743"],
      source: "pdata调研v2.md:112",
    },
    [p("t98_otc_deri_comp_sale_adtnl_det")]: {
      title: "销售按日附加明细",
      purpose: "把本次销售快照展开为计提日期，配上各产品逐日金额、费用与参数。",
      row: "销售快照记录 × 计提日形成的分析资料。连接历史来源后可能扩行，Agt_Id＋日期＋产品分支仅是理解入口，实际唯一性未验证。",
      identifiers:
        "Agt_Id 沿用销售编号。evt／his_dy 用 Inr_Seri_No；ks／ks_t 用确认编号 Agt_Id；nd／fee 用产品号 Otc_Seri_No；各自还需日期关联。",
      dates:
        "Busi_Date = Accrued_Date（计提日），Data_Etl_Date／Data_Upt_Date = 本次加工日。日期从 max(起始日, 加工日−150天) 展开到加工日；结束日另控制产品金额，不统一截断序列。历史金额可能配当前客户、初始本金及折算系数。",
      example:
        "示意，非真实数据：9月7日读取9月5日起始的销售快照，生成9月5／6／7日三条计提资料，Data_Etl_Date 都为9月7日。",
      formation:
        "107491 的 info 展开日期，evt、his_dy、ks／ks_t、nd、prop、fee 各自整理后按对应键回接；118141 收入和230202创收按各自范围读取。",
      tasks: ["107491"],
      source: "pdata调研v2.md:130",
    },
    [p("t98_otc_opt_comp_eday_prvs_fee")]: {
      title: "期权日计提费用",
      purpose: "承接源日计提费用事实，向创收提供当日费用金额。",
      row: "保留源费用明细编号、产品号、费用类型与业务日；230202 再按产品号和业务日汇总。不能将源明细行与消费汇总行混为一种粒度。",
      identifiers:
        "Src_Prd_Id 是源产品号，消费时接销售 Otc_Seri_No；费用类型在创收中区分期权费与其他费用。",
      dates:
        "Busi_Date 表达费用业务日。124561／211547 引用的 TEMP_1 日期来源仍缺证据。",
      formation:
        "两项已读写入承接源费用；固定网络唯一可见消费者为230202。未建立本表到118141的连接。",
      tasks: ["124561", "211547"],
      source: "pdata-output-placement.md:224",
    },
  },
  consumers: {
    118143: {
      title: "销售参数快照",
      output: "dm_otc_n.otc_sale_para",
      sha256:
        "f342363e48a55e018795ea2632627ae4fa7864d5a63d0331b50630e56dfd6016",
      lines: [124, 220],
      purpose:
        "为适用销售合约组织经营参数及管理归属，供参数查看。与收入计算并行。",
      row: "销售合约的参数快照记录，关联后的真实唯一性未验。",
      identifiers: "销售 Agt_Id 为关联入口；保留客户、产品及三组管理归属。",
      dates:
        "Busi_Date 是报告快照日；价差参数按最新有效记录排序选择，不能当作所有历史计提日参数。",
      scope:
        "已读版本排除 FEE_SWAP、Grp_Id=04 与 OTC_HK，并限定结束日晚于2021-09-30。",
      formation:
        "读取销售基础、管理归属、基础及价差系数。118141直接读取自己的基础资料，未把本结果作为必经输入。",
    },
    118141: {
      title: "逐日销售收入",
      output: "dm_otc_n.otc_sale_daily_rpt",
      sha256:
        "3deef0d98f78f781092ddf8e42623c2e43b41b6d66f43e6e9e0f4a50b0acc9e5",
      lines: [297, 418],
      purpose: "对适用产品计算逐日收入，进行保底调整、人员分配及累计。",
      row: "报告版本内的销售合约计提日记录，三组人员分配横向保留。基准连接只按 Agt_Id 接日明细，未同时限定 Grp_Id，行唯一性仍未验。",
      identifiers:
        "销售 Agt_Id 与计提日期定位收入；Allo_Prop_1／2／3直接乘调整后收入。",
      dates:
        "Busi_Date 是报告日，Accrued_Date 是收入对应的计提日。价差系数按计提日匹配，客户产品系数及部分基准、资金成本按起始日匹配。",
      scope:
        "排除 FEE_SWAP、极速互换及 OTC_HK，另有机构条件与指定合约例外；四类基础产品不都参与。",
      formation:
        "直接读取销售基础、管理归属、按日明细、各类参数；已有奖励汇总参与部分期权保底调整，再分配和累计。奖励是影响收入的输入，其生产及发放接续未核。",
      example:
        "示意，非真实数据：适用年化分支，1000万×(0.6%＋0.2%)÷365≈219.18，仅为调整前日收入；还需产品规则、保底及分配。",
    },
    230202: {
      title: "创收消费",
      output: "dm_otc_n.otc_rev_daily_rpt",
      sha256:
        "fa1695538980201e7f95e5904b39db2115c50872b8aec38a23e0aa239daacb2e",
      lines: [156, 195],
      purpose:
        "使用销售共用基础与日明细，再补日计提费用，按自己的规则形成创收。",
      row: "适用期权的逐日创收记录；静态对冲关系另整理分组，不能统一承诺合约日唯一。",
      identifiers:
        "基础与日明细按 Agt_Id 连接；源费用按 Src_Prd_Id＋Busi_Date 汇总，再接 Otc_Seri_No＋日明细业务日。",
      dates:
        "读取报告日的销售快照；日明细限定在起止计价日内，费用按其业务日补入。",
      scope:
        "补充v3筛选 OTC 期权（Grp_Id=01），区分普通与静态对冲分支；普通分支还排除 TRS_INNER。固定v2缺失，口径一致性未证。",
      formation:
        "销售基础＋按日附加明细＋日计提费用共同参与。本结果与销售收入共享部分基础，但不等于销售收入或费用表的简单下一步。",
    },
  },
};
