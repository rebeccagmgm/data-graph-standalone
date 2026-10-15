# Data Graph Code

从原项目按文件过滤导出的代码快照，保留原有目录结构。

- `packages/data-graph`：图谱后端、投影与查询。
- `packages/data-graph-ui`：React 图谱界面。
- `scripts`：原有脚本及共享依赖代码。
- `schemas`：数据契约定义。

本仓库不附原有文档、业务 SQL、业务数据、测试样本、缓存、本机配置及旧提交历史。
使用时请自行准备依赖、图数据库配置和外部输入。

图谱后端通过 Node 原生 `fetch` 调用 ArcadeDB HTTP/JSON API，不依赖 `neo4j-driver`。
连接配置的 `graphDatabase.uri` 必须是 HTTP 地址，例如 `http://127.0.0.1:2480`，不能填 Bolt 地址。
参考 `config/workspace.example.json`，将密码保存在 Git 忽略的本地文件中。
Node 需 24 或以上；连接层测试：`npm --prefix packages/data-graph run test:http`。
HTTP 协议参考：[ArcadeDB 官方说明](https://docs.arcadedb.com/arcadedb/reference/http-api/http)。
