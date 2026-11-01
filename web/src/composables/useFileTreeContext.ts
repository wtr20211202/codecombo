import { h, ref, computed } from 'vue'
import type { Ref, VNodeChild } from 'vue'
import { projectApi, gitexcludeApi, BATCH_SHARE_MAX_PATHS } from '../api/client'
import { AppError } from '../api/error-types'
import { confirmDialog } from './useDialog'
import { copyText } from '../utils/clipboard'
import { fileDownloadUrl, dirArchiveUrl, filesArchiveUrl, triggerDirectDownload, precheckDownload } from '../utils/directDownload'
import { buildRemoteViewUrl, remotePlatformName, type RemoteViewInfo } from '../utils/remoteViewUrl'
import { fileNameCompatIssue } from '../utils/fileNameCompat'
import { isSensitivePath } from '../utils/sensitiveName'
import { useCompareBaseline } from './useCompareBaseline'
import { confirmSensitiveFiles } from './useShareDialog'
import { useSyncDeliver } from './useSyncDeliver'

/** 汇总确认用的名清单：取前 3 项叶子名 + 截断省略号（「将删除 N 项：a, b, c…」） */
function summarizeNames(paths: string[]): string {
  const names = paths.map(p => p.split('/').pop() || p)
  return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')
}

/** 批量删除单块条目上限 = 服务端 batchEntriesMax（files/batch 护栏 ≤200）：
 *  多选删除链无前端量级护栏（选择集大小即用户意图），超护栏按块串行 */
const FILE_BATCH_CHUNK = 200

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  status?: string
  isIgnored?: boolean
}

/** 目录删除确认的递归规模载荷（GET /file/stat 的 data，服务端 files.DirStat） */
interface DirScale {
  isDir: boolean
  files: number
  dirs: number
  bytes: number
  sizeHuman: string
  truncated?: boolean
}

/** 右键菜单选项（NDropdown options 子集）：普通项（disabled 置灰——粘贴项在
 *  剪贴板为空时保持可见可发现）或分隔线——分隔线不可选中
 *  （handleContextSelect 不会收到 d-* key），key 仅作渲染 diff 标识须唯一 */
type MenuOpt = { label: string; key: string; disabled?: boolean } | { type: 'divider'; key: string }

/** 目录打包 probe 响应（GET /dir-archive?probe=1，拦截器已解包 envelope）：
 *  data=规模预估（entries/bytes/truncated 超护栏预估），warnings=敏感命中，
 *  scanTruncated=扫描条目达上限（可能漏检） */
interface DirArchiveProbe {
  data?: { entries: number; bytes: number; truncated: boolean }
  warnings?: string[]
  scanTruncated?: boolean
}

/**
 * 文件树右键菜单 + 内联新建/重命名输入（自 FileTreeView.vue 抽出）。
 * deps.openInTerminal：转发宿主 open-in-terminal 事件。
 * deps.selectedPaths：宿主持有的多选集合（P-20261002-20）——右键落在集合外时
 * 收缩为该节点单选（VS Code 资源管理器同款），落在集合内且 ≥2 时菜单切批量形态；
 * 批量操作完成后由本组合式函数清空（所有权归宿主，此处只做协同变更，与 expandedDirs 同款）
 */
export function useFileTreeContext(options: {
  projectId: () => string
  expandedDirs: Ref<Set<string>>
  selectedPaths: Ref<Set<string>>
  refreshTargetPath: (dirPath: string) => Promise<void>
  refreshRoot: () => Promise<void>
  openInTerminal: (path: string) => void
  /** 右键「在分屏打开」（P-20261003-321）：上抛宿主走 openInSplitByPath 既有链路
   *  （useOpenFiles.openInSplit：分屏组自动开+激活；已分屏直进分屏组）——分屏链路
   *  在宿主 openfiles 域，树内不可直达（compareWith 同款「菜单只转发」分工）；
   *  载荷与 tab 右键同形（路径字符串，EditorGroupPane.openInSplit 同款） */
  openInSplit: (path: string) => void
  /** 生成分享短链（path 为空串 = 项目根）；isDir 供创建弹层判定单文件 HTML
   *  的外部资源提示（P-20261020-4，文件树是唯一入口，目录/文件语义在此带出） */
  share: (path: string, isDir: boolean) => void
  /** 批量分享选中（P-20261008-1）：多选集合 → 一条冻结快照单链（跨目录
   *  评审包）。宿主负责打开创建弹层与 API 链路；paths 已排序去重 */
  shareSelected: (paths: string[]) => void
  /** 上传文件到指定目录（path 为空串 = 项目根）；宿主负责打开文件选择器 */
  upload: (dirPath: string) => void
  /** 项目根的本地绝对路径（无项目/未知时为空串，绝对路径复制回退为相对） */
  projectRoot: () => string
  /** 文件相对路径 → 平台查看目标（remote+当前分支拼 blob 页）；无 remote 等返回 null */
  remoteView: (filePath: string) => RemoteViewInfo | null
  /** 右键「与基准对比」（P-20261002-75）：上抛宿主读两文件开 diff（openDiffView
   *  在 useOpenFiles，树内不可直达）；基准态在 useCompareBaseline 模块单例 */
  compareWith: (target: { path: string; name: string }) => void
  /** 右键「本地历史」（P-20261002-130）：上抛宿主开本地历史弹窗（弹窗自含
   *  版本列表 + diff + 恢复，宿主只供给路径与装配点） */
  localHistory: (target: { path: string; name: string }) => void
  /** 右键「改动来源」（P-20261005-170）：上抛宿主开归因账弹窗（该路径最近
   *  改动的事件账：时间/来源/会话/命令摘要，弹窗自含查询，宿主只供路径） */
  fsAttribution: (target: { path: string; name: string }) => void
  /** 右键「在此目录新建 agent 会话」（P-20261003-55）：上抛宿主走
   *  useEditorAskAgent 既有发起链路；relDir 为项目相对目录路径（目录项=自身、
   *  文件项=父目录、空串=项目根），会话 cwd=该目录——发起/提示/打开 docked
   *  全在宿主链路，本组合式只做菜单项与转发（ask-agent 族复用勿改） */
  askAgentInDir: (relDir: string) => void
  /** 目录钉选/取消钉选（P-20261002-97）：钉选表与持久化归宿主（FileTreeView），
   *  此处只负责菜单项与转发；isPinned 决定菜单显示「钉选到顶部」还是「取消钉选」 */
  togglePin: (dirPath: string) => void
  isPinned: (dirPath: string) => boolean
  /** 右键「在此目录搜索」（P-20261003-118）：上抛宿主打开全工程搜索并预填目录
   *  glob（dir/**，查询词留空用户输）；glob 合成与元字符转义收口 utils/dirGlob，
   *  打开链在 useLayoutViews.searchInDir（本组合式只做菜单项与转发） */
  searchInDir: (relDir: string) => void
  /** 右键批量「移动到…」（P-20261003-160）：上抛宿主打开目录选择弹层；
   *  paths 为多选集合快照，弹层与批量移动执行链都在宿主（与拖拽共用 moveEntries） */
  moveTo: (paths: string[]) => void
  /** 右键批量「批量重命名」（P-20261003-283）：上抛宿主打开查找/替换弹层；
   *  paths 为多选集合快照，弹层（BatchRenameDialog）与执行链（useBatchRename）
   *  都在宿主——与 moveTo 同款「菜单只交快照」分工 */
  batchRename: (paths: string[]) => void
  /** 树内复制/剪切/粘贴（P-20261023-2③a）：内部剪贴板与 batch copy/move 执行
   *  链都在宿主（useFileTreeInternalClipboard + useFileTreeDragDrop），此处只做
   *  菜单项与转发。copy/cut 收多选集合快照；canPaste 决定粘贴项可用态（空板
   *  置灰保持可发现）；pasteInto 收目标目录（目录项=自身，根区=项目根） */
  copyEntries: (paths: string[]) => void
  cutEntries: (paths: string[]) => void
  pasteInto: (dirPath: string) => void
  canPaste: () => boolean
  /** rename 成功的反馈口（P-20261005-157，可选）：宿主提供时代替默认成功 toast
   *  （代码类文件带「更新引用？」动作的宿主在 useRenameRefUpdate，未提供的
   *  调用方保持既有 plain toast 语义不变） */
  renameFeedback?: (oldPath: string, newPath: string) => void
  /** 打开回收站浮层（P-20261005-163，可选）：敏感删除入站 toast 的动作直达——
   *  showTrash 状态在宿主，此处只转发（openInSplit/moveTo 同款「菜单只转发」
   *  分工）；未提供的调用方敏感 toast 动作空转（不炸） */
  openTrash?: () => void
  /** 动作 toast 所需的 success 重载子集：render 函数内容 + 驻留选项 + 可销毁
   *  句柄（useRenameRefUpdate.renamedFeedback 同款动作 toast 惯例；宿主传入的
   *  naive MessageApi 结构性满足本窄类型，泛化签名不引入对 naive 的类型依赖） */
  message: {
    success(m: string | (() => VNodeChild), opts?: { duration?: number; keepAliveOnHover?: boolean; closable?: boolean }): { destroy(): void }
    error(m: string): void
    warning(m: string): void
    info(m: string): void
  }
  t: (k: string, p?: Record<string, unknown>) => string
}) {
  const { projectId, expandedDirs, selectedPaths, refreshTargetPath, refreshRoot, openInTerminal, openInSplit, share, shareSelected, upload, projectRoot, remoteView, compareWith, localHistory, askAgentInDir, togglePin, isPinned, searchInDir, moveTo, batchRename, copyEntries, cutEntries, pasteInto, canPaste, renameFeedback, openTrash, fsAttribution, message, t } = options
  const { baseline: compareBase, setCompareBaseline, clearCompareBaseline } = useCompareBaseline()
  // 同步到其他实例（P-20261023-1 方案④）：轻投递对话框（自含 naive provider
  // 依赖 useDialog/useMessage——本组合式在组件 setup 期调用，上下文可用）
  const { openSyncDeliver } = useSyncDeliver()

  // 右键菜单状态
  const contextEntry = ref<FileEntry | null>(null)
  const contextX = ref(0)
  const contextY = ref(0)
  const showContext = ref(false)

  // 内联输入状态
  const inlineInput = ref<{ type: 'file' | 'dir' | 'rename'; parentPath: string; oldPath?: string } | null>(null)
  const inlineValue = ref('')
  // 行内错误红提示（P-20261002-117）：重命名目标已存在时输入框保持打开、
  // 下方红字提示就地改名（VS Code 资源管理器同款）；新建/其他失败不走此通道
  const inlineError = ref('')
  // 文件名跨平台兼容性即时红提示（P-20261002-132）：新建/重命名输入期间就地
  // 校验 Windows 保留设备名与段结尾点/空格（P-117 同款红提示通道）；命中时
  // 确认入口短路不发请求（服务端同口径 400 兜底直达 API 的调用方）
  const inlineCompatError = computed(() => {
    if (!inlineInput.value) return ''
    const val = inlineValue.value.trim()
    if (!val) return ''
    const issue = fileNameCompatIssue(val)
    if (issue === 'reservedWindowsName') return t('fileTree.nameReservedWindows', { name: val })
    if (issue === 'trailingDotSpace') return t('fileTree.nameTrailingDotSpace')
    return ''
  })

  function handleContextMenu(e: MouseEvent, entry: FileEntry) {
    e.preventDefault()
    contextEntry.value = entry
    // 右键落在多选集合外：收缩为该节点单选（VS Code 资源管理器同款）；
    // 落在集合内且 ≥2 时保持多选，菜单切批量形态（contextOptions 按此分支）
    if (!selectedPaths.value.has(entry.path)) {
      selectedPaths.value.clear()
      selectedPaths.value.add(entry.path)
    }
    contextX.value = e.clientX
    contextY.value = e.clientY
    showContext.value = true
  }

  function handleBackgroundContext(e: MouseEvent) {
    e.preventDefault()
    contextEntry.value = null
    contextX.value = e.clientX
    contextY.value = e.clientY
    showContext.value = true
  }

  const contextOptions = computed<MenuOpt[]>(() => {
    const entry = contextEntry.value
    if (!entry) {
      // 手动刷新兜底（P-20261002-124）：树不订阅 file.changed（仅 agent marks 消费），
      // watch 漏网/外部同步后给确定性重取入口；refreshRoot 保留目录展开状态。
      // 分隔线隔开「改内容」（新建/上传/分享）与「看视图」（刷新）两组动作。
      // 粘贴（P-20261023-2③a）：空板置灰保持可见（能力可发现），有板落项目根
      const rootOpts: MenuOpt[] = [
        { label: t('fileTree.newFile'), key: 'new-file-root' },
        { label: t('fileTree.newDir'), key: 'new-dir-root' },
        { label: t('fileTree.upload'), key: 'upload-root' },
        { label: t('fileTree.paste'), key: 'paste-root', disabled: !canPaste() },
        { label: t('fileTree.share'), key: 'share-root' },
      ]
      rootOpts.push({ type: 'divider', key: 'd-refresh' })
      rootOpts.push({ label: t('fileTree.refresh'), key: 'refresh-root' })
      return rootOpts
    }
    // 多选 ≥2 且右键落在集合内：批量形态。「下载选中」（P-20261003-250，本地
    // 多路径归档端点 files-archive 已具备）列首位——只读安全动作高频，其后为
    // 复制/剪切/移动/重命名/删除/exclude。不做语义分组（分隔线收益覆盖不了菜单变高的成本）
    if (selectedPaths.value.size >= 2 && selectedPaths.value.has(entry.path)) {
      return [
        { label: t('fileTree.batch.download', { n: selectedPaths.value.size }), key: 'batch-download' },
        // 分享选中（P-20261008-1）：多选集合 → 一条冻结快照单链（跨目录评审包）
        { label: t('fileTree.batch.share', { n: selectedPaths.value.size }), key: 'batch-share' },
        // 树内复制/剪切（P-20261023-2③a）：文件+文件夹混合多选整组入内部剪贴板
        { label: t('fileTree.batch.copy', { n: selectedPaths.value.size }), key: 'batch-copy' },
        { label: t('fileTree.batch.cut', { n: selectedPaths.value.size }), key: 'batch-cut' },
        { label: t('fileTree.batch.move', { n: selectedPaths.value.size }), key: 'batch-move' },
        { label: t('fileTree.batch.rename', { n: selectedPaths.value.size }), key: 'batch-rename' },
        { label: t('fileTree.batch.delete', { n: selectedPaths.value.size }), key: 'batch-delete' },
        { label: t('fileTree.batch.gitexclude', { n: selectedPaths.value.size }), key: 'batch-gitexclude' },
      ]
    }
    // 单项菜单按语义分组（P-20261003-210）：项数已多到无分组难扫读——
    // 四组「文件操作 / agent 与终端 / git 操作 / 分享导出」组间落分隔线，
    // 组内按使用频率排（新建/重命名在前，平台查看/本地历史类低频靠后）；
    // 破坏性「删除」殿后自成一组，与常规动作隔断防误触（VS Code 资源管理器
    // 同款位次）。四组当前恒非空（都有目录/文件共用的兜底项），空组跳线
    // 是对未来条目演化的防御；分隔线被 NDropdown treemate 标记 ignored，
    // 键盘导航跳过、select 不触发，handleContextSelect 无需感知
    const fileOps: MenuOpt[] = []
    const agentTerm: MenuOpt[] = []
    const gitOps: MenuOpt[] = []
    const shareExport: MenuOpt[] = []
    if (entry.isDir) {
      fileOps.push(
        { label: t('fileTree.newFile'), key: 'new-file' },
        { label: t('fileTree.newDir'), key: 'new-dir' },
        { label: t('fileTree.upload'), key: 'upload' },
        // 粘贴（P-20261023-2③a）：目标=本目录；空板置灰保持可发现
        { label: t('fileTree.paste'), key: 'paste', disabled: !canPaste() },
        { label: t('fileTree.rename'), key: 'rename' },
        { label: t('fileTree.copyMenu'), key: 'clip-copy' },
        { label: t('fileTree.cutMenu'), key: 'clip-cut' },
        { label: t('fileTree.duplicate'), key: 'duplicate' },
        // 常用目录钉选（P-20261002-97）：已钉选再点 = 取消（toggle 语义）
        { label: isPinned(entry.path) ? t('fileTree.pinned.unpin') : t('fileTree.pinned.pin'), key: 'pin-dir' },
      )
      agentTerm.push(
        { label: t('fileTree.openInTerminal'), key: 'open-terminal' },
        // 在此目录搜索（P-20261003-118）：与 open-terminal 同为「以该目录为
        // 范围」的入口，语义相邻；仅目录项（提案范围=目录，文件项的父目录
        // 语义易误触不提供）
        { label: t('fileTree.searchInDir'), key: 'search-in-dir' },
      )
    } else {
      fileOps.push(
        // 在分屏打开（P-20261003-321，仅文件项）：对照阅读起点常在文件树，免
        // 「先单击打开再 tab 右键」两步；走 openInSplit 既有链路。打开类动作
        // 使用频率最高，列文件组首位（VS Code 资源管理器「Open to the Side」同位次）
        { label: t('fileTree.openInSplit'), key: 'open-split' },
        { label: t('fileTree.rename'), key: 'rename' },
        { label: t('fileTree.copyMenu'), key: 'clip-copy' },
        { label: t('fileTree.cutMenu'), key: 'clip-cut' },
        { label: t('fileTree.duplicate'), key: 'duplicate' },
      )
      // 两文件互比（P-20261002-75，VS Code Select for Compare 同款三态）：
      // 无基准/基准是他文件 → 选基准（已有基准时再选即替换）；基准即本文件 →
      // 取消；有基准且异文件 → 与基准对比 + 选基准（换基准）双入口。
      // 跨项目残留基准按无基准处理（useCompareBaseline 消费侧同口径守卫）
      const base = compareBase.value
      const baseActive = !!base && base.projectId === projectId()
      if (baseActive && base!.path === entry.path) {
        gitOps.push({ label: t('compare.pick.cancel'), key: 'compare-clear' })
      } else if (baseActive) {
        gitOps.push(
          { label: t('compare.pick.withBase'), key: 'compare-run' },
          { label: t('compare.pick.select'), key: 'compare-select' },
        )
      } else {
        gitOps.push({ label: t('compare.pick.select'), key: 'compare-select' })
      }
    }
    // 在此目录新建 agent 会话（P-20261003-55）：目录项=自身、文件项=父目录，
    // 与终端/目录搜索同组（open-terminal 是目录专属 shell 入口，本项是 agent
    // 会话入口，语义相邻不合并）
    agentTerm.push({ label: t('agentTerminal.dirAsk.menu'), key: 'dir-agent' })
    gitOps.push({ label: t('fileTree.addToGitexclude'), key: 'gitexclude' })
    shareExport.push(
      { label: t('fileTree.share'), key: 'share' },
      // 同步到其他实例（P-20261023-1 方案④）：非项目内容轻投递（选对端+目标
      // 路径纯落位不注册项目）——交付脚本/配置样例跨实例分发
      { label: t('fileTree.syncTo'), key: 'sync-to' },
      // 目录打包下载（P-20261002-115）：与远程主机面板「下载（打包 zip）」
      // 对齐的取件入口，归分享导出组（内容带出同族）；文件节点不适用
      // （已有单文件 download）
      { label: entry.isDir ? t('fileTree.downloadZip') : t('fileTree.download'), key: entry.isDir ? 'download-zip' : 'download' },
      // 在系统中显示（P-20261003-323）：目录/文件共用一项，宿主文件管理器
      // 定位目标——与 copy-abs 语义相邻（拿绝对路径 / 去宿主看）
      { label: t('files.revealInSystem'), key: 'reveal' },
      { label: t('fileTree.copyPath'), key: 'copy' },
      { label: t('fileTree.copyAbsPath'), key: 'copy-abs' },
    )
    if (!entry.isDir) {
      // 本地文件历史（P-20261002-130）：写路径快照的查看/恢复入口（仅文件），
      // 归 git 组（历史/对比同族）；改动来源（P-20261005-170）：该路径最近
      // 改动的事件账（谁/哪条命令改的），归因查询与历史同族相邻；
      // 平台查看：仅文件且项目有可解析 remote 时出现（与编辑器工具条同一 util）
      gitOps.push({ label: t('files.history.menu'), key: 'local-history' })
      gitOps.push({ label: t('files.attribution.menu'), key: 'fs-attribution' })
      const view = remoteView(entry.path)
      if (view) {
        gitOps.push({
          label: t('fileTree.viewOnPlatform', { platform: remotePlatformName(view.platform, t('editor.remoteViewGeneric')) }),
          key: 'view-remote',
        })
      }
    }
    // 组装：分隔线只落在两组之间（组间收口一处，空组自动跳过）；
    // fileOps 恒非空（两分支都有 rename/duplicate），作首个分组起点
    const opts: MenuOpt[] = [...fileOps]
    const appendGroup = (key: string, group: MenuOpt[]) => {
      if (!group.length) return
      if (opts.length) opts.push({ type: 'divider', key })
      opts.push(...group)
    }
    appendGroup('d-agent', agentTerm)
    appendGroup('d-git', gitOps)
    appendGroup('d-share', shareExport)
    appendGroup('d-delete', [{ label: t('fileTree.delete'), key: 'delete' }])
    return opts
  })

  async function handleContextSelect(key: string) {
    showContext.value = false
    const entry = contextEntry.value

    switch (key) {
      case 'new-file':
      case 'new-file-root': {
        const parentPath = entry?.isDir ? entry.path : ''
        inlineInput.value = { type: 'file', parentPath }
        inlineValue.value = ''
        break
      }
      case 'new-dir':
      case 'new-dir-root': {
        const parentPath = entry?.isDir ? entry.path : ''
        inlineInput.value = { type: 'dir', parentPath }
        inlineValue.value = ''
        break
      }
      case 'open-split':
        // 在分屏打开（P-20261003-321）：转发宿主 openInSplitByPath 既有链路
        // （useOpenFiles.openInSplit：分屏组自动开+激活，已分屏直进分屏组）
        if (entry && !entry.isDir) openInSplit(entry.path)
        break
      case 'open-terminal':
        if (entry?.isDir) openInTerminal(entry.path)
        break
      case 'search-in-dir':
        // 在此目录搜索（P-20261003-118）：宿主经 useQuickNav 统一入口开搜索
        // 面板，glob 预填 dir/**（合成转义在 utils/dirGlob）
        if (entry?.isDir) searchInDir(entry.path)
        break
      case 'pin-dir':
        // 钉选/取消钉选都转发宿主（钉选表归属 FileTreeView，含持久化与上限淘汰）
        if (entry?.isDir) togglePin(entry.path)
        break
      case 'dir-agent':
        // 在此目录新建 agent 会话（P-20261003-55）：目录项取自身、文件项取父
        // 目录（项目根文件的父目录为空串 = 项目根会话）；发起链路在宿主
        if (entry && projectId()) {
          askAgentInDir(entry.isDir ? entry.path : entry.path.split('/').slice(0, -1).join('/'))
        }
        break
      case 'compare-select':
        // 选为对比基准：反馈即状态栏「对比基准：x（点击取消）」，不另弹 toast
        if (entry && !entry.isDir) setCompareBaseline({ projectId: projectId(), path: entry.path, name: entry.name })
        break
      case 'compare-clear':
        clearCompareBaseline()
        break
      case 'compare-run':
        // 与基准对比：读两侧内容 + 开 diff + 清基准在宿主链路（useLayoutViews）
        if (entry && !entry.isDir) compareWith({ path: entry.path, name: entry.name })
        break
      case 'share':
        // 任意文件/目录生成短链（幂等：同一目标恒同一短链）
        share(entry?.path || '', entry?.isDir ?? false)
        break
      case 'view-remote': {
        // 在平台上查看：新标签打开 blob 页（noopener 守外链红线；目标不可达时
        // 平台侧 404 属预期——未 push 的分支/文件没有远端内容）
        if (!entry || entry.isDir) break
        const view = remoteView(entry.path)
        if (view) window.open(view.url, '_blank', 'noopener')
        break
      }
      case 'share-root':
        // 背景右键 = 分享整个项目根
        share('', true)
        break
      case 'sync-to': {
        // 同步到其他实例（P-20261023-1 方案④）：轻投递对话框（选对端+目标
        // 路径纯落位）；无项目上下文不出入口（projectId 缺席静默）
        if (!entry || !projectId()) break
        openSyncDeliver(projectId(), entry.path, entry.name, !!entry.isDir)
        break
      }
      case 'upload':
        // 上传到该目录
        if (entry?.isDir) upload(entry.path)
        break
      case 'paste':
        // 粘贴到该目录（P-20261023-2③a）：执行链在宿主（内部剪贴板 → batch
        // copy/move），此处只转发目标
        if (entry?.isDir) pasteInto(entry.path)
        break
      case 'paste-root':
        // 背景右键 = 粘贴到项目根
        pasteInto('')
        break
      case 'clip-copy':
        // 树内复制（P-20261023-2③a）：多选集合快照入内部剪贴板（单项菜单时
        // 集合已收缩为该节点，同一快照通道）
        copyEntries([...selectedPaths.value])
        break
      case 'clip-cut':
        cutEntries([...selectedPaths.value])
        break
      case 'download-zip':
        // 目录打包下载（P-20261002-115）：probe 警示 + 直链取包全链路在下方
        await downloadDirZip(entry)
        break
      case 'upload-root':
        // 背景右键 = 上传到项目根
        upload('')
        break
      case 'refresh-root':
        // 背景右键 = 手动刷新整棵树（宿主 refreshRoot：先记展开集、重载后逐级恢复）
        await refreshRoot()
        break
      case 'duplicate': {
        // 创建副本（P-20261004-135）：服务端端点一次调用收口（旧前端 readFile→
        // writeFile 编排固定 _copy 后缀二次复制即静默覆盖，且目录/二进制不可用）；
        // 命名自增（-copyN 首个不冲突）在服务端，响应 path 是新路径唯一权威——
        // 前端不自行拼名，据它刷新树并把多选集收缩为新文件（VS Code 资源管理器
        // 同款「副本落位即选中」，用户接着 rename/拖拽不用重新点选）
        if (!entry || !projectId()) break
        try {
          const res: any = await projectApi.duplicateFile(projectId(), entry.path)
          const newPath = typeof res?.path === 'string' ? res.path : ''
          const newName = (newPath || entry.path).split('/').pop() || entry.name
          message.success(t('fileTree.duplicated', { name: newName }))
          if (newPath) {
            selectedPaths.value.clear()
            selectedPaths.value.add(newPath)
          }
          await refreshTargetPath(entry.path.split('/').slice(0, -1).join('/'))
        } catch { /* 拦截器处理 */ }
        break
      }
      case 'gitexclude':
        if (!entry || !projectId()) break
        try {
          await gitexcludeApi.addRule(projectId(), entry.path)
          message.success(t('fileTree.addedToExclude', { path: entry.path }))
          await refreshTargetPath(entry.isDir ? entry.path : entry.path.split('/').slice(0, -1).join('/'))
        } catch { /* 拦截器处理 */ }
        break
      case 'rename':
        if (!entry) break
        startRename(entry)
        break
      case 'delete':
        if (!entry) break
        await startDelete(entry)
        break
      case 'batch-download': {
        // 下载选中（P-20261003-250）：嵌套选中随父目录去重（moveEntries 同款
        // 前缀规则，服务端同规则兜底）后整组打包；probe 警示 + 取包链路在
        // downloadSelectionZip。非破坏动作，多选集合保留（与删除/exclude 清空
        // 不同——下载后条目仍在，用户可能接着移动/分享同一批）
        const all = [...selectedPaths.value].sort()
        const deduped = all.filter(p => !all.some(q => p.startsWith(q + '/')))
        if (deduped.length) await downloadSelectionZip(deduped)
        break
      }
      case 'batch-share': {
        // 分享选中（P-20261008-1）：跨目录集合 → 一条冻结快照单链。嵌套选中
        // 随父目录去重（与下载选中同规则，服务端兜底）——评审包里同一内容
        // 不重复出现；非破坏动作，多选集合保留
        const all = [...selectedPaths.value].sort()
        const deduped = all.filter(p => !all.some(q => p.startsWith(q + '/')))
        // 服务端单批上限 50（shareapi.maxBatchSharePaths）：就地拦下并提示
        // 分批，比提交后 400 更可行动（选择集是用户刚做的动作，仍在眼前）
        if (deduped.length > BATCH_SHARE_MAX_PATHS) {
          message.warning(t('fileTree.batch.shareTooMany', { n: BATCH_SHARE_MAX_PATHS }))
          break
        }
        if (deduped.length) shareSelected(deduped)
        break
      }
      case 'batch-move':
        // 移动到…（P-20261003-160）：转发宿主开目录选择弹层（选择与执行链在宿主，
        // 与多选拖拽共用 moveEntries）；此处只交出集合快照
        moveTo([...selectedPaths.value])
        break
      case 'batch-copy':
        // 树内复制（P-20261023-2③a）：集合快照入内部剪贴板，执行链在宿主
        copyEntries([...selectedPaths.value])
        break
      case 'batch-cut':
        cutEntries([...selectedPaths.value])
        break
      case 'batch-rename':
        // 批量重命名（P-20261003-283）：转发宿主开查找/替换弹层（预览与执行链
        // 在宿主，BatchRenameDialog + useBatchRename）；此处只交出集合快照
        batchRename([...selectedPaths.value])
        break
      case 'batch-delete': {
        // 破坏性聚合红线：汇总确认——总数 + 前几项名（确认后批量端点单请求
        // 收口 P-20261006-39，此前逐个调单路径删除 = N 次串行往返）
        const paths = [...selectedPaths.value]
        if (!paths.length || !projectId()) break
        if (!await confirmDialog({
          type: 'warning',
          title: t('fileTree.batch.delete', { n: paths.length }),
          content: t('fileTree.batch.confirmDelete', { n: paths.length, items: summarizeNames(paths) }),
        })) break
        let delFailed = 0
        // 服务端护栏单批 ≤200：>200 的多选按块串行，各块独立成败（请求级失败
        // 块内条目整体计入失败，如实报告不静默吞批；silent——汇总反馈由下方
        // success/error toast 一次给出）
        for (let i = 0; i < paths.length; i += FILE_BATCH_CHUNK) {
          const chunk = paths.slice(i, i + FILE_BATCH_CHUNK)
          try {
            const res: any = await projectApi.batchFiles(
              projectId(),
              { action: 'delete', entries: chunk },
              { silent: true },
            )
            for (const r of (res?.results || []) as Array<{ status: string }>) {
              if (r.status !== 'ok') delFailed++
            }
          } catch {
            delFailed += chunk.length
          }
        }
        selectedPaths.value.clear()
        if (delFailed === 0) message.success(t('fileTree.batch.deleted', { n: paths.length }))
        else message.error(t('fileTree.batch.partialFailed', { failed: delFailed, n: paths.length }))
        // 命中的父目录不定（跨层级多选）：整树刷新（保留展开状态）
        await refreshRoot()
        break
      }
      case 'batch-gitexclude': {
        // 一次确认覆盖整批（非逐项弹窗）；addRule 为单规则端点，循环保留既有单路径语义
        const paths = [...selectedPaths.value]
        if (!paths.length || !projectId()) break
        if (!await confirmDialog({
          title: t('fileTree.batch.gitexclude', { n: paths.length }),
          content: t('fileTree.batch.confirmGitexclude', { n: paths.length, items: summarizeNames(paths) }),
        })) break
        let exFailed = 0
        for (const p of paths) {
          try { await gitexcludeApi.addRule(projectId(), p) } catch { exFailed++ }
        }
        selectedPaths.value.clear()
        if (exFailed === 0) message.success(t('fileTree.batch.addedToExclude', { n: paths.length }))
        else message.error(t('fileTree.batch.partialFailed', { failed: exFailed, n: paths.length }))
        await refreshRoot()
        break
      }
      case 'download': {
        // 直链下载（P-20261030-2）：服务端本就带 Content-Disposition 附件头
        // （files/download.go），直链把传输交还浏览器——下载条原生进度、流式
        // 落盘。旧 blob 版整包读进内存才弹保存（1GB 级文件全程零反馈 + 内存
        // 峰值等于文件大小），已删。鉴权同源原生 GET 自动携带锁 cookie 载体
        //（utils/directDownload 头注有服务端核验结论）。
        // 失败反馈：直链失败浏览器只在下载条显示错误，确定性失败（文件被删/
        // 越界/锁定）用 1 字节 Range 预检提前拦下就地 toast（blob 版 catch 的
        // 拦截器 toast 语义由此补位）
        if (!entry || entry.isDir || !projectId()) break
        const url = fileDownloadUrl(projectId(), entry.path)
        const bad = await precheckDownload(url)
        if (bad !== null) {
          message.error(bad === 404
            ? t('errors.known.fileNotFound')
            : bad === 403 ? t('errors.known.invalidPath')
              : t('fileTree.downloadFailed'))
          break
        }
        triggerDirectDownload(url, entry.name)
        break
      }
      case 'local-history':
        // 本地文件历史弹窗：宿主装配（文件树/编辑器同弹窗实例）
        if (entry && !entry.isDir) localHistory({ path: entry.path, name: entry.name })
        break
      case 'fs-attribution':
        // 改动来源弹窗（P-20261005-170）：宿主装配（文件树/编辑器同弹窗实例）
        if (entry && !entry.isDir) fsAttribution({ path: entry.path, name: entry.name })
        break
      case 'reveal': {
        // 在系统中显示（P-20261003-323）：服务端按平台 exec 宿主文件管理器定位
        // 目标。成功反馈 = 宿主窗口本身（不叠加 toast）；headless 501 补一条
        // 「为什么没有窗口」的可行动说明，其余失败走拦截器
        if (!entry || !projectId()) break
        try {
          await projectApi.revealInSystem(projectId(), entry.path)
        } catch (err) {
          if (err instanceof AppError && err.status === 501) message.info(t('files.reveal.headless'))
        }
        break
      }
      case 'copy': {
        if (!entry) break
        // copyText 带 execCommand 降级（非安全上下文下 navigator.clipboard 不可用）
        const ok = await copyText(entry.path)
        if (ok) message.success(t('fileTree.pathCopied'))
        else message.error(t('common.copyFailed'))
        break
      }
      case 'copy-abs': {
        // 绝对路径 = 项目根 + 相对路径；Windows 风格根（含 \）输出原生反斜杠
        if (!entry) break
        const root = projectRoot().replace(/[\\/]+$/, '')
        if (!root) break
        const rel = entry.path
        const sep = root.includes('\\') ? '\\' : '/'
        const abs = rel ? root + sep + rel.replace(/\//g, sep) : root
        const okAbs = await copyText(abs)
        if (okAbs) message.success(t('fileTree.absPathCopied'))
        else message.error(t('common.copyFailed'))
        break
      }
    }
  }

  async function confirmInlineInput() {
    if (!inlineInput.value || !inlineValue.value.trim() || !projectId()) return
    const input = inlineInput.value
    const val = inlineValue.value.trim()
    // 兼容性命中：红提示已就地展示（即时计算），确认短路不发请求，输入行保持打开
    if (inlineCompatError.value) return
    inlineError.value = ''

    try {
      let targetPath = ''
      if (input.type === 'file') {
        const fullPath = input.parentPath ? `${input.parentPath}/${val}` : val
        await projectApi.createFile(projectId(), fullPath)
        message.success(t('fileTree.fileCreated', { name: val }))
        targetPath = input.parentPath
      } else if (input.type === 'dir') {
        const fullPath = input.parentPath ? `${input.parentPath}/${val}` : val
        await projectApi.createDir(projectId(), fullPath)
        message.success(t('fileTree.dirCreated', { name: val }))
        targetPath = input.parentPath
      } else if (input.type === 'rename' && input.oldPath) {
        const parts = input.oldPath.split('/')
        parts[parts.length - 1] = val
        const newPath = parts.join('/')
        // silent：409 目标已存在是预期分支，行内红提示就地反馈，不让拦截器
        // 再叠一条 toast（同 writeFile 冲突检测模式）；Console 照常留痕
        await projectApi.renameFile(projectId(), input.oldPath, newPath, { silent: true })
        // 成功反馈走宿主反馈口（P-20261005-157：代码类文件 toast 带「更新引用？」
        // 动作）；未提供时保持既有 plain toast
        if (renameFeedback) renameFeedback(input.oldPath, newPath)
        else message.success(t('fileTree.renamedTo', { name: val }))
        targetPath = input.oldPath.split('/').slice(0, -1).join('/')
      }
      inlineInput.value = null
      inlineValue.value = ''
      if (targetPath && expandedDirs.value.has(targetPath)) {
        await refreshTargetPath(targetPath)
      } else {
        await refreshRoot()
      }
    } catch (err) {
      // 重命名 409（目标已存在）：输入行保持打开 + 红提示，其余失败保持既有
      // 拦截器处理（此处 silent 已免 toast，非 409 失败补一次同链路提示）
      if (input.type === 'rename') {
        if (err instanceof AppError && err.status === 409) {
          inlineError.value = t('fileTree.renameExists', { name: val })
          return
        }
        if (err instanceof AppError && err.userMessage) message.error(err.userMessage)
      }
    }
  }

  function cancelInlineInput() {
    inlineInput.value = null
    inlineValue.value = ''
    inlineError.value = ''
  }

  // 内联创建的编程式入口（「新建文件」按钮直达：免右键两步）
  function startInlineCreate(type: 'file' | 'dir', parentPath = '') {
    inlineInput.value = { type, parentPath }
    inlineValue.value = ''
    inlineError.value = ''
  }

  // 行内重命名的编程式入口：右键菜单与树内 F2 快捷键共用（预填旧名）
  function startRename(entry: FileEntry) {
    inlineInput.value = { type: 'rename', parentPath: '', oldPath: entry.path }
    inlineValue.value = entry.name
    inlineError.value = ''
  }

  // ============== 目录「下载为 zip」（P-20261002-115） ==============
  // 服务端流式打包（不落盘、不整读进内存），与远程主机面板归档端点同语义。
  // probe 先行取敏感扫描 + 规模预估：命中走「确认后 override 二次请求」
  // （P-26 分享同款出域防线，确认框复用 confirmSensitiveFiles）；取包经同源
  // 直链（P-20261030-2）交浏览器下载条原生承接——1GB 级目录包不再整包进
  // 内存。触顶截断借 probe 预估如实提示——响应头先于流发出，截断标记无法
  // 事后回传，probe 预估是唯一的通知通道（remotehost_zip 同限，此处补齐
  // 前端提示面）
  const dirArchiveKeys = {
    title: 'fileTree.dirArchive.warningTitle',
    intro: 'fileTree.dirArchive.warningIntro',
    more: 'fileTree.dirArchive.moreFiles',
    partial: 'fileTree.dirArchive.partialNote',
    confirm: 'fileTree.dirArchive.confirmPack',
  }
  async function downloadDirZip(entry: FileEntry | null) {
    const pid = projectId()
    if (!entry?.isDir || !pid) return
    try {
      const probe = await projectApi.dirArchiveProbe(pid, entry.path) as unknown as DirArchiveProbe
      const warned = (probe?.warnings?.length ?? 0) > 0
      if (warned && !await confirmSensitiveFiles(probe!.warnings!, probe?.scanTruncated === true, dirArchiveKeys)) return

      // 直链取包（P-20261030-2）：传输交还浏览器下载条（原生进度、流式落盘），
      // 确认后的 override 随 URL 携带。probe 与取包窗口期新增敏感文件时服务端
      // 409 拦回（直链形态下 200+JSON 会被浏览器存成假 zip，见 archive.go）
      triggerDirectDownload(dirArchiveUrl(pid, entry.path, warned), `${entry.name}.zip`)
      // 反馈即状态（probe 预估口径）：已开始打包报预估条目数；触顶如实报截断
      //（服务端必在上限处收尾，非失败）
      if (probe?.data?.truncated) message.warning(t('fileTree.dirArchive.truncated', { n: probe.data.entries }))
      else message.success(t('fileTree.dirArchive.started', { n: probe?.data?.entries ?? 0 }))
    } catch { /* 拦截器处理 */ }
  }

  // ============== 多选「下载选中」打包 zip（P-20261003-250） ==============
  // 服务端 files-archive 端点：选择项集合（文件/目录混合）流式打包，目录项
  // 递归含子树。敏感扫描警示 + override 二次请求流与目录打包同款（确认框
  // 复用 confirmSensitiveFiles，intro 换批量专用文案）；取包直链化同
  // downloadDirZip（P-20261030-2）。触顶截断提示通道同 dir-archive——响应头
  // 先于流发出，截断标记无法事后回传，probe 预估是唯一的通知通道
  const batchArchiveKeys = {
    title: 'fileTree.dirArchive.warningTitle',
    intro: 'fileTree.batchArchive.intro',
    more: 'fileTree.dirArchive.moreFiles',
    partial: 'fileTree.dirArchive.partialNote',
    confirm: 'fileTree.dirArchive.confirmPack',
  }
  async function downloadSelectionZip(paths: string[]) {
    const pid = projectId()
    if (!pid) return
    try {
      const probe = await projectApi.filesArchiveProbe(pid, paths) as unknown as DirArchiveProbe
      const warned = (probe?.warnings?.length ?? 0) > 0
      if (warned && !await confirmSensitiveFiles(probe!.warnings!, probe?.scanTruncated === true, batchArchiveKeys)) return

      // 直链形态保存名权威 = 服务端 Content-Disposition（archive_batch.go
      // selectionZipName：单项=名.zip，多项=archive-<yyyymmdd>-<HHmmss>.zip）；
      // a.download 只兜头缺失形态，多项 fallback 名按服务端同格式合成
      const now = new Date()
      const day = now.toISOString().slice(0, 10).replace(/-/g, '')
      const hms = now.toTimeString().slice(0, 8).replace(/:/g, '')
      const name = paths.length === 1 ? `${(paths[0] ?? 'archive').split('/').pop() || 'archive'}.zip` : `archive-${day}-${hms}.zip`
      // 直链取包（P-20261030-2，downloadDirZip 同款：窗口期敏感命中服务端 409
      // 拦回，不落假包），确认后的 override 随 URL 携带
      triggerDirectDownload(filesArchiveUrl(pid, paths, warned), name)
      // 反馈即状态（probe 预估口径）：已开始打包报预估条目数；触顶如实报截断
      //（服务端必在上限处收尾，非失败）
      if (probe?.data?.truncated) message.warning(t('fileTree.batchArchive.truncated', { n: probe.data.entries }))
      else message.success(t('fileTree.batchArchive.started', { n: probe?.data?.entries ?? 0 }))
    } catch { /* 拦截器处理 */ }
  }

  // 目录规模查询（P-20261002-137）：拦截器已解包 envelope，取 data；任何失败
  // 返回 null（调用方退化盲确认，删除链路不依赖规模）
  async function fetchDirScale(pid: string, path: string): Promise<DirScale | null> {
    try {
      const res = await projectApi.fileStat(pid, path) as unknown as { data?: DirScale }
      return res?.data ?? null
    } catch { return null }
  }

  // 删除的编程式入口（P-20261002-134）：右键菜单与树内 Delete 快捷键共用，
  // 含既有确认对话框语义；返回是否确认后删除成功（宿主 Delete 键据此做
  // 焦点转移），取消/失败均 false。
  // 目录删除先取递归规模（P-20261002-137 知情确认）：递归删除从盲确认变
  // 知情确认；只在目录删除时调用，文件删除确认保持原样。统计是确认弹层的
  // 增强面而非删除的准入闸——取不到规模（目录竞态消失/异常路径，API 侧已
  // silent）静默退化为既有盲确认文案，不阻断删除主链路
  async function startDelete(entry: FileEntry): Promise<boolean> {
    if (!projectId()) return false
    const scale = entry.isDir ? await fetchDirScale(projectId(), entry.path) : null
    if (!await confirmDialog({
      type: 'warning',
      title: t('fileTree.delete'),
      content: scale
        ? (): VNodeChild => h('div', null, [
            h('p', { style: 'margin:0 0 6px' }, t('fileTree.confirmDelete', { name: entry.name })),
            // 递归规模行：N 个文件 / M 个目录 / 共 X（含隐藏文件——误删盲区必须可见）
            h('p', { style: 'margin:0;color:var(--text-secondary)' },
              t('files.delConfirm.summary', { files: scale.files, dirs: scale.dirs, size: scale.sizeHuman })),
            // 超服务端统计上限：以上为下界（walk 上限防大目录慢查询）
            scale.truncated
              ? h('p', { style: 'margin:6px 0 0;font-size:12px;color:var(--accent-orange)' },
                  t('files.delConfirm.truncatedNote'))
              : null,
          ])
        : t('fileTree.confirmDelete', { name: entry.name }),
    })) return false
    try {
      await projectApi.deleteFile(projectId(), entry.path)
      if (isSensitivePath(entry.path)) {
        // 敏感删除物变体 toast（P-20261005-163）：驻留风险在删除的第一反馈面
        // 就可见（明文驻留数据目录 7 天），动作直达回收站浮层（不就地 purge
        // ——误点即不可逆的按钮不挂 toast 上，彻底删仍过浮层内确认弹层）。
        // 动作 toast 惯例同 useRenameRefUpdate.renamedFeedback（10s 驻留 +
        // hover 保活 + 可关闭，未点到即错过无副作用）
        let toast: { destroy(): void } | null = null
        toast = message.success(() => h('span', null, [
          t('fileTree.deletedSensitive', { name: entry.name }),
          h('span', {
            'data-testid': 'delete-sensitive-open-trash',
            style: 'cursor:pointer;text-decoration:underline;text-underline-offset:3px;color:var(--brand-accent);font-weight:600;margin-left:6px;',
            onClick: () => { toast?.destroy(); openTrash?.() },
          }, t('files.trash.purgeNow')),
        ]), { duration: 10_000, keepAliveOnHover: true, closable: true })
      } else {
        message.success(t('fileTree.deleted', { name: entry.name }))
      }
      await refreshTargetPath(entry.path.split('/').slice(0, -1).join('/'))
      return true
    } catch { return false /* 拦截器处理 */ }
  }

  return {
    contextEntry, contextX, contextY, showContext,
    inlineInput, inlineValue, inlineError, inlineCompatError,
    handleContextMenu, handleBackgroundContext, contextOptions,
    handleContextSelect, confirmInlineInput, cancelInlineInput,
    startInlineCreate, startRename, startDelete,
  }
}
