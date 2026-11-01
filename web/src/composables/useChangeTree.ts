import { computed, inject, nextTick, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useDebounceFn, useVirtualList } from '@vueuse/core'
import { useMessage } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import type { FileStatus } from '../stores/changes'
import { useUiDensityStore } from '../stores/ui-density'
import { diffApi, gitignoreApi } from '../api/client'
import type { NumstatFile } from '../api/domains/git'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { copyText } from '../utils/clipboard'
import { buildChangeSummary, toStatMap } from '../utils/changeSummary'
import type { ChangeSummaryStat } from '../utils/changeSummary'
import { collectAllFilePaths, collectRangePaths } from '../utils/rangeSelection'
import { compareByVolumeDesc, nodeHeat } from '../utils/changeHeat'
import type { ChangeNodeHeat } from '../utils/changeHeat'
import { changeDiffBaseline } from '../utils/changeDiffBaseline'
import type { Changelist } from '../api/domains/git'
import type { AgentMark } from './useAgentMarks'
import { useDiffComments } from './useDiffComments'
import { useDiffCommentAgentFix, type DiffCommentFixItem } from './useDiffCommentAgentFix'

/**
 * 变更面板「变更树」的全部逻辑（自 CommitPanel.vue 拆出，P-20261003-143）：
 * 路径→树构建与排序 / 目录折叠 / 虚拟滚动（行高随 ui-density 密度档）/ 键盘导航
 * （↑↓ 环绕、Home/End、Enter 激活、Space 切勾选）/ 键盘多选（Shift+↑↓ 范围、
 * Ctrl+A 全选、右键批量形态，P-20261003-271）/ 组头统计（P-20261003-280，目录行
 * 「N 文件 +x -y」）/ 行选中 / 暂存切换与提交勾选 /
 * 右键菜单（stage/回滚/gitignore/复制路径/复制变更摘要/编辑器打开/文件树定位）。
 *
 * 由面板宿主（CommitPanel）在 setup 期调用一次——状态挂在面板实例上而非
 * CommitChangeTree 子组件上：changes 页签内容在 v-if 下，切 stash 页签会卸载
 * 子组件，折叠态/键盘光标/选中行若由子组件自持会在往返后重置（拆分前不丢）。
 * 返回的 state 是 reactive 面板（子组件模板经代理读写，赋值路由回 ref）；
 * containerProps/wrapperProps 保持裸对象**不进** reactive 面板——里面持有
 * useVirtualList 的容器 ref，reactive 深层解包会把 ref 摊平成元素导致滚动定位失效。
 */
export function useChangeTree(options: {
  /** 可见文件（面板过滤后的显示集）：树按它构建 */
  files: Ref<FileStatus[]>
  /** 提交勾选集（面板级状态：与提交操作区同源） */
  selectedForCommit: Ref<Set<string>>
  /** 会话归属标注（P-20261003-22）：agent 产出点标与 tooltip */
  agentMarks: Ref<Map<string, AgentMark>>
  /** 过滤词/归属二态/状态四态（面板级状态）：变化时键盘光标回落首行 */
  changesFilter: Ref<string>
  agentScopeFilter: Ref<'off' | 'agent' | 'human'>
  statusScopeFilter: Ref<'all' | 'unstaged' | 'staged' | 'conflict'>
  /** 变更列表分组维度过滤生效态（P-20261007-19，「只看活跃组」；缺省恒 false） */
  changelistFiltering?: Ref<boolean>
  /** 变更列表清单（P-20261007-19）：右键「移入列表」子菜单数据面；空 = 不出菜单项 */
  changelistLists?: Ref<Changelist[]>
  /** 移入列表回调（面板持实现：API 调用 + 刷新；子组件不直连 API） */
  onMoveToList?: (file: string, list: Changelist) => void
  /** 双击行打开 diff（面板 emit open-diff 给宿主布局） */
  onOpenDiff: (payload: { path: string; name: string; oldRef: string; newRef?: string }) => void
}) {
  const { files, selectedForCommit, agentMarks, changesFilter, agentScopeFilter, statusScopeFilter, onOpenDiff } = options
  const message = useMessage()
  const { t } = useI18n()
  const projectStore = useProjectStore()
  const changesStore = useChangesStore()
  const revealInFileTree = inject<(path: string) => void>('revealInFileTree')
  const openFileInEditor = inject<(path: string) => void>('openFileInEditor')

  // ============== 按改动量排序 + 行数热力（P-20261003-239） ==============
  // 审阅焦点信号：agent 批量改动先看最大的。排序是会话内显示态（默认路径序，
  // 与折叠态同「不持久化」口径），热力是常驻被动呈现；两者共用 numstat 数据面
  //（GET /projects/:id/numstat，P-219 复制摘要同源端点）。量级考量：status 走
  // 300ms 防抖刷新热路径（fetchStatus 整表替换 files），numstat 不并道——变更集
  // 停止翻动 1s 尾沿去抖后发一次 GET（与 P-219 点击取数同开销量级，稳态零请求），
  // 失败静默降级（热力条不渲染、排序退化为组内路径序），下轮变更集再动自动重试
  const sortBySize = ref(false)
  function toggleSortBySize(): void {
    sortBySize.value = !sortBySize.value
  }
  // path → 增删行数（toStatMap 脏行防御复用 P-219）；ref 整表替换，行级查找
  // 在 buildTree 内 O(1)
  const numstatMap = ref<Map<string, ChangeSummaryStat>>(new Map())
  let numstatGen = 0
  async function fetchNumstat(): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    const gen = ++numstatGen
    try {
      // silent：增强呈现取数失败就地降级，不叠拦截器全局错误 toast
      const res = await diffApi.getNumstat(pid, { silent: true }) as unknown as { data?: NumstatFile[] }
      if (gen !== numstatGen) return // 过期代（项目已切/更新请求在途）：丢弃防旧数据回写
      numstatMap.value = toStatMap(res?.data)
    } catch { /* 静默降级：保留上一份数据（工作区多半未大变）或空 */ }
  }
  const fetchNumstatDebounced = useDebounceFn(() => { void fetchNumstat() }, 1000)
  // 项目切换同步清空（错项目的热力一秒也不能挂）；变更集翻动（fetchStatus 整表
  // 替换身份触发）走去抖取数——过滤词/chips 不触碰 changesStore.files，切过滤
  // 不产生多余 GET（热力与过滤正交的数据面前提）
  watch(() => projectStore.currentProjectId, () => {
    numstatMap.value = new Map()
    // 多选集与锚点随项目切换失效：路径集合按项目语义持有，跨项目残留会误伤
    // 批量操作（文件树多选 P-20 同款防误伤）
    multiSelectedPaths.value = new Set()
    selectionAnchorIdx.value = -1
  })
  watch(() => changesStore.files, (list) => {
    if (list.length === 0) numstatGen++ // 空变更集无需行数面，作废在途响应即可
    else fetchNumstatDebounced()
  }, { immediate: true })
  // 峰值归一口径：对全量变更集（含被过滤隐藏的）取最大改动行数——过滤只裁剪
  // 显示不重标定色阶，同一文件过滤前后热力档不变（与过滤正交的语义前提）
  const heatPeak = computed(() => {
    let peak = 0
    for (const f of changesStore.files) {
      const s = numstatMap.value.get(f.path)
      if (!s || s.binary) continue
      if (s.additions + s.deletions > peak) peak = s.additions + s.deletions
    }
    return peak
  })

  // 树形结构
  interface TreeNode {
    name: string
    path: string
    isDir: boolean
    children: TreeNode[]
    file?: FileStatus
    /** 改动行数（P-20261003-239 排序键）：文件=自身行数；目录=子树合计 */
    volume: number
    /** 行热力视图（1 档以上才有；undefined = 无行数量不渲染条） */
    heat?: ChangeNodeHeat
    /** 行数明细（文件节点；numstat 覆盖且非二进制才有——二进制/未覆盖不计行，
     * P-219「宁缺毋谎」同口径）：组头统计的自底向上聚合源 */
    stat?: { additions: number; deletions: number }
    /** 组头统计（P-20261003-280，目录节点）：组内文件数与增删行数合计；numstat
     * 数据面未就位/取数失败不挂（模板不渲染）——加载窗的「+0 -0」假零比空缺误导 */
    dirStat?: { files: number; additions: number; deletions: number }
  }

  function buildTree(list: FileStatus[]): TreeNode[] {
    const root: TreeNode[] = []
    for (const file of list) {
      const parts = file.path.split('/')
      let current = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        const isLast = i === parts.length - 1
        if (isLast) {
          const raw = numstatMap.value.get(file.path)
          const stat = raw && !raw.binary ? { additions: raw.additions, deletions: raw.deletions } : undefined
          current.push({
            name: part,
            path: file.path,
            isDir: false,
            children: [],
            file,
            volume: stat ? stat.additions + stat.deletions : 0,
            heat: nodeHeat(raw, heatPeak.value),
            stat,
          })
        } else {
          const existing = current.find(n => n.isDir && n.name === part)
          if (existing) {
            current = existing.children
          } else {
            const newDir: TreeNode = { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true, children: [], volume: 0 }
            current.push(newDir)
            current = newDir.children
          }
        }
      }
    }
    assignDirAggregates(root)
    sortTree(root)
    return root
  }

  /**
   * 目录聚合一遍自底向上：volume（P-20261003-239 排序键）与 dirStat（P-20261003-280
   * 组头统计）同遍求出——两份聚合面同源（文件节点的 stat），分两次遍历白费 O(n)。
   * 返回子树的「文件数 + 增删行数」：目录节点据此挂 dirStat、并把行数合计写回
   * volume（=原 assignDirVolumes 口径：文件 volume 之和）。文件数计 status 全量
   *（二进制/未覆盖行数的文件也是「一个文件」），行数只计 numstat 覆盖的非二进制
   * 文件——两个计数各自如实（N 面是 status 事实，行数面是 numstat 事实）
   */
  function assignDirAggregates(nodes: TreeNode[]): { files: number; additions: number; deletions: number } {
    let files = 0
    let additions = 0
    let deletions = 0
    for (const n of nodes) {
      if (n.isDir) {
        const sub = assignDirAggregates(n.children)
        n.volume = sub.additions + sub.deletions
        // 行数面就位才挂组头统计（heat「宁缺毋谎」同款：取数失败静默降级为不渲染）
        if (numstatMap.value.size > 0) n.dirStat = sub
        files += sub.files
        additions += sub.additions
        deletions += sub.deletions
      } else {
        files++
        additions += n.stat?.additions ?? 0
        deletions += n.stat?.deletions ?? 0
      }
    }
    return { files, additions, deletions }
  }

  function sortTree(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      // 按改动量（P-20261003-239）：目录按子树合计、文件按自身行数降序在前，
      // 同量按名升序兜底；「目录先于文件」结构不变量在上方分支保持
      if (sortBySize.value) return compareByVolumeDesc(a, b)
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.isDir) sortTree(node.children)
    }
  }

  const allTree = computed(() => buildTree(files.value))

  const collapsedDirs = ref<Set<string>>(new Set())

  // 树头批量展开/收起（P-20261003-169）：展开=清折叠集（空集即既有「全展开」
  // 语义）；收起=当前树（allTree 由可见变更集构建）目录全集**并入**既有折叠集
  //（含内层目录）——收起后只剩顶层目录行。并入而非替换：过滤视图只是目录的
  // 子集，替换会把视图外目录先期收起态一并冲掉（清过滤后意外弹回，违背
  // 「收起全部」字面承诺；e2e 实抓）；展开则无条件全域清空，与收起对称
  function expandAllDirs() {
    collapsedDirs.value = new Set()
  }

  function collapseAllDirs() {
    const dirs = new Set(collapsedDirs.value)
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.isDir) {
          dirs.add(n.path)
          walk(n.children)
        }
      }
    }
    walk(allTree.value)
    collapsedDirs.value = dirs
  }

  function toggleFileSelection(file: FileStatus) {
    if (selectedForCommit.value.has(file.path)) selectedForCommit.value.delete(file.path)
    else selectedForCommit.value.add(file.path)
  }

  function toggleDir(path: string) {
    if (collapsedDirs.value.has(path)) collapsedDirs.value.delete(path)
    else collapsedDirs.value.add(path)
  }

  // 过滤激活即「命中自动展开优先」（P-20261003-169）：任一过滤维度生效时扁平化
  // 无视折叠集整链展开——否则先期收起的目录会把过滤命中整组藏掉（输入框报有
  // 命中、列表却扫不到行）。与树头的全部展开/收起正交：两钮始终改折叠集本身，
  // 显示层由过滤优先级裁定，清过滤后折叠态原样生效。
  // changelistFiltering 缺省落本地恒 false ref：watch 源数组不接受 undefined 项
  const clFiltering = options.changelistFiltering ?? ref(false)
  const isTreeFiltering = computed(() =>
    changesFilter.value.trim() !== '' ||
    agentScopeFilter.value !== 'off' ||
    statusScopeFilter.value !== 'all' ||
    clFiltering.value
  )

  function flattenTree(nodes: TreeNode[], depth: number = 0): Array<TreeNode & { depth: number }> {
    const result: Array<TreeNode & { depth: number }> = []
    for (const node of nodes) {
      result.push({ ...node, depth })
      if (node.isDir && (isTreeFiltering.value || !collapsedDirs.value.has(node.path))) {
        result.push(...flattenTree(node.children, depth + 1))
      }
    }
    return result
  }

  const flatTree = computed(() => flattenTree(allTree.value))

  // ============== 文件行内联 diff 展开（P-20261004-25） ==============
  // 文件行 chevron 展开嵌入 DiffViewer（懒加载渲染面在 CommitChangeTree 的
  // CommitInlineDiff，enableHunkStaging=true 点亮 hunk 三键）——分块处置
  // （stage/unstage/discard）的变更面板就近入口；既有「双击开编辑器 Diff 标签」
  // 主路径不动，chevron 是独立点击区。
  // accordion：同面板单文件展开（''=全部收起），键用 path——status 一文件一条
  //（parseXY 对「暂存后又改」MM 只出索引侧单条），path 在树内唯一。展开态挂在
  // 本 composable（面板宿主实例）而非 CommitChangeTree 子组件：changes 页签
  // v-if 卸载子组件，切 stash 往返会重置（折叠态/键盘光标同口径）
  const INLINE_DIFF_HEIGHT = 300
  const expandedDiffPath = ref('')
  function toggleDiffExpand(file: FileStatus): void {
    expandedDiffPath.value = expandedDiffPath.value === file.path ? '' : file.path
  }
  // 展开的文件从 status 消失（提交/回滚/全部 hunk 处置完）即收起——行已不在，
  // 留着键位会让同路径后续新变更意外自动展开
  watch(() => changesStore.files, (list) => {
    if (expandedDiffPath.value && !list.some((f) => f.path === expandedDiffPath.value)) {
      expandedDiffPath.value = ''
    }
  })

  // 变更树虚拟滚动：构建风暴场景下单次 status 可达数千文件，全量渲染会让
  // 每次 300ms 刷新都重建同等量级 DOM（行高随密度档，见 .cp-node 与 ui-density store）
  const densityStore = useUiDensityStore()
  // itemHeight 函数形态实时读密度档（@vueuse v14 不支持响应式 itemHeight——切片
  // 重算由 watch 调 onScroll 补触发；舒适档 26 = 历史 .cp-node 行高，零变化）。
  // P-20261004-25：展开行在行高之上再加内嵌 diff 固定槽高——useVirtualList 的
  // getOffset/getDistance 对函数形态逐行实时求值，切片与 scrollTo 定位自动含
  // 展开槽；函数值变化后由下方 watch 调 onScroll 补重算（密度档同款）
  const { list: visibleNodes, containerProps: treeContainerProps, wrapperProps: treeWrapperProps, scrollTo } =
    useVirtualList(flatTree, {
      itemHeight: (idx: number) => {
        const node = flatTree.value[idx]
        return node?.file && node.path === expandedDiffPath.value
          ? densityStore.rowHeightPx + INLINE_DIFF_HEIGHT
          : densityStore.rowHeightPx
      },
      overscan: 8,
    })
  // store 实例上 ref 已解包，watch 须走 getter 形态（同 FileTreeView）
  watch(() => densityStore.rowHeightPx, () => { treeContainerProps.onScroll() })
  watch(expandedDiffPath, () => { treeContainerProps.onScroll() })

  // ============== 键盘多选（P-20261003-271，文件树 P-20 多选的键盘同构） ==============
  // Shift+↑↓ 自锚点行扩展范围（文件树 Shift+Click 同 anchor 模式：Shift 释放后
  // 锚点保留——不监听 keyup，锚点只在非 Shift 导航/点选时重设），Ctrl+A 全选可见
  // 文件行，Esc 退出。范围集存「路径集合」防虚拟列表重排漂移（文件树同款）；
  // 目录行不参与（批量操作面是文件级，区间收集见 utils/rangeSelection）。
  // 多选 ≥2 且右键落在集合内 → 右键菜单切批量形态（contextOptions）。
  const multiSelectedPaths = ref<Set<string>>(new Set())
  const selectionAnchorIdx = ref(-1)

  function applyRangeSelection(): void {
    multiSelectedPaths.value = collectRangePaths(flatTree.value, selectionAnchorIdx.value, activeIdx.value)
  }

  function clearMultiSelection(): void {
    if (multiSelectedPaths.value.size) multiSelectedPaths.value = new Set()
  }

  // 多选集随 status 刷新对账：外部 git 操作/回滚使行不复存在后，残留路径进批量
  // 菜单只会打出必败调用——消失路径剪除，剪到不足 2 项整体清空（<2 无批量语义）
  watch(() => changesStore.files, (list) => {
    if (multiSelectedPaths.value.size === 0) return
    const alive = new Set(list.map((f) => f.path))
    for (const p of multiSelectedPaths.value) {
      if (!alive.has(p)) multiSelectedPaths.value.delete(p)
    }
    if (multiSelectedPaths.value.size < 2) multiSelectedPaths.value = new Set()
  })

  // ============== 变更列表键盘导航（复刻 NotificationCenter 模式） ==============
  // 列表容器可聚焦（tabindex=0，见模板），↑↓ 在扁平行序列（目录行+文件行=P-33
  // 过滤后的可见项）环绕移动高亮，Enter 激活当前行（文件=选中并打开 diff；目录=
  // 展开/收起，同通知中心组行展开语义），Space 切换当前文件提交勾选（仅 staged
  // 文件——勾选框只对 staged 渲染，未暂存文件上不产生看不见的状态突变），Home/End
  // 首尾。焦点落在输入框/按钮上时让位原生行为（通知中心同款 closest 判定）。
  const activeIdx = ref(0)
  watch(flatTree, (rows) => {
    if (activeIdx.value >= rows.length) activeIdx.value = Math.max(0, rows.length - 1)
  })
  // 过滤词/归属二态/状态 chip/排序模式/活跃组过滤变化=列表整体更换内容，高亮
  // 回落首行（通知中心切页签同款回落——重排后旧光标位号会指到无关行）；锚点是
  // 行位次语义，随光标一并回落，否则下次 Shift 扩展的区间会指到无关行
  watch([changesFilter, agentScopeFilter, statusScopeFilter, sortBySize, clFiltering], () => {
    activeIdx.value = 0
    selectionAnchorIdx.value = 0
  })
  // 高亮行滚入视口：虚拟列表 DOM 只渲染可见窗口，通知中心的 data-nav-idx +
  // scrollIntoView 够不到窗口外行，改用 scrollTo 定位；窗口内不滚（等价
  // scrollIntoView block:nearest 的只补视口外语义），环绕移动不整屏抖动
  function scrollActiveIntoView(): void {
    const rows = visibleNodes.value
    if (rows.length === 0) return
    const first = rows[0]!.index
    const last = rows[rows.length - 1]!.index
    if (activeIdx.value < first) scrollTo(activeIdx.value)
    else if (activeIdx.value > last) scrollTo(activeIdx.value - (last - first))
  }
  watch([activeIdx, flatTree], () => nextTick(scrollActiveIntoView))

  function onFileListKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    // 焦点落在容器内输入框/按钮上时让位原生行为（通知中心同款 closest 判定）
    if (target.closest('input, textarea, button, select, [contenteditable]')) return
    const rows = flatTree.value
    if (rows.length === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (e.shiftKey) {
          // 扩展范围在末尾钳制不环绕：环绕后再取锚点区间会把「向下扩一行」
          // 变成近乎全表（min/max 锚距语义），VS Code 扩展选区同款钳制
          if (activeIdx.value < rows.length - 1) {
            activeIdx.value += 1
            applyRangeSelection()
          }
          break
        }
        activeIdx.value = (activeIdx.value + 1) % rows.length
        selectionAnchorIdx.value = activeIdx.value // 普通导航重设锚点并退出多选
        clearMultiSelection()
        break
      case 'ArrowUp':
        e.preventDefault()
        if (e.shiftKey) {
          if (activeIdx.value > 0) {
            activeIdx.value -= 1
            applyRangeSelection()
          }
          break
        }
        activeIdx.value = (activeIdx.value - 1 + rows.length) % rows.length
        selectionAnchorIdx.value = activeIdx.value
        clearMultiSelection()
        break
      case 'Home':
        e.preventDefault()
        activeIdx.value = 0
        selectionAnchorIdx.value = 0
        clearMultiSelection()
        break
      case 'End':
        e.preventDefault()
        activeIdx.value = rows.length - 1
        selectionAnchorIdx.value = rows.length - 1
        clearMultiSelection()
        break
      case 'a': {
        // Ctrl/Cmd+A 全选可见文件行（文件树 P-20 全选可见层级同款；双修饰约定
        // 见 CLAUDE.md 前端红线），「可见」= 当前展开/过滤视图，所见即所选
        if (!(e.ctrlKey || e.metaKey)) break
        e.preventDefault()
        selectionAnchorIdx.value = activeIdx.value
        multiSelectedPaths.value = collectAllFilePaths(rows)
        break
      }
      case 'Escape':
        // 退出多选（VS Code 选区收缩同键）；光标与锚点原地保留，可再 Shift 扩展
        clearMultiSelection()
        break
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const row = rows[activeIdx.value]
        if (!row) return
        if (row.isDir) { toggleDir(row.path); return }
        if (!row.file) return
        if (e.key === 'Enter') {
          handleFileClick(row.file) // 打 diff 前先落选中态（与鼠标「单击再双击」同终态）
          handleFileDblClick(row.file)
        } else if (row.file.staged) {
          toggleFileSelection(row.file)
        }
        break
      }
    }
  }

  // 选中文件
  const selectedFilePath = ref('')

  function handleFileClick(file: FileStatus) {
    selectedFilePath.value = file.path
    // 鼠标点选同步键盘光标：首次方向键从点中的行继续——本列表有持久选中态
    // （is-selected），两套高亮错位会让下一次 Enter 落在非预期行；普通点击
    // 重设锚点并退出多选（文件树 P-20 同款），与 Shift 扩展模式互斥可预期
    const i = flatTree.value.findIndex(n => !n.isDir && n.path === file.path)
    if (i >= 0) {
      activeIdx.value = i
      selectionAnchorIdx.value = i
    }
    clearMultiSelection()
  }

  function handleFileDblClick(file: FileStatus) {
    // 按暂存态分流 diff 基线（P-20261004-42 盲提交收口，changeDiffBaseline 纯
    // 函数）：已暂存行看 HEAD vs 暂存区（=将提交的形态），未暂存行看暂存区 vs
    // 工作区（=剩余改动），冲突行维持 HEAD 合并 diff——与行内嵌 diff（P-25，
    // GetFileDiff staged 参数）及 hunk 三键基线同语义
    const target = changeDiffBaseline(file)
    onOpenDiff({ path: file.path, name: file.path.split('/').pop() || file.path, oldRef: target.oldRef, newRef: target.newRef })
  }

  // 暂存切换
  async function toggleFileStage(file: FileStatus, e: MouseEvent) {
    e.stopPropagation()
    if (!projectStore.currentProjectId) return
    try {
      if (file.staged) {
        selectedForCommit.value.delete(file.path)
        await changesStore.unstageFiles(projectStore.currentProjectId, [file.path])
      }
      else await changesStore.stageFiles(projectStore.currentProjectId, [file.path])
    } catch { /* 拦截器处理 */ }
  }

  // 右键菜单
  const contextFile = ref<FileStatus | null>(null)
  const contextX = ref(0)
  const contextY = ref(0)
  const showContext = ref(false)

  // ============== 审阅留言批量交给智能体（P-20261006-55 入口②） ==============
  // 变更树文件行右键「把 N 条留言交给智能体」：该文件在 diff 上有未解决留言
  // 时出项（N=条数），把留言清单一次交给一个 agent 会话（「交给智能体」动作
  // 族第五数据源，装箱/发起链在 useDiffCommentAgentFix）。留言锚点 = 文件相对
  // 路径 + 工作区版本行号（useDiffComments 既有口径），与本树 file.path 同域
  // 直接对上。留言状态零触碰——resolved 只由人的复核勾选翻转（安全边界）。
  // 懒加载在此也触发一次（用户可能从未开过 diff 标签就右键变更行；幂等不重复拉）
  const diffComments = useDiffComments()
  void diffComments.ensureLoaded()
  const commentAgentFix = useDiffCommentAgentFix()

  /** 某文件未解决留言（右键菜单 N 计数与发起清单同源，resolved 不入清单） */
  function pendingCommentsFor(path: string): DiffCommentFixItem[] {
    const pid = projectStore.currentProjectId || ''
    if (!pid) return []
    return diffComments.commentsFor(pid, path)
      .filter((c) => !c.resolved)
      .map((c) => ({ path, comment: c }))
  }

  function handleContextMenu(e: MouseEvent, file: FileStatus) {
    e.preventDefault()
    // 右键落在多选集合外（或不足 2 项）：收缩为该行单选（集合清空，动作对象
    // 回到右键行自身）；集合内且 ≥2 保持多选，菜单随之切批量形态——文件树
    // P-20 / VS Code 资源管理器同款交互
    if (!(multiSelectedPaths.value.size >= 2 && multiSelectedPaths.value.has(file.path))) {
      clearMultiSelection()
    }
    contextFile.value = file
    contextX.value = e.clientX
    contextY.value = e.clientY
    showContext.value = true
  }

  // ============== 复制变更摘要（P-20261003-219） ==============
  // 「这次改了 N 个文件 M 行」的概要转述出口：文件清单 + 各文件 +N/-M 行式
  // 贴给 agent/记录。范围 = 当前可见变更集（所见即所复制，P-188 同哲学：
  // 过滤后的摘要就是过滤视图的摘要，头部过滤计数 n/total 已在示界）。
  // 行数按需取数（点击时一次 GET /numstat，不随树渲染预取），失败就地反馈
  // 不产出半真摘要（文件清单本地本有，缺的是行数——补齐后再复制才完整）
  const copyingSummary = ref(false)
  async function copyChangeSummary(): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid || copyingSummary.value || files.value.length === 0) return
    copyingSummary.value = true
    try {
      // silent：取数失败由下方就地反馈，不叠拦截器全局错误 toast
      const res = await diffApi.getNumstat(pid, { silent: true }) as unknown as { data?: NumstatFile[] }
      const text = buildChangeSummary(
        files.value,
        toStatMap(res?.data),
        projectStore.currentProject?.currentBranch || '',
        t,
      )
      if (!text) return
      const ok = await copyText(text)
      if (ok) message.success(t('changes.summary.copied'))
      else message.error(t('common.copyFailed'))
    } catch {
      message.error(t('changes.summary.loadFailed'))
    } finally {
      copyingSummary.value = false
    }
  }

  const contextOptions = computed(() => {
    const f = contextFile.value
    if (!f) return []
    // 批量形态（P-20261003-271）：多选 ≥2 且右键落在集合内——暂存/取消暂存按
    // 意图双列（选择集可混合两种暂存态，服务端 add/restore 对已处目标态的文件
    // 是 no-op 不误伤）；open/locate 等单文件动作与树级摘要不进批量形态
    if (multiSelectedPaths.value.size >= 2 && multiSelectedPaths.value.has(f.path)) {
      const n = multiSelectedPaths.value.size
      return [
        { label: t('commitPanel.ctxBatchStage', { n }), key: 'batch-stage' },
        { label: t('commitPanel.ctxBatchUnstage', { n }), key: 'batch-unstage' },
        { label: t('commitPanel.ctxBatchRollback', { n }), key: 'batch-rollback' },
        { label: t('commitPanel.ctxBatchGitignore', { n }), key: 'batch-gitignore' },
        { label: t('commitPanel.ctxBatchCopyPath', { n }), key: 'batch-copy' },
      ]
    }
    const opts: DropdownOption[] = [
      { label: f.staged ? t('commitPanel.ctxUnstage') : t('commitPanel.ctxStageFile'), key: 'stage' },
      { label: t('commitPanel.ctxRollback'), key: 'rollback' },
      { label: t('commitPanel.ctxGitignore'), key: 'gitignore' },
      { label: t('commitPanel.ctxCopyPath'), key: 'copy' },
      { label: t('changes.tree.copySummary'), key: 'copySummary' },
      { label: t('commitPanel.ctxOpenInEditor'), key: 'open' },
      { label: t('changes.locateInTree'), key: 'locate' },
    ]
    // 审阅留言交给智能体（P-20261006-55 入口②）：该文件有未解决留言才出项
    //（N=条数；纯展示计算走 useDiffComments 模块单例既有响应式面，单文件
    // ≤100 条的线性过滤在右键菜单重算时是微不足道的量级）
    const pending = pendingCommentsFor(f.path)
    if (pending.length > 0) {
      opts.splice(5, 0, { label: t('diff.comment.handAction', { n: pending.length }), key: 'commentsToAgent' })
    }
    // 移入列表（P-20261007-19）：子菜单列出全部可见列表，已含该文件的项禁用
    //（移动语义=换组，同组重移是无反馈 no-op，禁用即如实反馈）；key 用下标
    // 避免列表名含分隔字符时解析歧义
    const clLists = options.changelistLists
    if (clLists && clLists.value.length > 0) {
      opts.splice(2, 0, {
        label: t('changes.changelist.moveTo'),
        key: 'moveToList',
        children: clLists.value.map((l, i) => ({
          label: `${l.name} (${l.files.length})`,
          key: `moveto:${i}`,
          disabled: l.files.includes(f.path),
        })),
      })
    }
    return opts
  })

  // 批量动作执行（P-20261003-271）：先快照路径再动手；状态变更类完成后清空
  // 多选（选择语义已随状态过期，文件树批量同款），复制非破坏保留选择
  async function handleBatchSelect(key: string): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    const paths = [...multiSelectedPaths.value]
    if (paths.length === 0) return
    switch (key) {
      case 'batch-stage':
        try { await changesStore.stageFiles(pid, paths) } catch { /* 拦截器处理 */ }
        clearMultiSelection()
        break
      case 'batch-unstage':
        // 与单文件 unstage 同款：取消暂存的文件从提交勾选集同步过期
        for (const p of paths) selectedForCommit.value.delete(p)
        try { await changesStore.unstageFiles(pid, paths) } catch { /* 拦截器处理 */ }
        clearMultiSelection()
        break
      case 'batch-rollback': {
        // 与单文件回滚同款 confirmDialog 守卫——丢弃不可恢复，误点即丢工作
        const ok = await confirmDialog({
          type: 'warning',
          title: t('changes.rollback.title'),
          content: t('commitPanel.batchRollbackConfirm', { n: paths.length }),
          confirmText: t('changes.rollback.confirmBtn'),
        })
        if (!ok) break
        try {
          await changesStore.rollback(pid, paths)
          message.success(t('commitPanel.batchRolledBack', { n: paths.length }))
        } catch { /* 拦截器处理 */ }
        clearMultiSelection()
        break
      }
      case 'batch-gitignore':
        // 逐个调单路径端点（文件树批量 git exclude 同款惯例），完成后一次刷新
        try {
          for (const p of paths) await gitignoreApi.addRule(pid, p)
          message.success(t('commitPanel.gitignoreAdded'))
          changesStore.fetchStatus(pid)
        } catch { /* 拦截器处理 */ }
        clearMultiSelection()
        break
      case 'batch-copy': {
        // copyText 带 execCommand 降级（非安全上下文下 navigator.clipboard 不可用）
        const ok = await copyText(paths.join('\n'))
        if (ok) message.success(t('commitPanel.pathCopied'))
        else message.error(t('common.copyFailed'))
        break
      }
    }
  }

  async function handleContextSelect(key: string) {
    showContext.value = false
    const f = contextFile.value
    if (!f || !projectStore.currentProjectId) return
    // 移入列表子菜单（P-20261007-19）：key=moveto:<下标>，经面板回调落 API
    if (key.startsWith('moveto:')) {
      const list = options.changelistLists?.value[Number(key.slice(7))]
      if (list) options.onMoveToList?.(f.path, list)
      return
    }
    // 批量形态（P-20261003-271）：动作对象是多选集合而非右键行自身
    if (key.startsWith('batch-')) {
      await handleBatchSelect(key)
      return
    }
    switch (key) {
      case 'stage':
        try {
          if (f.staged) await changesStore.unstageFiles(projectStore.currentProjectId, [f.path])
          else await changesStore.stageFiles(projectStore.currentProjectId, [f.path])
        } catch { /* 拦截器处理 */ }
        break
      case 'rollback': {
        // 回滚直接丢弃未提交修改且不可恢复，误点（与 stage/gitignore 相邻）即丢
        // 工作——与删分支/中止变基同款 confirmDialog 守卫；长路径截尾保文件名
        const displayPath = f.path.length > 60 ? '…' + f.path.slice(-59) : f.path
        const ok = await confirmDialog({
          type: 'warning',
          title: t('changes.rollback.title'),
          content: t('changes.rollback.confirm', { name: displayPath }),
          confirmText: t('changes.rollback.confirmBtn'),
        })
        if (!ok) break
        try {
          await changesStore.rollback(projectStore.currentProjectId, [f.path])
          message.success(t('commitPanel.rolledBack', { path: f.path }))
        } catch { /* 拦截器处理 */ }
        break
      }
      case 'gitignore':
        try {
          await gitignoreApi.addRule(projectStore.currentProjectId, f.path)
          message.success(t('commitPanel.gitignoreAdded'))
          changesStore.fetchStatus(projectStore.currentProjectId)
        } catch { /* 拦截器处理 */ }
        break
      case 'copy': {
        // copyText 带 execCommand 降级（非安全上下文下 navigator.clipboard 不可用）
        const ok = await copyText(f.path)
        if (ok) message.success(t('commitPanel.pathCopied'))
        else message.error(t('common.copyFailed'))
        break
      }
      case 'copySummary':
        // 树级动作（整份可见变更集的摘要），经所在文件行菜单触发
        await copyChangeSummary()
        break
      case 'commentsToAgent':
        // 审阅留言交给智能体（P-20261006-55 入口②）：本行文件未解决留言批量
        // 发起 agent 修复会话（清单与菜单 N 同源 pendingCommentsFor；留言
        // resolved 不动，人复核勾选解除）
        await commentAgentFix.handCommentsToAgent(pendingCommentsFor(f.path))
        break
      case 'open':
        openFileInEditor?.(f.path)
        break
      case 'locate':
        revealInFileTree?.(f.path)
        break
    }
  }

  /** 徽标 tooltip：运行时列表 + 会话数（多会话共目录 >1），并注明归属边界 */
  function agentMarkTip(path: string): string {
    const mark = agentMarks.value.get(path)
    if (!mark) return ''
    const runtime = mark.runtimes.length > 0 ? mark.runtimes.join('/') : t('changes.agentMarks.unknownRuntime')
    return t('changes.agentMarks.tip', { runtime, n: mark.sessions })
  }

  /** 热力条 tooltip：精确行数（梯度条做概览，数字供核对，P-37 悬停明细同哲学） */
  function heatTip(h: ChangeNodeHeat): string {
    return t('changes.heat.tip', { n: h.additions + h.deletions, a: h.additions, d: h.deletions })
  }

  return {
    // reactive 面板：子组件模板经代理读写（赋值/含 ref 的属性访问均解包路由回上方）
    state: reactive({
      activeIdx,
      selectedFilePath,
      selectedForCommit,
      multiSelectedPaths,
      collapsedDirs,
      agentMarks,
      visibleNodes,
      contextX,
      contextY,
      showContext,
      contextOptions,
      agentMarkTip,
      sortBySize,
      toggleSortBySize,
      heatTip,
      expandedDiffPath,
      toggleDiffExpand,
      inlineDiffHeight: INLINE_DIFF_HEIGHT,
      onFileListKeydown,
      toggleDir,
      expandAllDirs,
      collapseAllDirs,
      copyChangeSummary,
      copyingSummary,
      handleFileClick,
      handleFileDblClick,
      handleContextMenu,
      toggleFileStage,
      toggleFileSelection,
      handleContextSelect,
    }),
    // 裸对象：containerProps 持有 useVirtualList 容器 ref，进 reactive 会被深层解包
    // （见文件头注），v-bind 摊平后滚动定位失效
    list: {
      containerProps: treeContainerProps,
      wrapperProps: treeWrapperProps,
    },
  }
}

export type ChangeTreeState = ReturnType<typeof useChangeTree>['state']
export type ChangeTreeList = ReturnType<typeof useChangeTree>['list']
