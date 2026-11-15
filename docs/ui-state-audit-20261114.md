# UI 状态保持语义全景审计（P-20261114-2-S1）

- 审计基线：worktree 分支 `enhance/P-20261114-2-S1`，基点 commit `62300e8d`
- 审计范围：前端全部 UI「保持语义」状态——三写入轨 × 多恢复轨 × 清除点，逐项过三问（**持久化了吗 / 谁恢复 / 谁清除**）
- 本文档是 S2（登记纪律机制化：矩阵文档 + 注册表 + 门禁）的字段值输入；S3（防回归 e2e 网）钉本文「修复面」后的行为
- 审计方法（可复现命令）：
  - `grep -rE "sc\.[a-zA-Z]" web/src` 字面量键面 → 脚本化精确提取（引号字符串字面量）实锚 **51 个唯一键**
  - `grep -rn "collect 不认识\|collectCurrentUIState 不认识"` → 实勘 **12 处**（uiState.ts 11 处 + layoutLock.ts 1 处）——双轨演化的注释证据
  - `git log -S fileTreeExpanded` / `git show 832a7b31:web/src/views/Layout.vue` → 考古 collect extra 接线史
  - 逐文件读实现核对实际行为（不止归类）

---

## 一、三写入轨结构（升格定案的结构性根因，实勘证据面）

| 轨 | 机制 | 写入时机 | 恢复时机 |
|---|---|---|---|
| ① collect 收集轨 | `useLayoutState.collectCurrentUIState`（useLayoutState.ts:44）→ `saveCurrentState` 键级 diff（脏键才发）→ 500ms 防抖（uiState.ts:524）；beforeunload 走 `forceSaveCurrentState` keepalive | auto-save watch 源变化（面板六元/editor 签名/项目切换）+ 关页 | `useLayoutBootstrap.restoreLayoutOnly`（layout 命名空间，无项目依赖早恢复）+ `restoreLayoutState`（项目维度，`projectRestored` 守卫） |
| ② 键级读写器轨 | uiState store `saveXxx` 族即时写（`patchNamespaces` 浅合并 + 乐观推进基底 + 失败入 unsentKeys 兜底） | 低频用户动作即时 | 各命名空间自有恢复口（per-load once / 宿主 boot / everOpened immediate） |
| ③ localStorage 轨 | `utils/storage.ts safeStorage` 通道（隐私模式内存兜底）；存量裸读点在案豁免渐进迁移（CLAUDE.md 健壮性红线） | 即时 | 各消费域挂载自恢复 |

多恢复轨（实勘）：`restoreLayoutOnly`（仅 layout 命名空间）/ 各 `restoreXxxOnce` per-load memoized promise（notes→dsh→share 显式定序，usePanelLayout.ts:269/312/354）/ 宿主 `everOpened` immediate（HomeView dshEverOpened、NotesView、RemoteConsoleOverlay——懒挂载保活的自举）。

「collect 不认识本键」注释 12 处分布：uiState.ts :129/:144/:151/:156/:162/:168/:181/:189/:201/:207/:216 + layoutLock.ts:13——均为「独立命名空间 + 浅合并天然保留」的双轨演化记录，本次逐处核实仍属实。

## 二、uiState 命名空间逐项三问（20 命名空间 + 子字段级定案）

NESTED_UISTATE_SUBFIELDS 实勘 20 命名空间（uiState.ts:247-268）与升格评审值一致。整表 Record 排除清单：snapshots/bookmarks/diffComments（写端恒发完整表，「缺子键=有意删除」）。

| 命名空间 | 写入轨 | 恢复时机 | 清除点 | 裁决 |
|---|---|---|---|---|
| editor.openFiles/activeIndex/splitOpen/splitFiles/splitActiveFile/splitDirection | ① collect+auto-save+关页 | restoreLayoutState（projectRestored 守卫）| 项目切换静默清空（openfiles/core.ts:124，在案定案「语义对齐页面刷新」）| **正常**（定案语义维持） |
| editor.scrollPositions | 无写端（collect 恒 `{}`，useLayoutState.ts:75）| 无恢复端 | — | **僵尸字段**：Monaco 滚动位置记忆从未实现。已注释定案（uiState.ts）；实现属新收集/恢复链 → **升格清单 #2**。**S2 裁决（P-20261114-2-S2）：显式退役已执行**——UIStateData 字段/NESTED_UISTATE_SUBFIELDS 登记行/collect 写面/测试夹具四处同步清退，旧记录残留键为沉淀数据向后兼容零迁移（uiState.ts editor 字段墓碑注在案） |
| fileTree.expandedDirs / selectedFile | ①（已退役，见修复面 #2）| 无（bootstrap 恢复段已删，见修复面 #1）| — | **恒空僵尸→本次退役**：真源 = `sc.fileTree.expanded.<projectId>`（FileTreeView.vue:549-560 watch 回写/挂载自恢复/useLayoutReset.ts:52 清键对账）。已注释定案（uiState.ts） |
| fileTree.pinnedDirs | ② saveFileTreePinnedDirs（uiState.ts:925，回带基底 expandedDirs/selectedFile）| FileTreeView 挂载（:119 getFileTreePinnedDirs）| 用户取消钉选；**布局重置不清**（P-74 定案，uiState.ts:894）| **正常**（定案语义维持） |
| layout 六元 + commitLocation | ① collect+auto-save | restoreLayoutOnly（useLayoutBootstrap.ts:182-203，pending 意图优先）| useLayoutReset 一键重置（写回 LAYOUT_DEFAULTS）| **正常**。commitLocation 恒归一 'sidebar'（底部提交 tab 退役定案，usePanelLayout.ts:421） |
| layout.bottomPanelMaximized / bottomPanelEditorMaximized | ① | restoreLayoutOnly:205-206 | 面板隐藏 watch 清（usePanelLayout.ts:543）/ 重置 | **正常**（最大化族落盘两档，升格评审定案核实一致） |
| terminal.activeTabId | ①（已退役，见修复面 #2）| 无（恢复段已删，见修复面 #1）| — | **恒空僵尸→本次退役**：真源 = `sc.term.activeTabMap`（terminalActiveTab.ts，TerminalView.vue:725/739 项目切换 recall/remember + useTerminalReconnect.ts:57）。已注释定案 |
| gitPanel.collapsedSections | ① extra 断线（恒 `[]`）| restoreGitPanel 桥在位（useLayoutBootstrap.ts:262 保留）| — | **漏收集**：extra 自 init commit（832a7b31）从未接线；恢复桥还被 GitPanel 挂载方式饿死（BottomPanel.vue:168 `v-else-if="bottomTab==='git'"`，boot 时 ref 多半未挂载）。修复需收集端接线 + 恢复时序裁决（pending 消费或挂载自恢复），属恢复口三件套 → **升格清单 #1**。**S2 裁决（P-20261114-2-S2）：升格独立提案**（登记行 `gitPanel.collapsedSections` 矩阵如实记「现状不保持」，本步不修） |
| gitPanel.selectedBranch | 同上（恒 `''`）| 恢复桥 `if (branch)` 守卫空值跳过 | — | **恒空有意**：分支跟随 git 事实派生，不持久化选择（恢复陈旧分支名与实际分支冲突）。已注释定案 |
| remoteConsole.tabs/groups/open/sidebarCollapsed | ② saveRemoteConsoleState（uiState.ts:605）| restoreLayoutOnly:90（open+tabs>0 才恢复）+ RemoteConsoleView boot | 视图关闭即写（watch 链）| **正常** |
| agentTerminal.groups/sidebarCollapsed/collapsedProjects/collapsedGroups/projectOrder/projectSessionOrder/lastViewedSessionId | ② saveAgentTerminalState | 管理页 boot getAgentTerminalState（形状防御在读取器）| 用户操作；会话消亡剪枝 | **正常** |
| dshConsole.open | ② persistDshConsoleOpen watch（usePanelLayout.ts:259——统一持久化覆盖「浮层头部直写/互斥隐式关闭」全部路径）| restoreDshConsoleOnce（**notes 先 dsh 后**显式定序；开启按互斥语义清他视图）| 互斥族/关闭钮/首页路过 | **正常**（dshMaximized 临时不持久化，定案注释 usePanelLayout.ts:84-87）。**S2 裁决（P-20261114-4-S2）**：分场景槽 open=project 槽 / homeOpen=home 槽（向后兼容零迁移），恢复按所在场景读槽、写入落当前场景槽 |
| shareManager.open | ② persistShareManagerOpen watch（:342）| restoreShareManagerOnce（**notes→dsh→share** 定序，异常双真存档后到者胜）| 互斥族/toggle | **正常**（P-20261112-6-S3 族内缺口已补） |
| notesView.open/activeId/sidebarOpen/mode | ② saveNotesView* 四写端（uiState.ts:703-751）| restoreNotesViewOnce + NotesPanel presentation/activeId（loadList 保底选篇两段式）| 互斥族/关闭钮/**首页路过收起（HomeView.vue:100）** | **P-20261114-1 修复面**：HomeView mount 期无条件 closeNotesView 已由同批 P-1 裁决处置——本次不改该段代码（派发时序上 P-1 分支尚未合入本 worktree，留给 P-1）。**S2 裁决（P-20261114-4-S2，清除点裁决基线翻转）**：工作面归属打开它的场景——open=project 槽、新增 homeOpen=home 槽分场景（旧单槽值原位即 project 槽向后兼容零迁移）；「首页路过收起」清除点随 P-20261114-4-S1 内存快照定案消亡（回首页恢复 home 场景快照而非收起，显式关闭才落本场景槽 false） |
| dashboard.landing | ② saveDashboardLanding | bootstrap（仅显式进入+偏好开，useLayoutBootstrap.ts:139-143）| 设置切换 | **正常**；视图显隐不落盘（showDashboard，P-20261005-224 定案「纯查看面」） |
| taskRunner.recent | ② saveTaskRunnerRecent | 面板挂载 getTaskRunnerRecent（旧版 `source::cwd::name` 键静默丢弃）| 上限 5 条 FIFO | **正常** |
| snapshots（整表 Record）| ② saveWorkspaceSnapshots | useWorkspaceSnapshot 弹层/快捷键恢复链 | 用户删除快照；恢复前自动档滚动槽 | **正常** |
| bookmarks / diffComments（整表 Record）| ② saveEditorBookmarks / saveDiffComments | useEditorBookmarks / useDiffComments 挂载恢复 | 用户删锚/删留言；上限在写入方收口（≤100/项目）| **正常** |
| editorPrefs.mdMode | ② saveEditorMdModePreference | 打开 .md 恢复 | — | **正常** |
| agentTaskTemplates.items | ②特例：GET+merge+PUT 整更新（saveAgentTaskTemplates，uiState.ts:1094——非 patchNamespaces；手动合并基底防 beforeunload 抹回）| useAgentTaskTemplates 消费（null=出厂预置）| 管理面增删改 | **正常**（低频管理面特例，整更新由 GET 带回其他实例记录原样写回=无害；不改动） |
| layoutLock.locked | ② saveLayoutLocked | restoreFromState（restoreLayoutOnly 内，早退前）| toggle | **正常** |
| railOrder.railTop | ② saveRailTopOrder | restoreRailTopOrder（restoreLayoutOnly 内）| 拖拽重排 | **正常**（形状防御在 panels/registry） |
| monitorBoard.cardOrder/hiddenCards | ② saveMonitorBoardLayout | monitor 页 boot getMonitorBoardLayout | 用户操作 | **正常**（已知 id 收敛在 utils/monitorBoardLayout） |
| notificationCenter.lastSeenAt | ② saveNotificationLastSeenAt（面板关闭即写）| 面板打开读 | — | **正常** |
| sync.direction/peers/projects/contexts | ② saveSyncPrefs（执行成功即写）| 面板打开 getSyncPrefs（一键重跑）| — | **正常** |
| conflictAgent.template | ② saveConflictAgentTemplate | 弹层发起读（''=无记忆回 i18n 派生）| 恢复默认链写 '' 清记忆 | **正常** |

## 三、localStorage sc.* 键逐项三问

字面量实锚 51 个 = **44 生产键** + 5 测试专用键 + 2 误命中（`sc.label`=WelcomePanel.vue:146 v-for 作用域变量、`sc.inlineEdit.bar/prompt`=Monaco widget id 非 localStorage 键，useEditorInlineEdit.ts:44-45）。另有动态前缀族 6 组与「非 sc.* 前缀的同通道键」边界（见三.3）。

### 三.1 生产键逐项（44 键，按域分组）

| 键 | 域/含义 | 写入 | 恢复 | 清除 | 裁决 |
|---|---|---|---|---|---|
| sc.fileTree.expanded.\<pid\>（动态族）| 树展开按项目真源 | FileTreeView watch | FileTreeView 挂载自恢复；快照采集采它（useWorkspaceSnapshot:317）；快照应用写入（useLayoutShell:343）| useLayoutReset 重置清 | **正常**（uiState 退役后为唯一真源） |
| sc.fileTree.showHidden / sc.fileTree.hideIgnored（动态族）| 树过滤开关 | FileTreeView:209 | readFilterPref（:203，裸读在案豁免）| — | **正常** |
| sc.term.activeTabMap | 终端激活 tab 按项目 | TerminalView:739 | TerminalView:725 + useTerminalReconnect:57 | 已关闭会话残留无害（恢复方校验，在案注释）| **正常** |
| sc.terminalSessions.sortMode/groupMode/pinnedIds/runtimeFilter | 终端会话显示偏好 4 键 | terminal-sessions-prefs.ts | store setup 一次读 | pinnedIds 消亡剪枝（防无界）| **正常** |
| sc.terminal.closeNoConfirm | 关 tab 免确认（项目终端+远程控制台共用）| useTerminalTabs:246 / TerminalSettings | useRemoteConsoleTabs:188 / useTerminalTabs:58 | 恢复确认时 removeItem | **正常** |
| sc.terminal.copyOnSelect / stripTrailingNewline / pasteNoMultilineWarn | 终端剪贴板偏好 | useTerminalClipboard | 同文件模块级初始化 | copyOnSelect 开=清 key（回归默认语义，:65）| **正常** |
| sc.terminal.mouseModeHintDismissed | 鼠标模式一次性提示 | terminalMouseModeHint:50 | :41 | 「重置提示」可清（:57）| **正常** |
| sc.tmuxScrollTipShown | tmux 翻页一次性提示 | TerminalView:858 | :858 读 | — | **正常** |
| sc.terminalFloat.geometry | 终端悬浮窗几何 | useTerminalFloat:73 | :64 | — | **正常** |
| sc.agentTerminal.openState / expandedMode | agent 终端开态/形态 | useAgentTerminal watch 持久化 | 模块加载 loadPendingOpenState → consumePendingOpenState 首宿主消费 | 测试复位清 | **正常** |
| sc.agentTerminal.pos / size | agent 悬浮窗几何 | useAgentTerminalFloat:64/102 | 同文件 | — | **正常** |
| sc.agentTerminal.ballPos / ballStyle | 悬浮球位置/样式 | AgentTerminalMini | 同组件 | — | **正常** |
| sc.agentTerminal.lastRuntime | 上次选择的 agent runtime | useAgentRuntimeOptions:38 | 对话框回填 | — | **正常**（注释在案：uiState 的 agentTerminal 是读改写链，旁路写会互相覆盖，故走 localStorage） |
| sc.agentTerminal.sidebarWidth | agent 管理页侧栏宽 | useSidebarWidth 泛化实现（拖拽/键盘/双击统一落盘）| 宿主挂载 load | 双击复位 | **正常**（车道定案：面板内嵌侧栏宽=localStorage 客户端偏好，CLAUDE.md 侧栏 resizer 节在案；与主侧栏 uiState 按实例形成两档） |
| sc.remoteConsole.sidebarWidth / sc.notes.sidebarWidth | 远程/笔记侧栏宽 | useSidebarWidth（SidebarResizer 把手）| 同上 | 同上 | **正常**（P-20261111-7/P-20261112-9 接入，键约定 sc.\<panel\>.sidebarWidth 在案） |
| sc.editor.splitWidth | 分屏主组占比（两方向共用比例）| EditorArea onUp 落盘 | readSplitWidth | 双击复位对半 | **正常** |
| sc.settings.lastTab | 设置上次分区 | SettingsModal watch | recallLastTab（分区表校验回落 general）| — | **正常** |
| sc.previewPorts | 预览最近端口 | PreviewPanel:32 | :12 | 上限截断 | **正常** |
| sc.palette.commandUsage / recentCommands(legacy) / fileUsage | 命令面板使用计数 | paletteUsage:102 | :75 | legacy 键收编后 removeItem（:86 迁移清理）| **正常** |
| sc.snippet.paramValues | 片段参数历史 | snippetParamHistory:47 | :43 | 上限环形 | **正常** |
| sc.keymapOverrides | 快捷键覆盖 | stores/keymap.ts | 启动读 | 恢复默认清 | **正常**（导出键供 settingsTransfer） |
| sc.newSession.draft | 新会话表单草稿 | useNewSessionPromptState:241 | :215（恢复提示条）| 成功提交/丢弃清（:255）| **正常** |
| sc.agentQueue.draft.\<sessionId\>（动态族）| 排队指令草稿 | useDraftGuard（**sessionStorage**，会话级生命周期）| 挂载/切行回填 | 关标签页即清/提交清 | **正常**（车道注释在案：sessionStorage 刷新存活、关页即清，与防丢语义对齐） |
| sc.draft-saved | 草稿落库信标（跨标签页 storage 事件）| draftDb 每次写覆盖（savedAt 保新值触发）| settingsSync 按键分发表忽略本键（纯信标）| 覆盖式 | **正常**（单键 JSON 载荷防 path 冒号编码歧义，注释在案） |
| sc.unlockToken | 解锁令牌 | stores/lock.ts | 启动读 | 登出/上锁 removeItem（:39）| **正常** |
| sc.lockShortcut | 锁屏快捷键 | lock.ts:272 | :101 | 恢复默认清（:274）| **正常** |
| sc.httpWarningDismissed | http 警示一次性关闭 | useHttpWarning:36 | :27 | — | **正常** |
| sc.localeSuggestDismissed | 语言建议一次性关闭 | useLocaleSuggest:53 | :35 | — | **正常** |
| sc.approvalGuideDismissed | 审批指南一次性关闭 | useApprovalGuide:29 | :23 | — | **正常** |
| sc.approvalRuleSuggestShown | 审批建议节流（单键 JSON map）| approvalPattern | 读回判定 | — | **正常**（单键而非 per-pattern：safeStorage 无键枚举面，注释在案） |
| sc.gitignoreSuggest.dismissed.\<projectId\>（动态族）| gitignore 建议按项目一次性关闭 | GitPanel:156 | :150 | — | **正常** |
| sc.rfm.cwd.\<hostId\> / sc.rfm.mem.\<hostId\>（动态族）| 远程文件浏览器目录/路径记忆 | useRemoteFileBrowser:51/185 | :58/:177（cwd 裸读在案豁免）| — | **正常**（设备本地偏好口径注释在案） |
| sc.morningBrief.\<date\>（动态族）| 晨报当日已阅 | morningBrief.ts | 同日读 | 按日轮换自然失效（零清理负担，注释在案）| **正常** |
| sc.clip-relay.device | 剪贴板中继设备 id | clipRelay:29 | :26 | — | **正常**（设备标识，非 UI 偏好） |
| sc.debug.terminalClipboard | 终端剪贴板调试开关 | 手动 Console 设置 | 模块加载读 | 手动清 | **正常**（调试后门，注释在案） |
| sc.test.draft / sc.test.draft.session-a/b / sc.test.sidebarWidth / sc.rfm.mem.h1/h2 | 测试夹具键 | 仅 .test.ts | — | 用例内清 | **正常**（不入生产键面） |

### 三.2 动态前缀键族汇总

`sc.fileTree.expanded.<pid>`、`sc.fileTree.<toggle>`（showHidden/hideIgnored）、`sc.morningBrief.<yyyy-MM-dd>`、`sc.agentQueue.draft.<sessionId>`（sessionStorage）、`sc.gitignoreSuggest.dismissed.<projectId>`、`sc.rfm.cwd.<hostId>` + `sc.rfm.mem.<hostId>`——字面量 grep 抓不到，S2 注册表/门禁须按前缀模式登记。**S2 落地回执（P-20261114-2-S2）**：七族已按尾随 `*` 前缀模式入 `web/src/persistence/uiStateLanes.json` legacyScKeys 豁免基线（模板串/拼接常量前缀段提取形态），check:uistate-lanes 门禁与一致性单测双守。

### 三.3 边界：非 sc.* 前缀的同通道键（存在性清单，不逐项深挖）

theme-settings / font-settings / terminal-theme-follow / notify-dnd / notify-dnd-manual / notify-sound / notify-simple / notify-scroll-read / ctx-warn-pct / ui-zoom-settings / graph-lane-settings / file-nesting-settings / editor-recent-files / home-recent-projects / clone-prefs / clone-url-history / runbook-params-history / locale（LOCALE_STORAGE_KEY）/ opsAtomPrefs ATOM_STORAGE_KEYS / theme early-init / updateCheck 版本记忆 / useSearchHistory / useSearchScope 等——同一 safeStorage 通道的客户端设备本地偏好/设备标识车道，早于 sc.* 命名约定或独立约定。**边界声明**：本审计主面 = sc.* 键族 + uiState 命名空间 + usePanelLayout 内存态；S2 若建注册表可将其列为「非 sc.* 存量族」一节，不强制收编。

## 四、内存态逐项三问（usePanelLayout 模块级单例 + agent 终端）

| 状态项 | 持久化 | 恢复 | 清除 | 裁决 |
|---|---|---|---|---|
| sideView/showSidePanel/showBottomPanel/bottomTab/commitLocation/sidePanelWidth/bottomPanelHeight | ①（layout 命名空间）| restoreLayoutOnly | 重置 | 正常 |
| bottomPanelMaximized/bottomPanelEditorMaximized | ①（落盘两档）| restoreLayoutOnly | 面板隐藏 watch/重置 | 正常 |
| terminalMaximized | **不持久化** | —（LAYOUT_DEFAULTS 有出厂键）| 面板隐藏/互斥/重置/Esc | **定案维持**（临时档，升格评审定案核实一致） |
| editorGroupMaximized / terminalPaneMaximized | **不持久化**（uiState 无键，注释 usePanelLayout.ts:63/69）| — | splitOpen=false 清组最大化（EditorArea:158）/Esc 退栈/restoreFromMaximized | **定案维持**（P-20261004-64 临时聚焦态） |
| dshMaximized | **不持久化**（:87）| —（刷新从常态开始）| 关控制台即还原 | **定案维持** |
| showRemoteConsole | ②（remoteConsole.open）| restoreLayoutOnly | 互斥族 | 正常 |
| showShareManager | ② | restoreShareManagerOnce | 互斥族 | 正常 |
| showDshConsole | ② | restoreDshConsoleOnce | 互斥族 | 正常 |
| showDashboard | **不持久化**（P-20261005-224 注释）| —（刷新回工作形态）| 互斥族 | **定案维持**（纯查看面） |
| showNotesView | ② | restoreNotesViewOnce | 互斥族/关闭钮/首页路过（P-1 面）| P-20261114-1 修复面。**S2 裁决（P-20261114-4-S2）**：分场景槽 homeOpen=home 槽（open=project 槽），恢复按所在场景读槽 |
| pendingSideFilesOpen/pendingBottomTab/pendingSideView | 不持久化（跨页一次性意图）| bootstrap 消费 | 消费即清 | 正常 |
| agentTerminal visible/mode/expandedMode | ③（openState/expandedMode）| 模块加载→首宿主消费 | 测试复位 | 正常 |
| agentTerminal projectDockedMem | 不持久化（项目级 docked 记忆，会话内）| — | 项目切换 | 正常（会话性记忆） |

## 五、清除点普查清单（隐藏清除点逐个裁决）

| 清除点 | 位置 | 裁决 |
|---|---|---|
| 首页 mount 期无条件收笔记 | HomeView.vue:100 closeNotesView | **P-20261114-1 修复面**——本次不改（P-1 分支待合入，留给 P-1）。**S2 裁决（P-20261114-4-S2）**：该清除点已随 P-20261114-4-S1 消亡（HomeView mount 期 closeNotesView 移除，回首页按 home 场景快照恢复）——清除点普查以 P-20261114-4 per-scene 定案为基线 |
| 主区五视图互斥族（开一方清余四方）| usePanelLayout.ts:141-239 + doRestoreXxx 开分支 | **定案维持**（「最后落位者优先」互斥语义，恢复定序已显式固定） |
| agent docked 反向互清 | useAgentTerminal closeMainViews:263 + AgentTerminal 组件反向 watch | 定案维持 |
| 底部面板隐藏清最大化族 | usePanelLayout.ts:543 watch | 定案维持（形态随宿主显隐） |
| 关分屏清组最大化 | EditorArea.vue:158 watch | 定案维持（组号失效残留防御） |
| 关 dsh 清 dshMaximized | usePanelLayout.ts:243 | 定案维持 |
| 布局重置 | useLayoutReset.ts（清 sc.fileTree.expanded.\<pid\> + resetLayoutState **保 pinnedDirs**）| **定案维持**（P-74：重置=布局自救，钉选是策展数据） |
| 置顶会话消亡剪枝 | terminal-sessions-prefs.ts | 定案维持（防集合无界） |
| 晨报当日键 | morningBrief.ts 按日轮换 | 定案维持（零清理负担） |
| 排队草稿键 | useDraftGuard（sessionStorage 生命周期）| 定案维持 |
| palette legacy 键 | paletteUsage.ts:86 迁移后 removeItem | 定案维持 |
| 解锁令牌 | lock.ts:39 | 定案维持 |
| 项目切换清 openFiles | openfiles/core.ts:124 | **定案维持**（对齐页面刷新语义，显式注释） |

**普查结论**：除 HomeView:100（P-1 面）外，无新发现的无主清除点；mount 期无条件写清除仅此一处。

## 六、本次修复面（S1 点修，独立可回溯）

考古结论先行：collect extra 的 fileTreeExpanded/terminalActiveTab（及 gitPanel 两键）**自 init commit（832a7b31）起从未有任何调用方接线**（`git show 832a7b31:web/src/views/Layout.vue` 的 `createBeforeUnloadHandler()`/`setupAutoSave()` 即无参形态，`git log -S` 无接线史）——生产恒写空值，属死接口而非回归。

1. **useLayoutBootstrap.ts**：restoreLayoutState 删 `fileTree.expandedDirs`（revealExpandedDirs 桥）与 `terminal.activeTabId`（restoreTerminalTab 桥）两恢复段——两车道真源早已在 localStorage 各自键控面（时序上 FileTreeView/TerminalView 挂载自恢复总在其后覆盖，终态不受影响；删桥零行为变化，消除「死恢复口」误导与历史遗留真值的考古恢复路径）；`restoreGitPanel` 恢复段**保留**并注释标注为升格项落点。
2. **useLayoutState.ts**：collectCurrentUIState 收窄——fileTree/terminal 两键退出 collect 面（不再为已迁移车道维护死副本）；extra 参数收窄为 gitPanelCollapsed/gitPanelBranch（升格重接落点）。联动安全：diffChangedKeys 只比较 state 自身键（不发即不 diff）；saveFileTreePinnedDirs 独立写端不受影响（从基底回带）；NESTED_UISTATE_SUBFIELDS 注册表 backfill 对其他写端照常兜底；旧记录残留键被服务端浅合并原样保留（无人清理，无害）。
3. **useLayoutShell.ts**：deps 闭包删 revealExpandedDirs/restoreTerminalTab 两桥。
4. **uiState.ts**：editor.scrollPositions / fileTree.expandedDirs / fileTree.selectedFile / terminal.activeTabId / gitPanel 五处字段级定案注释（僵尸/恒空有意/漏收集升格中）。类型字段保留（旧记录读取兼容，落盘格式零变化）。
5. **useWorkspaceSnapshot.ts**:311 注释随动（快照树展开采集取 localStorage 真源的表述更新）。
6. **测试**：useLayoutBootstrap.test.ts deps 收窄 + 新增「legacy 记录携带退役字段真值时零异常跳过、未退役车道照常」用例；useLayoutState.test.ts 新增「collect 面不产 fileTree/terminal 键、gitPanel 键保留」用例。

**升级兼容**：本修复零落盘格式变更（UIStateData 类型面不动、注册表不动）；旧记录中的 fileTree/terminal 键成为无人读写的沉淀数据，向后兼容零迁移。

## 七、升格清单（需新车道/新恢复口三件套/跨组件重设计——本步不修）

> **S2 裁决回执（P-20261114-2-S2）**：#1 collapsedSections → **升格独立提案**（登记行 `gitPanel.collapsedSections` 矩阵如实记「现状不保持」，恢复桥保留为重接落点）；#2 scrollPositions → **显式退役已执行**（字段/登记行/collect 写面/测试夹具四处同步清退，墓碑注在案）。

1. **gitPanel.collapsedSections 漏收集**（升格点：收集端 extra 接线 + 恢复时序裁决）。现状：GitPanel.collapsedSections 纯内存（GitPanel.vue:167），设计持久化位 uiState.gitPanel 存在且注册表登记、恢复桥 restoreGitPanel 在位，但 ①收集端 extra 从未接线（恒空）②恢复桥被 GitPanel 挂载方式饿死（BottomPanel.vue:168 `v-else-if="bottomTab==='git'"`——boot 时 GitPanel 多半未挂载，ref 可选链静默跳过）。修复需：收集端在 useLayoutShell 传动态 extra（对象 getter 或响应式源）+ 恢复端改「GitPanel 挂载后自恢复」或 pending 消费语义（同 pendingSideView 三件套）——跨组件时序重设计，属恢复口三件套。gitPanel.selectedBranch 维持不恢复（分支跟随 git 事实，见二节定案）。**S2 裁决：升格独立提案。**
2. **editor.scrollPositions Monaco 滚动位置记忆**（从未实现：无写端无恢复端）。实现需 Monaco scroll 事件收集（防抖）+ 恢复钩子 + 分屏组归属 + 漂移容忍——新收集/恢复链。备选：随 S2 注册表节奏显式退役删除字段（二选一，S2/S3 裁决）。**S2 裁决：显式退役（已执行，见二节定案回执与 uiState.ts 墓碑注）。**

除上述两项外**全部点修完毕/无其他升格项**。

## 八、车道归类核实（评审修订点②落实）

- 主侧栏宽度：uiState `layout.sidePanelWidth` **按实例、跨浏览器**（collect useLayoutState.ts:89 → restoreLayoutOnly:182）——核实一致。
- 面板内嵌侧栏宽：localStorage `sc.<panel>.sidebarWidth` 客户端偏好车道（agentTerminal / remoteConsole / notes 三处接入 useSidebarWidth 泛化实现，CLAUDE.md 侧栏 resizer 节在案）——核实一致；任务书「仅 agent 管理页侧栏宽是 localStorage」的表述为 P-20261106-5 前的旧况，P-20261111-7（remoteConsole）/P-20261112-9（notes）接入后实况为三处，**方向与在案定案一致**（面板内嵌侧栏=设备本地偏好），非偏差。
- 最大化族两档：bottomPanelMaximized/bottomPanelEditorMaximized 落盘（collect:96-97 → restore:205-206），terminalMaximized/editorGroupMaximized/terminalPaneMaximized/dshMaximized 临时——核实一致。
