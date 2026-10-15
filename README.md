# Data Graph Code

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

入口：`input-pack:*` → `input-pack:machine-facts` → `graph:prepare` → `graph:publish`。
查询和展示使用 `graph:query`、`graph:serve`、`graph:ui`；`npm test` 验证连接层。

图谱后端通过 Node 原生 `fetch` 调用 ArcadeDB HTTP/JSON API，不依赖 `neo4j-driver`。
连接配置的 `graphDatabase.uri` 必须是 HTTP 地址，例如 `http://127.0.0.1:2480`，不能填 Bolt 地址。
参考 `config/workspace.example.json`，将密码保存在 Git 忽略的本地文件中。
Node 需 24 或以上；连接层测试：`npm --prefix packages/data-graph run test:http`。
HTTP 协议参考：[ArcadeDB 官方说明](https://docs.arcadedb.com/arcadedb/reference/http-api/http)。
