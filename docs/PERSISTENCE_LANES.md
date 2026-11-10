# 持久化三车道纪律（Persistence Lanes）

> **新增任何落盘数据前必读本文件。** 数据必须先声明车道，再写代码。
> 本纪律保证一个长期性质：无论文件 I/O 随功能增长多少，**换 SQLite 时只动车道 1，迁移成本恒定**。
>
> 判定问题一句话：这块数据的 source of truth 是不是本应用拥有、且需要查询/事务/增量修改的实体？
> 是 → 车道 1；追加流/大块数据 → 车道 2；别人的文件 → 车道 3；密钥/证书/运维文件 → 特例清单。

---

## 目录

- [背景：为什么需要车道纪律](#背景为什么需要车道纪律)
- [车道 1：结构化状态](#车道-1结构化状态)
- [车道 2：流与大块数据](#车道-2流与大块数据)
- [车道 3：互操作](#车道-3互操作)
- [特例清单（不属于任何车道）](#特例清单不属于任何车道)
- [判定流程](#判定流程)
- [现状归类基线（2026-10）](#现状归类基线2026-10)
- [Code Review 检查清单](#code-review-检查清单)
- [何时换 SQLite（触发条件）](#何时换-sqlite触发条件)
- [已知历史债务](#已知历史债务)

---

## 背景：为什么需要车道纪律

当前持久化架构：`DocumentStore` 接口（`server/store/docstore.go`，15 个方法，含
repo 层三步 upsert 样板收口用的 `Upsert`）+
唯一实现 `fileDocStore`（`server/filestore/`，每文档一个 JSON 文件，位于
`~/.codecombo/data/<kind>/<key>.json`（P-20261025-1 起；旧 `~/.simple-coding/` 启动期自动迁移）），上层约 20 个领域 repo（`server/store/*.go`）。

产品是单用户/单机定位，文件存储在当前数据量下没有性能问题；真正的风险是**架构漂移**：

1. 文件 I/O 本身不是债务——本产品的领域就是操作这台机器上的文件（文件管理、git、
   tmux/shell、agent 安装），绕过 store 的文件操作会且应该持续增长；
2. 债务是**车道 1 形状的状态漏进 ad-hoc 文件**（历史反例：`peer-certs.json`——
   一个被并发查询、增量修改的应用实体，以整文件重写方式住在临时文件里）；
3. 一旦泄漏积累，未来换 SQLite 时每个泄漏点都要写专门的迁移逻辑，成本开始随功能数增长。

因此纪律只锁一条线：**能被查询的应用实体，只允许住在 DocumentStore 里。**

---

## 车道 1：结构化状态

**定义**：应用拥有、需要查询/事务/一致性/增量修改的实体——项目、凭据、令牌、审批、
任务、通知、会话元数据等。

**载体**：`DocumentStore` 新增 kind + `server/store/` 新增 repo 文件。

**必须（MUST）**：

- 一条记录 = 一条文档；键用稳定且有语义的 ID（uuid / 用户可见标识）。
- 新 kind 必须有对应 repo 文件（`server/store/<domain>.go`），handler 不直接调
  `DocumentStore`——保持现有「repo 层 = 唯一访问面」约定，这是换库时业务层零改动的根基。
- **append 型 kind 必须同时实现保留策略**（上限或 TTL），参照：
  notifications 上限 200（`server/store/notification.go` `notificationMax`）、
  agenttask 7 天 ticker 清理（`server/api/ai/module.go` 启动注册）。没有保留策略的
  append kind 不会被合并（参照 deploytasks 的教训）。
- 集合增大后需要分页/排序/过滤：先按「加载全部 + 内存过滤」实现可以接受（有 3~5s
  TTL 缓存模式可抄），但在 PR 里注明「将来下推到存储层」。

**禁止（NEVER）**：

- **单文档存整个数组/集合**（键类似 `all`，或「每项目一条文档装全部历史」）。
  历史反例：snippets（`all` 单键）、terminal_history（每项目一条装 500 条）——
  历史遗留，迁移 SQLite 时一并解决，**勿模仿、勿新增**。
- 绕过 store 在任意路径写可变 JSON / 状态文件（即「第四车道」）。
- **读路径写盘副作用**：列表/查询接口里做数据迁移、重加密、格式升级
  （反例：`server/store/sshkey.go` `listMeta` 惰性重加密）。迁移类操作放启动期
  或显式迁移命令。**唯一例外**：filestore 损坏文档隔离（P-20261004-76）——
  读到非法 JSON 改名 `.corrupt-*` 留证 + Warn + 按 `ErrNotFound` 回落
  （`server/filestore/quarantine.go`），属自愈而非迁移：不转换数据、无格式升级、
  单次幂等、改名失败降级为仅 Warn 不阻断读。

## 车道 2：流与大块数据

**定义**：追加型日志、会话/屏幕录制、构建产物、下载缓存、导入导出包——
**文件本身就是数据**，不需要字段级查询（或查询可走元数据索引）。

**载体**：`~/.codecombo/artifacts/<feature>/`（本纪律新立的目录约定），
现有日志沿用 `logs/`（15 天轮转）、更新下载沿用现状。

**必须（MUST）**：

- **第一天就配轮转/保留策略**（大小上限、条数上限或 TTL），与功能同 PR 交付。
- 需要「列表/搜索/按条件查」时：元数据与索引进车道 1 kind
  （参照 deploy 任务元数据 `deploytasks` ↔ 运行日志 logBuf 的分工；持久化日志
  落地时也应如此拆——deploy 留档快照已照此落地，见下方车道 2 现状）。
- 单文件预计 >1MB 且需要整体读入内存才能查询的，重新判定：要么拆成车道 1 记录，
  要么为它建车道 1 索引。

**迁移语义**：车道 2 的文件迁移 = 原样拷贝，不做格式变换。因此文件内部格式自由
（.log/.cast/.tar.gz），但**可查询状态不许只存在于文件内容里**——那是车道 1 的事。

## 车道 3：互操作

**定义**：不属于本应用的数据——用户工作区文件、git 仓库与配置、tmux/shell/agent
配置、外部工具数据（`~/.claude/projects/*.jsonl`、`~/.codex/` 等）。

**规则**：

- 以对等身份读写：走既有入口（文件 API、`execGit`、fsnotify、直接读写），
  **永不把外部数据镜像进车道 1 当作唯一副本**。
- 加速用的索引/缓存必须**可重建**（rebuildable）：损坏或删除后能从源文件全量重建，
  重建入口写清楚（启动重建 / 手动触发）。实现参照规划中的 claude-sessions 索引。
- 对外部文件按外部工具的格式写（如 git config、tmux.conf），不发明旁路状态文件。

## 特例清单（不属于任何车道）

以下允许直接文件 I/O。**新增特例必须在 PR 中说明理由并更新本清单**：

| 路径 | 理由 |
|---|---|
| `~/.codecombo/master-key`（`server/config/crypto.go`） | 密钥先于加密体系存在（DB 加密依赖它，鸡生蛋） |
| `~/.codecombo/data/token-salt/`（`server/store/token.go`） | 同上，令牌哈希盐 |
| `~/.codecombo/instance-id`（`server/claims/claims.go`） | 数据目录级持久实例身份（双开检测去幻报），pid 同族运维基础设施 |
| 项目 `.git/codecombo/project-claims/`（`server/claims/`；旧 `.git/simple-coding/project-claims/` 扫描面并集兼容，P-20261025-1） | 双开检测的跨实例共享锚点（P-20261003-3）：各实例数据目录互不可见，同目录唯一必然共享处是目录本身的 .git（对 git status/文件树不可见）；心跳续期 + staleness 自清理 + 退出清理，短暂易逝无查询需求 |
| `~/.codecombo/license.key` | 授权文件，独立生命周期 |
| TLS 证书目录 | 证书生命周期管理 |
| `*.pid`、dsh 标志文件 | 运维基础设施 |
| `logs/` 日轮转日志（15 天） | 基础设施，已有保留策略 |
| 更新下载产物 / `update-result.json` | 单写者 + 5 分钟 TTL 快照（边缘案例，接受）；P-20261109-10 起新进程启动观察窗推送结果通知后回写 `notifiedAt` 跨重启防重（读改写保留 Timestamp 锚，仍是同一文件快照语义，不升格车道 1） |

---

## 判定流程

新功能涉及持久化时，按顺序回答：

```
1. source of truth 是本应用拥有、需要查询/事务/增量修改的实体？
   ├─ 是 → 车道 1：新增 kind + repo 文件（遵守 MUST/NEVER）
   └─ 否 ↓
2. 是追加型流 / 二进制大块 / 产物，不需要字段级查询（或查询走元数据）？
   ├─ 是 → 车道 2：artifacts/<feature>/ + 轮转保留 + 元数据进车道 1
   └─ 否 ↓
3. 是别人的文件（用户工作区 / 外部工具 / 系统配置）？
   ├─ 是 → 车道 3：对等读写；索引可重建
   └─ 否 ↓
4. 密钥 / 证书 / pid / 一次性快照？→ 特例清单（新增须说明理由）
   └─ 都不像 → 回到 1 重新审：大概率它就是车道 1
```

---

## 现状归类基线（2026-10）

**车道 1（store kinds）**，按增长类型分组：

| 增长类型 | kinds | 保留策略 |
|---|---|---|
| 固定/低频（用户创建） | projects, credentials, sshkeys, tokens, agenttokens, quickdroptokens（快投递凭据单例，P-20261006-51，仅哈希不存明文——生成即轮换/撤销，无 TTL 由用户显式管理）, hooktokens（入站事件 Hook 凭据单例，P-20261003-23，仅哈希不存明文——签发/轮换/销毁由用户显式操作，无 TTL；销毁即入站全部 401）, remotehosts, templates, shares, notifprefs, uistate, config/settings, deployconfig, instances, inst-status, lock, agentsessionmeta, claudecur（Claude 会话星标/备注/隐藏/轮级书签/轮级语义标签，P-20261003-67 + P-20261003-112 + P-20261003-122 + P-20261003-256，键控 upsert 一会话一文档（书签=同文档 bookmarks 集合上限 200 保最新，标签=同文档 tags (轮,标签名) 对集合上限 200 同款钳制，非追加型 kind 无保留策略义务）；transcript 消失后孤儿保留——同 id 重建自动跟回）, compareexp（对比实验记录，P-20261003-46，上限 50 裁剪最旧）, expapply（对比实验采用落盘记录 + 强制备份（还原补丁/被删 untracked 字节内嵌文档体，单记录硬上限 8MB 超限拒执行），P-20261004-72，一动作一文档，上限 20 裁剪最旧；实验删除级联清账）, agentsessionqueue（运行中会话的排队指令，P-20261003-248，一会话一文档、单队列上限 5 条；单会话文档有界即保留策略，会话关闭随 CloseTerminal 删除）, agentchain（会话接续链定义，P-20261004-38，一链一文档，上限 50 裁剪最旧；触发事实 lastTriggeredAt/lastSessionId 同文档 RecordTrigger 单点写入）, claudeassoc（Claude 恢复链终端↔transcript 会话关联，P-20261031-1，键控 upsert 一会话一文档；Active 精确判定的数据面——活终端挂载=活跃、关联终端已关=立即失活；列表端点对死关联超 30 天尽力 GC（活挂载豁免），transcript 消失后孤儿条目无害不产幽灵行） | 手动删除/TTL，无需变动, uisnap（用户 UI 现场最近快照，P-20261004-52，instance 级单文档 last-write-wins——保留策略即形态本身；TTL 10 分钟无心跳读取端查无，读端时钟判定无清理义务）
| 低频（连接期自动写入） | sshhostkeys（SSH 主机密钥 TOFU 指纹，P-20261003-34，host:port 一文档；随主机删除/改地址级联清理，重连自动重新首录） | ✅ |
| 高频追加，已有保留 | notifications（上限 200）, agenttask（7 天）, quickdrops（快投递收件箱，P-20261006-51，一投递一文档、上限 20 裁最旧 + 单条 TTL 24h 创建即定——模块 10 分钟巡检清账 + List/Get 惰性把守双路径；内容明文与 agentask 同级敏感面过窗即删）, recording（审批过程实况索引，90 天）, dailyreport（日报存档，14 天滚动，随发报巡检裁剪）, activityday（实例活动序列行，P-20261003-37，365 天滚动随发报巡检裁剪；日报存档旁路投影，按日 upsert 幂等）, inbox（会话间定向消息收件箱，P-20261004-68，一会话一文档、环形 20 条裁最旧 + 单条 TTL 24h——Append/Take 惰性剪枝 + 模块小时级巡检清账整箱；目标会话关闭**不级联清理**，无主收件箱随 TTL 自然过期）, replacehist（批量替换历史留档，P-20261004-66，一替换一文档、键 `<projectId>-<unixNano>-<rand>` 前缀圈定按项目查询；补丁 base64 内嵌（--binary patch，超 2MB 只留 artifacts 文件名引用如实标注）；保留 = 每项目 20 份逐最旧 + 30 天 TTL（files 模块每日 ticker）双上界，项目删除级联清账）, fsattribution（文件改动来源归因账，P-20261005-170，每项目一文档环形 500 条 + 同路径 2s 紧邻事件就地合并——terminal_history 同形状例外：文件事件频率远高于命令，一事件一文档会放大文档 churn；项目删除级联清账）, cronmetric（定时任务指标时序，P-20261005-237，一任务一文档、环形 30 点裁最旧——环形保留即保留策略，无需时间窗清理 ticker；只存数值点不存输出原文，任务删除级联清账）, diaghist（远程诊断数值趋势摘要，P-20261002-18，一主机一文档、环形 20 条裁最旧——环形保留即保留策略；只存数值不存全文报告，主机删除级联清账）, selfcheckhist（本机体检数值趋势快照，P-20261005-169，diaghist 同族不同 kind——DiagSnapshot 无会话/终端字段且远程列表按主机枚举读取面对本地条目天然不可见；单实例恒一文档固定键 local、环形 20 条裁最旧，每日定时巡检+每次 GET /api/selfcheck 体检入账） | ✅ |
| **追加，无保留（待补）** | **deploytasks, agentapproval（非消费态）, shares（长期堆积）** | ❌ 见债务清单 |

**历史形状问题（勿模仿）**：snippets（`all` 单键存全量）、terminal_history（每项目一条文档装 500 条 × 8KB）。

**车道 2 现状**：日志 `logs/`（15 天）、更新下载、审批过程实况 cast `artifacts/recordings/`
（P-20261001-15，90 天，与车道 1 `recording` 索引同 ticker 清理）；deploy 运行日志内存环
（logBuf 200 条）+ 终态快照留档 `artifacts/deploy-logs/`（P-20261007-8，文件名=任务 id、
内容=渲染终形 txt，寿命同任务记录 30 天——随 deploytask-cleanup 巡更同批孤儿对账清理，
单快照 1MiB 封顶；元数据在车道 1 `deploytasks`，文件名即 id 无需独立索引）；
文件回收站 `artifacts/trash/`（P-20261003-304，7 天/500MB 双上限逐最旧）；
冻结分享快照 `artifacts/share-snapshots/`（P-20261003-320，目录名 = 零代际派生
token——rotate 换链副本不动；单份 200MB/总量 1GB 护栏 + 记录侧 30 天 TTL，
撤销即删、孤儿对账兜底；可查询元数据在车道 1 `shares` 的 `frozen` 标记记录）；
批量替换备份 `artifacts/replace-backups/<projectId>/`（P-20261004-114，执行前
强制落档的工作区 --binary patch，30 天/每项目 50 份双上限逐最旧，项目删除
级联清空；清单/内容经 GET /api/projects/:id/replace/backups 查询；P-20261004-66
起同一内容以 base64 内嵌车道 1 `replacehist` 文档——artifacts 副本吃清账，
内嵌副本承载产品内一键还原，还原端内嵌缺失时回落读本目录）；
审计归档 CSV `artifacts/audit-archive/`（P-20261003-277，auditlog-cleanup 每日
巡更在时间窗清理前把将出窗事件转 CSV 留档，`audit-archive-<日期>.csv` 每日一
文件追加制；膨胀防线 = 归档文件沿既有 `auditRetentionDays` 窗口随同一巡更
清账——总覆盖 ≈ 2×保留窗口；可查询状态仍以车道 1 `auditlog` kind 为准直到
出窗，文件是离线留档 trail 非查询面）。

**车道 3 现状**：用户工作区（文件 API / gitops / merge 冲突读取）、git hook 与
credential-helper 配置注入、tmux.conf / shellint 脚本、agent 技能安装
（`server/agentops/install.go` → `~/.claude/skills/` 等）、claude 会话 `.jsonl` 只读消费
（`server/claudesessions/`）。

**孤儿数据**：`data/aiproviders/`、`data/opschat_sessions/`——功能已删（commit be5f477），
目录残留待清理。

---

## Code Review 检查清单

涉及落盘数据的 PR，reviewer 逐项过：

- [ ] 新增持久化数据已声明车道（PR 描述注明车道编号及理由）
- [ ] 车道 1：有 repo 文件；无「单文档存数组」；append 型有保留策略
- [ ] 车道 2：路径在 `artifacts/<feature>/`；第一天就有轮转/保留；可查询元数据在车道 1
- [ ] 车道 3：外部数据未被镜像成唯一副本；索引/缓存可重建且写明重建入口
- [ ] `~/.codecombo/data/` 下没有 filestore 之外的新写入方；若新增特例，清单已更新
- [ ] 读路径（List/Get/校验）无写盘副作用（filestore 损坏文档隔离除外——见上方
      「禁止」节例外注记；repo/handler 层读路径仍一律禁止）
- [ ] 密钥/敏感字段走 `config.EncryptToken` 体系（见 CLAUDE.md「敏感数据加密存储」）

---

## 何时换 SQLite（触发条件）

出现以下任一情况时启动换库（写 SQLite 版 `DocumentStore` + conformance 测试对拍 +
通用迁移器 kind/key/JSON → 行），**车道 2、3 不动**：

1. 需要多进程 / 多实例写同一 DataDir（当前 filestore 无文件锁，仅原子 rename）；
2. 单 kind 文档量上万且需要真分页 / 字段级查询；
3. 第一个事件流 / 审计 / 搜索类功能排上日程（FTS5、`DELETE WHERE created_at < ?`、
   原子条件写是文件方案给不了的能力）。

换库前置：DocumentStore conformance 测试套件已就绪（同一份用例跑文件实现与 SQLite 实现对拍）。

## 已知历史债务

| # | 债务 | 处置 |
|---|---|---|
| 1 | `peer-certs.json`（`server/peercert/peercert.go`）TOFU 指纹表整文件重写 | ✅ 已收编为 kind `peercerts`（host 一文档，键 = host 哈希）；旧文件由组合根启动期 `peercert.MigrateLegacy()` 导入，原文件改名 `.migrated` 留备份 |
| 2 | deploytasks / agentapproval 无保留策略 | ✅ 已补：deploy 模块 30 天 ticker、ai 模块 30 天兜底（`CleanupBefore`）。shares 经评审**不做自动清理**——活链接自动删除是功能性回归，增长由用户驱动且确定性 Token 去重，见 `store/share.go` 接口注释 |
| 3 | snippets `all` / terminal_history 整数组单文档 | 不动，SQLite 迁移时一并解决；禁止新增同类 |
| 4 | sshkey `listMeta` 读路径惰性重加密 | ✅ 已迁启动期 `MigrateLegacyPem()`（组合根调用一次）；读路径保留明文/旧字段兼容读取但零写盘 |
| 5 | 孤儿目录 aiproviders / opschat_sessions | ✅ 组合根启动期 `cleanupOrphanKinds` 删除 |
| 6 | 孤儿/越界写入的检测手段缺失 | 可选：启动期扫描 `data/` 非 filestore 格式文件并告警 |
| 7 | ~~跨进程写无互斥、rename 前无 fsync~~ | ✅ filestore 已补：变更类操作叠加 kind 级 flock（`<kind>.lock`，Windows LockFileEx / Unix flock），`atomicWrite` rename 前 fsync。换 SQLite 后由数据库锁接替 |
| 8 | ~~agenttask 列表 O(n²) 排序、agenttoken 每请求读盘、proxy SetStatus 每请求写盘~~ | ✅ 已修：sort.Slice / 5s TTL 缓存（写后失效）/ 变更才落盘 |
| 9 | ~~Claude 会话列表每次全量读 transcript~~ | ✅ 可重建索引（kind `claudeindex`）：列表请求 stat 级对账，未变更文件零内容读；搜索仍走全量扫描。车道 3 加速的首个范例实现 |

换库前置（conformance 套件）已就绪：`server/store/conformance.go`（`RunConformance`），文件实现经 `server/filestore/conformance_test.go` 对拍全绿；SQLite 实现接入时跑同一 suite 即可。
