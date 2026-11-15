# Features 页模块×素材源矩阵（P-20261115-2-S1 实勘产物）

> 本文档是官网文档分页族 **Features 全模块指南页**（`site/guide/features.html`，
> P-20261115-2-S1 建页）的实勘矩阵，也是后续步的硬输入：
> **S2**（README「Details →」落点换真页 + 导航联动，含 On-call / Multi-instance /
> Git workbench 三模块新增 Details 行）与 **S3**（发布链 + 门禁收口）都以此表的
> 口径与源锚为准。矩阵由 P-20261115-2-S1 运行实勘产出，前提核验基于主线
> `a63a7ede`（P-20261115-1 四步全合收口）。

## 1. 素材源白名单与黑名单（评审修正③d 定案）

**可用素材源**（features 页逐块标注「源=」）：

| 素材源 | 用途 | 纪律 |
| --- | --- | --- |
| README「What's inside」表 +「Highlights」节 | 各模块定位文案的事实源 | 摘要级重组，不整段复制；改先改 README（landing 同款双维护纪律） |
| `site/guide/getting-started.html` / `faq.html` | 已成文的长文落点 | features 页只链接不重复（防双源漂移） |
| docs/deploy-linux.md / docs/remote-access.md | 远程管理/部署流水线的运维向补充 | 只做指针链接，运维长文事实源仍在 docs/ |
| 产品行为实勘（本次） | 各模块入口路径与产品名 | 锚 `web/src/panels/registry.ts` / `web/src/views/home/HomeView.vue` / `web/src/locales/zh-CN.ts`，见 §3 逐行标注 |

**禁用素材源**：

- **产品内 ops 手册（`GET /api/ops-manual`）不能作素材源**——它是 agent API 向
  文档（CLAUDE.md 官网节明文「文档模块不含 ops 手册复制，防双源漂移」）。

## 2. 12 模块口径推导（17 → 12，可溯源）

口径输入双源，恰好同数：

- README「What's inside」表 **17 行**（Git workbench / Web terminal / Remote
  machines / AI agent sessions / Agent ops channel / Approval center / Notes /
  TODO list / Change stream / Environment profile / On-call dashboard /
  Multi-instance sync / Sharing links / dsh integration / Security foundation /
  Self-update / i18n & themes）；
- 前端面板注册表 **17 个唯一面板 id**（`web/src/panels/registry.ts` 19 次
  registerPanel，git / terminal 各在 rail-top 与 bottom-tab 两组注册）。

归并规则（17 行 → 12 模块）：

| README 行 | 处置 | 缘由 |
| --- | --- | --- |
| Git workbench | 模块 1 | registry git + changes 两面板归并（提交面板与 Git 面板同一工作流两面） |
| Web terminal | 模块 2 | registry terminal；端口预览/问题/控制台三个底部 tab 属工作区配套不单列 |
| Remote machines | 模块 3（远程管理） | registry remote-console；产品名「远程管理」（zh-CN.ts:2986） |
| AI agent sessions | 模块 4（终端会话管理） | registry agent-terminal；产品名「终端会话管理」（zh-CN.ts:1314）；**Agent ops channel 并入本节叙事**——ops 通道是会话的底层驱动面（getting-started `#agent-setup` 合写先例），审批卡回流入口指向模块 5 |
| Approval center | 模块 5（审批中心） | **非 registry 面板 id，按功能名口径处理**（评审定案）：审批卡经 ops 通道回流、聚合在审批中心管理面 |
| Notes | 模块 6（笔记库） | registry notes |
| TODO list | 模块 7 | registry todos |
| Change stream | **并入模块 9** | README 变更流行自述「the in-workbench entry … beyond the on-call dashboard card」——与大屏同数据面的 IDE 内入口，用户可感知为一件事的两面 |
| Environment profile | 模块 8（环境画像） | registry env |
| On-call dashboard | 模块 9（值班大屏） | monitor 视图（`web/src/views/monitor/`）+ 项目仪表盘（registry dashboard，项目级常态首页）+ 变更流（并入）同属「一屏总览」叙事群 |
| Multi-instance sync | 模块 10（多实例同步） | registry sync |
| Sharing links | 模块 11（分享中心） | registry share-manager；文件/文件夹/片段/**实时终端**分享（终端只读直播分享 zh-CN.ts:2646）统一落本模块 |
| dsh integration | 模块 12（dsh 集成） | registry dsh-console；含「dsh 版本管理」子面（dshConsole.versionsTitle，zh-CN.ts:2056） |
| Security foundation | **归 faq 联动节** | faq `#security`（锁与远程访问）已成文，features 页仅链接 |
| Self-update | **归 faq 联动节** | faq `#upgrading`（升级路径判别表）已成文，features 页仅链接 |
| i18n & themes | **不算独立模块** | 语言与主题是产品全局设置面，不是用户可感知的功能模块 |

**工作区配套面板（不占模块位）**：files（项目文件）/ preview（端口预览）/
problems（问题）/ console（控制台）四个 registry id 归入模块 1/2 的工作区叙事
（getting-started `#add-project` 的项目工作区截图已覆盖文件树+编辑器+终端同屏）。

用户点名功能覆盖核对（任务书动机）：远程管理→模块 3、终端会话管理→模块 4、
dsh 版本管理→模块 12、文件分享/终端分享→模块 11。全数在列。

## 3. 模块×素材源矩阵（S1 建页事实源；S2 补 Details 行按本表逐行取材）

| # | 模块（页内节 id） | registry 面板 id | README 源锚 | 截图（docs/img） | 步骤素材密度 | S1 落页形态 | 产品行为实勘（入口路径） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Git 工作台 `#git-workbench` | git、changes | What's inside「Git workbench」行 + Highlights「…and a complete Git workbench」节 | project-editor.png、commit-diff.png、file-tree-menu.png | **有图**；README 能力清单实（hunk 级暂存/三方 diff/交互 rebase/worktree 等） | 定位+能力清单+图 | 活动栏 Git 分支图标 = Git 面板（registry.ts:283），底部 tab 同源；提交入口=活动栏 changes（registry.ts:210） |
| 2 | Web 终端 `#web-terminal` | terminal | What's inside「Web terminal」行 + landing toolbox-more 摘要 | 无（工作区同屏已在模块 1 图） | 步骤素材零 | 定位+入口短条目 | 活动栏终端图标/底部 tab（registry.ts:302）；tmux 持久化与恢复叙事=faq/getting-started `#restart-restore` 链接 |
| 3 | 远程管理 `#remote` | remote-console | What's inside「Remote machines」行 + landing toolbox-more 摘要 | **无现成图**（任务书点名缺口） | **降格**：SSH 主机管理/部署流水线只有 docs 运维文 | 定位+入口短条目+docs 指针 | 活动栏地球图标（registry.ts:435）；一键部署流水线（bootstrap→runtime→systemd）事实源=docs/deploy-linux.md §2§3；隧道形态=docs/remote-access.md |
| 4 | 终端会话管理 `#agent-sessions` | agent-terminal | What's inside「AI agent sessions」行 + Highlights「AI agent sessions」节 +「Agent ops channel」节（并入） | agent-session.png | **有图**；getting-started `#agent-setup` 长文已成 | 定位+能力清单+图+getting-started 链接 | 活动栏对话气泡图标（registry.ts:387）；免项目开会话（getting-started `#agent-setup`）；ops 通道=结构化 API（ask/approval 卡回流）；`CC_LOCK_TOKEN`/`CC_BASE_URL` 注入 |
| 5 | 审批中心 `#approvals` | （非 registry 面板 id，功能名口径） | What's inside「Approval center」行 + Highlights「Approval center」节 | approval-card.png | **有图**；README 叙事完整（逐条允许/拒绝/改写+终端录像+脱敏） | 定位+叙事+图 | 高危命令/批量替换以审批卡回流（README 实文）；入口随模块 4 会话流 |
| 6 | 笔记库 `#notes` | notes | What's inside「Notes」行 + Highlights（无独立节，Quickstart 第 5 步提及） | **无现成图**（任务书点名缺口） | **降格**：单面板功能，素材=定位+人机共享语义 | 定位+入口短条目+getting-started `#share-notes` 链接 | 活动栏文档图标（registry.ts:327）；项目无关独立笔记库；agent 经 ops 通道读写（getting-started `#share-notes` 已成文） |
| 7 | TODO 清单 `#todos` | todos | What's inside「TODO list」行 | **无现成图**（任务书点名「任务面板」缺口） | 步骤素材零 | 定位+入口短条目 | 活动栏剪贴板图标（registry.ts:225）；聚合代码注释 TODO/FIXME/XXX/HACK（registry.ts:221-224 注记） |
| 8 | 环境画像 `#env-profile` | env | What's inside「Environment profile」行 | **无现成图** | 步骤素材零（只读画像，无操作步骤） | 定位+入口短条目 | 活动栏服务器图标（registry.ts:256）；三块面：Dev 端口/输出哨兵/部署目标（zh-CN.ts:1978-1981） |
| 9 | 值班大屏 `#oncall` | （monitor 视图）+ dashboard + stream | What's inside「On-call dashboard」行 +「Change stream」行（并入）+ Highlights「On-call dashboard」节 | oncall-dashboard.png | **有图**；README 叙事完整 | 定位+能力清单+图+变更流入口 | 首页工具条「值班大屏」入口（HomeView.vue:315-316）；实例健康/52 周热力图/变更流/agent 协作流/停滞会话分诊（README 实文）；IDE 内变更流=活动栏脉冲图标（registry.ts:240） |
| 10 | 多实例同步 `#sync` | sync | What's inside「Multi-instance sync」行 + Highlights「Multi-instance sync」节 | instance-sync.png | **有图**；`.scpkg` 迁移/接管/同步 README 叙事完整 | 定位+能力清单+图 | 活动栏云环图标（registry.ts:271）；加密 `.scpkg` 机器迁移（README 实文）；实例健康总览+终端/面板接管 |
| 11 | 分享中心 `#sharing` | share-manager | What's inside「Sharing links」行 + Highlights「Sharing links」节 + getting-started `#share-notes`（长文事实源） | share-dialog.png、share-manager.png | **有图**；getting-started 已成文（TTL/口令/阅后即焚/冻结快照/吊销） | 定位+图+getting-started 链接 | 右键文件 → Share（getting-started `#share-notes` 实文）；活动栏链接图标=分享管理（registry.ts:421）；实时终端分享=终端只读直播（zh-CN.ts:2646，遮蔽化只读输出流） |
| 12 | dsh 集成 `#dsh` | dsh-console | What's inside「dsh integration」行 + landing toolbox-more 摘要 | **无现成图**（任务书点名缺口） | **降格**：嵌入与版本管理步骤素材实质为零 | 定位+入口短条目 | 活动栏 dsh 图标（registry.ts:403）；dsh Web UI 经回环代理嵌入；**dsh 版本管理**子面=升级/回退+版本变更日志（zh-CN.ts:2056-2059） |

**联动节（不占模块位，页尾「还有这些」短节集中链接）**：
Security foundation → faq `#security`；Self-update → faq `#upgrading`；
i18n/主题 → landing toolbox-more 行已有摘要，features 页不重复。

## 4. 截图库存与缺口（S2/S3 待办输入）

docs/img 现有 9 张：agent-session / approval-card / commit-diff / file-tree-menu /
instance-sync / oncall-dashboard / project-editor / share-dialog / share-manager。

- 已覆盖模块 1/4/5/9/10/11 的图；
- **无图模块**（任务书点名）：dsh 版本管理（模块 12）/远程管理（模块 3）/
  笔记库（模块 6）/TODO 面板（模块 7）——S1 按评审定案**不硬凑新图**，
  以「定位+入口路径」短条目落页；后续补图走 `web/scripts/site-screenshots.mjs`
  重摄矩阵（截图唯一事实源=docs/img，只引用不复制）。

## 5. S1 已落地 & S2/S3 交接清单

**S1 已落地**（本矩阵 + `site/guide/features.html` 骨架）：

- 12 模块节 + 序节 + 联动短节，双语双份内联，独立 title/meta/og；
- 侧栏三页同改（features 新页 + getting-started + faq 补 Features 项，同 PR 纪律）；
- 样式门禁联动：`page_letter()` 登记 E=features，registry pages 字段扩
  GEF（guide scope 类）与对应私有类升级，`scripts/check-site-styles.sh` 绿。

**S2 待办**（README Details 落点换真页+导航联动）——**已由 P-20261115-2-S2 落地**，
落地口径（S3 只需认本段，勿重做）：

1. README Highlights「Details →」行换/补真页锚：On-call dashboard（模块 9）、
   Multi-instance sync（模块 10）、Git workbench（模块 1）三模块**新增** Details 行；
   已有 Details 行的模块（Agent ops channel / AI agent sessions / Approval center /
   Sharing links / Self-update）落点从 getting-started/faq 锚改为 features 页
   对应节锚（双留口径：Pages 绝对 URL + 仓内 site/guide/ 相对路径，zh 直落
   `?lang=zh-CN`）——**逐行以本表「README 源锚」列为取材清单**；
   ✅ 落地映射：Agent ops channel / AI agent sessions → `#agent-sessions`（ops 通道
   并入模块 4 叙事）、Approval center → `#approvals`、Sharing links → `#sharing`、
   Self-update → `#more` 联动节（faq `#upgrading` 升级判别表经 features 页一跳可达）；
   Highlights 引言行与 README 末 Docs 节同 PR 补 Features 页同列（双语两侧同改）。
2. 导航联动：landing 顶导航/页尾 Docs 入口是否加 Features 直链（相对路径
   `guide/features.html`），以及 features 页顶栏「Docs」链接是否换指本页——
   以 landing/顶栏静态复制纪律做全页同 PR 改动；
   ✅ 落地口径：**landing 顶导航不新增链接**（S3 实测的 761px 收起阶梯无新增宽度预算，
   新增 en 文案会在 761px+ 复现「GitHub 键顶出视口」级溢出）——改为顶导航 Features 锚
   改指 `guide/features.html`（原页内 `#features` 高亮栅格锚；栅格紧随快速上手滚动可达、
   节题本为 Highlights，锚名/目的地对齐；en 文案等宽、zh 功能全览 +29px 仍在 ≤760
   隐藏带内）；landing 页尾补「Features guide/功能全览」直链；getting-started/faq
   页尾同款形态补 Features 项（guide 三页页尾全族互链）；features 页顶栏「Docs」
   链接维持指 getting-started（族入口，自链无意义）；guide 顶栏零改动（侧栏已含
   Features 项）。
3. 改 README Highlights 摘要时同步 features 页「源=」注记（双维护纪律反向亦成立）。
   ✅ 本步未改任何摘要文案（仅增/换 Details 行与导航链接），features 页「源=」注记
   无需同步；另 getting-started `#agent-setup`/`#restart-restore`/`#share-notes`
   三节尾新增反向互指 features 对应模块节（features 侧「深入指南」链接既存，双向互达）。

**S3 待办**（发布链+门禁收口）——**已由 P-20261115-2-S3 落地**，P-20261115-2 全链就此收口：

1. `scripts/release-export.sh` 骨架自检 must-list 补 features 两行登记
   （site 侧 + docs 侧，同 getting-started/faq 两行形态，漏登记不报警）；
   ✅ 落地口径：must-list site/docs 两侧各插入 `guide/features.html`（与
   getting-started/faq 同行并列），excluded() 复验零 site/guide 条目=自动导出；
2. `docs/pages-publishing.md` 页族清单/预览路径补 features 页；
   ✅ 落地口径：S1 已补预览路径/文件约定表/走查清单四处，本步核对补漏——
   `site/assets/site.css` 行与 site.css 头注两处「三页走查」残留改「全站页走查」
   （四页现状），「站点内文件约定」节尾补 features 两行登记完成态；
3. 发布链全链自检：导出树逐引用解析（`../../docs/img/` 改写后 `../img/`）+
   `release-scan.sh` 零放行 + 双语 `data-lang` 配对/锚点解析真脚本（S3 任务书口径）。
   ✅ 落地口径：新增 `scripts/check-site-content.sh`（姊妹于 check-site-styles.sh，
   bash/POSIX 同纪律）两道对账——双语 `data-lang-en/zh` 裸属性标记剥注释后
   en,zh 严格交替+计数相等（实形非 `data-lang="en"` 值形态）+锚点解析（页内/
   跨页 #锚 × id 集对账、站内 .html 目标存在性、重复 id；外部/非 HTML 资产豁免）；
   现库 4 页零误报（en=326/zh=326、id 31、锚引用 82），七类红样例验红删除；
   发布链自检位挂 pages-publishing.md「修改后要过的检查」第 5 条；导出实测：
   must-list 双 FATAL 红样例（临时把 features.html 加进 excluded()）证明守卫
   有牙，预览导出树 site/docs 两侧 features.html 在场、15 处 img 引用零断链
   零残留未改写形态、guide 页级链接导出树态全通，`release-scan.sh` 0 HARD
   命中零放行（3460 文件 manifest，INFO 级目录名提及为脚本文档化的不拦面）。
