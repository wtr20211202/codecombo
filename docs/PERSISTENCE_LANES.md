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
- [UI 状态保持矩阵（P-20261114-2-S2）](#ui-状态保持矩阵p-20261114-2-s2)
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
| `.part` 续传半截文件 + `.part.meta` 旁元数据（server/update/partresume.go，tmp/update-<版本>/ 下） | 自更新断点续传的跨重启半截现场（P-20261110-1-S1，可再生临时产物）：元数据记录资产身份（URL/ETag/总长）防「半截 A+半截 B」拼接，成功即原子 rename 消费、失败保留待续传；保留期 7 天（`CleanupOldUpdateTmp` 启动期回收，不升格车道 1） |

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

## UI 状态保持矩阵（P-20261114-2-S2）

> **范围边界声明（首轮修订⑤）**：本矩阵主面 = 前端 UI「保持语义」状态三项族——① uiState 命名空间（collect 收集轨 + saveXxx→patchNamespaces 专用读写器轨 + 退役档）、② localStorage/sessionStorage `sc.*` 键控面、③ usePanelLayout 内存态（临时档）。非 `sc.*` 前缀的同通道键（theme-settings / font-settings / terminal-theme-follow / notify-dnd / notify-dnd-manual / notify-sound / notify-simple / notify-scroll-read / ctx-warn-pct / ui-zoom-settings / graph-lane-settings / file-nesting-settings / editor-recent-files / home-recent-projects / clone-prefs / clone-url-history / runbook-params-history / locale（LOCALE_STORAGE_KEY）/ opsAtomPrefs ATOM_STORAGE_KEYS / theme early-init / updateCheck 版本记忆 / useSearchHistory / useSearchScope 等）为**存量族**：早于 `sc.*` 命名约定或独立约定，**不强制收编**（S1 审计 docs/ui-state-audit-20261114.md 三.3 边界定案维持）——新增同通道键应按 `sc.*` 约定命名并走登记纪律。

> **登记与门禁**：登记号 = `web/src/persistence/uiStateLanes.json` 的 rows[].id，本矩阵三表与注册表**逐行逐格对应**（一致性单测 `web/src/__tests__/persistence/uiStateLanes.test.ts` 钉住：文档行=注册表行，单元格不一致即红）——改动先改注册表再同步本表对应行，`check:uistate-lanes` 门禁（挂 npm run check/check:fast 尾链）与单测双红强制同步。存量 `sc.*` 生产键（S2 门禁机械实勘 **48 逻辑键 / 47 豁免条目**——S1 审计口径「44 生产键」为引号字面量行去重统计，模板串/拼接前缀族的归并方式不同，门禁以提取面为准）逐条注缘由入注册表 legacyScKeys 豁免基线（键面已删报红强制修剪）；新键一律登记 rows[].keys（exact 或尾随 * 前缀形态，动态拼接族 `sc.agentQueue.draft.<sessionId>` 等按前缀登记）。

> **多标签列注记（首轮修订④）**：同实例多标签页并存时，uiState 两轨以键级补丁（相对基底的脏键 diff，本页未动键零外发）+ 命名空间浅合并 + 即时写乐观推进落位——**后写赢**（最后落位者胜，关页 forceSave 走 keepalive 补丁同样只发本页变更键，A 页 boot 旧值不整包覆盖 B 页新值，P-20261002-8 核心语义）；localStorage 同设备多标签共享、同为此语义；sessionStorage 例外（标签页隔离）。

> **换机器列注记（首轮修订④）**：uiState 落服务端数据目录 `~/.codecombo/data/uistate/`（kind=uiState，实例键控）——数据目录整体迁移/同步/换机部署时**跟随**；localStorage/sessionStorage 是浏览器设备本地存储，**不随数据目录**（换浏览器/换机器即失，与 uiState 车道形成按实例/按设备两档）。

> **三轨选轨判据**：何时 collect 面 / 何时专用读写器 / 何时 localStorage / 临时态不登记——成文见 CLAUDE.md 前端纪律节「UI 状态保持三轨选轨与登记」。

### ① uiState 命名空间（collect 收集轨 + 专用读写器轨 + 退役档）

| 登记号 | 状态项 | 车道 | 刷新 | 路由往返 | 多标签 | 换浏览器 | 换机器 | 清除语义 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| `editor.openFiles` | editor.openFiles / activeIndex / splitOpen / splitFiles / splitActiveFile / splitDirection | collect | ✓ restoreLayoutState（projectRestored 守卫） | ✓ 保持（boot 恢复） | 后写赢（键级补丁+脏键 diff，未动键零写） | ✓（实例记录不依赖设备） | 跟随数据目录（uiState kind 实例键） | 项目切换静默清空（openfiles/core.ts:124，语义对齐页面刷新） | untitled 草稿/diff/预览签不入持久化清单；分屏组清单 SPLIT_FILES_MAX=20 截旧（useLayoutState 收口） |
| `fileTree.expandedDirs` | fileTree.expandedDirs / selectedFile（uiState 字段面） | retired | ✗（已退役：bootstrap 恢复段 S1 删除，字段无恢复端） | ✗（真源见 ls.fileTree.expanded 行） | ✗（恒空退役，不写不读） | ✗ | ✗（字段面；真源为设备本地） | 无（字段无写端；真源清除见 ls.fileTree.expanded 行） | 恒空僵尸→S1 退役（collect 面收窄+恢复桥删除，考古实证 extra 自 init commit 从未接线）；字段保留旧记录读取兼容，真源=ls.fileTree.expanded 行 |
| `fileTree.pinnedDirs` | fileTree.pinnedDirs（常用目录钉选，projectId→有序路径表） | writer | ✓ FileTreeView 挂载（getFileTreePinnedDirs） | ✓ 保持 | 后写赢（键级补丁；expandedDirs/selectedFile 由注册表从基底回填不丢） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 用户取消钉选；布局重置不清（P-74/P-97 定案：钉选是策展数据非布局） | — |
| `layout.main` | layout.sidePanelWidth / bottomPanelHeight / showSidePanel / showBottomPanel / sideView / bottomTab / commitLocation | collect | ✓ restoreLayoutOnly（pending 意图优先） | ✓ 保持 | 后写赢（键级补丁+脏键 diff，他页修改不被关页回滚） | ✓（按实例、跨浏览器——P-20261114-2-S1 车道归类核实） | 跟随数据目录（uiState kind 实例键） | useLayoutReset 一键重置（写回 LAYOUT_DEFAULTS，经 patchNamespaces 走 writer 面） | commitLocation 恒归一 sidebar（底部提交 tab 退役定案）；与面板内嵌侧栏宽（ls.panelSidebarWidth）形成按实例/按设备两档 |
| `layout.maximized` | layout.bottomPanelMaximized / bottomPanelEditorMaximized | collect | ✓ restoreLayoutOnly（最大化族落盘两档） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 面板隐藏 watch 清（usePanelLayout）/布局重置 | 与四个临时最大化档（mem.terminalMaximized 等）相对：仅此两档落盘，升格评审定案核实一致 |
| `terminal.activeTabId` | terminal.activeTabId（uiState 字段面） | retired | ✗（已退役：bootstrap 恢复段 S1 删除，字段无恢复端） | ✗（真源见 ls.term.activeTabMap 行） | ✗（恒空退役，不写不读） | ✗ | ✗（字段面；真源为设备本地） | 无（字段无写端；真源清除见 ls.term.activeTabMap 行） | 恒空僵尸→S1 退役（同 fileTree.expandedDirs 考古定案）；字段保留旧记录读取兼容，真源=ls.term.activeTabMap 行 |
| `gitPanel.collapsedSections` | gitPanel.collapsedSections（Git 面板分区折叠） | collect | ✗（现状不保持：漏收集——extra 自 init commit 从未接线恒空；恢复桥又被 BottomPanel v-else-if 挂载饿死） | ✗（同刷新） | 后写赢（键级补丁；现状恒空不产生实际写） | ✗（现状恒空） | ✗（现状恒空） | —（无写端） | S2 裁决：升格独立提案（修复需收集端接线+恢复时序三件套：pending 消费或挂载自恢复），本步不修——见 docs/ui-state-audit-20261114.md 七节 #1 |
| `gitPanel.selectedBranch` | gitPanel.selectedBranch（Git 面板选中分支） | collect | ✗（恒空有意——分支跟随 git 事实派生，恢复陈旧分支名与实际分支冲突有害） | ✗（同刷新） | 后写赢（恒空不产生实际写） | ✗（不持久化） | ✗（不持久化） | —（无写端；恢复桥 if (branch) 守卫空值跳过） | S1 定案维持不恢复（假设①在案） |
| `remoteConsole` | remoteConsole.tabs / groups / open / sidebarCollapsed | writer | ✓ restoreLayoutOnly（open+tabs>0 才恢复）+ RemoteConsoleView boot | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 视图关闭即写（watch 链） | showRemoteConsole 内存态即 remoteConsole.open（usePanelLayout）；open 唯一读端=项目页 bootstrap 恢复守卫（首页 boot 不恢复远程视图），槽天然 project 槽——首页 overlay 内嵌实例 persistState 不落 open 子键（P-20261114-4-S2 remote 槽随件评估，缺子键由注册表从基底回填） |
| `agentTerminal` | agentTerminal.groups / sidebarCollapsed / collapsedProjects / collapsedGroups / projectOrder / projectSessionOrder / lastViewedSessionId | writer | ✓ 管理页 boot getAgentTerminalState（形状防御在读取器） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 用户操作；会话消亡剪枝 | 浮窗几何/悬浮球/开态等设备本地面见 ls.agentTerminal.* 行——uiState 的 agentTerminal 是读改写链，旁路写会互相覆盖故走 localStorage（S1 车道定案） |
| `dshConsole.open` | dshConsole.open / homeOpen（dsh 控制台视图可见性，P-20261114-4-S2 分场景槽：open=project 槽、homeOpen=home 槽） | writer | ✓ restoreDshConsoleOnce（notes 先 dsh 后显式定序；按所在场景读槽——home 读 homeOpen、project 读 open） | ✓ 保持（互斥语义：开启按互斥族清他视图；路由往返走 per-scene 内存快照，P-20261114-4-S1） | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 互斥族/关闭钮（persistDshConsoleOpen watch 覆盖浮层直写与互斥隐式关闭全部路径，落当前场景槽） | dshMaximized 临时不持久化（见 mem.dshMaximized 行）；旧单槽值原位即 project 槽，向后兼容零迁移（旧前端读新档忽略未知子字段零影响） |
| `shareManager.open` | shareManager.open（文件分享管理视图可见性） | writer | ✓ restoreShareManagerOnce（notes→dsh→share 定序，异常双真存档后到者胜） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 互斥族/toggle | P-20261112-6-S3 族内缺口补齐（dshConsole 同族口径） |
| `notesView` | notesView.open / homeOpen / activeId / sidebarOpen / mode（P-20261114-4-S2 分场景槽：open=project 槽、homeOpen=home 槽；activeId/sidebarOpen/mode 面板内容/呈现态不分槽） | writer | ✓ restoreNotesViewOnce（按所在场景读槽）+ NotesPanel presentation/activeId（loadList 保底选篇两段式） | ✓ 保持（P-20261114-4-S2 场景归属：home 槽/project 槽各自恢复互不越界，路由往返走 per-scene 内存快照 P-20261114-4-S1） | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 互斥族/关闭钮/首页 Esc（persistNotesViewOpen watch 覆盖全部路径，落当前场景槽） | sidebarOpen 恢复仅桌宽生效（窄屏默认收起出厂口径，消费端守卫）；mode 无宽条件；旧单槽值原位即 project 槽，向后兼容零迁移（旧前端读新档忽略未知子字段零影响） |
| `dashboard.landing` | dashboard.landing（进入项目默认落仪表盘偏好） | writer | ✓ bootstrap（仅显式进入+偏好开，useLayoutBootstrap） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 设置切换 | 视图显隐 showDashboard 不落盘（纯查看面定案，见 mem.showDashboard 行） |
| `taskRunner.recent` | taskRunner.recent（任务面板运行历史，至多 5 条） | writer | ✓ 面板挂载 getTaskRunnerRecent（旧版 source::cwd::name 键静默丢弃） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 上限 5 条 FIFO | — |
| `snapshots` | snapshots（工作现场存档点，projectId→命名快照列表，整表 Record） | writer | ✓ useWorkspaceSnapshot 弹层/快捷键恢复链 | ✓ 保持 | 后写赢（键级补丁；整表 Record「缺子键=有意删除」） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 用户删除快照；恢复前自动档滚动槽 | 整表 Record 命名空间不在 NESTED_UISTATE_SUBFIELDS 回填面（写端恒发完整表） |
| `bookmarks` | bookmarks（编辑器书签锚，projectId→文件→记录表，整表 Record） | writer | ✓ useEditorBookmarks 挂载恢复 | ✓ 保持 | 后写赢（键级补丁；整表 Record） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 用户删锚；上限在写入方收口（每项目 ≤100 行防膨胀） | — |
| `diffComments` | diffComments（diff 审阅留言，projectId→文件→行级留言，整表 Record） | writer | ✓ useDiffComments 挂载恢复 | ✓ 保持 | 后写赢（键级补丁；整表 Record） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 用户删留言；每项目 ≤100 条写入方收口 | — |
| `editorPrefs.mdMode` | editorPrefs.mdMode（Markdown 三态显示模式偏好） | writer | ✓ 打开 .md 恢复 | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | —（无显式清除点） | 独立命名空间而非塞进 editor——collect 整体重建 editor 键会静默抹掉未收录字段（fileTree.pinnedDirs 同款教训在案） |
| `agentTaskTemplates.items` | agentTaskTemplates.items（智能体任务模板定制表） | writer | ✓ useAgentTaskTemplates 消费（null=出厂预置） | ✓ 保持 | 后写赢（低频管理面） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 管理面增删改 | 特例：GET+merge+PUT 整更新（saveAgentTaskTemplates 非 patchNamespaces——手动合并基底防 beforeunload 抹回），无 writerNs 字段，写函数由一致性单测 writerFn 钉住 |
| `layoutLock.locked` | layoutLock.locked（布局锁定防误拖开关） | writer | ✓ restoreFromState（restoreLayoutOnly 内，早退前） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | toggle | 独立命名空间——collect 整体重建 layout 键会抹掉未收录字段；layout 重置不波及。无专用读函数（恢复走 bootstrap 已拉取快照） |
| `railOrder.railTop` | railOrder.railTop（活动栏面板手动序） | writer | ✓ restoreRailTopOrder（restoreLayoutOnly 内） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 拖拽重排 | 顺序是用户策展的个性化偏好（agentTerminal.projectOrder 同哲学）；形状防御在 panels/registry。无专用读函数（恢复走 bootstrap） |
| `monitorBoard` | monitorBoard.cardOrder / hiddenCards（值班大屏卡片类目布局） | writer | ✓ monitor 页 boot getMonitorBoardLayout | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 用户操作 | 已知类目 id 收敛在 utils/monitorBoardLayout（读取器只做数组清洗） |
| `notificationCenter.lastSeenAt` | notificationCenter.lastSeenAt（通知中心未读分界线） | writer | ✓ 面板打开读 | ✓ 保持（跨刷新/跨标签延续） | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | —（面板关闭即写，无清除点） | — |
| `sync` | sync.direction / peers / projects / contexts（同步中心配置记忆） | writer | ✓ 面板打开 getSyncPrefs（一键重跑） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | —（执行成功即写，无清除点） | — |
| `conflictAgent.template` | conflictAgent.template（冲突 agent 派单模板记忆） | writer | ✓ 弹层发起读（空串=无记忆回 i18n 派生默认） | ✓ 保持 | 后写赢（键级补丁） | ✓（实例记录） | 跟随数据目录（uiState kind 实例键） | 恢复默认链写空串清记忆（空模板发起是临时态而非偏好措辞，不记忆） | — |

### ② localStorage / sessionStorage 键控面

| 登记号 | 状态项 | 车道 | 刷新 | 路由往返 | 多标签 | 换浏览器 | 换机器 | 清除语义 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| `ls.fileTree.expanded` | sc.fileTree.expanded.<projectId>（树展开按项目真源，动态前缀族） | localStorage | ✓ FileTreeView 挂载自恢复；快照采集/应用读写（useWorkspaceSnapshot/useLayoutShell） | ✓ 保持（各消费域挂载自恢复） | 同设备共享（后写赢） | ✗（设备本地） | ✗（不随数据目录，设备本地） | useLayoutReset 重置清（清键对账） | uiState 的 fileTree.expandedDirs 退役后为唯一真源（FileTreeView watch 回写） |
| `ls.fileTree.filters` | sc.fileTree.showHidden / hideIgnored（树过滤开关，模板形态 sc.fileTree.<toggle>） | localStorage | ✓ readFilterPref（FileTreeView 内读取） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | 裸读点在案豁免（渐进迁移不强制，健壮性红线在案） |
| `ls.term.activeTabMap` | sc.term.activeTabMap（终端激活 tab 按项目映射） | localStorage | ✓ TerminalView 项目切换 recall + useTerminalReconnect | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 已关闭会话残留无害（恢复方校验，在案注释） | — |
| `ls.terminalSessions` | sc.terminalSessions.sortMode / groupMode / pinnedIds / runtimeFilter（终端会话显示偏好 4 键） | localStorage | ✓ store setup 一次读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | pinnedIds 消亡剪枝（防集合无界） | — |
| `ls.terminal.closeNoConfirm` | sc.terminal.closeNoConfirm（关 tab 免确认，项目终端+远程控制台共用） | localStorage | ✓ useTerminalTabs / useRemoteConsoleTabs 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 恢复确认时 removeItem | — |
| `ls.terminal.clipboardPrefs` | sc.terminal.copyOnSelect / stripTrailingNewline / pasteNoMultilineWarn（终端剪贴板偏好 3 键） | localStorage | ✓ 同文件模块级初始化读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | copyOnSelect 开=清键（回归默认语义） | — |
| `ls.terminal.mouseModeHint` | sc.terminal.mouseModeHintDismissed（鼠标模式一次性提示） | localStorage | ✓ 模块读（terminalMouseModeHint） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 「重置提示」可清 | — |
| `ls.tmuxScrollTip` | sc.tmuxScrollTipShown（tmux 翻页一次性提示） | localStorage | ✓ TerminalView 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（一次性提示无清除点） | — |
| `ls.terminalFloat.geometry` | sc.terminalFloat.geometry（终端悬浮窗几何） | localStorage | ✓ useTerminalFloat 同文件读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | — |
| `ls.agentTerminal.openState` | sc.agentTerminal.openState / expandedMode（agent 终端开态/形态） | localStorage | ✓ 模块加载 loadPendingOpenState→consumePendingOpenState 首宿主消费 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 测试复位清 | uiState 的 agentTerminal 命名空间是读改写链，旁路写会互相覆盖故走 localStorage（S1 车道定案） |
| `ls.agentTerminal.floatGeometry` | sc.agentTerminal.pos / size（agent 悬浮窗几何） | localStorage | ✓ useAgentTerminalFloat 同文件读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | — |
| `ls.agentTerminal.ball` | sc.agentTerminal.ballPos / ballStyle（悬浮球位置/样式） | localStorage | ✓ AgentTerminalMini 组件读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | — |
| `ls.agentTerminal.lastRuntime` | sc.agentTerminal.lastRuntime（上次选择的 agent runtime） | localStorage | ✓ 对话框回填 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | 设备本地偏好（uiState 读改写链旁路写会互相覆盖，注释在案） |
| `ls.agentTerminal.sidebarWidth` | sc.agentTerminal.sidebarWidth（agent 管理页侧栏宽） | localStorage | ✓ 宿主挂载 load（useSidebarWidth 泛化实现） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 双击复位 | 面板内嵌侧栏宽=localStorage 客户端偏好车道（与主侧栏 layout.sidePanelWidth 按实例形成两档） |
| `ls.panelSidebarWidth` | sc.remoteConsole.sidebarWidth / sc.notes.sidebarWidth（远程/笔记面板内嵌侧栏宽） | localStorage | ✓ 宿主挂载 load（useSidebarWidth 泛化实现） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 双击复位 | 键约定 sc.<panel>.sidebarWidth（P-20261111-7 / P-20261112-9 接入在案） |
| `ls.editor.splitWidth` | sc.editor.splitWidth（分屏主组占比，两方向共用比例） | localStorage | ✓ readSplitWidth | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 双击复位对半 | — |
| `ls.settings.lastTab` | sc.settings.lastTab（设置上次分区） | localStorage | ✓ recallLastTab（分区表校验回落 general） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | — |
| `ls.previewPorts` | sc.previewPorts（预览最近端口） | localStorage | ✓ PreviewPanel 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 上限截断 | — |
| `ls.palette` | sc.palette.commandUsage / recentCommands（legacy） / fileUsage（命令面板使用计数 3 键） | localStorage | ✓ paletteUsage 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | legacy 键收编后 removeItem（迁移清理） | — |
| `ls.snippet.paramValues` | sc.snippet.paramValues（片段参数历史） | localStorage | ✓ snippetParamHistory 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 上限环形 | — |
| `ls.keymapOverrides` | sc.keymapOverrides（快捷键覆盖） | localStorage | ✓ 启动读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 恢复默认清 | 导出键供 settingsTransfer |
| `ls.newSession.draft` | sc.newSession.draft（新会话表单草稿） | localStorage | ✓ 读（恢复提示条） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 成功提交/丢弃清（useNewSessionPromptState） | — |
| `ls.agentQueue.draft` | sc.agentQueue.draft.<sessionId>（排队指令草稿，动态前缀族，sessionStorage） | localStorage | ✓ sessionStorage 刷新存活；挂载/切行回填 | ✓ 保持（标签页存活期内） | ✗（sessionStorage 标签页隔离） | ✗（会话级存储） | ✗（会话级存储） | 关标签页即清/提交清（useDraftGuard——会话级生命周期与防丢语义对齐） | sessionStorage 通道（非 localStorage），sc.* 命名约定同族；车道注释在案 |
| `ls.draftSavedBeacon` | sc.draft-saved（草稿落库信标，跨标签页 storage 事件） | localStorage | ✗（纯信标非状态真源——settingsSync 按键分发表忽略本键） | ✗（同刷新） | 跨标签 storage 事件分发（信标语义，savedAt 保新值触发） | ✗（设备本地） | ✗（设备本地） | 覆盖式（draftDb 每次写覆盖） | 单键 JSON 载荷防 path 冒号编码歧义（注释在案） |
| `ls.unlockToken` | sc.unlockToken（解锁令牌） | localStorage | ✓ 启动读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 登出/上锁 removeItem（lock.ts） | — |
| `ls.lockShortcut` | sc.lockShortcut（锁屏快捷键） | localStorage | ✓ 启动读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 恢复默认清 | — |
| `ls.httpWarningDismissed` | sc.httpWarningDismissed（http 警示一次性关闭） | localStorage | ✓ useHttpWarning 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（一次性关闭无清除点） | — |
| `ls.localeSuggestDismissed` | sc.localeSuggestDismissed（语言建议一次性关闭） | localStorage | ✓ useLocaleSuggest 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（一次性关闭无清除点） | — |
| `ls.approvalGuideDismissed` | sc.approvalGuideDismissed（审批指南一次性关闭） | localStorage | ✓ useApprovalGuide 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（一次性关闭无清除点） | — |
| `ls.approvalRuleSuggestShown` | sc.approvalRuleSuggestShown（审批建议节流，单键 JSON map） | localStorage | ✓ 读回判定（approvalPattern） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（无清除点） | 单键而非 per-pattern：safeStorage 无键枚举面（注释在案） |
| `ls.gitignoreSuggest.dismissed` | sc.gitignoreSuggest.dismissed.<projectId>（gitignore 建议按项目一次性关闭，动态前缀族） | localStorage | ✓ GitPanel 读 | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（一次性关闭无清除点） | — |
| `ls.rfm` | sc.rfm.cwd.<hostId> / sc.rfm.mem.<hostId>（远程文件浏览器目录/路径记忆，动态前缀族 2 键） | localStorage | ✓ useRemoteFileBrowser 读（cwd 裸读在案豁免） | ✓ 保持 | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | —（设备本地偏好口径，注释在案） | — |
| `ls.morningBrief` | sc.morningBrief.<yyyy-MM-dd>（晨报当日已阅，动态前缀族） | localStorage | ✓ 同日读 | ✓ 保持（当日） | 同设备共享（后写赢） | ✗（设备本地） | ✗（设备本地） | 按日轮换自然失效（零清理负担，注释在案） | — |
| `ls.clipRelay.device` | sc.clip-relay.device（剪贴板中继设备 id） | localStorage | ✓ clipRelay 读 | ✓ 保持 | 同设备共享 | ✗（设备本地） | ✗（设备本地） | —（设备标识，非 UI 偏好） | — |
| `ls.debug.terminalClipboard` | sc.debug.terminalClipboard（终端剪贴板调试开关） | localStorage | ✓ 模块加载读 | ✓ 保持 | 同设备共享 | ✗（设备本地） | ✗（设备本地） | 手动清（调试后门，注释在案） | — |

### ③ 临时态（定案不持久化）

| 登记号 | 状态项 | 车道 | 刷新 | 路由往返 | 多标签 | 换浏览器 | 换机器 | 清除语义 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| `mem.terminalMaximized` | terminalMaximized（终端临时最大化） | temporary | ✗（定案不持久化，LAYOUT_DEFAULTS 有出厂键但临时档刷新回常态） | ✗（面板隐藏/互斥/重置/Esc 退栈） | 各页独立（不落盘） | ✗ | ✗ | 面板隐藏/互斥/重置/Esc | 升格评审定案维持临时档（usePanelLayout 注释在案） |
| `mem.editorGroupMaximized` | editorGroupMaximized（编辑器组临时全宽，P-20261004-64） | temporary | ✗（uiState 无键，刷新从常态开始） | ✗（兄弟组 v-show 保活，路由往返按互斥语义退出） | 各页独立（不落盘） | ✗ | ✗ | 再双击/Esc/关分屏清组最大化（EditorArea watch） | 临时聚焦态定案维持（usePanelLayout 注释在案） |
| `mem.terminalPaneMaximized` | terminalPaneMaximized（终端 pane 临时全幅，P-20261004-64） | temporary | ✗（uiState 无键，刷新从常态开始） | ✗（同编辑器组临时态） | 各页独立（不落盘） | ✗ | ✗ | 再双击/Esc/恢复后 fit 自愈链重触发 | 仅 split 双 pane 可进入；xterm 实例与 WS 会话不断 |
| `mem.dshMaximized` | dshMaximized（dsh 控制台临时最大化） | temporary | ✗（uiState 无键，刷新从常态开始） | ✗（关闭控制台即还原） | 各页独立（不落盘） | ✗ | ✗ | 关闭控制台即还原（usePanelLayout） | 与编辑器组/终端 pane 最大化同口径（P-20261004-64） |
| `mem.showDashboard` | showDashboard（项目仪表盘视图显隐） | temporary | ✗（显隐不落盘——纯查看面定案 P-20261005-224，刷新回上次工作形态） | ✗（互斥族） | 各页独立（不落盘） | ✗ | ✗ | 互斥族/显式退出 | 落盘偏好只有 dashboard.landing（见 dashboard.landing 行） |
| `mem.pendingIntents` | pendingSideFilesOpen / pendingBottomTab / pendingSideView（跨页一次性跳转意图） | temporary | ✗（不持久化） | ✓（跨路由存活——bootstrap 布局恢复时消费一次并保证侧栏可见） | 各页独立（模块级单例） | ✗ | ✗ | 消费即清（consume 语义） | — |
| `mem.agentProjectDockedMem` | agentTerminal.projectDockedMem（项目级 docked 记忆，会话内） | temporary | ✗（不持久化） | ✗（项目切换即清） | 各页独立（会话性记忆） | ✗ | ✗ | 项目切换 | 会话性记忆定案维持 |

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
- [ ] 涉前端 UI 状态保持项：已在 `web/src/persistence/uiStateLanes.json` 登记一行并
      同步「UI 状态保持矩阵」对应行（过三轨选轨判据；`check:uistate-lanes` 门禁 +
      uiStateLanes.test.ts 一致性单测双守）

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
