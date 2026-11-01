<script setup lang="ts">
// 全工程搜索：基于 git grep 的实时搜索面板
// 支持：大小写敏感、整词、正则、glob 文件过滤、跨项目批量搜索（按项目分组）
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, h } from 'vue'
import { NIcon, NInput, NCheckbox, NSelect, NSpin, NEmpty, NButton, useMessage } from 'naive-ui'
import { SearchOutline, SwapHorizontalOutline, DocumentTextOutline, CloseOutline, FolderOpenOutline, TrashOutline, CopyOutline, DownloadOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { projectApi, replaceApi, type ReplaceExecResult } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { useSearchHistory } from '../../composables/useSearchHistory'
import { safeStorage } from '../../utils/storage'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { copyText } from '../../utils/clipboard'
import { buildCsv } from '../../utils/csv'
import { exportFileName } from '../../utils/exportFileName'
import { OPS_FILES_EXTERNAL_CHANGE, OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import ReplacePreviewModal from './ReplacePreviewModal.vue'
import GlobExtensionChips from './GlobExtensionChips.vue'
import { buildFilePreview, buildReplaceRegex, type FilePreview } from '../../utils/replacePreview'

const message = useMessage()

const props = defineProps<{
  show: boolean
  /** 种子查询词（P-20261002-86 降级跳转）：打开时填入并自动搜索；普通入口恒为空 */
  initialQuery?: string
  /** glob 种子（P-20261003-118 目录右键「在此目录搜索」）：打开时预填（查询词
   *  留空用户输）；普通入口为空串/缺省——不动 glob 输入的跨打开粘滞 */
  initialFilePattern?: string
}>()
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
  (e: 'open-file', path: string, line?: number): void
}>()

const projectStore = useProjectStore()
const { t } = useI18n()

interface Match {
  path: string
  line: number
  column: number
  content: string
  before?: string
  after?: string
  match: string
}

const query = ref('')
const replaceText = ref('')
const showReplace = ref(false)
const caseSensitive = ref(false)
// 保留大小写（P-20261006-16）：替换输出跟随命中词形态，与 caseSensitive 正交
//（那管匹配、这管输出，可同开）；不影响搜索命中，不入 watch 重搜链
const preserveCase = ref(false)
const wholeWord = ref(false)
const useRegex = ref(false)
const filePattern = ref('')
const loading = ref(false)
const isTruncated = ref(false)
const matches = ref<Match[]>([])
const error = ref('')
const searchToken = ref(0)

// ── 跨项目搜索的中途取消（P-20261005-182）────────────────────────────────
// 每轮跨项目流式搜索一枚 AbortController：逐项目拆分请求共享 signal（经 http
// 层请求拦截器与实例切换的全局信号合并），取消钮/关面板/新一轮发起任一触发
// 即中止在途请求——已上屏结果保留不整体丢弃。
const searchCancelled = ref(false)
// 取消时点的完成度快照（中止前的可见进度），进度行据此标注「已取消（N/M）」
const cancelledProgress = ref({ done: 0, total: 0 })
// 非响应式：仅事件路径读写，无渲染依赖
let activeSearchAbort: AbortController | null = null

let debounceTimer: ReturnType<typeof setTimeout> | null = null

// ── 跨项目搜索范围（默认仅当前项目；「全部项目」快捷项一键覆盖）──────────
// 用户未自定义范围时跟随当前项目切换（scopeTouched 后不再跟随）
const scopeTouched = ref(false)
const projectScope = ref<string[]>([])
const searchProjectIds = computed<string[]>(() => {
  if (projectScope.value.length > 0) return projectScope.value
  return projectStore.currentProjectId ? [projectStore.currentProjectId] : []
})
const isMultiProject = computed(() => searchProjectIds.value.length > 1)
// 大项目集提示：并发子进程有界，但逐仓扫描耗时随项目数线性放大
const isOversizeScope = computed(() => searchProjectIds.value.length > 10)
const isAllScope = computed(() => {
  const usable = projectStore.projects.filter((p) => p.valid !== false)
  return usable.length > 0 && usable.every((p) => projectScope.value.includes(p.id))
})
const projectOptions = computed(() =>
  projectStore.projects.map((p) => ({ label: p.name, value: p.id })),
)

function toggleAllScope(checked: boolean) {
  scopeTouched.value = true
  projectScope.value = checked
    ? projectStore.projects.filter((p) => p.valid !== false).map((p) => p.id)
    : (projectStore.currentProjectId ? [projectStore.currentProjectId] : [])
}
// 默认范围 = 当前项目（挂载即对齐一次；此后未触碰时跟随切换）
watch(() => projectStore.currentProjectId, (id) => {
  if (!scopeTouched.value) projectScope.value = id ? [id] : []
}, { immediate: true })

// ── 项目范围记忆（P-20261003-69）：显式勾选/取消即 localStorage 持久化 ──────
// 固定项目组合免每次重开重勾。记的是用户显式选择（scopeTouched 口径）——
// n-select 勾选/取消与「全部项目」快捷项两条显式路径都汇入 projectScope，
// 这里统一落袋；未显式选择（跟随当前项目）不落袋，首次默认行为不变。
// 显式清空 ≈ 回「仅当前项目」默认口径：清记忆不落空数组。
// 走 safeStorage（红线：禁裸 localStorage）；恢复入口见 restoreRememberedScope。
const SCOPE_MEMORY_KEY = 'project-search-scope'
watch(projectScope, (ids) => {
  if (!scopeTouched.value) return
  if (ids.length === 0) safeStorage.removeItem(SCOPE_MEMORY_KEY)
  else safeStorage.setItem(SCOPE_MEMORY_KEY, JSON.stringify(ids))
})

// 面板打开时恢复上次显式范围：只收当前项目列表仍存在的 id（项目删除后的
// 失效引用自动过滤，部分失效经上方 watch 顺带回写修剪存储）；项目列表未
// 就绪时不动（boot 竞态防误清，列表加载后面板重开即恢复）。存储脏数据视同无记忆。
function restoreRememberedScope() {
  if (projectStore.projects.length === 0) return
  let remembered: string[]
  try {
    const raw = safeStorage.getItem(SCOPE_MEMORY_KEY)
    remembered = raw
      ? (JSON.parse(raw) as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
      : []
  } catch {
    return
  }
  if (remembered.length === 0) return
  const validIds = new Set(projectStore.projects.map((p) => p.id))
  const restored = remembered.filter((id) => validIds.has(id))
  if (restored.length === 0) {
    safeStorage.removeItem(SCOPE_MEMORY_KEY)
    return
  }
  projectScope.value = restored
  scopeTouched.value = true
}

// 按文件分组
interface FileGroup {
  path: string
  matches: Match[]
}
function groupMatches(ms: Match[]): FileGroup[] {
  const map = new Map<string, Match[]>()
  for (const m of ms) {
    if (!map.has(m.path)) map.set(m.path, [])
    map.get(m.path)!.push(m)
  }
  return Array.from(map.entries()).map(([path, ms]) => ({ path, matches: ms }))
}
const groupedMatches = computed<FileGroup[]>(() => groupMatches(matches.value))

// ── 文件级勾选：替换范围收敛到勾选文件，默认全选（与既有「全部替换」语义兼容）──
const selectedPaths = ref<Set<string>>(new Set())
// 新搜索落地即重置为全选：陈旧勾选会把上一轮的排除项带进下一轮替换（误替换风险）
watch(matches, () => {
  selectedPaths.value = new Set(groupedMatches.value.map((g) => g.path))
})
const selectedGroups = computed(() =>
  groupedMatches.value.filter((g) => selectedPaths.value.has(g.path)),
)
const selectedFileCount = computed(() => selectedGroups.value.length)
const isAllSelected = computed(() =>
  groupedMatches.value.length > 0 && selectedFileCount.value === groupedMatches.value.length,
)
const isPartialSelected = computed(() => selectedFileCount.value > 0 && !isAllSelected.value)

function toggleFileSelection(path: string, checked: boolean) {
  const next = new Set(selectedPaths.value)
  if (checked) next.add(path)
  else next.delete(path)
  selectedPaths.value = next
}

function toggleSelectAll(checked: boolean) {
  selectedPaths.value = checked
    ? new Set(groupedMatches.value.map((g) => g.path))
    : new Set()
}

// 替换按钮文案随选择动态：全选（含零结果）保持「全部替换」，部分勾选显示实际范围
const replaceButtonLabel = computed(() =>
  isAllSelected.value || selectedFileCount.value === 0
    ? t('projectSearch.replaceAll')
    : t('search.replace.replaceSelected', { n: selectedFileCount.value }),
)

// ── 跨项目搜索的单项目结果组（流式上屏：完成一个原位填充一个）─────────
interface ProjectResultGroup {
  projectId: string
  name: string
  matches: Match[]
  truncated: boolean
  error: string
  // pending 该项目仍在搜索中：组头先亮占位（转圈），完成后原位换命中数——
  // 慢项目不再拖住快项目的首字上屏（P-20261003-94）
  pending: boolean
}
const projectResults = ref<ProjectResultGroup[]>([])

// 渲染结构：单项目模式包一层无头组（不渲染项目组头，保持既有形态），
// 跨项目模式组头显示项目名 + 命中数，组内复用文件分组样式
interface RenderProjectGroup {
  projectId: string
  name: string
  error: string
  hitCount: number
  fileGroups: FileGroup[]
  pending: boolean
}
const renderGroups = computed<RenderProjectGroup[]>(() => {
  if (!isMultiProject.value) {
    return [{ projectId: '', name: '', error: '', hitCount: matches.value.length, fileGroups: groupedMatches.value, pending: false }]
  }
  return projectResults.value.map((g) => ({
    projectId: g.projectId,
    name: g.name || g.projectId,
    error: g.error,
    hitCount: g.matches.length,
    fileGroups: groupMatches(g.matches),
    pending: g.pending,
  }))
})

// 进度行计数（P-20261003-94）：已完成/总数——失败组也算完成（有明确终态）
const searchProgress = computed(() => ({
  done: projectResults.value.filter((g) => !g.pending).length,
  total: projectResults.value.length,
}))

const totalMatches = computed(() => matches.value.length)
const totalFiles = computed(() => renderGroups.value.reduce((n, g) => n + g.fileGroups.length, 0))
const anyTruncated = computed(() =>
  isMultiProject.value
    ? projectResults.value.some((g) => g.truncated)
    : isTruncated.value,
)

// ── 复制全部路径（P-20261003-149）：结果头小钮一键转述给 agent/脚本 ──────
// 范围口径 = 当前结果列表本身：glob 过滤（filePattern）在服务端搜索期生效，
// 现有结果即过滤后范围，复制面天然与之协同（扩展名 chips UI 本面板不存在，
// 提案注记「不存在则注记」——后续若加 chips，其收敛若落在结果集上自动跟随）。
// 替换文件勾选（showReplace）是替换范围语义，不收窄复制面（标题即「全部」）。
// 换行用 \n：剪贴板面向 agent/脚本逐行消费，三平台一致取 LF（\r\n 会污染
// 粘贴进命令行/参数的场景），是显式约定而非平台默认。
const copyPathsText = computed<string>(() => {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const pg of renderGroups.value) {
    for (const g of pg.fileGroups) {
      // 跨项目模式带项目名前缀：相对路径跨仓会重名，前缀后才可去重定位；
      // 键含前缀后跨仓同名不再互斥，同项目内 fileGroups 按路径分组本就唯一，
      // Set 去重是会合点的通用防线
      const line = pg.projectId ? `${pg.name}/${g.path}` : g.path
      if (!seen.has(line)) {
        seen.add(line)
        lines.push(line)
      }
    }
  }
  return lines.join('\n')
})

async function onCopyAllPaths() {
  const ok = await copyText(copyPathsText.value)
  if (ok) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}

// ── 结果导出 CSV（P-20261003-272）：结果头小钮，留档分析 ──────────────────
// 范围口径 = copyPathsText 同款「当前结果列表本身」（glob 过滤/截断钳制均已
// 生效的前端现成数据，纯前端生成下载零新请求）；跨项目模式文件列带项目名前缀
// （P-149 复制路径同款——相对路径跨仓会重名）。CSV 形状（BOM/RFC 4180/公式
// 注入防护/语言中立小写表头）全在 utils/csv.ts 单一实现，此处只供行数据。
// 下载名沿用 exportFileName 导出族净化（查询词作标题段，留档自标识）。
function onExportCsv() {
  if (matches.value.length === 0) return
  const rows: string[][] = []
  for (const pg of renderGroups.value) {
    for (const g of pg.fileGroups) {
      const file = pg.projectId ? `${pg.name}/${g.path}` : g.path
      for (const m of g.matches) rows.push([file, `${m.line}`, m.content])
    }
  }
  const blob = new Blob([buildCsv(['file', 'line', 'content'], rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = exportFileName(query.value.trim() || 'results', new Date(), 'csv', 'search')
  a.click()
  // 10s 后再 revoke：Safari 等异步触发下载的浏览器上立即回收会截断文件（P-76 同款）
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  message.success(t('projectSearch.exportDone'))
}

// ── 结果行删除（P-20261003-178）：搜索定位到垃圾文件后清理一步到位 ─────────
// 树删除族（useFileTreeContext.startDelete）的不同 surface：同一 confirmDialog
// 确认语义 + 同一 deleteFile 端点，只是入口在结果行。搜索结果恒为文件
// （git grep 不返回目录），走「规模显示惯例」的单文件简版——无目录递归规模行。
// 仅单项目模式：跨项目结果路径混含多仓相对路径，deleteFile 按项目路由，
// 行上不带项目归属就无法落对仓库（提案注记：路由复杂度，跨项目禁用）。
const deletingPath = ref('')
async function onDeleteResult(path: string) {
  if (isMultiProject.value || deletingPath.value) return
  // 结果归属仓 = 本轮搜索实际跑的仓（ids[0]），非惯性取当前项目——范围显式
  // 单选了别的项目时（isMultiProject 为 false 但 ≠ 当前项目），按当前项目删
  // 会落错仓库
  const pid = searchProjectIds.value[0] || projectStore.currentProjectId
  if (!pid) return
  const name = path.split('/').pop() || path
  if (!await confirmDialog({
    type: 'warning',
    title: t('fileTree.delete'),
    content: t('fileTree.confirmDelete', { name }),
  })) return
  deletingPath.value = path
  try {
    await projectApi.deleteFile(pid, path)
    message.success(t('fileTree.deleted', { name }))
    // 结果即时移除：matches 是单一事实源，过滤后分组/统计/替换勾选集
    // （watch(matches) 重置全选）与键盘导航序列自动跟随
    matches.value = matches.value.filter(m => m.path !== path)
    if (activeIdx.value >= matches.value.length) activeIdx.value = matches.value.length - 1
    // 打开了该文件时内存内容保留（重载 404 静默），编辑器侧文件清单缓存
    // （Quick Open / 路径补全）走既有外部变更广播失效——与替换完成同链路
    window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: [path] } }))
  } catch { /* 拦截器处理 */ } finally {
    deletingPath.value = ''
  }
}

// 单项目/跨项目两路共用同一参数形态（类型取自 searchContent 声明）
type SearchParams = NonNullable<Parameters<typeof projectApi.searchContent>[1]>

async function runSearch() {
  const ids = searchProjectIds.value
  // 新一轮发起先中止上一轮（P-20261005-182④）：陈旧结果不混屏，在途请求不再
  // 白跑；清空词短路同样收口（面板态即将清空，请求更不该续跑）
  activeSearchAbort?.abort()
  activeSearchAbort = null
  searchCancelled.value = false
  if (!query.value.trim() || ids.length === 0) {
    matches.value = []
    projectResults.value = []
    error.value = ''
    isTruncated.value = false
    return
  }
  // 查询历史（P-20261003-48）：搜索发起即记忆（去重置顶，环形 15 容量内零成本）；
  // 只在本组件 runSearch 这一条真搜索路径记录，替换执行后的重搜同此口
  recordQuery(query.value)
  const token = ++searchToken.value
  loading.value = true
  error.value = ''
  try {
    const base: SearchParams = {
      q: query.value,
      case: caseSensitive.value ? '1' : '0',
      word: wholeWord.value ? '1' : '0',
      regex: useRegex.value ? '1' : '0',
      glob: filePattern.value || undefined,
    }
    if (!isMultiProject.value) {
      // 单项目：既有链路（多取 1 条探测截断：恰好 500 条真实匹配时不会误报「结果过多」）
      const res: any = await projectApi.searchContent(ids[0]!, { ...base, max: 501 })
      if (token !== searchToken.value) return
      const found = (res.data || []) as Match[]
      isTruncated.value = found.length > 500
      matches.value = isTruncated.value ? found.slice(0, 500) : found
      projectResults.value = []
      activeIdx.value = -1
    } else {
      // 跨项目：流式上屏（P-20261003-94）——并发拆分调用既有单仓端点，
      // 完成一个项目原位上屏一个，首字延迟 = 最快项目而非最慢项目；
      // 批量端点（searchProjectsContent）保留给单请求省开销场景，不再在此使用
      projectResults.value = ids.map((id) => ({
        projectId: id,
        // 组头先占位：名称从项目列表预填（单仓端点不回传项目名），列表缺席退化显示 id
        name: projectStore.projects.find((p) => p.id === id)?.name || '',
        matches: [],
        truncated: false,
        error: '',
        pending: true,
      }))
      matches.value = []
      isTruncated.value = false
      activeIdx.value = -1
      const controller = new AbortController()
      activeSearchAbort = controller
      await runMultiProjectSearch(ids, base, token, controller)
      // 取消收口：未完成组定格终态（占位转圈停），已完成组原样保留——worker 对
      // 中止请求只静默退出不写组，这里统一落账（matches 扁平序列无变化，无需重算）
      if (token === searchToken.value && controller.signal.aborted) {
        projectResults.value = projectResults.value.map((g) =>
          g.pending ? { ...g, pending: false } : g)
      }
    }
  } catch (e: any) {
    if (token !== searchToken.value) return
    error.value = e?.userMessage || t('errors.unknown')
    matches.value = []
    projectResults.value = []
  } finally {
    if (token === searchToken.value) loading.value = false
  }
}

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(runSearch, 300)
}

// ── 跨项目流式搜索（P-20261003-94）───────────────────────────────────
// 并发钳 4：与服务端批量池（gitops/search.go batchSearchConcurrency）同语义——
// 前端再快也只会在服务端 git grep 子进程上限处排队，扇出超过 4 纯增加限流风险
const MULTI_SEARCH_CONCURRENCY = 4

// 有界并发逐仓调用单仓端点（worker 池 + 游标取号，单线程事件循环内 cursor
// 读增之间无 await，无需锁）；每仓完成即原位写回自己的组，组序恒为范围选择序
// （DOM 稳定不跳）。单仓失败只标该组 error（silent 抑制拦截器逐项 toast，
// N 仓失败不该弹 N 个 toast），不拖垮其他组。本轮 AbortController 供取消
// （P-20261005-182）：中止时在途请求静默退出、排队请求不再发出
async function runMultiProjectSearch(ids: string[], base: SearchParams, token: number, controller: AbortController) {
  let cursor = 0
  const worker = async () => {
    while (cursor < ids.length && token === searchToken.value && !controller.signal.aborted) {
      const id = ids[cursor++]!
      try {
        // 多取 1 条探测截断（与单项目路径同语义）：恰好 500 条真实命中不误报；
        // skipInflightDedupe：逐轮请求必须独立可取消——取消/换轮后紧跟的新一轮
        // 与被中止的旧轮同键，旧请求尚未出 P-246 去重表的窗口期并入会把新轮
        // 请求一起带进取消
        const res: any = await projectApi.searchContent(id, { ...base, max: 501 }, {
          silent: true,
          signal: controller.signal,
          skipInflightDedupe: true,
        })
        if (token !== searchToken.value) return
        const found = (res.data || []) as Match[]
        const truncated = found.length > 500
        patchGroup(id, { matches: truncated ? found.slice(0, 500) : found, truncated, error: '', pending: false })
      } catch (e: any) {
        if (token !== searchToken.value) return
        // 本轮被主动取消（取消钮/关面板/新一轮发起）：静默退出不改组态——
        // 已上屏结果保留，未完成组由调用方取消收口统一定格。实例切换的全局
        // 中止不置位本轮 signal，仍走下方失败标记（与既有形态一致）
        if (controller.signal.aborted) return
        // 与服务端批量端点同文案口径（UI 只区分成败，不细排原因）；
        // 429 单列（P-20261004-124 搜索限流）：语义是「稍候重试即可」而非失败
        patchGroup(id, {
          matches: [],
          truncated: false,
          error: e?.response?.status === 404 ? 'project not found'
            : e?.response?.status === 429 ? 'rate limited'
            : 'search failed',
          pending: false,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MULTI_SEARCH_CONCURRENCY, ids.length) }, () => worker()))
}

// 取消钮（P-20261005-182②）：中止在途请求，已到结果保留、进度行换「已取消」
// 标注——部分结果可用不整体丢弃
function onCancelSearch() {
  const c = activeSearchAbort
  if (!c || c.signal.aborted) return
  cancelledProgress.value = {
    done: projectResults.value.filter((g) => !g.pending).length,
    total: projectResults.value.length,
  }
  searchCancelled.value = true
  c.abort()
}

// 原位写回单项目组并同步扁平命中序列（键盘导航/全选均以 matches 为单一事实源）
function patchGroup(projectId: string, patch: Pick<ProjectResultGroup, 'matches' | 'truncated' | 'error' | 'pending'>) {
  const idx = projectResults.value.findIndex((g) => g.projectId === projectId)
  if (idx < 0) return
  const next = [...projectResults.value]
  next[idx] = { ...next[idx]!, ...patch }
  projectResults.value = next
  matches.value = next.flatMap((g) => g.matches)
}

// ── 查询历史下拉（P-20261003-48）：聚焦出最近查询，输入前缀过滤补全 ──────
const { history: queryHistory, recordQuery, filterByPrefix, clearHistory } = useSearchHistory()
// 聚焦态 + 收起态分离：Esc/点选后本轮聚焦内不再自动弹出（浏览器地址栏同惯例）；
// 点击输入框可重新唤出（@click 同 handler——已聚焦时 focus 事件不再触发，仅靠 @focus 收不回来）
const historyFocused = ref(false)
const historyDismissed = ref(false)
const historyVisible = computed(() =>
  historyFocused.value && !historyDismissed.value && queryHistory.value.length > 0,
)
const historyItems = computed(() => filterByPrefix(query.value))
// 输入前缀过滤全空时保留下拉给空态提示（「无匹配」也是反馈，静默消失像坏了）
const historyAllFilteredOut = computed(() =>
  historyVisible.value && query.value.trim() !== '' && historyItems.value.length === 0,
)
function onFocusQuery() {
  historyFocused.value = true
  historyDismissed.value = false
}
function closeHistoryDropdown() {
  historyDismissed.value = true
}
function onClearHistory() {
  clearHistory()
  closeHistoryDropdown()
}
// 回填并立即执行：点选是明确意图，绕过 300ms 防抖直接搜；suppress 掉 watch(query)
// 的防抖兜底（幂等但白跑一次 git grep）。值未变时 watch 不触发，标志位不会悬空误吞后续输入
let suppressNextSchedule = false
function applyHistory(term: string) {
  if (query.value !== term) {
    suppressNextSchedule = true
    query.value = term
  }
  closeHistoryDropdown()
  void runSearch()
}

watch(query, () => {
  if (suppressNextSchedule) {
    suppressNextSchedule = false
    // 历史回填路径保持收起：结果区即是反馈，不再弹补全盖住结果
    return
  }
  // 手动编辑 → 补全重新可用（Esc 收起后一输入即恢复，浏览器地址栏同惯例）
  historyDismissed.value = false
  scheduleSearch()
})
watch([caseSensitive, wholeWord, useRegex, filePattern], runSearch)
// 范围变化即时重搜（与选项条同级语义；query 为空时 runSearch 自行短路清理）
watch(searchProjectIds, runSearch)

// 打开时聚焦输入
const queryInputRef = ref<InstanceType<typeof NInput> | null>(null)
watch(() => props.show, async (val) => {
  if (val) {
    // 上次显式项目范围先恢复（种子词搜索随之按记忆范围跑，P-20261002-86 同面板语义）
    restoreRememberedScope()
    await nextTick()
    // 降级跳转种子词（P-20261002-86）：填入即触发 watch(query) → 300ms 防抖后自动搜索；
    // 普通入口种子恒为空串（值未变不触发），与既有「关闭时清空」行为等价
    query.value = props.initialQuery?.trim() || ''
    // 目录搜索 glob 种子（P-20261003-118）：带种子时覆盖残留值（右键该目录是
    // 明确意图）；查询词为空时 watch(filePattern) 触发的 runSearch 会自行短路，
    // 不发请求。普通入口种子为空——保留 glob 输入的既有粘滞语义
    if (props.initialFilePattern?.trim()) filePattern.value = props.initialFilePattern.trim()
    queryInputRef.value?.focus()
  } else {
    // 关闭时清空
    query.value = ''
    replaceText.value = ''
    matches.value = []
    projectResults.value = []
    // 关闭即隐式中止在途搜索（P-20261005-182③）：面板态已清，请求不续跑；
    // 取消标注一并复位（重开面板不残留上轮的「已取消」注记）
    activeSearchAbort?.abort()
    activeSearchAbort = null
    searchCancelled.value = false
    // 历史下拉态随面板复位（v-if 移除不触发 blur，须显式清）
    historyFocused.value = false
    historyDismissed.value = false
    suppressNextSchedule = false
  }
})

// Esc 关闭：窗口级监听兜底（卡片/输入框上的 @keydown 只在焦点落在浮层内时生效，
// 点过外部后 Esc 就失效了）；有模态弹窗打开时让位（同 AgentTerminal onKeyDown 惯例）
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.show) {
    // 分层关闭：历史下拉开着时先收下拉——stopPropagation 拦住卡片/窗口级
    // Esc（否则同一次 Esc 会顺带关掉整个面板），再按一次才关面板
    if (historyVisible.value) {
      e.preventDefault()
      e.stopPropagation()
      closeHistoryDropdown()
      return
    }
    emit('update:show', false)
    return
  }
  // 结果键盘导航：↑↓ 移动活动行，Enter/Shift+Enter 打开当前/上一命中
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveActive(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveActive(-1)
  } else if (e.key === 'Enter' && flatMatches.value.length > 0) {
    // Enter：有活动行开活动行，无则开首个匹配（VS Code 惯例）；Shift+Enter
    // 反向开上一命中（走查回退；clamp 不回绕与 ↑↓ 同口径，无活动行同开首个）
    e.preventDefault()
    if (e.shiftKey) moveActive(-1)
    else if (activeIdx.value < 0) activeIdx.value = 0
    openActive()
  }
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show) return
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出最大化）不重复处理
  if (e.key === 'Escape') {
    if (hasBlockingOverlay()) return
    e.preventDefault()
    emit('update:show', false)
    return
  }
  // F3/Shift+F3 面板态全局跳下/上一命中（P-20261006-23②）：与 Esc 同层窗口级
  // 监听，焦点落在卡片外（遮罩/naive-ui 浮层的 body 挂载点）也能连续走查；
  // 模态弹窗在场上时让位（同 Esc 口径）。只移动高亮不打开——打开是 Enter 的
  // 动作（会关面板），F3 保持面板开着才谈得上「跨文件连续走查」
  if (e.key === 'F3' && flatMatches.value.length > 0) {
    if (hasBlockingOverlay()) return
    e.preventDefault()
    moveActive(e.shiftKey ? -1 : 1)
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  // 组件卸载同样中止在途搜索（关面板的兜底面：宿主整树重建/实例切换等路径）
  activeSearchAbort?.abort()
  activeSearchAbort = null
})

// ── 全部替换：预览弹层（before→after 对照）+ 按勾选文件执行 ──────────────
// P-20261003-71：确认流从纯计数 confirmDialog 升级为预览弹层——regex 误配
// （贪婪/边界）在计数里看不出来，行级对照才是安全网。
// P-20261004-66：执行链从「逐文件 readFile→replace→writeFile（N 次往返、无
// 备份纪律）」切换到服务端执行 API（POST /replace，paths 圈定勾选子集）——
// 替换前强制备份落档 + 每次执行自动进替换历史（设置·安全·替换历史可一键
// 还原），BaseHash 并发拒绝/写锁串行/审计照服务端纪律收口。预览弹层的
// after 仍由前端共享 regex 生成（与本面板搜索结果同源），执行以服务端 RE2
// 为准（编译失败 400 提示降级，双端差异见服务端 dualEndRegexHint 哨兵）。
const replacing = ref(false)
const showPreview = ref(false)
const previewFiles = ref<FilePreview[]>([])

// ── 备份补丁下载（P-20261003-76 语义保留）─────────────────────────────
// 备份本体在服务端执行期强制落档（artifacts + 替换历史内嵌，可逆性不再依赖
// 用户保管文件）；勾选「替换前导出备份补丁」= 执行成功后按备份名取回内容
// 触发浏览器下载（留一份离手副本）。P-20261004-56 起 untracked 命中文件以
// new-file 段入备份（先删除该文件再重放即还原替换前内容），替换现场新文件
// 不再漏备份。
function downloadPatchBackup(content: string) {
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const blob = new Blob([content], { type: 'text/x-diff' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `replace-backup-${stamp}.patch`
  a.click()
  // 10s 后再 revoke：Safari 等异步触发下载的浏览器上立即回收会截断文件
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function openReplacePreview() {
  // 跨项目结果不支持替换：结果混含多仓相对路径，逐组替换语义模糊且高危，
  // 仅保留单项目范围（按钮在多项目模式禁用并提示）
  if (isMultiProject.value) return
  if (!projectStore.currentProjectId || replacing.value || matches.value.length === 0) return
  const re = buildReplaceRegex(query.value, {
    caseSensitive: caseSensitive.value,
    wholeWord: wholeWord.value,
    useRegex: useRegex.value,
  })
  if (!re) {
    message.error(t('projectSearch.invalidRegex'))
    return
  }
  // 预览覆盖全部结果文件（含被排除文件，带未勾选态展示——弹层内可直接改勾选）；
  // 确认执行仅作用勾选文件（selectedGroups 单一事实源）。preserveCase 预览联动
  //（P-20261006-16）：after 形态跟随与执行同参，所见即所得
  previewFiles.value = groupedMatches.value.map(g => buildFilePreview(g.path, g.matches, re, replaceText.value, preserveCase.value))
  showPreview.value = true
}

// 敏感命中闸的确认弹层（服务端 409 files.sensitive_confirm_required 后的
// 知情确认）：命中清单点名展示，确认后带 confirmSensitive=true 重试
async function confirmSensitiveReplace(hits: string[]): Promise<boolean> {
  return confirmDialog({
    title: t('search.replace.sensitive.title'),
    type: 'warning',
    content: () => h('div', { style: 'display:flex;flex-direction:column;gap:6px;' }, [
      h('div', { style: 'color:var(--accent-yellow);' }, t('search.replace.sensitive.warn')),
      h('div', null, t('search.replace.sensitive.files', { files: hits.join('、') })),
      h('div', null, t('search.replace.sensitive.confirm')),
    ]),
  })
}

async function executeReplace(backup: boolean) {
  const pid = projectStore.currentProjectId
  const groups = selectedGroups.value
  if (!pid || replacing.value || groups.length === 0) return
  // 服务端 paths 圈定上限（replacePathsMax）的前端同口径预检：超限明确提示
  // 缩小范围，而不是等服务端 400
  if (groups.length > 500) {
    message.error(t('search.replace.tooManyFiles'))
    return
  }
  replacing.value = true
  // 敏感闸重试循环：409（未确认）→ 确认弹层 → 带 confirmSensitive 重放同一
  // 份参数（while+标志而非递归——递归会在外层 finally 里关掉内层的执行态）
  let confirmSensitive = false
  try {
    for (;;) {
      let data: ReplaceExecResult | undefined
      try {
        const res: any = await replaceApi.execute(pid, {
          pattern: query.value,
          replacement: replaceText.value,
          caseSensitive: caseSensitive.value,
          wholeWord: wholeWord.value,
          useRegex: useRegex.value,
          preserveCase: preserveCase.value,
          paths: groups.map(g => g.path),
          confirmSensitive,
        })
        data = res?.data as ReplaceExecResult | undefined
      } catch (e: any) {
        if (!confirmSensitive && e?.data?.code === 'files.sensitive_confirm_required') {
          if (!await confirmSensitiveReplace((e.data?.sensitiveHits || []) as string[])) return
          confirmSensitive = true
          continue
        }
        throw e
      }
      const changed = (data?.changed || []).map(c => c.path)
      if (changed.length === 0) {
        // 全部被跳过/冲突（服务端逐文件甄别与前端预览可能失配：编码/并发写）：
        // 如实回告不装成功——明细在响应 skipped/conflicts，历史不落档（服务端）
        message.warning(t('projectSearch.replacedNone'))
      } else {
        message.success(t('projectSearch.replacedAll', { files: changed.length, matches: data?.totalHits ?? 0 }))
        // 跳过/冲突计数附告（有才提示）：文件被并发改写时用户需要知道哪些没动
        const skipped = data?.skipped?.length ?? 0
        const conflicts = data?.conflicts?.length ?? 0
        if (skipped + conflicts > 0) {
          message.warning(t('search.replace.partial', { skipped, conflicts }))
        }
        // 服务端扫描截断如实附告：命中集可能不完整（勾选文件的命中被截在
        // 扫描上限外 = 未替换），缩小 glob 分批
        if (data?.truncated) {
          message.warning(t('search.replace.truncatedNote'))
        }
        // 备份勾选 → 取回服务端留档的备份 patch 触发下载；失败不回滚替换
        //（备份已服务端留档并进替换历史，可一键还原——离手副本只是冗余）
        if (backup && data?.backup?.name && !data.backup.empty) {
          try {
            const body: any = await replaceApi.backups(pid, data.backup.name)
            if (typeof body?.data === 'string') {
              downloadPatchBackup(body.data)
              message.success(t('search.replace.backup.saved'))
            }
          } catch {
            message.warning(t('search.replace.backup.downloadFailed'))
          }
        }
        // 已打开的同名文件从磁盘重读：编辑器内存里还是替换前内容，直接保存会
        // 把替换结果整个覆盖回去（干净重读/脏文件点名提示由 useOpenFiles 承载）
        window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: changed } }))
      }
      showPreview.value = false
      await runSearch()
      return
    }
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('errors.unknown'))
  } finally {
    replacing.value = false
  }
}

// ── 结果键盘导航（VS Code 搜索惯例）：↑↓/F3 移动活动行，Enter 打开 ──
const activeIdx = ref(-1)
const flatMatches = computed<Match[]>(() => matches.value)
// 活动行归属项目（与 flatMatches 同序）：跨项目模式下 Enter 打开须带上
// 命中所属项目，否则会按当前项目路径打开到错误仓库
const flatProjectIds = computed<string[]>(() =>
  isMultiProject.value
    ? projectResults.value.flatMap((g) => g.matches.map(() => g.projectId))
    : [],
)

function moveActive(delta: number) {
  if (flatMatches.value.length === 0) return
  activeIdx.value = Math.min(flatMatches.value.length - 1, Math.max(0, activeIdx.value + delta))
}
function openActive() {
  const m = flatMatches.value[activeIdx.value]
  if (m) openMatch(m, flatProjectIds.value[activeIdx.value] || '')
}

// 引用等值直判（O(1)）：matches 内对象引用唯一，旧 indexOf 写法每渲染行
// O(n)、按键驱动的高频重渲染上是无谓平方量级
function isActive(m: Match) {
  return activeIdx.value >= 0 && flatMatches.value[activeIdx.value] === m
}

// ── 折叠行按需展开 + 活动行滚动跟随（P-20261006-23①）──────────────────
// 每文件组默认只渲染前 30 行（.ps-more 折叠线）；键盘走查越过折叠线时活动行
// 还不在 DOM 里——渲染上限按活动命中所在组抬到活动行为止（activeLoc 纯派生
// 无附加状态，活动行离开该组即自动回落折叠线），滚动跟随才有行可滚
const RESULT_SLICE = 30

// 活动命中定位：命中本体 + 文件组内序（同路径前序命中计数）。前向扫一趟
// O(activeIdx)，扁平序列 500 条封顶、单次按键至多触发一次，量级可忽略；
// 跨项目同名路径两仓互不混计（同序 flatProjectIds 对齐判别）
const activeLoc = computed(() => {
  const idx = activeIdx.value
  const m = flatMatches.value[idx]
  if (!m) return null
  const pid = flatProjectIds.value[idx] || ''
  let within = 0
  for (let i = 0; i < idx; i++) {
    if (flatMatches.value[i]!.path !== m.path) continue
    if (pid && flatProjectIds.value[i] !== pid) continue
    within++
  }
  return { m, within }
})

// 该文件组应渲染的命中行数：活动命中属于本组（引用等值即定位到组内下标，
// 组间对象引用唯一）时抬到 within+1 盖住活动行，否则维持折叠线上限
function visibleCount(group: FileGroup): number {
  const loc = activeLoc.value
  if (!loc || group.matches[loc.within] !== loc.m) return RESULT_SLICE
  return Math.max(RESULT_SLICE, loc.within + 1)
}

// 滚动跟随：活动行变更等 DOM 落定（含按需展开的重渲染）后滚入可视区
//（block:nearest 不强夺用户既有滚动位置；OutlinePopover 等弹层同惯例）。
// 在结果容器内取活动行（组件域查询，不依赖 document 全局）
const resultsRef = ref<HTMLElement | null>(null)
watch(activeIdx, async (idx) => {
  if (idx < 0) return
  await nextTick()
  resultsRef.value?.querySelector('.ps-line.is-active')?.scrollIntoView({ block: 'nearest' })
})

function openMatch(m: Match, projectId = '') {
  const pid = projectId || projectStore.currentProjectId
  if (pid && pid !== projectStore.currentProjectId) {
    // 跨项目结果：复用终端文件链接的「先切项目再打开 + 行定位」既有链路
    //（useLayoutViews 监听该事件：切项目 → nextTick 等清空 watcher 落地 → 打开）
    const detail: OpenFileAtDetail = { path: m.path, projectId: pid, line: m.line, col: m.column }
    window.dispatchEvent(new CustomEvent(OPS_OPEN_FILE_AT, { detail }))
  } else {
    emit('open-file', m.path, m.line)
  }
  emit('update:show', false)
}

// 高亮匹配
function highlight(content: string, match: string): { before: string; match: string; after: string } {
  if (!match) return { before: content, match: '', after: '' }
  let idx: number
  if (caseSensitive.value) {
    idx = content.indexOf(match)
  } else {
    idx = content.toLowerCase().indexOf(match.toLowerCase())
  }
  if (idx < 0) return { before: content, match: '', after: '' }
  return {
    before: content.slice(0, idx),
    match: content.slice(idx, idx + match.length),
    after: content.slice(idx + match.length),
  }
}
</script>

<template>
  <transition name="ps-fade">
    <div
      v-if="props.show"
      class="ps-mask"
      @click.self="emit('update:show', false)"
    >
      <div
        class="ps-card glass-panel"
        @keydown="onKeydown"
      >
        <!-- 头部：搜索 / 替换 -->
        <div class="ps-header">
          <div class="ps-input-row">
            <n-icon
              size="14"
              class="ps-icon"
            >
              <SearchOutline />
            </n-icon>
            <n-input
              ref="queryInputRef"
              v-model:value="query"
              :placeholder="t('projectSearch.placeholder')"
              :bordered="false"
              size="medium"
              class="ps-input"
              @focus="onFocusQuery"
              @click="onFocusQuery"
              @blur="historyFocused = false"
            />
            <!-- 键位处理只在卡片级 @keydown 一处（P-20261006-23）：n-input 上再绑
                 一份会因事件冒泡双触发（↑↓ 一次跳两行 / Enter 双开）——历史上输入框
                 绑定时 onKeydown 还只处理幂等的 Esc，导航并入后即成双触发源头 -->
            <button
              class="ps-toggle-replace"
              :title="t('projectSearch.replace')"
              @click="showReplace = !showReplace"
            >
              <n-icon size="13">
                <SwapHorizontalOutline />
              </n-icon>
            </button>
            <button
              class="ps-close"
              :title="t('commandPalette.close')"
              @click="emit('update:show', false)"
            >
              <n-icon size="14">
                <CloseOutline />
              </n-icon>
            </button>
          </div>

          <!-- 替换输入（可折叠） -->
          <transition name="ps-slide">
            <div
              v-if="showReplace"
              class="ps-input-row ps-replace-row"
            >
              <n-icon
                size="14"
                class="ps-icon replace-icon"
              >
                <SwapHorizontalOutline />
              </n-icon>
              <n-input
                v-model:value="replaceText"
                :placeholder="t('projectSearch.replacePlaceholder')"
                :bordered="false"
                size="small"
                class="ps-input"
              />
              <!-- 保留大小写（P-20261006-16）：替换输出跟随命中词形态，与选项条的
                   Aa（区分大小写·匹配）语义正交可同开——只影响替换故驻替换行；
                   不影响命中，勾选不触发重搜 -->
              <label
                v-if="!isMultiProject"
                class="opt-chip"
                data-testid="ps-preserve-case"
                :title="t('search.replace.preserveCase')"
              >
                <n-checkbox
                  v-model:checked="preserveCase"
                  size="small"
                />
                <span>Ab</span>
              </label>
              <!-- 全选/清空三态 chip：替换范围随文件勾选收敛（跨项目模式替换不可用，不渲染） -->
              <label
                v-if="totalFiles > 0 && !isMultiProject"
                class="opt-chip ps-select-all"
              >
                <n-checkbox
                  size="small"
                  :checked="isAllSelected"
                  :indeterminate="isPartialSelected"
                  @update:checked="toggleSelectAll"
                />
                <span>{{ isAllSelected ? t('search.replace.clearAll') : t('search.replace.selectAll') }}</span>
              </label>
              <n-button
                size="tiny"
                type="primary"
                :loading="replacing"
                :disabled="matches.length === 0 || isMultiProject || selectedFileCount === 0"
                :title="isMultiProject ? t('search.projects.replaceDisabled') : undefined"
                @click="openReplacePreview"
              >
                {{ replaceButtonLabel }}
              </n-button>
            </div>
          </transition>

          <!-- 选项条 -->
          <div class="ps-options">
            <n-select
              v-model:value="projectScope"
              multiple
              size="tiny"
              :options="projectOptions"
              :max-tag-count="1"
              :placeholder="t('search.projects.scopePlaceholder')"
              class="ps-project-select"
              @update:value="scopeTouched = true"
            />
            <label
              class="opt-chip"
              :title="t('search.projects.scopeAll')"
            >
              <n-checkbox
                :checked="isAllScope"
                size="small"
                @update:checked="toggleAllScope"
              />
              <span>{{ t('search.projects.scopeAll') }}</span>
            </label>
            <label class="opt-chip">
              <n-checkbox
                v-model:checked="caseSensitive"
                size="small"
              />
              <span>Aa</span>
            </label>
            <label class="opt-chip">
              <n-checkbox
                v-model:checked="wholeWord"
                size="small"
              />
              <span>\b</span>
            </label>
            <label class="opt-chip">
              <n-checkbox
                v-model:checked="useRegex"
                size="small"
              />
              <span>.*</span>
            </label>
            <!-- 扩展名快选 chips（P-20261003-148）：点选预填 glob=*.ext，与下方
                 glob 框双向联动（active 由 filePattern 派生）；重搜走既有
                 watch(filePattern)，此处不另接搜索逻辑 -->
            <GlobExtensionChips
              :pattern="filePattern"
              @update:pattern="filePattern = $event"
            />
            <n-input
              v-model:value="filePattern"
              size="tiny"
              :bordered="true"
              :placeholder="t('projectSearch.filePattern')"
              class="ps-glob"
            />
            <div class="ps-stats">
              <span
                v-if="loading"
                class="ps-stat-loading"
              >
                <n-spin :size="11" />
                <!-- 跨项目流式搜索显示进度计数（P-20261003-94）：慢项目在途时可见快慢分化 -->
                {{ isMultiProject ? t('search.projects.progress', searchProgress) : t('projectSearch.searching') }}
                <!-- 取消钮（P-20261005-182）：仅跨项目流式进行中显示——多项目大仓长搜
                     的一步退出；单项目路径单请求生命周期短，不入范围 -->
                <button
                  v-if="isMultiProject"
                  class="ps-cancel-search"
                  data-testid="ps-cancel-search"
                  :title="t('search.projects.cancel')"
                  @click="onCancelSearch"
                >
                  <n-icon size="11">
                    <CloseOutline />
                  </n-icon>
                  <span>{{ t('search.projects.cancel') }}</span>
                </button>
              </span>
              <template v-else>
                <!-- 已取消标注（P-20261005-182）：到账口径如实注记，部分结果照常可用 -->
                <span
                  v-if="searchCancelled"
                  class="ps-stat-cancelled"
                  data-testid="ps-cancelled-note"
                >{{ t('search.projects.cancelled', cancelledProgress) }}</span>
                <span
                  v-if="totalMatches > 0"
                  class="ps-stat-summary"
                >
                  <strong>{{ totalMatches }}</strong> {{ t('projectSearch.matchesIn') }}
                  <strong>{{ totalFiles }}</strong> {{ t('projectSearch.filesUnit') }}
                  <span
                    v-if="anyTruncated"
                    class="ps-stat-truncated"
                  >{{ isMultiProject ? t('search.projects.truncatedHint') : t('projectSearch.truncatedHint') }}</span>
                  <span
                    v-else-if="isOversizeScope"
                    class="ps-stat-truncated"
                  >{{ t('search.projects.rangeHint', { n: searchProjectIds.length }) }}</span>
                </span>
              </template>
              <!-- 复制全部路径（P-20261003-149）：结果头小钮，随统计行内联；
                   跨项目流式搜索加载中禁用（防复制到半程快照） -->
              <button
                v-if="totalMatches > 0"
                class="ps-copy-paths"
                data-testid="ps-copy-paths"
                :disabled="loading"
                :title="t('projectSearch.copyPaths')"
                @click="onCopyAllPaths"
              >
                <n-icon size="12">
                  <CopyOutline />
                </n-icon>
              </button>
              <!-- 结果导出 CSV（P-20261003-272）：复制路径邻位同族小钮，纯前端生成
                   下载（当前结果集即数据面）；加载中禁用同款半程快照防线 -->
              <button
                v-if="totalMatches > 0"
                class="ps-export-csv"
                data-testid="ps-export-csv"
                :disabled="loading"
                :title="t('projectSearch.exportCsv')"
                @click="onExportCsv"
              >
                <n-icon size="12">
                  <DownloadOutline />
                </n-icon>
              </button>
            </div>
          </div>

          <!-- 查询历史下拉（P-20261003-48；P-20261006-32 起锚定头部件下缘=选项
               chips 行之下，不再盖 chips——想点「Aa/\b/.*」时下拉悬在头上点不到，
               50f7fb0c e2e 实证）：mousedown.prevent 保输入框焦点（点击不先触发
               blur）；absolute 悬浮在结果区顶部，结果行 mousedown 先 blur 收下拉、
               布局不动落点不漂（流内布局会在 mousedown/mouseup 间位移换行故不取） -->
          <div
            v-if="historyVisible"
            class="ps-history"
            data-testid="ps-history"
            @mousedown.prevent
          >
            <div
              v-if="historyAllFilteredOut"
              class="ps-history-empty"
              data-testid="ps-history-empty"
            >
              {{ t('projectSearch.history.empty') }}
            </div>
            <div
              v-else
              class="ps-history-list"
            >
              <button
                v-for="(h, hi) in historyItems"
                :key="h"
                class="ps-history-item"
                :data-testid="`ps-history-item-${hi}`"
                :title="h"
                @click="applyHistory(h)"
              >
                <n-icon
                  size="12"
                  class="ps-history-item-icon"
                >
                  <SearchOutline />
                </n-icon>
                <span class="ps-history-item-text">{{ h }}</span>
              </button>
            </div>
            <button
              class="ps-history-clear"
              data-testid="ps-history-clear"
              @click="onClearHistory"
            >
              <n-icon size="12">
                <TrashOutline />
              </n-icon>
              <span>{{ t('projectSearch.history.clear') }}</span>
            </button>
          </div>
        </div>

        <!-- 结果列表 -->
        <div
          ref="resultsRef"
          class="ps-results"
        >
          <div
            v-if="error"
            class="ps-error"
          >
            {{ error }}
          </div>
          <div
            v-else-if="!query.trim()"
            class="ps-hint"
          >
            {{ t('projectSearch.startHint') }}
          </div>
          <div
            v-else-if="loading && matches.length === 0"
            class="ps-loading"
          >
            <n-spin size="small" />
            <span>{{ t('projectSearch.searching') }}</span>
          </div>
          <div
            v-else-if="totalMatches === 0"
            class="ps-empty"
          >
            <n-empty
              size="small"
              :description="t('projectSearch.noResults')"
            />
          </div>
          <div
            v-else
            class="ps-list"
          >
            <div
              v-for="pg in renderGroups"
              :key="pg.projectId || '__current__'"
              class="ps-project-group"
            >
              <!-- 项目组头（仅跨项目模式渲染） -->
              <div
                v-if="pg.projectId"
                class="ps-project-header"
                :title="pg.name"
              >
                <n-icon
                  size="13"
                  class="ps-project-icon"
                >
                  <FolderOpenOutline />
                </n-icon>
                <span class="ps-project-name">{{ pg.name }}</span>
                <span
                  v-if="pg.error"
                  class="ps-project-error"
                >{{ t('search.projects.projectFailed') }}</span>
                <span
                  v-else-if="pg.pending"
                  class="ps-project-pending"
                  :title="t('projectSearch.searching')"
                ><n-spin :size="10" /></span>
                <span
                  v-else
                  class="ps-project-count"
                >{{ pg.hitCount }}</span>
              </div>
              <template v-if="!pg.error">
                <div
                  v-for="group in pg.fileGroups"
                  :key="group.path"
                  class="ps-file-group"
                >
                  <div
                    class="ps-file-header"
                    :title="group.path"
                  >
                    <!-- 文件级勾选（展开替换行时出现）：决定该文件是否参与替换 -->
                    <n-checkbox
                      v-if="showReplace"
                      size="small"
                      class="ps-file-check"
                      :checked="selectedPaths.has(group.path)"
                      :disabled="isMultiProject"
                      @update:checked="(checked: boolean) => toggleFileSelection(group.path, checked)"
                    />
                    <n-icon
                      size="13"
                      class="ps-file-icon"
                    >
                      <DocumentTextOutline />
                    </n-icon>
                    <span class="ps-file-name">{{ group.path.split('/').pop() }}</span>
                    <span class="ps-file-path">{{ group.path }}</span>
                    <span class="ps-file-count">{{ group.matches.length }}</span>
                    <!-- 结果行删除（P-20261003-178）：文件组头尾部小钮，确认后删除并
                         即时移除该文件全部结果；跨项目模式禁用（title 说明原因） -->
                    <button
                      class="ps-file-delete"
                      data-testid="ps-file-delete"
                      :disabled="isMultiProject || deletingPath === group.path"
                      :title="isMultiProject ? t('search.projects.deleteDisabled') : t('projectSearch.deleteResult')"
                      @click="onDeleteResult(group.path)"
                    >
                      <n-icon size="12">
                        <TrashOutline />
                      </n-icon>
                    </button>
                  </div>
                  <button
                    v-for="m in group.matches.slice(0, visibleCount(group))"
                    :key="`${m.path}:${m.line}:${m.column}`"
                    class="ps-line"
                    :class="{ 'is-active': isActive(m) }"
                    @click="openMatch(m, pg.projectId)"
                  >
                    <span class="ps-line-num">{{ m.line }}</span>
                    <span class="ps-line-content">
                      <template v-if="highlight(m.content, m.match).match">
                        <span class="hl-before">{{ highlight(m.content, m.match).before }}</span>
                        <span class="hl-match">{{ highlight(m.content, m.match).match }}</span>
                        <span class="hl-after">{{ highlight(m.content, m.match).after }}</span>
                      </template>
                      <template v-else>{{ m.content }}</template>
                    </span>
                  </button>
                  <div
                    v-if="group.matches.length > visibleCount(group)"
                    class="ps-more"
                  >
                    +{{ group.matches.length - visibleCount(group) }} {{ t('projectSearch.more') }}
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- 键盘走查键位提示（P-20261006-23）：有命中才有可遍历对象，随结果出现；
             置卡片脚注不随结果列表滚动（走查中键位表常在） -->
        <div
          v-if="totalMatches > 0"
          class="ps-kbd-hint"
          data-testid="ps-kbd-hint"
        >
          {{ t('projectSearch.kbdHint') }}
        </div>
      </div>

      <!-- 替换预览弹层（P-20261003-71）：before→after 对照 + 勾选收敛，确认仅作用勾选文件 -->
      <ReplacePreviewModal
        v-model:show="showPreview"
        :files="previewFiles"
        :selected-paths="selectedPaths"
        :executing="replacing"
        @toggle-file="toggleFileSelection"
        @toggle-all="toggleSelectAll"
        @confirm="executeReplace"
      />
    </div>
  </transition>
</template>

<style scoped src="./project-search.css"></style>
