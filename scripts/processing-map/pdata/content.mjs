// Authored reading groups for the fixed batch, grounded in output DDL and SQL.
// Membership is explicit; these groups are not formal warehouse layer definitions.
export const snapshotVersion =
  "4f61cee7134b1cba7686191bc0e8606ab28cc4d673935a50298e7ba792babf9a";
// Membership comes from pdata-output-placement.md through placement.mjs.

export const observations = {
  103941: {
    title: "源合约进入模型后增加了身份与转码",
    text: "合约编号与修饰符共同表达身份；源交易对手编号带上前缀，属性、审核和代码映射参与结果。",
    sha256: "f76ab9322f2c1bc9ebcf5d706f1e7c93986b04138e1cb535437e484ce09c2dc6",
    ranges: [
      [1, 18],
      [149, 178],
    ],
  },
  105529: {
    title: "合约与账簿关系保存有效历史",
    text: "当天关系与历史有效关系比较，区分新增、变化、消失及不变，再维护生效区间。账簿关系不是只保存当天的一个属性。",
    sha256: "8fcb7c85359b6a53a24b5192a9f8c551dbf57cf01256f521270b3af0e04562dc",
    ranges: [
      [51, 82],
      [94, 113],
      [133, 204],
    ],
  },
  107018: {
    title: "合约、腿和持仓共同形成交易标的主题",
    text: "沿合约与腿标识接入持仓，再补证券和汇率；更新范围还涉及历史业务日期。没有验证 Join 后唯一性或运行接续。",
    sha256: "6d875301037813f5b68ade3f5fb5c85bc389cc06698d70859015fcc94167eb2d",
    ranges: [
      [1, 6],
      [107, 148],
    ],
  },
  158195: {
    title: "同一当事人的分散属性重新组合",
    text: "以交易对手为起点，按当事人编号补名称、身份、关系、证件和评级；共享输入的生产过程不一定在本批。",
    sha256: "e27aaf7f5fc7b7aae4428640ba8228fd4edb8d5eb3078fae6a0c9e321c34c73f",
    ranges: [
      [142, 175],
      [189, 216],
    ],
  },
  173965: {
    title: "保证金流水按源业务日期整理",
    text: "读取加工日快照，选取源业务日期为当日或源与目标记录数不同的日期，目标分区采用源业务日期。记录数一致并不能证明全部金额未变。",
    sha256: "d22f68617e0a6bde87696208f2b7329333f10d76bfc6460d0f18d594d1dcd9f2",
    ranges: [
      [1, 27],
      [28, 68],
    ],
  },
  147139: {
    title: "这一履保分支实际承载组合结果",
    text: "该写入把 BUNDLE_ID 放入组合编号，账户及合约编号部分为空。不能只因表名含“账户”就认定输出为账户粒度。",
    sha256: "7ad9f1ccc5c9939f37c3b00db17ad87ce3c5f3846e76107b6f128e7b886225e6",
    ranges: [[1, 41]],
  },
  121575: {
    title: "日终指标的日期与采集分区分开",
    text: "从加工日快照选择待更新的报价日期，将 QUOTE_DATE 写为目标业务日期，同时补模型身份和转码。多数指标直接读取源计算结果。",
    sha256: "ca701fcc1112c787f71f767af041eab4ac42e05383d794e3dfcd8867573be8f5",
    ranges: [
      [1, 44],
      [245, 270],
    ],
  },
  105743: {
    title: "销售合约需要跨来源的管理归属",
    text: "销售合约与合约、客户介绍关系连接，再补员工及机构资料。已读分支按字段使用合约介绍信息优先、客户介绍信息补充的 COALESCE。",
    sha256: "4f41d3eefca10d8b23da323ab612ef876fdf087e0c37cabee9e0ec4bb54e78d7",
    ranges: [
      [45, 85],
      [101, 137],
      [162, 200],
    ],
  },
  107491: {
    title: "合约快照展开为计提日期序列",
    text: "从计价开始日与当前日减 150 天的较晚者起展开日期，再补不同产品的历史金额。目标 busi_date 表达计提日，不是基础表所读的加工日。",
    sha256: "8f655b98522a2a9bf6e4c8aa4d945e163242145551096ab992c516dabc825ca6",
    ranges: [
      [11, 51],
      [79, 99],
    ],
  },
  199176: {
    title: "财务源结果与模型身份共同组成输出",
    text: "读取源财务互换视图，按内部合约编号关联模型合约，补协议和交易对手身份；这不是报送成功的证据。",
    sha256: "48477df8b46dd9a362592ddf82d8417bc83ab932db9d0a64c44a6c75ec6fc398",
    ranges: [[1, 38]],
  },
};
