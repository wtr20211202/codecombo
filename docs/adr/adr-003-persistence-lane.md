# ADR-003 持久化 lane 选型——JSON 文档三车道，换库只动车道 1

- 状态：已采纳　日期：2026-10-04

## 背景

本产品的领域就是操作本机文件（文件管理、git、tmux/shell、agent 安装），文件 I/O
本身不是债务，绕过 store 的文件操作会且应该持续增长。真正的问题是**架构漂移**：
「可查询的应用实体」漏进 ad-hoc 文件（历史反例 `peer-certs.json` 整文件重写），
积累后每次换存储都要为泄漏点写专门迁移。曾评估直接上 SQLite——被否，理由见决策。

## 决策

**存储保持零依赖 JSON 文档层（`DocumentStore` + `filestore/`，每文档一 JSON 文件），
用「三车道」纪律锁住形状，而不是换数据库：**

- **车道 1 结构化状态**（应用拥有的可查询实体）→ `DocumentStore` 新增 kind +
  `server/store/<domain>.go` repo；一记录一文档；append 型必须同 PR 带保留策略；
  **禁止单文档存整个数组**（历史反例 snippets `all` / terminal_history）；
- **车道 2 流与大块数据**（日志/录制/产物）→ `~/.simple-coding/artifacts/<feature>/`，
  第一天配轮转；可查询元数据/索引进车道 1（deploytasks ↔ 运行日志的分工）；
- **车道 3 互操作**（用户工作区、git/tmux/agent 配置、`~/.claude` 等）→ 对等读写，
  永不镜像成唯一副本；加速索引必须可重建（范例：claudeindex）；
- 特例（master-key/证书/pid/日志）直接文件 I/O，显式清单收口，新增须在 PR 说明理由。

否决「现在就上 SQLite」：单用户/单机量级下文件存储无性能问题，换库收益为零而
迁移与并发语义成本实打实；故把换库成本**锁死为恒定**——`DocumentStore` 接口 +
conformance 对拍套件（`server/store/conformance.go`）保证未来只动车道 1，
并发语义由 kind 级 flock + atomicWrite fsync 补齐。出现触发条件（多进程写同一
DataDir / 单 kind 上万需真分页 / 事件流·审计·搜索排上日程）再启动换库。

## 后果

- 正面：新落盘数据「先声明车道再写代码」，形状漂移有 review 清单与判定流程兜底；
  车道 1 kind 持续健康增长——约 20 个领域 repo 按此纪律落地（截至 2026-10 已含
  `compareexp`（上限 50）、`claudecur`、`sshhostkeys` 等新成员），保留策略缺口
  （deploytasks 教训）由 review 门禁当场拦下而非事后返工；
- 接受的负面：历史形状问题（snippets/terminal_history 单文档数组）不单独偿还，
  留待换库时一并解决——已列入禁增清单；
- 维护要求：车道 1 新 repo 必须过 conformance 套件；现状基线表随新 kind 演进
  （见 PERSISTENCE_LANES.md「现状归类基线」）。

## 关联

- 纪律全文与现状基线：[docs/PERSISTENCE_LANES.md](../PERSISTENCE_LANES.md)
- 锚点：`server/store/docstore.go`（`DocumentStore` 14 方法）、
  `server/filestore/conformance_test.go`（对拍套件）
- 关联决策：ADR-001（shares 保留策略是本纪律 A2 评审的产物）；
  P-20261003-46（compareexp）/ P-20261003-67（claudecur）/ P-20261003-34（sshhostkeys）
  为新 kind 按本决策落地的样例
