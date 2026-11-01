<script setup lang="ts">
// 命令面板 / Quick Open 二合一弹窗
// - 输入以 ">" 开头：命令模式，过滤命令列表
// - 否则：文件模式，模糊匹配过滤当前项目文件列表（utils/fuzzy 子序列打分排序）
// 快捷键：↑↓ 选择、Enter 执行、Esc 双层退出（有查询先清、空查询才关，P-20261004-95）
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useVirtualList } from '@vueuse/core'
import { NIcon, NInput } from 'naive-ui'
import { SearchOutline, ChevronForwardOutline, DocumentTextOutline, ServerOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { fuzzyScoreWeighted } from '../../utils/fuzzy'
import { parseFileLineQuery } from '../../utils/fileLineQuery'
import {
  loadCmdUsage, saveCmdUsage, recordCmdUsage, topFrequentCmdIds, compareCmdFrecency,
  loadFileUsage,
  type CmdUsageMap,
} from '../../utils/paletteUsage'

export interface PaletteCommand {
  id: string
  title: string
  subtitle?: string
  category?: string
  icon?: any
  shortcut?: string[]
  keywords?: string
}

export interface PaletteFile {
  path: string
  name: string
}

/** 远程文件层条目（P-20261004-137）：path 仍是 remote: 伪路径（选中经既有
 *  openFile 远程分支打开），rpath/hostName 只服务独立分组渲染（host 徽标 +
 *  远端绝对路径次行）与模糊匹配（rpath 直接参与） */
export interface PaletteRemoteFile extends PaletteFile {
  hostId: string
  rpath: string
  hostName: string
}

/** 远程条目判定（结构判据：远程层条目一律携 rpath/hostId；项目相对路径不带） */
function isRemoteFile(f: PaletteFile): f is PaletteRemoteFile {
  const r = f as Partial<PaletteRemoteFile>
  return typeof r.rpath === 'string' && typeof r.hostId === 'string'
}

export type PaletteItem =
  | { kind: 'command'; cmd: PaletteCommand }
  | { kind: 'file'; file: PaletteFile }

const props = defineProps<{
  show: boolean
  commands: PaletteCommand[]
  files: PaletteFile[]
  /** 远程文件层（P-20261004-137）：独立分组追加在项目文件分组之后——不并入
   *  files，保项目候选的计数/匹配/frecency/最近置顶语义零变化 */
  remoteFiles?: PaletteRemoteFile[]
  recentFiles?: PaletteFile[]
  /** 文件列表是否正在加载——决定空态文案 */
  filesLoading?: boolean
  /** 打开时的初始模式：'commands' 预置 '>' 直达命令模式（Ctrl+Shift+P） */
  initialMode?: 'files' | 'commands'
  /** 源文件列表是否触达索引上限（P-20261002-77）——列表尾部显示弱提示行 */
  filesTruncated?: boolean
  /** 文件层 frecency 作用域 = 当前项目 id（P-20261005-222）：空串/缺省不读
   *  usage（首页无项目态文件模式本就无数据面） */
  projectId?: string
}>()

const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
  (e: 'run-command', id: string): void
  /** line/col：文件名:行号直达语法（P-20261003-302）解析出的定位参数，宿主走 handleSearchOpenFile 既有行定位链 */
  (e: 'open-file', path: string, line?: number, col?: number): void
  /** 文件模式 Ctrl/Cmd+Enter（P-20261002-106）：选中文件在右侧分屏打开（无行定位语义） */
  (e: 'open-file-split', path: string): void
  /** 空结果降级（P-20261002-86）：文件模式无命中，带查询词去项目搜索 */
  (e: 'fallback-search', query: string): void
}>()

const { t } = useI18n()
const query = ref('')
const selectedIndex = ref(0)
const inputRef = ref<InstanceType<typeof NInput> | null>(null)

/** 文件层 frecency（P-20261005-222）：当前项目的 path → {count,lastAt}，
 *  键序/上限/过期与命令层同机制分 key（见 paletteUsage 文件层节）。声明于
 *  groups 之前——文件模式排序比较器无条件读它，而 groups 链在 setup 期就会被
 *  useVirtualList 立即求值（命令层的 cmdUsage 仅被命令模式分支读取、首评跳过，
 *  留在下方声明无害；此处不然，置前是硬性要求非风格偏好） */
const fileUsage = ref<CmdUsageMap>({})

const isCommandMode = computed(() => query.value.trimStart().startsWith('>'))

const normalizedQuery = computed(() => {
  if (isCommandMode.value) return query.value.replace(/^\s*>/, '').trim().toLowerCase()
  return query.value.trim().toLowerCase()
})

/** 行号直达语法（P-20261003-302）：文件模式查询串尾 `:N` / `:N:C` 的解析结果
 *  （命令模式不解析——`>` 后的冒号是命令语义）。仅解析剥离，是否启用行语义
 *  见 fileModeMatch 的双兜底 */
const fileLineQuery = computed(() => (isCommandMode.value ? null : parseFileLineQuery(query.value)))

/**
 * 文件模式的实际匹配词与行定位参数（查询解析收口，打分与条目子标题/选中链共用）：
 * 尾缀 `:N` 剥离后仍有文件命中才启用行语义——含冒号的罕见文件名不被误剥离
 * （剥离后零命中则整串回退普通匹配，与不带行号行为一致），即提案约定的双兜底。
 * 双兜底判定需一次 O(文件数) 的 early-exit 模糊匹配，仅在查询尾形如 :N 时发生。
 */
const fileModeMatch = computed<{ text: string; lineSel: { line: number; col?: number } | null }>(() => {
  if (isCommandMode.value) return { text: '', lineSel: null }
  const flq = fileLineQuery.value
  if (flq) {
    const needle = flq.text.toLowerCase()
    // 远程层同参与行号语法判定（P-20261004-137）：远端文件同样可 name:80 直达；
    // 项目文件仍以 path 为兜底字段、远程以 rpath（远端绝对路径直接参与匹配）
    const files = props.files
    const remote = props.remoteFiles || []
    if (
      files.some(f => fuzzyScoreWeighted(needle, f.name, f.path) !== null)
      || remote.some(f => fuzzyScoreWeighted(needle, f.name, f.rpath) !== null)
    ) {
      return { text: needle, lineSel: { line: flq.line, col: flq.col } }
    }
  }
  return { text: normalizedQuery.value, lineSel: null }
})

// 分组：最近文件 / 所有文件
interface RenderGroup {
  label: string
  items: PaletteItem[]
}

const groups = computed<RenderGroup[]>(() => {
  if (isCommandMode.value) {
    // 模糊打分排序：标题命中 ×2，关键词/分类兜底；frecency 只做同分破平
    // （P-20261005-200）——动态命令族（切分支/诊断主机/模板/设置分区）标题同构，
    // 模糊分常打平，高频目标借使用记录浮到第一位省 3-5 个方向键。分数与
    // frecency 都相同时稳定排序回落静态注册序（零使用命令互不重排防跳动）
    const now = Date.now()
    const list = props.commands
      .map(c => ({
        c,
        score: fuzzyScoreWeighted(normalizedQuery.value, c.title, [c.keywords, c.category].filter((k): k is string => !!k).join(' ')),
      }))
      .filter((x): x is { c: PaletteCommand; score: number } => x.score !== null)
      .sort((a, b) =>
        b.score - a.score
        || compareCmdFrecency(cmdUsage.value[a.c.id], cmdUsage.value[b.c.id], now))
      .map(x => x.c)
    if (list.length === 0) return []
    const result: RenderGroup[] = []
    // 空查询：frecency 置顶组（P-20261002-107 记录，P-20261005-200 排序——最近
    // 窗口档优先、次数权重、lastAt 破平；其余分组不再重复出现）
    let remaining = list
    if (!normalizedQuery.value) {
      const usedIds = topFrequentCmdIds(cmdUsage.value, 5, now)
      const top = usedIds
        .map(id => list.find(c => c.id === id))
        .filter((c): c is PaletteCommand => !!c)
      if (top.length > 0) {
        result.push({ label: t('commandPalette.frequentCommands'), items: top.map(c => ({ kind: 'command' as const, cmd: c })) })
        const pinned = new Set(top.map(c => c.id))
        remaining = list.filter(c => !pinned.has(c.id))
      }
    }
    // 按 category 分组
    const byCat = new Map<string, PaletteCommand[]>()
    for (const c of remaining) {
      const cat = c.category || ''
      if (!byCat.has(cat)) byCat.set(cat, [])
      byCat.get(cat)!.push(c)
    }
    result.push(...Array.from(byCat.entries()).map(([cat, items]) => ({
      label: cat || t('commandPalette.title'),
      items: items.map(c => ({ kind: 'command' as const, cmd: c })),
    })))
    return result
  }
  // 文件模式：文件名命中 ×2、路径兜底，按分数降序（原名匹配则是纯子串，
  // `urepo` 找不到 `useRepo.ts`）；空查询全 0 分保持原序。
  // 匹配词经 fileModeMatch 收口——行号直达语法在此剥离（P-20261003-302）。
  // 同分带 frecency 破平（P-20261005-222）：匹配分严格相等才比较文件层使用
  // 记录（compareCmdFrecency/topFrequentCmdIds 为 {count,lastAt} 通用形态，
  // 两层数据共用）——匹配语义优先，常开文件不会压过匹配更好的文件；无记录
  // 条目按零使用两两持平，稳定排序回落清单原序防跳动
  const now = Date.now()
  const scored = props.files
    .map(f => ({ f, score: fuzzyScoreWeighted(fileModeMatch.value.text, f.name, f.path) }))
    .filter((x): x is { f: PaletteFile; score: number } => x.score !== null)
    .sort((a, b) =>
      b.score - a.score
      || compareCmdFrecency(fileUsage.value[a.f.path], fileUsage.value[b.f.path], now))
  const matched = scored.map(x => x.f)
  // 最近打开置顶
  const recentSet = new Set((props.recentFiles || []).map(f => f.path))
  const result: RenderGroup[] = []
  // 空查询置顶段（P-20261005-222）：文件层 frecency 前 5「继续上次工作」——
  // 刚打开面板未输入时高频文件直达。条目须仍在当前清单内（已删/改名文件自然
  // 落选，存储侧打开失败清理 + TTL 过期兜底），置顶文件自下方分组去重——同
  // 文件只出现一次，命令层置顶组同款
  let pool = matched
  if (!normalizedQuery.value) {
    const top = topFrequentCmdIds(fileUsage.value, 5, now)
      .map(p => matched.find(f => f.path === p))
      .filter((f): f is PaletteFile => !!f)
    if (top.length > 0) {
      result.push({ label: t('quickOpen.resumeWork'), items: top.map(f => ({ kind: 'file' as const, file: f })) })
      const pinned = new Set(top.map(f => f.path))
      pool = matched.filter(f => !pinned.has(f.path))
    }
  }
  const recent = pool.filter(f => recentSet.has(f.path))
  const others = pool.filter(f => !recentSet.has(f.path))
  if (recent.length > 0) {
    result.push({ label: t('quickOpen.recent'), items: recent.map(f => ({ kind: 'file' as const, file: f })) })
  }
  if (others.length > 0) {
    result.push({ label: t('quickOpen.allFiles'), items: others.map(f => ({ kind: 'file' as const, file: f })) })
  }
  // 远程文件层独立分组（P-20261004-137）：匹配复用同一模糊打分（name + rpath
  // 双字段）；frecency/最近置顶/截断提示均属项目清单域，不作用于本组——远程
  // 条目按「已开签在前、最近远程随后」的派生序稳定排列（同分不重排）
  const remoteMatched = (props.remoteFiles || [])
    .map(f => ({ f, score: fuzzyScoreWeighted(fileModeMatch.value.text, f.name, f.rpath) }))
    .filter((x): x is { f: PaletteRemoteFile; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map(x => x.f)
  if (remoteMatched.length > 0) {
    result.push({
      label: t('quickOpen.remoteFiles'),
      items: remoteMatched.map(f => ({ kind: 'file' as const, file: f })),
    })
  }
  return result
})

// 扁平化所有 item（用于键盘导航索引）。
// P1-11 虚拟滚动：空查询时全仓文件可达数千条，历史实现静态截断前 100 条——
// 截断外的条目键盘可达但 DOM 缺失（scrollIntoView 失效）。现在分组标签扁平为
// 定高行 + vueuse 变高 itemHeight 窗口化，全量可滚动可导航
const flatItems = computed<PaletteItem[]>(() => {
  const out: PaletteItem[] = []
  for (const g of groups.value) out.push(...g.items)
  return out
})

// 行模型：分组标签行 + 条目行 + 截断提示行；高度与模板内联 style 强制值一致
type FlatRow =
  | { kind: 'label'; label: string; height: number }
  | { kind: 'item'; item: PaletteItem; globalIndex: number; height: number }
  | { kind: 'hint'; label: string; height: number }

const ROW_H_LABEL = 26
const ROW_H_HINT = 28
function rowHeightOf(it: PaletteItem): number {
  if (it.kind === 'file') return 52 // 标题 + 路径副标题
  return it.cmd.subtitle ? 52 : 36
}

function rowKeyOf(r: FlatRow): string {
  if (r.kind === 'label') return `l-${r.label}`
  if (r.kind === 'hint') return 'cap-hint'
  return `i-${r.globalIndex}`
}

const flatRows = computed<FlatRow[]>(() => {
  const rows: FlatRow[] = []
  let n = 0
  for (const g of groups.value) {
    if (g.items.length === 0) continue
    rows.push({ kind: 'label', label: g.label, height: ROW_H_LABEL })
    for (const it of g.items) {
      rows.push({ kind: 'item', item: it, globalIndex: n++, height: rowHeightOf(it) })
    }
  }
  // 索引截断弱提示（P-20261002-77）：源列表达上限时缀于列表尾部。非可选项——
  // 不进 flatItems，键盘导航停在最后一个条目上；命令模式列的是命令，提示行无意义
  if (props.filesTruncated && !isCommandMode.value && flatItems.value.length > 0) {
    rows.push({ kind: 'hint', label: t('quickOpen.indexCapped', { n: props.files.length }), height: ROW_H_HINT })
  }
  return rows
})

// 键盘选中索引 → 扁平行索引（scrollTo 定位用）
const actionableRow = computed(() => {
  const m = new Map<number, number>()
  flatRows.value.forEach((r, i) => {
    if (r.kind === 'item') m.set(r.globalIndex, i)
  })
  return m
})

const { list: visibleRows, containerProps: paletteContainerProps, wrapperProps: paletteWrapperProps, scrollTo } =
  useVirtualList(flatRows, { itemHeight: (i: number) => flatRows.value[i]?.height ?? 44, overscan: 12 })

watch(() => props.show, async (val) => {
  if (val) {
    query.value = props.initialMode === 'commands' ? '>' : ''
    selectedIndex.value = 0
    cmdUsage.value = loadCmdUsage()
    // 文件层 frecency（P-20261005-222）：记录发生在 openFile 成功链（面板外
    // 写入），打开面板时点重读保证置顶段与同分破平拿到最新账
    fileUsage.value = props.projectId ? loadFileUsage(props.projectId) : {}
    await nextTick()
    inputRef.value?.focus()
  }
})

/** 常用命令 usage（P-20261002-107）：执行即计数——safeStorage 持久 map
 *  cmdId → {count, lastAt}（上限 50 键 LRU + 条目 30 天过期，见 paletteUsage），
 *  替代旧「最近 5」MRU 数组，重度用户高频命令稳定置顶。frecency 排序
 *  （P-20261005-200）：置顶组取 topFrequentCmdIds(5)、查询路径模糊同分以
 *  compareCmdFrecency 破平，详见 groups */
const cmdUsage = ref<CmdUsageMap>({})

function rememberCommand(id: string) {
  cmdUsage.value = recordCmdUsage(cmdUsage.value, id)
  saveCmdUsage(cmdUsage.value)
}

/** 点击「命令模式」提示 = 直接进入命令模式。此前是纯展示 span，但放在
 *  可交互面板里用户（与自动化巡检）都会本能去点——索性做成按钮语义 */
function enterCommandsMode() {
  query.value = '>'
  inputRef.value?.focus()
}

watch(flatItems, () => {
  if (selectedIndex.value >= flatItems.value.length) {
    selectedIndex.value = Math.max(0, flatItems.value.length - 1)
  }
})

function activate(idx: number) {
  const item = flatItems.value[idx]
  if (!item) return
  if (item.kind === 'command') {
    rememberCommand(item.cmd.id)
    emit('run-command', item.cmd.id)
  } else {
    // 行号直达（P-20261003-302）：带 :N 的选中走宿主 handleSearchOpenFile
    // 既有行定位链（预览位 + 行定位轮询现成）；无行号时 lineSel 为 null 行为不变
    const sel = fileModeMatch.value.lineSel
    emit('open-file', item.file.path, sel?.line, sel?.col)
  }
  emit('update:show', false)
}

/** 空结果降级（P-20261002-86）：文件模式无命中时引导「改搜内容」——关面板并
 *  带查询词打开项目搜索（Ctrl+Shift+F 的等价路径）。仅文件模式；命令模式空态
 *  保持纯文案。空查询（仓库本无文件）不引导 */
const canFallbackSearch = computed(() =>
  !isCommandMode.value && !props.filesLoading && flatItems.value.length === 0 && !!normalizedQuery.value,
)

function openFallbackSearch() {
  if (!canFallbackSearch.value) return
  // 降级搜的是文件名（内容搜索），行号后缀是位置指令不是检索词——解析成功
  // 即剥离（P-20261003-302）；解析失败（如 foo:bar）保持原样
  emit('fallback-search', fileLineQuery.value ? fileLineQuery.value.text : query.value.trim())
  emit('update:show', false)
}

function onInputKeydown(e: KeyboardEvent) {
  // 面板打开期间 Ctrl/Cmd+Shift+P = 切换命令模式。全局 handler 对打开的弹窗让位
  // （useLayoutKeyboard isDialogOpen 提前 return），「直达命令模式」的已打开态由
  // 面板自己承接，否则面板开着时该快捷键完全失效，与 VS Code 惯例不符
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault()
    e.stopPropagation()
    enterCommandsMode()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, Math.max(0, flatItems.value.length - 1))
    scrollSelectedIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
    scrollSelectedIntoView()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    // 空结果降级（P-20261002-86）：无可选项时 Enter = 执行降级动作
    if (canFallbackSearch.value) {
      openFallbackSearch()
      return
    }
    // 分屏打开（P-20261002-106）：文件模式下 Ctrl/Cmd+Enter = 选中文件进右侧
    // 分屏组（「搜到即对照」一步到位）。命令模式无分屏语义，照常执行。
    // 行号直达仅主组链路（openInSplitByPath 无行定位链），分屏打开忽略 :N 后缀
    if ((e.ctrlKey || e.metaKey) && !isCommandMode.value) {
      const item = flatItems.value[selectedIndex.value]
      if (item?.kind === 'file') {
        emit('open-file-split', item.file.path)
        emit('update:show', false)
        return
      }
    }
    activate(selectedIndex.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    // Esc 双层退出（P-20261004-95，VS Code「先清后关」惯例）：长查询输到一半
    // 误按 Esc 不再连查询带面板同失重来。判定用 normalizedQuery（命令模式剥
    // '>' 后的有效查询）而非 query 本身——裸 '>' 的原生命令模式视同已空，
    // Esc 直接关闭不空转；有查询时清空保留 '>' 前缀（模式语义不漂移回文件
    // 模式），选中归零重新起查。宿主 esc-layered 链（useLayoutKeyboard）对打开
    // 的面板整体让位（isDialogOpen 含 showCommandPalette），故无需
    // stopPropagation 也一次只退 palette 一层
    if (normalizedQuery.value) {
      query.value = isCommandMode.value ? '>' : ''
      selectedIndex.value = 0
      inputRef.value?.focus()
      scrollSelectedIntoView()
      return
    }
    emit('update:show', false)
  }
}

function scrollSelectedIntoView() {
  nextTick(() => {
    const row = actionableRow.value.get(selectedIndex.value)
    if (row !== undefined) scrollTo(row)
  })
}

// 在弹窗内监听全局键盘事件，避免输入框失焦后无法操作
function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show) return
  // 焦点不在输入框（如点过列表项）时同样响应命令模式直达键
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
    onInputKeydown(e)
    return
  }
  if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
    onInputKeydown(e)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

function modeLabel() {
  return isCommandMode.value ? t('commandPalette.commands') : t('quickOpen.placeholder')
}

// Esc 双层退出的底部键位提示随态切换（P-20261004-95）：有查询=清空查询，
// 空查询=关闭——与 onInputKeydown 的 Esc 分支同一判定源（normalizedQuery），
// 提示不撒谎
const escHintKey = computed(() =>
  normalizedQuery.value ? 'commandPalette.clearQuery' : 'commandPalette.close',
)

// 跨平台快捷键显示：macOS 用 ⌘ 替换 Ctrl
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')
function formatKey(k: string): string {
  if (!isMac) return k
  if (k === 'Ctrl') return '⌘'
  if (k === 'Alt') return '⌥'
  if (k === 'Shift') return '⇧'
  return k
}
</script>

<template>
  <transition name="palette-fade">
    <div
      v-if="props.show"
      class="palette-mask"
      @click.self="emit('update:show', false)"
    >
      <div class="palette-card glass-panel">
        <!-- 顶部输入框 -->
        <div class="palette-input-row">
          <n-icon
            size="14"
            class="palette-input-icon"
          >
            <SearchOutline />
          </n-icon>
          <n-input
            ref="inputRef"
            v-model:value="query"
            :placeholder="modeLabel()"
            class="palette-input"
            size="large"
            :bordered="false"
            @keydown="onInputKeydown"
          />
          <span class="palette-mode-badge">{{ isCommandMode ? t('commandPalette.commands') : t('quickOpen.files') }}</span>
        </div>

        <!-- 列表（虚拟滚动：分组标签 + 条目均为定高行）。
             注意：v-bind 已携带 vueuse 的 containerRef，此处不能再叠加静态 ref（会覆盖导致视口测量失效） -->
        <div
          v-bind="paletteContainerProps"
          class="palette-list"
        >
          <div
            v-if="flatItems.length === 0"
            class="palette-empty"
            :class="{ 'palette-empty-fallback': canFallbackSearch }"
          >
            <template v-if="filesLoading && !isCommandMode">
              {{ t('commandPalette.loading') }}
            </template>
            <!-- 空结果降级（P-20261002-86）：「改搜内容」引导行 -->
            <template v-else-if="canFallbackSearch">
              <span class="palette-fallback-text">{{ t('commandPalette.fallback.hint') }}</span>
              <button
                type="button"
                class="palette-fallback-action"
                @click="openFallbackSearch"
              >
                {{ t('commandPalette.fallback.action') }}
              </button>
            </template>
            <template v-else>
              {{ t('commandPalette.noResults') }}
            </template>
          </div>
          <div
            v-else
            v-bind="paletteWrapperProps"
          >
            <template
              v-for="row in visibleRows"
              :key="rowKeyOf(row.data)"
            >
              <!-- 分组标签行 -->
              <div
                v-if="row.data.kind === 'label'"
                class="palette-group-label"
                :style="{ height: row.data.height + 'px' }"
              >
                {{ row.data.label }}
              </div>
              <!-- 索引截断弱提示行（非交互，不可选中） -->
              <div
                v-else-if="row.data.kind === 'hint'"
                class="palette-cap-hint"
                :style="{ height: row.data.height + 'px' }"
              >
                {{ row.data.label }}
              </div>
              <!-- 条目行 -->
              <button
                v-else
                :data-idx="row.data.globalIndex"
                class="palette-item"
                :class="{
                  active: row.data.globalIndex === selectedIndex,
                  'palette-item-remote': row.data.item.kind === 'file' && isRemoteFile(row.data.item.file),
                }"
                :style="{ height: row.data.height + 'px' }"
                @click="activate(row.data.globalIndex)"
                @mousemove="selectedIndex = row.data.globalIndex"
              >
                <!-- 命令项 -->
                <template v-if="row.data.item.kind === 'command'">
                  <n-icon
                    v-if="row.data.item.cmd.icon"
                    size="14"
                    class="palette-item-icon"
                  >
                    <component :is="row.data.item.cmd.icon" />
                  </n-icon>
                  <span
                    v-else
                    class="palette-item-glyph"
                  >&gt;</span>
                  <div class="palette-item-main">
                    <div class="palette-item-title">
                      {{ row.data.item.cmd.title }}
                    </div>
                    <div
                      v-if="row.data.item.cmd.subtitle"
                      class="palette-item-sub"
                    >
                      {{ row.data.item.cmd.subtitle }}
                    </div>
                  </div>
                  <div
                    v-if="row.data.item.cmd.shortcut"
                    class="palette-item-shortcut"
                  >
                    <kbd
                      v-for="k in row.data.item.cmd.shortcut"
                      :key="k"
                    >{{ formatKey(k) }}</kbd>
                  </div>
                </template>
                <!-- 文件项 -->
                <template v-else>
                  <n-icon
                    size="14"
                    class="palette-item-icon"
                  >
                    <ServerOutline v-if="isRemoteFile(row.data.item.file)" />
                    <DocumentTextOutline v-else />
                  </n-icon>
                  <div class="palette-item-main">
                    <div class="palette-item-title">
                      {{ row.data.item.file.name }}
                    </div>
                    <div class="palette-item-sub palette-item-path">
                      <!-- 远程层（P-20261004-137）：host 别名徽标 + 远端绝对路径
                           次行——与项目相对路径形态一眼可辨 -->
                      <template v-if="isRemoteFile(row.data.item.file)">
                        <span
                          class="palette-item-remote-badge"
                          :title="row.data.item.file.hostName"
                        >{{ row.data.item.file.hostName }}</span>
                        <span class="palette-item-path-text">{{ row.data.item.file.rpath }}</span>
                      </template>
                      <span
                        v-else
                        class="palette-item-path-text"
                      >{{ row.data.item.file.path }}</span>
                      <!-- 行号直达提示（P-20261003-302）：查询带 :N 且命中时展示去向行 -->
                      <span
                        v-if="fileModeMatch.lineSel"
                        class="palette-item-linehint"
                      >→ {{ t('quickOpen.gotoLine', { n: fileModeMatch.lineSel.line }) }}</span>
                    </div>
                  </div>
                  <n-icon
                    size="12"
                    class="palette-item-enter"
                  >
                    <ChevronForwardOutline />
                  </n-icon>
                </template>
              </button>
            </template>
          </div>
        </div>

        <!-- 底部提示条 -->
        <div class="palette-footer">
          <span class="palette-hint">
            <kbd>↑</kbd><kbd>↓</kbd> {{ t('commandPalette.navigate') }}
            <span class="dot">·</span>
            <kbd>↵</kbd> {{ t('commandPalette.select') }}
            <!-- 文件模式：Ctrl/Cmd+Enter 在右侧分屏打开（P-20261002-106） -->
            <template v-if="!isCommandMode">
              <span class="dot">·</span>
              <kbd>{{ formatKey('Ctrl') }}</kbd><kbd>↵</kbd> {{ t('commandPalette.selectSplit') }}
            </template>
            <span class="dot">·</span>
            <kbd>Esc</kbd> {{ t(escHintKey) }}
          </span>
          <button
            class="palette-mode-hint"
            type="button"
            @click="enterCommandsMode"
          >
            <code>&gt;</code> {{ t('commandPalette.commandsMode') }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped src="./command-palette.css"></style>
