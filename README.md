# Data Graph Code

基于 SQL 与表结构证据构建可复核的表级、字段级血缘图谱，使用 ArcadeDB 存储，提供查询接口及 React 图谱展示。

完整技术路线、分层职责、数据契约、图模型、运行入口和验证边界见 [技术方案](TECHNICAL_DESIGN.md)。当前生成器输出 **1.3.0**，消费端以 **2.0.0** 为当前 L1 门槛；不能把读取支持写成已完成迁移，详见技术方案第 10 节。

字段字典、事实关联键、接续算法、缓存与事务、HTTP 接口和 SQL 解释示例见 [实现明细](IMPLEMENTATION_DETAILS.md)。

理解节点、边和稳定 ID，可从 [第 7 节：任务内投影与身份](IMPLEMENTATION_DETAILS.md#7-任务内投影与身份) 开始，按业务视图、读写上下文、存储实现逐层阅读。

保留 SQL 采集、输入清洗与修复、血缘事实加工、图谱构建及查询展示代码。

- `packages/data-graph`：图谱后端、投影与查询。
- `packages/data-graph-ui`：React 图谱界面。
- `scripts/input`、`scripts/evidence`：采集、输入整理和证据处理。
- `scripts/plans`、`scripts/machine-facts`、`scripts/reconcile`：解析、事实加工和血缘对账。
- `scripts/project-graph`：图谱准备与投影。
- `scripts/shared`：图谱依赖的共享助手。
- `schemas`：数据契约定义。

已排除专题网页、业务分析页面、实验、固定案例审计及无关工具。
不附原有文档、业务 SQL、业务数据、原项目测试样本、缓存、本机配置及旧提交历史。
使用时请自行准备依赖、图数据库配置和外部输入。

主线入口：采集或缓存导入 → `input-pack:machine-facts` → `graph:prepare` → `graph:publish`。当前生成的 1.3.0 事实按遗留证据分级；发布还需要本机配置、边界规则和实际数据库。
查询和展示使用 `graph:query`、`graph:serve`、`graph:ui`；`npm test` 验证连接层。

图谱后端通过 Node 原生 `fetch` 调用 ArcadeDB HTTP/JSON API，不依赖 `neo4j-driver`。
连接配置的 `graphDatabase.uri` 必须是 HTTP 地址，例如 `http://127.0.0.1:2480`，不能填 Bolt 地址。
参考 `config/workspace.example.json`，将密码保存在 Git 忽略的本地文件中。
Node 需 24 或以上；连接层测试：`npm --prefix packages/data-graph run test:http`。
HTTP 协议参考：[ArcadeDB 官方说明](https://docs.arcadedb.com/arcadedb/reference/http-api/http)。
