import { onMounted, onBeforeUnmount } from 'vue'
import { matchShortcut } from '../utils/shortcut'
import { hasBlockingOverlay } from '../utils/overlayGuard'
import {
  useKeymapStore, matchLayoutCombo, withShiftVariant, withShiftedKey, type KeymapAction,
} from '../stores/keymap'

/**
 * Layout 全局键盘快捷键（自 Layout.vue 抽出）：Esc 逐层收起（P-20261004-12：
 * 演示态→浮出层→最大化→底栏面板，naive 弹窗存在时整体让位）/
 * Ctrl+B 侧栏 / Ctrl+\` 终端 / Ctrl+Shift+\` 新建终端 / Ctrl+Shift+V 预览 /
 * Ctrl+W 关标签 / Ctrl+Tab 循环 / Ctrl+PgUp/PgDn 线性切标签（P-20261002-135）/
 * Ctrl+\ 开关分屏 / Ctrl+Alt+\ 下方分屏（P-20261005-230）/ Ctrl+Shift+\ 切活跃编辑器组
 * / Ctrl+Alt+N 新建草稿 / Ctrl+K 面板 / Ctrl+P Quick Open / Ctrl+Shift+F 搜索 /
 * Ctrl+Shift+O 大纲 / Ctrl+Alt+V 多剪贴板粘贴（P-20261002-149） / Ctrl+Shift+M Markdown 模式循环（仅 .md，P-20261003-18） / Alt+Shift+T 重开已关闭标签 / Ctrl+Alt+←→ 导航后退前进 /
 * Ctrl+Alt+PgUp/PgDn 书签间跳转（P-20261004-102）/ Alt+↑↓ diff 导航 /
 * Alt+Shift+←→ 移动当前标签（P-20261005-201）；锁定快捷键优先级最高。所有行为经 deps 回调上抛，本组合式只做
 * 键位判定与监听管理。
 *
 * 布局键位（P-20261002-28）不再硬编码：动作 → combo 查 keymap store（默认表 +
 * 用户覆盖，设置→快捷键分区改绑）。Esc / ? / Alt+↑↓ / Ctrl+1-9 数字直达 /
 * Ctrl+Alt+1-9 工作区预设直达（P-20261004-49）为单键或区间键，不在可改键
 * MVP 范围，维持硬编码（见 stores/keymap.ts 边界说明）。
 * 移位字符/±Shift 变体 helper（withShiftVariant / withShiftedKey / 移位字符映射）
 * P-20261003-111 起上收 stores/keymap.ts，与终端域匹配面（comboVariants）同源。
 */

export function useLayoutKeyboard(deps: {
  isDialogOpen: () => boolean
  lockShortcut: () => string | null
  lock: () => void
  /** Esc 退出投屏演示模式（P-20261002-45）：演示态中消费返回 true，否则 false 放行 */
  exitPresentModeByEsc: () => boolean
  exitMaximizedByEsc: () => boolean
  /** Esc 逐层收起（P-20261004-12）浮出层：收回底部终端浮动窗 / 收起智能体悬浮窗
   *  ——布局 z 序最上层（浮窗基座 3000+ / 悬浮窗 900，均高于最大化 100），先于
   *  最大化被逐层收回。命中消费返回 true */
  dismissFloatByEsc: () => boolean
  /** Esc 逐层收起（P-20261004-12）最内层：收起底栏面板（终端聚焦时已在 Esc 分支
   *  入口的 INPUT/TEXTAREA veto 让位 PTY，不会误关）。命中消费返回 true */
  dismissBottomPanelByEsc: () => boolean
  toggleSidePanel: () => void
  toggleTerminalPanel: () => void
  createNewTerminal: () => void
  togglePreviewPanel: () => void
  isRemoteOrChat: () => boolean
  closeActiveTab: () => void
  reopenClosedTab: () => void
  navBack: () => void
  navForward: () => void
  /** 当前项目书签条数（bookmarkPrev/Next 的门控计数：无书签 veto 放行浏览器，
   *  同 cycleTab 的 openFilesCount 口径） */
  bookmarkJumpCount: () => number
  /** 书签间跳转（P-20261004-102，Ctrl+Alt+PgUp/PgDn）：delta -1 上一个 / 1 下一个，
   *  环形序取相邻书签后走开文件+行定位链（实现在 useLayoutViews） */
  bookmarkJump: (delta: number) => void
  newUntitledDraft: () => void
  /** 全部保存（P-20261002-101）：双组全部脏文件串行落盘（useOpenFiles.saveAllFiles） */
  saveAll: () => void
  openFilesCount: () => number
  cycleEditorTab: (delta: number) => void
  /** 线性切换活跃组上一/下一标签（P-20261002-135，Ctrl+PgUp/PgDn）：
   *  delta -1 上一个 / 1 下一个，activeFileIndex ±1 环绕 */
  switchTab: (delta: number) => void
  /** 键盘移动活跃组当前标签（P-20261005-201，Alt+Shift+←/→）：delta -1 前/
   *  1 后移一位；组内到头静默停（实现收口 useOpenFiles.moveActiveTab） */
  moveTab: (delta: number) => void
  toggleSplit: () => void
  /** 下方分屏/方向切换（P-20261005-230，splitDown 键位）：未分屏开纵向分屏，
   *  已开异方向切纵向、同向取消（实现收口 useOpenFiles.splitDown） */
  splitDown: () => void
  focusOtherGroup: () => void
  openCommandPalette: (mode?: 'files' | 'commands') => void
  openQuickOpen: () => void
  openProjectSearch: () => void
  openOutline: () => void
  /** 多剪贴板粘贴（P-20261002-149，Ctrl+Alt+V）：呼出剪贴板历史选择弹层 */
  openClipboardHistory: () => void
  /** 活跃编辑器文件是否为 Markdown（mdModeCycle 的消费门——非 md 文件不拦截按键） */
  isMdFileActive: () => boolean
  /** Markdown 模式循环（P-20261003-18）：source→preview→split（作用于活跃组编辑器） */
  cycleActiveMdMode: () => void
  diffNav: (down: boolean) => void
  openShortcutsHelp: () => void
  railPanelCount: () => number
  switchRailPanel: (index: number) => void
  /** 工作区预设数（P-20261004-49，Ctrl+Alt+数字越界放行的门控计数）：shell 以
   *  useWorkspaceSnapshot 的预热列表供给——捕获链是同步裁决，非同步注册表面
   *  （uiState 拉取）只能给计数，越界即放行浏览器 */
  workspacePresetCount: () => number
  /** 恢复第 N 个工作区预设（P-20261004-49，Ctrl/Cmd+Alt+数字 N）：取数与流程
   *  编排在 useWorkspaceSnapshot（restoreSnapshotByIndex），此处只上抛序号 */
  restoreWorkspacePreset: (index: number) => void
  openSettings: () => void
  isLocked: () => boolean
}) {
  const keymap = useKeymapStore()

  /** 编辑器域动作共用门控（newUntitledDraft / navBack / navForward）：远程控制台
   *  /AI 助手主区激活或焦点在输入框时跳过，但 Monaco 隐藏输入区
   *  （textarea.inputarea）是编辑器本体——编辑中照常可用 */
  function vetoNonEditor(e: KeyboardEvent): boolean {
    if (deps.isRemoteOrChat()) return true
    const t0 = e.target as HTMLElement | null
    return !!t0 && (t0.tagName === 'INPUT' || (t0.tagName === 'TEXTAREA' && !t0.classList.contains('inputarea')))
  }

  // 布局动作注册表：数组序 = 匹配优先序（与旧硬编码判定顺序一一对应；
  // 用户改键撞键时先注册者生效，后注册者由设置分区标红警告）。
  // veto = 旧实现的门控（远程控制台/AI 助手主区、焦点在输入框等）——命中即整段
  // 返回不消费，与旧代码「门控 return」语义一致，不落给后续动作
  const layoutActions: Array<{
    action: KeymapAction
    run: (e: KeyboardEvent) => void
    veto?: (e: KeyboardEvent) => boolean
    /** 主键 ±Shift 变体同样命中（` / Tab 两个旧实现的现实行为） */
    shiftTolerant?: boolean
    /** 主键的移位字符变体同样命中（Ctrl+Shift+` 在部分平台报告 '~'，见
     *  withShiftedKey）；变体不问事件是否带 shift，同旧硬编码分支对 '~' 的
     *  无差别容差 */
    shiftedKeyTolerant?: boolean
  }> = [
    // Ctrl/Cmd+B 切换侧边栏
    { action: 'toggleSidebar', run: () => deps.toggleSidePanel() },
    // Ctrl/Cmd+Shift+` 新建终端（P-20261002-38，对标 VS Code 新建终端键位）：
    // 注册序先于 toggleTerminal——后者的 ±Shift 变体兜底命中 ctrl+shift+`，
    // 本动作须先匹配才能接管；非 shift 的 Ctrl+` 面板开关语义不变
    {
      action: 'newTerminal',
      run: () => deps.createNewTerminal(),
      shiftedKeyTolerant: true,
    },
    // Ctrl/Cmd+` 切换终端面板
    { action: 'toggleTerminal', run: () => deps.toggleTerminalPanel(), shiftTolerant: true },
    // Ctrl/Cmd+Shift+V 切换端口预览面板（P-20261002-69：对标 VS Code markdown
    // 预览键位直觉；toggle 语义与终端键对齐——未开或非 preview 则开面板并落
    // preview tab，已是 preview 态则收起）
    { action: 'previewToggle', run: () => deps.togglePreviewPanel() },
    // Ctrl/Cmd+W 关闭当前编辑器标签（先确认当前焦点不在输入框）；
    // 远程控制台/AI 助手主区激活时跳过——两个视图自己处理 Ctrl+W
    {
      action: 'closeTab',
      run: () => deps.closeActiveTab(),
      veto: (e) => {
        if (deps.isRemoteOrChat()) return true
        const tag = (e.target as HTMLElement)?.tagName
        return tag === 'INPUT' || tag === 'TEXTAREA'
      },
    },
    // Ctrl/Cmd+Tab、Ctrl/Cmd+Shift+Tab 循环切换编辑器标签（主区非编辑器视图时跳过）
    {
      action: 'cycleTab',
      run: (e) => deps.cycleEditorTab(e.shiftKey ? -1 : 1),
      veto: () => deps.isRemoteOrChat() || deps.openFilesCount() < 2,
      shiftTolerant: true,
    },
    // Ctrl/Cmd+PgUp/PgDn 线性切换上一/下一编辑器标签（P-20261002-135，对标 VS Code
    // Ctrl+PgUp/PgDn）：与 cycleTab（Ctrl+Tab 循环）按序浏览分工，只动活跃组。
    // 门控同导航键（vetoNonEditor）——Monaco 编辑中切换是主场景（VS Code 肌肉
    // 记忆），隐藏输入区放行；再叠 openFilesCount 计数（同 cycleTab 口径，无标
    // 可切时放行浏览器）。成对方向键拆两动作（同 navBack/navForward），无 shift 变体
    {
      action: 'switchTabPrev',
      run: () => deps.switchTab(-1),
      veto: (e) => vetoNonEditor(e) || deps.openFilesCount() < 2,
    },
    {
      action: 'switchTabNext',
      run: () => deps.switchTab(1),
      veto: (e) => vetoNonEditor(e) || deps.openFilesCount() < 2,
    },
    // Alt+Shift+←/→ 移动当前标签（P-20261005-201，对标 Move Tab 扩展惯例键位）：
    // 拖拽重排（P-184）的键盘对位——活跃标签在组内前/后移一位，跨组不越界、
    // 到头静默停在实现（moveActiveTab，与拖拽共用 reorderGroupTabs 一条链）。
    // 门控同导航键（vetoNonEditor——Monaco 编辑中重排是主场景）+ openFilesCount
    // 计数（同 switchTab 口径，单标签无可移动时放行浏览器）。成对方向键拆两动作
    //（同 navBack/navForward 先例），无 shift 变体容差
    {
      action: 'moveTabPrev',
      run: () => deps.moveTab(-1),
      veto: (e) => vetoNonEditor(e) || deps.openFilesCount() < 2,
    },
    {
      action: 'moveTabNext',
      run: () => deps.moveTab(1),
      veto: (e) => vetoNonEditor(e) || deps.openFilesCount() < 2,
    },
    // Ctrl/Cmd+Shift+\ 切换活跃编辑器组（P-20261002-93，0<->1 未分屏 no-op）：
    // 注册序先于 toggleSplit（同 newTerminal→toggleTerminal 先例）——真实键盘/
    // Playwright 对 Shift+\ 上报移位字符 '|'（同 Shift+` 报 '~'），本动作
    // shiftedKeyTolerant 兜底命中该变体；直接报 '\' 的平台由主键位命中。
    // 编辑器域门控同导航键：远程控制台/AI 助手主区或终端输入焦点时跳过
    {
      action: 'focusOtherGroup',
      run: () => deps.focusOtherGroup(),
      veto: vetoNonEditor,
      shiftedKeyTolerant: true,
    },
    // Ctrl/Cmd+\ 分屏开关（P-20261002-93，对标 VS Code split editor 键位）：
    // 无分屏时以当前活跃文件开右侧分屏、已分屏时关闭（合成在 deps 接线，与
    // 「在右侧分屏打开」/「关闭分屏」菜单同链路）；无活跃文件 no-op
    { action: 'toggleSplit', run: () => deps.toggleSplit(), veto: vetoNonEditor },
    // Ctrl/Cmd+Alt+\ 下方分屏/方向切换（P-20261005-230，VS Code orthogonal split
    // 对称）：未分屏以活跃文件开纵向分屏；已开横向切纵向（排列轴翻转零重建）、
    // 纵向再按取消拆分（终端 splitTab toggle 语义同构）。门控同 toggleSplit
    { action: 'splitDown', run: () => deps.splitDown(), veto: vetoNonEditor },
    // Alt+Shift+T 重新打开最近关闭的编辑器标签（对标 VS Code Ctrl+Shift+T；
    // Chrome 保留 Ctrl+Shift+T 重开浏览器标签页无法拦截，故退避为 Alt 组合）。
    // 与 Ctrl+W 同门控：远程控制台/AI 助手主区激活或焦点在输入框时跳过
    {
      action: 'reopenClosedTab',
      run: () => deps.reopenClosedTab(),
      veto: (e) => {
        if (deps.isRemoteOrChat()) return true
        const tag = (e.target as HTMLElement)?.tagName
        return tag === 'INPUT' || tag === 'TEXTAREA'
      },
    },
    // Ctrl/Cmd+Alt+N 新建未命名草稿（对标 VS Code Ctrl+N；Chrome 保留 Ctrl+N
    // 无法拦截，退避为 Alt 组合，同 Alt+Shift+T 先例）。焦点在输入框时跳过，
    // 但 Monaco 隐藏输入区（textarea.inputarea）是编辑器本体——编辑中照常可用；
    // 与 Ctrl+W 同门控：远程控制台/AI 助手主区激活时跳过（主区非编辑器）
    {
      action: 'newUntitledDraft',
      run: () => deps.newUntitledDraft(),
      veto: vetoNonEditor,
    },
    // Ctrl/Cmd+Alt+S 全部保存（P-20261002-101）：串联双组全部脏文件串行落盘
    // （VS Code Save All 键位直觉，Ctrl+S 留给编辑器域单文件保存）。门控同
    // newUntitledDraft：远程控制台/AI 助手主区或输入框焦点跳过（编辑中照常可用）
    { action: 'saveAll', run: () => deps.saveAll(), veto: vetoNonEditor },
    // Ctrl/Cmd+Alt+←/→ 编辑器导航后退/前进（P-20261002-51，对标 VS Code
    // navigateBack/Forward；裸 Alt+←/→ 是浏览器历史导航保留键，退避多修饰
    // 组合，同 Alt+Shift+T 先例）。Monaco 聚焦（编辑/跳转后随即回退）是主
    // 场景：隐藏输入区放行，门控同 newUntitledDraft
    { action: 'navBack', run: () => deps.navBack(), veto: vetoNonEditor },
    { action: 'navForward', run: () => deps.navForward(), veto: vetoNonEditor },
    // Ctrl+Alt+PgUp/PgDn 书签间跳转（P-20261004-102）：环形序上/下一个书签（按
    // 文件+行全局排序），跨文件走开文件+行定位既有链。成对方向键拆两动作（同
    // navBack/navForward 先例）；无书签 veto 放行（越界放行惯例，同 cycleTab
    // 的 openFilesCount 门控），门控同导航键（远程控制台/AI 助手主区、输入框
    // 焦点跳过，Monaco 隐藏输入区放行——编辑中跳转是主场景）
    { action: 'bookmarkPrev', run: () => deps.bookmarkJump(-1), veto: (e) => vetoNonEditor(e) || deps.bookmarkJumpCount() < 1 },
    { action: 'bookmarkNext', run: () => deps.bookmarkJump(1), veto: (e) => vetoNonEditor(e) || deps.bookmarkJumpCount() < 1 },
    { action: 'commandPalette', run: () => deps.openCommandPalette() },
    // Ctrl/Cmd+, 打开设置（VS Code 惯例）
    { action: 'openSettings', run: () => deps.openSettings() },
    // VS Code 惯例：Ctrl+Shift+P 直达命令模式（命令面板的 commands 预置态）
    { action: 'commandMode', run: () => deps.openCommandPalette('commands') },
    // 避免覆盖浏览器打印
    { action: 'quickOpen', run: () => deps.openQuickOpen() },
    { action: 'projectSearch', run: () => deps.openProjectSearch() },
    { action: 'outline', run: () => deps.openOutline() },
    // 多剪贴板粘贴（P-20261002-149，Ctrl+Alt+V 呼出历史选择弹层）：Monaco 聚焦
    // 是主场景（多段组装插进编辑器），隐藏输入区放行，门控同 newUntitledDraft
    { action: 'clipHistoryPaste', run: () => deps.openClipboardHistory(), veto: vetoNonEditor },
    // Markdown 模式循环（P-20261003-18，仅 .md 文件激活）：source→preview→split
    // 循环。非 md 文件 veto 放行（不消费按键，无浏览器强占面）；模式按钮只在
    // md 工具栏可见时才有意义，故不做输入框焦点门控（切换是视图态非编辑动作）
    {
      action: 'mdModeCycle',
      run: () => deps.cycleActiveMdMode(),
      veto: () => !deps.isMdFileActive(),
    },
  ]

  /** 动作匹配：命中绑定键位，或 shiftTolerant / shiftedKeyTolerant 动作命中
   *  其 ±Shift 变体 / 主键移位字符变体 */
  function matchesAction(e: KeyboardEvent, spec: (typeof layoutActions)[number]): boolean {
    const bound = keymap.combos[spec.action]
    if (!bound) return false
    if (matchLayoutCombo(e, bound)) return true
    if (spec.shiftedKeyTolerant) {
      const shifted = withShiftedKey(bound)
      if (shifted && matchLayoutCombo(e, shifted)) return true
    }
    if (!spec.shiftTolerant) return false
    const variant = withShiftVariant(bound)
    return !!variant && matchLayoutCombo(e, variant)
  }

  function handleKeyDown(e: KeyboardEvent) {
    // 弹窗打开时由组件内部处理键盘事件，避免冲突
    if (deps.isDialogOpen()) return
    // 锁定快捷键优先级最高：在所有其他判断之前处理
    const shortcut = deps.lockShortcut()
    if (shortcut && matchShortcut(e, shortcut)) {
      e.preventDefault()
      deps.lock()
      return
    }
    // 锁定态：除锁定快捷键外全部门控——快捷键不再穿透锁屏改动后台布局
    // （侧栏/面板 toggle、标签关闭等在锁屏之下不可见却真实生效，解锁后状态突变）
    if (deps.isLocked()) return
    // ESC 逐层退出（P-20261004-12 扩展链）：一次退一层不跨层——演示态（最外层
    // 覆盖态：进入时已收起面板并压下最大化）→ 浮出层（终端浮动窗/智能体悬浮窗，
    // z 序高于最大化）→ 最大化状态（终端全屏 > 编辑器区域 > 底部全屏）→ 底栏
    // 面板。仅当焦点不在输入框时响应：终端聚焦 Esc 直通 PTY（vim 等依赖）、
    // Monaco 聚焦 Esc 自理（清选择/关内嵌部件）、输入框让位输入法退出
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // naive 弹窗/抽屉/下拉存在时整体让位（P-20261004-12）：弹窗内表单 Esc 只关
      // 弹窗（naive 自理 closeOnEsc），全局链不得穿透退背后的布局层。isDialogOpen
      // 只覆盖 shell 自管弹层——表单弹窗（Clone/AddProject/Push）、useDialog 确认
      // 弹窗等不在其列，复用 hasBlockingOverlay 既有 DOM 存在性守卫兜底（同
      // TaskRunner/通知中心等组件级 Esc 的让位先例）
      if (hasBlockingOverlay()) return
      if (deps.exitPresentModeByEsc()) {
        e.preventDefault()
        return
      }
      if (deps.dismissFloatByEsc()) {
        e.preventDefault()
        return
      }
      if (deps.exitMaximizedByEsc()) {
        e.preventDefault()
        return
      }
      if (deps.dismissBottomPanelByEsc()) {
        e.preventDefault()
        return
      }
    }
    // doc 级终端动作让位（P-20261003-111）：历史/片段/字号等终端键是 TerminalView
    // 的 document 监听（键位全域生效），跨域撞键语义为「终端域优先接管」——事件
    // 命中 doc 级键位且终端域宿主在场时布局链整体让位（保存时警示已按 takeover
    // 语义告知），TerminalView 消费后 preventDefault。终端域不在场（面板切
    // git/console 等分区）时键位无消费方，布局链照常接管
    if (keymap.docClaimsCombo(e)) return
    // 布局动作按注册序查 keymap 匹配（用户改键后由此生效）
    for (const spec of layoutActions) {
      if (!matchesAction(e, spec)) continue
      if (spec.veto?.(e)) return
      e.preventDefault()
      spec.run(e)
      return
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      deps.diffNav(e.key === 'ArrowDown')
    }
    // '?'（Shift+/）快捷键备忘单：焦点不在输入框/可编辑区时呼出
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t0 = e.target as HTMLElement | null
      if (t0 && (t0.tagName === 'INPUT' || t0.tagName === 'TEXTAREA' || t0.isContentEditable)) return
      e.preventDefault()
      deps.openShortcutsHelp()
    }
  }

  // Ctrl/Cmd+1..9 切换活动栏面板 + Ctrl/Cmd+Alt+1..9 恢复工作区预设（P-20261004-49，
  // VS Code 数字直达惯例）：capture 相位监听——终端 xterm 聚焦时会在 target 相位
  // 消化并 preventDefault 按键，气泡监听收不到；数字直达需要比 xterm 更早拿到事件
  // （preventDefault + stopPropagation 断其传入）。锁定快捷键仍最高优先：匹配到
  // 锁定键则放行气泡链由 handleKeyDown 处理。用户把某布局动作（改）绑到 Ctrl+数字
  // 时同样放行（claimsCombo）——capture 相位若先吞掉改绑键，改绑动作永远不触发，
  // 故数字直达让位 keymap 键位。越界数字（超出面板数/预设数）不消费，放行浏览器
  // 自身的标签页切换。Alt 修饰分支（预设直达）与面板直达共用同一套让位/门控纪律：
  // 共享门前移（弹窗/锁定键/claimsCombo/锁屏）后按 altKey 分流，两分支各自越界放行。
  function handleDigitCapture(e: KeyboardEvent) {
    if (deps.isDialogOpen()) return
    const isMod = e.ctrlKey || e.metaKey
    if (!isMod || e.shiftKey) return
    if (deps.lockShortcut() && matchShortcut(e, deps.lockShortcut()!)) return
    // keymap 键位占用该组合（改绑到数字的动作）：放行气泡链
    if (keymap.claimsCombo(e)) return
    // 锁定态门控：数字直达不穿透锁屏（同 handleKeyDown 门控）
    if (deps.isLocked()) return
    if (!/^[1-9]$/.test(e.key)) return
    const idx = Number(e.key) - 1
    // Ctrl/Cmd+Alt+数字 N 恢复第 N 个工作区预设（P-20261004-49）：多现场切换
    // （调试/评审/值班）免命令面板三步直达。预设计数来自 shell 预热列表（非同步
    // 注册表面），越界放行与面板直达同纪律；恢复流程收口 useWorkspaceSnapshot
    // 的 restoreSnapshotByIndex（未保存确认/恢复前自动档等语义与弹层行内恢复同链）
    if (e.altKey) {
      if (idx >= deps.workspacePresetCount()) return
      e.preventDefault()
      e.stopPropagation()
      deps.restoreWorkspacePreset(idx)
      return
    }
    if (idx >= deps.railPanelCount()) return
    e.preventDefault()
    e.stopPropagation()
    deps.switchRailPanel(idx)
  }

  onMounted(() => {
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('keydown', handleDigitCapture, true)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeyDown)
    document.removeEventListener('keydown', handleDigitCapture, true)
  })
}
