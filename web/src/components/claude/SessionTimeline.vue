<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualList } from '@vueuse/core'
import { NButton, NDropdown, NIcon, NInput, NSpin, useMessage } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import {
  ChatbubblesOutline,
  ChevronDownOutline,
  CopyOutline,
  DocumentTextOutline,
  PricetagOutline,
  TerminalOutline,
  AlertCircleOutline,
  PersonCircleOutline,
  ShareSocialOutline,
  SparklesOutline,
  Star,
  StarOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { fetchWithEgressGate } from '../../composables/useEgressGate'
import { claudeApi, type ClaudeSessionInfo, type ClaudeTimelineEntry, type ClaudeTurnTag } from '../../api/domains/claude'
import { relativeTimeParts } from '../../utils/relative-time'
import { maskSensitive } from '../../utils/sensitiveMask'
import { exportFileName } from '../../utils/exportFileName'
import { renderCurationMarkdown } from '../../utils/claudeCurationExport'
import { buildSessionDeepLinkUrl, projectIdForCwd } from '../../utils/sessionDeepLink'
import { copyText } from '../../utils/clipboard'
import { useProjectStore } from '../../stores/project'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useClaudeSessionSummary } from '../../composables/useClaudeSessionSummary'
import { useShareDialog } from '../../composables/useShareDialog'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'

/**
 * 会话回放时间线（P-20261001-3）：按时间正序逐步渲染一条 Claude 会话的
 * transcript——用户指令、assistant 回复、工具调用（名称+关键输入，可折叠）、
 * 工具结果（成功/失败）。每步显示时刻与相对时间，相邻步间隔 ≥1 分钟时以
 * 间隔徽标呈现（时间间隔可见）。
 *
 * 数据直读服务端 /claude/sessions/:id/timeline（transcript 尾部窗口），分页
 * 「加载更多」向后追加更新的步骤；超窗（truncated）时提示仅最近一段。
 *
 * 时间线内搜索（P-20261002-81）：头部搜索框对已加载条目的可见文本做子串
 * 过滤（即时命中计数徽标），Enter/Shift+Enter 在命中间循环跳转，「仅命中」
 * 隐藏未命中条目；服务端 q 参数留二期。正则开关（P-20261003-196）：开启按
 * 正则匹配，非法正则降级字面并就地提示——错误/路径模式一步定位。
 *
 * 继续此会话（P-20261002-96）：footer 主按钮复用 picker 的恢复链路（新建
 * agent 终端注入 `claude --resume <id>`）——回放的价值终点常是续聊，行动
 * 出口就在回放现场；成功后 emit resumed(sessionId) 交宿主关弹层。
 *
 * 敏感遮蔽（P-20261004-14）：transcript 常含口令/令牌回显（agent 执行时 echo
 * 的 env/密码/密钥），回放是投屏/截图/旁人路过场景——消息正文与工具输入摘要
 * 默认经 P-108 maskSensitive() 遮蔽（头部「显示原文」确认后放行，纯展示层，
 * API 返回原文不变）。P-108 前端单一权威模式集（utils/sensitiveMask.ts）复用，
 * 与录制回放侧（utils/recording parseCast 双保险）同一套防线。
 *
 * 导出双格式（P-20261003-44 + P-20261003-60）：工具条「导出」下拉两选——
 * Markdown 为服务端 timeline 解析基建渲染的人读文档（分节/工具摘要/思考引用，
 * 原样保真，下载名 = claude-<标题摘要>-<日期>.md）；原始 JSONL 为 transcript
 * 原文件无损直传（机读存档/再分析，.jsonl 同名约定）。均为 blob 下载（下载名
 * 客户端合成，utils/exportFileName 同约定），服务端同路写审计（数据出域记账）。
 * 仅问答档（P-20261004-132）：Markdown 分化两档——完整（现状零变化）/仅问答
 *（mode=qa 服务端渲染层过滤只留问答正文，下载名 -qa 尾缀），贴文档/发队友
 * 读者跳过工具过程噪声。
 *
 * AI 总结本会话（P-20261003-215）：工具条「AI 总结」一键发起新 claude 会话，
 * agent 自读 transcript 全量产出结构化摘要（任务/关键改动/结论/遗留事项）——
 * 与导出（原文）/搜索（定位）/进度条（位置）构成会话消化四件。取数/装箱/创建
 * 收口 useClaudeSessionSummary（transcriptPath 取数据面 + 成本知情 tip +
 * prompt 内置遮蔽要求）；成功后与续聊同款接线（激活新会话 + 开管理页 +
 * emit summarized 交宿主关弹层）。
 *
 * 时间轴进度条拖拽定位（P-20261003-132）：搜索行与列表之间的细进度条，按
 * 条目索引比例映射（0..total-1）——数百轮回放「大约在中后段」的空间导航
 * 不再靠长滚。拖拽全程只在浮层预览目标条目首行摘要（列表不动、不产生
 * IO——未加载段只报位号），松手一次定位：自动「加载更多」到位 → 滚动定位
 *（P-182 虚拟化 scrollTo）→ 复用 is-focus 呼吸高亮 2s。列表滚动同步填充
 * 位置（rAF 合帧）。
 *
 * 回放深链（P-20261003-154）：?session=<id>&turn=<N> 直达本时间线的第 N 条
 * （1 计，utils/sessionDeepLink 单一事实源）——focusTurn prop（0-based）经
 * P-132 既有 jumpToIndex 定位（加载到位→滚动定位→呼吸高亮同款视觉语言），
 * 优先于 focusAt 的时刻模糊定位。每步 meta 行 hover 浮现「复制此轮链接」：
 * 拼 origin 深链入剪贴板（cwd 反查归属项目带 project 参数，「复制文件链接」
 * P-49 同语义；锚点生成不依赖书签，P-122 书签是并行的回读策展件）。
 *
 * 单条内容复制（P-20261003-185）：每步 meta 行 hover 浮现「复制本条内容」——
 * 选区复制受渲染结构干扰（选中含 meta 行/折叠块等 UI 元素），item 级复制钮
 * 把该条以纯文本入剪贴板（P-44 渲染链单条口径剥格式），结论引用进笔记/文档
 * 粘贴即用；复制出口走遮蔽视图（P-197 审批卡复制出口同先例）。
 *
 * 回放时间线键盘导航（P-20261003-224）：导航三件（P-89 搜索 / P-132 进度条 /
 * P-185 复制）此前全鼠标——键盘流是导航的补全：↑↓ 在渲染列表上移动 roving
 * 高亮（FileTreeView 键盘导航同款，域 = renderList，「仅命中」下只在命中内
 * 移动、到边即停；首按从视口中线条目起步），Enter 复制该轮（P-185 链），
 * / 直达搜索框。滚动协调复用 P-182 scrollToEntryPos（收敛循环带序号，防键盘
 * 连发时双循环拉锯）。i18n 无关（无新文案，复制反馈沿用 P-185 既有 toast）；
 * b 键（跳书签）暂不实现——P-122 书签已落地，键盘伴生留后续提案。
 *
 * 轮级书签（P-20261003-122）：「这个结论重要，以后要回来看」的轮级策展回跳
 *（P-67 会话星标的轮级版）——assistant 轮 meta 行 star toggle + 回放顶部书签
 * 清单（时刻+结论首行摘要，点击直达该轮）。持久随 P-67 选型：claudecur 策展
 * 文档扩 bookmarks 集合（sessionId+轮时刻即逻辑键，curation 端点增量扩展
 * bookmarkAdd/Remove，timeline 响应携书签集——回放打开即得）。与既有过滤
 * 正交：书签是持久策展件，搜索/仅命中是会话内显示态；跳转复用 P-132
 * jumpToIndex（虚拟化定位+呼吸高亮，自带紧凑视图退出语义）。
 *
 * 策展导出（P-20261003-144）：导出下拉策展组「当前过滤结果 / 书签轮」——与
 * 过滤/书签联动成知识回收闭环（全量双格式 P-44/60 语义与选项不变）。过滤与
 * 书签都是前端态、服务端无过滤口径，策展导出为前端渲染 markdown
 *（utils/claudeCurationExport：版式镜像服务端渲染链 + 文档头口径注记），
 * 下载链复用既有 blob 约定（下载名 claude-hits-/claude-bookmarks- 前缀防同日
 * 互相覆盖）。
 *
 * 轮级语义标签（P-20261003-256）：书签=位置（这轮重要），标签=语义（这轮讲
 * 什么主题）——长回放主题导航的互补面。任意有时刻的条目可挂 #标签（输入 trim
 * +剥前导 #，与服务端 NormalizeTag 同口径），持久随 P-122 惯例（claudecur 策
 * 展文档扩 tags 对集合，curation 端点增量 tagAdd/tagRemove，timeline 响应携标
 * 签集）；回放顶部标签过滤条（#标签×轮数，点击切换过滤，多选 OR）+ 条目已挂
 * chips（恒显，点击=过滤）。与搜索/书签正交：标签过滤与「仅命中」是两个显示
 * 态 ∩ 叠加；标签数据是持久策展件；定位意图优先（jumpToIndex 目标被折叠时
 * 自动退出过滤，书签同款）。编辑器用条目内联行而非浮层——虚拟列表滚动换窗
 * 下浮层定位跟不上，内联行高度变化由既有 RO 实测回写天然消化（P-182 链路
 * 零新增）。
 *
 * 回放时间线虚拟滚动（P-20261003-182）：P-52（文件树）/P-85（变更树）虚拟化
 * 第三面——数百轮回放不再全量 DOM 渲染。与两前辈的固定行高不同，回放条目
 * 高度随消息长度变化，走 @vueuse itemHeight 函数形态（CommandPalette 变高行
 * 同款）+「估高起步、渲染测量修正」降级：估高只求量级正确，RO 实测后覆盖。
 * scrollTo 与窗口切片共用同一套 itemHeight 求和（同源一致性）——估高再不准
 * 目标条目也必然落进切片，只影响像素级偏移。与导航三件的协调：P-89 命中
 * 跳转 / P-132 进度条 / focusAt 时刻定位原是 querySelector+scrollIntoView
 * （全量渲染时目标必在 DOM），虚拟化下窗口外无元素，统一收口 scrollTo
 * （FileTreeView 先例）+ 测量收敛后回补一次落点。
 */
const props = defineProps<{
  /** 回放目标会话（取 id 拉时间线，title/cwd 用于头部摘要） */
  session: ClaudeSessionInfo
  /** 定位目标时刻（RFC3339，可选，P-20261002-82）：打开后滚动至最近早于
   *  该时刻的条目并呼吸高亮 2s——审批卡「回放」等入口定位到审批时刻；
   *  不传 = 无定位的普通回览 */
  focusAt?: string
  /** 定位目标条目（0-based，可选，P-20261003-154 回放深链）：深链 turn（1 计）
   *  换算的精确索引，经 P-132 jumpToIndex 定位；越界（会话被截断/收缩）由其
   *  钳到尾条保底。与 focusAt 不同时携带，同时携带时本参数优先 */
  focusTurn?: number
}>()

const emit = defineEmits<{
  /** 「继续此会话」成功：携带新建终端会话 id（宿主关弹层，列表宿主再切页签选中） */
  (e: 'resumed', sessionId: string): void
  /** 「AI 总结」发起成功（P-20261003-215）：携带新 agent 会话 id，宿主处置同 resumed */
  (e: 'summarized', sessionId: string): void
}>()

const { t } = useI18n()

// ============== 数据加载（时间正序分页追加） ==============
const LIMIT = 50
const entries = ref<ClaudeTimelineEntry[]>([])
const total = ref(0)
const truncated = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = ref(false)
let querySeq = 0

async function fetchPage(offset: number, append: boolean) {
  const seq = ++querySeq
  if (append) loadingMore.value = true
  else {
    loading.value = true
    loadError.value = false
  }
  try {
    const res = (await claudeApi.timeline(props.session.id, { limit: LIMIT, offset })) as unknown as {
      data?: { entries?: ClaudeTimelineEntry[]; total?: number; truncated?: boolean; bookmarks?: string[]; tags?: ClaudeTurnTag[] }
    }
    if (seq !== querySeq) return // 竞态丢弃：已有更新请求在途
    const list = res?.data?.entries ?? []
    total.value = res?.data?.total ?? 0
    truncated.value = res?.data?.truncated ?? false
    if (!append) {
      expandedInputs.value = new Set<number>() // 整体重载：展开态不复用
      hitCursor.value = -1 // 跳转游标同步作废（jumpHit 内另有越界防御）
      navIdx.value = -1 // 键盘 roving 高亮同步作废（P-224，条目区间可能完全不同）
      visibleIdx.value = 0 // 进度条位置复位（会话切换/重载后从头计）——声明见进度条节
      entryHeights.value = [] // 整体重载：实测/估高全作废（内容可能完全不同，声明见虚拟化节）
      bookmarks.value = res?.data?.bookmarks ?? [] // 书签整表以响应为准（P-122，会话切换/重载后重取策展态；append 页不覆盖防在途竞态回写旧值）
      tags.value = res?.data?.tags ?? [] // 标签整表同书签口径（P-256）；过滤是会话内显示态，随重载复位防指向新会话不存在的标签
      activeTags.value = []
    }
    entries.value = append ? [...entries.value, ...list] : list
    // 高度表随条目扩张：已测/已估条目保留，新条目即时填估高（scrollTo 求和
    // 与切片定位都依赖表项齐全，缺项会退化为 FALLBACK_ROW_H 常量）
    entryHeights.value = entries.value.map((e, i) => entryHeights.value[i] ?? estimateEntryHeight(e))
  } catch {
    if (seq === querySeq && !append) loadError.value = true // 失败保留现有内容，可重试
  } finally {
    if (seq === querySeq) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function loadMore() {
  if (entries.value.length < total.value) void fetchPage(entries.value.length, true)
}

function retry() {
  void fetchPage(0, false)
}

// 会话切换 / 定位目标变化（宿主复用同一弹层实例时）：整体重载后按需定位。
// 重载与定位串行——定位依赖重载后的条目区间，单独 watch 会在旧条目上跑空
watch([() => props.session.id, () => props.focusAt, () => props.focusTurn], () => {
  void fetchPage(0, false).then(() => locateTarget())
})
onMounted(() => void fetchPage(0, false).then(() => locateTarget()))

// ============== 定位高亮（P-20261002-82）：目标时刻最近早于条目 ==============
const FOCUS_MS = 2000
const focusIdx = ref(-1)
let focusTimer: ReturnType<typeof setTimeout> | null = null

function clearFocus() {
  focusIdx.value = -1
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
}

/** 定位分发（P-20261003-154 抽取）：深链 turn（focusTurn）是精确索引，走
 *  P-132 jumpToIndex（加载到位→滚动定位→is-focus 呼吸高亮）；否则按
 *  focusAt 时刻模糊定位（P-82 既有链）。二者均未携带 = 无定位普通回览 */
async function locateTarget() {
  if (props.focusTurn !== undefined) {
    await jumpToIndex(props.focusTurn)
    return
  }
  await locateFocus()
}

/** 滚动至最近早于 focusAt 的条目并呼吸高亮 2s。目标可能落在首屏之后
 * （时间正序、审批时刻贴近会话尾部）：先「加载更多」追加到位再定位；
 * 追加无进展（失败/到顶）即止，不无限转 */
async function locateFocus() {
  const target = new Date(props.focusAt ?? '').getTime()
  if (Number.isNaN(target) || entries.value.length === 0) return
  while (entries.value.length < total.value) {
    const last = entries.value[entries.value.length - 1]
    if (!last?.at || ms(last.at) >= target) break // 已覆盖目标时刻 / 末条无时间戳无法判断
    const before = entries.value.length
    await fetchPage(entries.value.length, true)
    if (entries.value.length === before) break
  }
  let idx = -1
  for (let i = 0; i < entries.value.length; i++) {
    const at = entries.value[i]!.at
    if (!at) continue // 个别行无时间戳：不参与定位
    if (ms(at) > target) break
    idx = i
  }
  if (idx < 0) idx = 0 // 全部晚于目标时刻：落首条
  clearFocus() // 先清再设：同一条目重复定位时重启动画
  focusIdx.value = idx
  await nextTick()
  await scrollToEntryPos(idx)
  if (focusTimer) clearTimeout(focusTimer)
  focusTimer = setTimeout(clearFocus, FOCUS_MS)
}

onBeforeUnmount(clearFocus)

// ============== 步骤呈现：种类图标 / 时刻 / 间隔 / 相对时间 ==============
const kindIcons = {
  user: PersonCircleOutline,
  assistant: SparklesOutline,
  tool: TerminalOutline,
  result: ChatbubblesOutline,
} as const

function kindLabel(kind: ClaudeTimelineEntry['kind']): string {
  return t(`claudeSessions.timelineKind${kind[0]!.toUpperCase()}${kind.slice(1)}`)
}

function ms(at: string): number {
  const v = new Date(at).getTime()
  return Number.isNaN(v) ? 0 : v
}

/** HH:MM:SS（title 里给完整日期） */
function fmtClock(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtFull(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/** 相对当前时刻（复用终端「最近活动」文案切片） */
function relText(at: string): string {
  if (!at) return ''
  const { key, n } = relativeTimeParts(ms(at))
  return t(`agentTerminal.${key}`, { n })
}

/** 与上一步的间隔徽标（≥1 分钟才显示，秒级噪声太多）；按相邻「渲染项」计算——
 * 「仅命中」模式下隐藏条目不参与间隔 */
const GAP_CHIP_SECONDS = 60
function gapChipText(prev: ClaudeTimelineEntry | undefined, cur: ClaudeTimelineEntry): string {
  if (!prev?.at || !cur.at) return ''
  const s = Math.max(0, Math.round((ms(cur.at) - ms(prev.at)) / 1000))
  if (s < GAP_CHIP_SECONDS) return ''
  return t('claudeSessions.timelineGapMin', { n: Math.round(s / 60) })
}

// ============== 工具调用折叠（默认收起，点开看输入摘要） ==============
const expandedInputs = ref(new Set<number>())
function toggleInput(idx: number) {
  const next = expandedInputs.value
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  expandedInputs.value = next
}

// ============== 时间线内搜索（P-20261002-81；正则开关 P-20261003-196） ==============
// 长会话回放找「那次谁说要改哪个文件」只能逐屏滚动：对已加载条目的全部可见
// 文本（正文 + 工具名 + 输入摘要）做大小写不敏感子串过滤，即时命中计数；
// Enter/Shift+Enter 在命中间循环跳转（目标为工具调用时自动展开输入折叠块）
// 并滚动定位；「仅命中」隐藏未命中条目（紧凑模式）。服务端 q 参数（jsonl 行
// 匹配复用 scanFile 的 q 模式）留二期——分页窗口已限制已加载规模，页内过滤够用
//
// 正则开关（P-20261003-196）：错误模式/路径模式用正则一步定位，与终端搜索
//（useTerminalSearch）/全局替换（utils/replacePreview）同族语义——开启按
// 大小写不敏感正则匹配（与字面模式的既有大小写不敏感一致），非法正则降级
// 字面匹配并以 invalid 徽标就地提示（不弹窗打断输入），关闭回字面子串。
const searchInput = ref('')
const query = ref('')
const searchRegex = ref(false)
const hitsOnly = ref(false)
const hitCursor = ref(-1)
// listRef（滚动容器 ref）由下方虚拟化节从 containerProps.ref 别名而来——
// 同一元素既是 useVirtualList 的切片容器也是进度同步/定位的查询面

function onSearchInput(v: string) {
  searchInput.value = v
  query.value = v.trim() // 纯内存过滤无 IO，即时生效不防抖
  if (!query.value) hitsOnly.value = false // 清空查询后「仅命中」失效，自动退出
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter') return
  e.preventDefault() // 单行输入框 Enter 无默认行为，防未来形态变化误触发
  jumpHit(e.shiftKey ? -1 : 1)
}

/** 查询匹配器（P-20261003-196 正则开关）：正则模式构造大小写不敏感 RegExp，
 * 非法正则降级字面（同一 includes 语义）并携 invalid 标记驱动提示徽标。
 * 量级：computed 随 query/toggle 记忆化，每次按键只构造一次 RegExp；条目
 * 规模受分页窗口限制（P-81 既有边界，数百条级、正文服务端已截断） */
const searchMatcher = computed<{ test: (s: string) => boolean; invalid: boolean } | null>(() => {
  const q = query.value
  if (!q) return null
  if (searchRegex.value) {
    try {
      const re = new RegExp(q, 'i')
      return { test: (s: string) => re.test(s), invalid: false }
    } catch {
      // 非法正则：降级字面匹配（搜索不中断），提示见 regexInvalid 徽标
      const lower = q.toLowerCase()
      return { test: (s: string) => s.toLowerCase().includes(lower), invalid: true }
    }
  }
  const lower = q.toLowerCase()
  return { test: (s: string) => s.toLowerCase().includes(lower), invalid: false }
})

/** 非法正则降级提示（regex 模式 + 当前 query 构造失败才显） */
const regexInvalid = computed(() => searchMatcher.value?.invalid ?? false)

/** 命中条目序号（时间正序）：跳转游标与徽标计数共用 */
const matchIndexes = computed(() => {
  const m = searchMatcher.value
  if (!m) return []
  const out: number[] = []
  entries.value.forEach((e, i) => {
    if (m.test(`${e.text}\n${e.tool ?? ''}\n${e.input ?? ''}`)) out.push(i)
  })
  return out
})
const hitSet = computed(() => new Set(matchIndexes.value))

watch(query, () => { hitCursor.value = -1 }) // 新查询词从头跳

/** Enter/Shift+Enter：命中间循环跳转；工具输入命中时自动展开折叠块再滚动定位 */
function jumpHit(dir: 1 | -1) {
  const hits = matchIndexes.value
  if (hits.length === 0) return
  const cur = hitCursor.value >= hits.length ? -1 : hitCursor.value // 重载后游标越界防御
  hitCursor.value = (cur + dir + hits.length) % hits.length
  const idx = hits[hitCursor.value]!
  const target = entries.value[idx]
  if (target?.kind === 'tool' && target.input) expandedInputs.value.add(idx)
  void nextTick(() => { void scrollToEntryPos(idx) })
}

/** 当前跳转定位的命中项（叠加高亮，与普通命中区分） */
function isCurrentHit(idx: number): boolean {
  const hits = matchIndexes.value
  return hitCursor.value >= 0 && hitCursor.value < hits.length && hits[hitCursor.value] === idx
}

/** 渲染列表：默认全量；「仅命中」只留命中条目；标签条选中（P-256）只留打了
 *  所选标签的条目——两个显示态过滤正交叠加（∩），idx 为原 entries 下标，
 *  展开/跳转的 data-step 定位与全量模式共用一套。条目取遮蔽视图
 * （maskedEntries 与 entries 同长同序，hitSet/标签 at 键原下标直接适用） */
const renderList = computed(() => {
  const filterHits = hitsOnly.value && query.value !== ''
  const filterTags = activeTags.value.length > 0
  const out: { e: ClaudeTimelineEntry; idx: number; gap: string }[] = []
  let prev: ClaudeTimelineEntry | undefined
  maskedEntries.value.forEach((e, idx) => {
    if (filterHits && !hitSet.value.has(idx)) return
    if (filterTags) {
      const ts = e.at ? tagsByAt.value.get(e.at) : undefined
      if (!ts?.some(tg => activeTagSet.value.has(tg))) return
    }
    out.push({ e, idx, gap: gapChipText(prev, e) })
    prev = e
  })
  return out
})

/** 过滤后空列表的文案：标签过滤激活时按标签口径提示（「没有命中的步骤」是
 *  搜索语义，标签态下误导） */
const renderListEmptyText = computed(() =>
  activeTags.value.length > 0
    ? t('claudeSessions.timeline.tag.noMatch')
    : t('claudeSessions.timeline.search.noMatch'))

const showLoadMore = computed(() => entries.value.length < total.value)

// ============== 敏感遮蔽（P-20261004-14）：回放展示面默认遮蔽 ==============
// 消息正文与工具输入摘要统一过 P-108 maskSensitive()（sc?_ 令牌 / password
// 赋值 / AKIA 密钥，模式集唯一权威在 utils/sensitiveMask.ts，与录制回放侧
// 同源）——「录了能遮、回放裸奔」的防线不一致在此收口。纯展示层：接口返回
// 原文不变（agent 续聊上下文需要原文，遮蔽只服务人的查看）。
// 时间线内搜索（P-81）仍按原文匹配：保持「找到含该词的步骤」语义不变，
// 命中呈现只是步骤高亮不回显原文；先遮蔽后渲染的次序杜绝任何回显路径
const showOriginal = ref(false)
async function toggleShowOriginal() {
  if (showOriginal.value) {
    showOriginal.value = false // 收回原文无风险，不需确认
    return
  }
  const ok = await confirmDialog({
    title: t('claudeSessions.mask.confirmTitle'),
    content: t('claudeSessions.mask.confirmDesc'),
    type: 'warning',
    confirmText: t('claudeSessions.mask.confirmShow'),
  })
  if (ok) showOriginal.value = true
}

/** 遮蔽渲染条目：正文 + 工具输入摘要（tool 名/时刻/状态非敏感原样透传）。
 * 每次载入/翻页整表算一遍（P-108 全量侧已验证逐消息正则开销可接受），
 * 开关切回原文直接复用原条目零拷贝 */
const maskedEntries = computed<ClaudeTimelineEntry[]>(() => {
  if (showOriginal.value) return entries.value
  return entries.value.map(e => ({
    ...e,
    text: e.text ? maskSensitive(e.text) : e.text,
    input: e.input ? maskSensitive(e.input) : e.input,
  }))
})

// ============== 轮级语义标签（P-20261003-256）：主题标注 + chips 过滤 ==============
// 书签=位置（这轮重要），标签=语义（这轮讲什么主题）——互补的回读策展件。
// 持久域沿 P-122 惯例：claudecur 策展文档扩 tags (轮时刻,标签名) 对集合，
// curation 端点增量扩展（tagAdd/tagRemove），timeline 响应携标签集（回放打开
// 即得）。与既有过滤正交：标签过滤是会话内显示态（与「仅命中」∩ 叠加），
// 标签数据本身是持久策展件；定位意图优先语义同书签（jumpToIndex 自动退出
// 折叠目标的过滤）。
// 位置注记：本节须在 renderList 之前——useVirtualList 注册期即求值 renderList
//（P-182 已知语义），过滤面所依赖的声明若在其后会 TDZ
const tags = ref<ClaudeTurnTag[]>([])

/** at（RFC3339 原串）→ 该轮标签名列表（字典序）：条目 chips 渲染与过滤判定
 *  同源。个别行无时刻不参与（与书签同款：无定位键） */
const tagsByAt = computed(() => {
  const m = new Map<string, string[]>()
  for (const p of tags.value) {
    if (!p.at || !p.tag) continue // 旧文档/异常响应防御
    const list = m.get(p.at)
    if (list) list.push(p.tag)
    else m.set(p.at, [p.tag])
  }
  for (const list of m.values()) list.sort()
  return m
})

/** 会话内全部标签（名字典序）+ 使用轮数：顶部标签过滤条的事实源 */
const tagChips = computed(() => {
  const counts = new Map<string, number>()
  for (const p of tags.value) {
    if (!p.at || !p.tag) continue
    counts.set(p.tag, (counts.get(p.tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, n]) => ({ tag, n }))
})

/** 标签过滤态（会话内显示态，不持久——与 hitsOnly 同口径）：多选 OR 语义
 * （主题导航常是「看架构相关与修复相关」，AND 会窄到同时挂两标签的稀有轮） */
const activeTags = ref<string[]>([])
const activeTagSet = computed(() => new Set(activeTags.value))

function toggleTagFilter(tag: string) {
  activeTags.value = activeTagSet.value.has(tag)
    ? activeTags.value.filter(tg => tg !== tag)
    : [...activeTags.value, tag]
}

// ============== 虚拟滚动（P-20261003-182）：动态高度切片渲染 ==============
// P-52（文件树）/P-85（变更树）虚拟化第三面：数百轮回放不再全量 DOM。条目
// 高度随消息长度变化——@vueuse itemHeight 函数形态（CommandPalette 变高行
// 同款）承载「估高起步 + 渲染测量修正」：估高只求量级正确（首帧滚动条长度
// 与落点），实测后覆盖收敛。scrollTo(idx) 与窗口切片用同一套 itemHeight 求和
// （同源一致性）——估高再不准，目标条目也必然落在切片内，只影响像素偏移。
// 量级考量：itemHeight 求和 O(i)、切片定位 O(n)，数百条级=微秒级纯内存计算
//（分页窗口本就限制已加载规模），滚动路径无 IO、无每帧全量重渲染。
// 位置注记：本节须在 renderList/maskedEntries 之后——useVirtualList 内部
// watch(source) 在注册期即求值 source.value（Vue 3.5 shallowRef 解包内层
// computed），声明在后会 TDZ
const entryHeights = ref<number[]>([]) // 高度表：下标 = entries 原下标（「仅命中」只改渲染子集不动此表）
const EST_LINE_CHARS = 80 // 12px 正文在 760px 弹层内容宽下的经验均宽折行数（CJK/拉丁混合粗估）
const EST_LINE_H = 18 // .cstl-text：12px × line-height 1.5
const EST_META_H = 18 // .cstl-meta 单行
const EST_TOGGLE_H = 22 // .cstl-input-toggle 折叠钮行
const EST_PAD_H = 12 // .cstl-body padding-bottom
const FALLBACK_ROW_H = 48 // 表项缺失兜底（fetchPage 即时填估高，此处防御式）

/** 估高折行：pre-wrap 显式换行分段 + 段内按经验均宽折行 */
function estLines(s: string): number {
  return s.split('\n').reduce((n, seg) => n + Math.max(1, Math.ceil(seg.length / EST_LINE_CHARS)), 0)
}

/** 估高：与 .cstl-* 实际样式量级对齐（meta 行 + 正文行数 + 工具折叠钮 + 步尾距）；
 * result 条目正文有 -webkit-line-clamp: 3，估高同步钳制 */
function estimateEntryHeight(e: ClaudeTimelineEntry): number {
  let h = EST_META_H + EST_PAD_H
  if (e.text) h += Math.min(estLines(e.text), e.kind === 'result' ? 3 : Number.POSITIVE_INFINITY) * EST_LINE_H
  if (e.kind === 'tool' && e.input) h += EST_TOGGLE_H
  return h
}

const { list: visibleSteps, containerProps, wrapperProps, scrollTo } = useVirtualList(renderList, {
  itemHeight: (i: number) => {
    const r = renderList.value[i]
    return (r ? entryHeights.value[r.idx] : undefined) ?? FALLBACK_ROW_H
  },
  overscan: 10,
})
// 滚动容器 ref 由 containerProps.ref 承担（v-bind 绑定），别名复用既有定位/
// 进度同步逻辑——同一元素既是切片容器也是查询面（原 listRef 语义不变）
const listRef = containerProps.ref

/** 切片内条目实测高度回写：RO 首次回调即初测；展开折叠块、视宽重排等后续
 * 尺寸变化同由 RO 覆盖。回写后按当前 scrollTop 重切窗口（上方高度修正会
 * 改变同一 scrollTop 对应的条目）。只认真实差异（≥1px）：估高已准不折腾；
 * jsdom 无布局恒 0 被忽略——单测零布局依赖 */
let stepRO: ResizeObserver | null = null
const observedSteps = new Set<HTMLElement>()

function measureStepEl(el: HTMLElement) {
  const idx = Number(el.dataset.step ?? -1)
  const h = el.offsetHeight
  if (idx < 0 || idx >= entries.value.length || h <= 0) return
  const cur = entryHeights.value[idx]
  if (cur !== undefined && Math.abs(cur - h) < 1) return
  entryHeights.value[idx] = h
  containerProps.onScroll()
}

// 切片变化时增量维护观察集：窗口内 observe（新元素首回调即测）、窗口外
// unobserve（防观察集随滚动无界增长）
watch(visibleSteps, () => {
  void nextTick(() => {
    const list = listRef.value
    if (!list) return
    if (!stepRO && typeof ResizeObserver !== 'undefined') {
      stepRO = new ResizeObserver(roEntries => {
        for (const en of roEntries) measureStepEl(en.target as HTMLElement)
      })
    }
    if (!stepRO) return // 无 RO 环境（jsdom）：高度保持估高，切片渲染不受影响
    const live = new Set(list.querySelectorAll<HTMLElement>('[data-step]'))
    for (const el of live) {
      if (!observedSteps.has(el)) {
        stepRO.observe(el)
        observedSteps.add(el)
      }
    }
    for (const el of [...observedSteps]) {
      if (!live.has(el)) {
        stepRO.unobserve(el)
        observedSteps.delete(el)
      }
    }
  })
})

/** 条目原下标 → 渲染子集位次：P-89 命中跳转 / P-132 进度条 / focusAt 定位
 *  从「querySelector + scrollIntoView」（全量渲染时目标必在 DOM）改为虚拟化
 *  scrollTo（FileTreeView 先例）的换算缝。目标被「仅命中」折叠时落最近可见
 *  后继（无则末条）——定位意图就近可达；空列表返回 -1 */
const renderPosByEntry = computed(() => {
  const m = new Map<number, number>()
  renderList.value.forEach((r, i) => m.set(r.idx, i))
  return m
})

function scrollPosForEntry(idx: number): number {
  const pos = renderPosByEntry.value.get(idx)
  if (pos !== undefined) return pos
  const next = renderList.value.findIndex(r => r.idx > idx)
  return next >= 0 ? next : renderList.value.length - 1
}

/** 定位滚动 + 测量回补：估高落点后切片初测/回写会平移条目实际位置（估高差值
 *  只来自切片内已测条目），按 DOM 实测位差把目标钉回容器顶，直至测量收敛。
 *  尾段特例：目标贴近已加载尾（下方内容不足一屏）时顶对齐物理不可达——
 *  scrollTop 被钳在末端，退化为底对齐（目标可见即定位成立，原 scrollIntoView
 *  block:center 在尾段同理）。上限 10 轮（每轮隔两帧给 RO 回写留窗口）防异常
 *  环境回环。定位期间吞 scroll 事件防进度读数抖动，并把进度位号钉在定位目标
 *  上（P-132「定位意图优先」语义从进度条推广到三处定位，后续滚动仍走中线同步）。
 *  序号守卫（P-224）：键盘连发时上一个收敛循环还在途，放任并发会双循环互相
 *  拉锯（各自往自己的目标回补 scrollTop）——后发定位使旧循环退场 */
let scrollSeq = 0
async function scrollToEntryPos(idx: number) {
  const seq = ++scrollSeq
  const pin = () => {
    const pos = scrollPosForEntry(idx)
    if (pos >= 0) scrollTo(pos)
  }
  swallowScrollUntil = performance.now() + 150
  pin()
  await nextTick()
  for (let i = 0; i < 10; i++) {
    if (seq !== scrollSeq) return // 更新定位已接管：本轮收敛循环退场
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const listEl = listRef.value
    if (!listEl) break
    const target = listEl.querySelector<HTMLElement>(`[data-step="${idx}"]`)
    if (!target) { pin(); continue } // 测量换窗把目标挤出切片：重放定位
    const padTop = parseFloat(getComputedStyle(listEl).paddingTop) || 0
    const delta = target.getBoundingClientRect().top - listEl.getBoundingClientRect().top - padTop
    if (Math.abs(delta) <= 1) break // 落点已稳（估高与实测一致或回写收敛）
    const desired = listEl.scrollTop + delta
    const maxScroll = listEl.scrollHeight - listEl.clientHeight
    if (desired > maxScroll - 1 && delta > 0) {
      listEl.scrollTop = maxScroll // 尾段顶对齐不可达：底对齐收尾（目标可见）
      break
    }
    listEl.scrollTop = desired
  }
  if (seq !== scrollSeq) return // 被更新的定位顶替：不回写其进度归属
  swallowScrollUntil = performance.now() + 150 // 回补期的尾随滚动事件一并吞掉
  visibleIdx.value = idx
}

/** 尾条目判定（rail 连线收口）：虚拟切片内 :last-child 随滚动漂移，不能用 */
const tailEntryIdx = computed(() => renderList.value.at(-1)?.idx ?? -1)

// ============== 时间轴进度条拖拽定位（P-20261003-132） ==============
// 「大约在中后段」的空间导航：细进度条按条目索引线性映射（idx = 比例 ×
// (total-1)，任务书明确的简化模型——条目不按时长/字节加权）。拖拽只在
// 浮层预览（列表不动、零 IO——未加载段无文本可预览，只报位号），松手才
// 加载+定位：拖动路径跨未加载段不会连发请求。预览文本取遮蔽视图
// maskedEntries——浮层是渲染面，与消息正文同过 P-108 防线
const barRef = ref<HTMLElement | null>(null)
const barDragging = ref(false)
const dragRatio = ref(0) // 拖动中的比例 0..1
const visibleIdx = ref(0) // 未拖拽时由列表滚动同步的「当前条目」（视口中线所在）
const scrubIdx = ref(-1) // 拖拽定位的高亮条目（与 focusAt 定位共用 is-focus）
let scrubTimer: ReturnType<typeof setTimeout> | null = null
let scrubRaf = 0
let swallowScrollUntil = 0 // 定位滚动后短暂吞掉 scroll 事件的截止时刻

const scrubMax = computed(() => Math.max(0, total.value - 1))
const showProgress = computed(() =>
  total.value > 1 && entries.value.length > 0 && !loading.value && !loadError.value)
const barPct = computed(() => {
  const ratio = barDragging.value
    ? dragRatio.value
    : (scrubMax.value === 0 ? 0 : visibleIdx.value / scrubMax.value)
  return `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(2)}%`
})

function clearScrub() {
  scrubIdx.value = -1
  if (scrubTimer) {
    clearTimeout(scrubTimer)
    scrubTimer = null
  }
}

/** 列表滚动 → 进度位置：视口垂直中线所在条目即「当前」。只遍历切片内已渲染
 * 条目（虚拟化下窗口外无 DOM，中线必落在切片内）——越过中线即 break；分页
 * 窗口限制已加载规模（数百条级），每帧一次 rAF 合帧，无热路径风险 */
function syncBarFromScroll() {
  const list = listRef.value
  if (!list || scrubMax.value === 0) return
  const listRect = list.getBoundingClientRect()
  const center = listRect.top + listRect.height / 2
  let cur = 0
  for (const el of list.querySelectorAll<HTMLElement>('[data-step]')) {
    if (el.getBoundingClientRect().top <= center) cur = Number(el.dataset.step ?? 0)
    else break
  }
  visibleIdx.value = cur
}

function onListScroll() {
  if (barDragging.value || scrubRaf) return
  if (performance.now() < swallowScrollUntil) return // 定位滚动自带的事件（读数受钳制影响），见 jumpToIndex
  // 定位身份窗口（呼吸高亮 FOCUS_MS）内进度归属定位目标：虚拟化定位的测量
  // 回补/尾段钳制会在落点后数百毫秒内派发迟到滚动事件（内容高度收敛触发
  // scrollTop 重钳），若放行会把读数从中线拖回——尾段底对齐时中线天然偏离
  // 目标，窗口期一过恢复中线同步
  if (scrubIdx.value >= 0 || focusIdx.value >= 0) return
  scrubRaf = requestAnimationFrame(() => {
    scrubRaf = 0
    syncBarFromScroll()
  })
}

function barRatioAt(e: PointerEvent): number {
  const rect = barRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

function onBarDown(e: PointerEvent) {
  if (!showProgress.value || e.button !== 0) return
  barDragging.value = true
  dragRatio.value = barRatioAt(e)
  // setPointerCapture：拖出条外仍收 move/up（jsdom 无此 API，防御式调用）
  ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
}

function onBarMove(e: PointerEvent) {
  if (!barDragging.value) return
  dragRatio.value = barRatioAt(e)
}

function onBarUp(e: PointerEvent) {
  if (!barDragging.value) return
  barDragging.value = false
  ;(e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId)
  // 用 up 事件自带坐标而非末次 move 的 dragRatio：快速拖拽时浏览器输入管线
  // 会合并/丢弃 move（末次采样落后于指针真实位置），松手点才是定位真值
  void jumpToIndex(Math.round(barRatioAt(e) * scrubMax.value))
}

function onBarCancel(e: PointerEvent) {
  if (!barDragging.value) return
  barDragging.value = false // 系统打断（触摸滚动手势接管等）：取消不跳
  ;(e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId)
}

/** 松手定位：先「加载更多」追加到位（无进展即止，同 locateFocus 不无限转），
 *  再 scrollToEntryPos 滚动定位并呼吸高亮 FOCUS_MS；目标被「仅命中」或标签
 *  过滤（P-256）折叠时退出对应过滤——空间导航的定位意图优先于紧凑过滤，跳到
 *  一个不可见元素即是失败 */
async function jumpToIndex(idx: number) {
  idx = Math.min(scrubMax.value, Math.max(0, idx))
  if (hitsOnly.value && !hitSet.value.has(idx)) hitsOnly.value = false
  if (activeTags.value.length > 0) {
    const at = entries.value[idx]?.at
    const ts = at ? tagsByAt.value.get(at) : undefined
    if (!ts?.some(tg => activeTagSet.value.has(tg))) activeTags.value = []
  }
  while (entries.value.length <= idx && entries.value.length < total.value) {
    const before = entries.value.length
    await fetchPage(entries.value.length, true)
    if (entries.value.length === before) break
  }
  clearScrub() // 先清再设：重复定位同一条目时重启动画
  scrubIdx.value = idx
  if (scrubRaf) { // 丢弃定位前已在途的滚动合帧：定位结果为准
    cancelAnimationFrame(scrubRaf)
    scrubRaf = 0
  }
  await nextTick()
  await scrollToEntryPos(idx) // 虚拟化定位（scrollTo + 测量回补，进度钉在目标）
  if (scrubTimer) clearTimeout(scrubTimer)
  scrubTimer = setTimeout(clearScrub, FOCUS_MS)
}

// 拖动浮层：位号恒显（语言中立，无 i18n），文本=目标条目首行摘要（tool 条目
// 取工具名+输入首行）；tip 横向钳位防极端比例下被 overflow:hidden 裁掉半截
const dragIdx = computed(() => Math.round(dragRatio.value * scrubMax.value))
const dragPreviewPos = computed(() => `${dragIdx.value + 1} / ${total.value}`)
const dragPreviewText = computed(() => {
  if (!barDragging.value) return ''
  const e = maskedEntries.value[dragIdx.value]
  if (!e) return ''
  if (e.kind === 'tool') {
    const input = e.input ? e.input.split('\n')[0]!.trim() : ''
    return [e.tool, input].filter(Boolean).join(' ')
  }
  return (e.text ?? '').split('\n')[0]!.trim()
})
const dragTipPct = computed(() => `${(Math.min(92, Math.max(8, dragRatio.value * 100))).toFixed(2)}%`)

onBeforeUnmount(() => {
  if (scrubRaf) cancelAnimationFrame(scrubRaf)
  clearScrub()
  stepRO?.disconnect() // 切片观察集随组件消亡（弹层 v-if 每开全新挂载）
})

// ============== 继续此会话（P-20261002-96）：回放现场的续聊出口 ==============
// 复用 ClaudeSessionPicker 的恢复链路：新建 agent 终端注入 `claude --resume
// <id>`（dir=会话 cwd）→ 激活并展开管理页 → emit resumed(sessionId) 交宿主
// 关弹层（列表宿主再切页签选中）。守卫与列表行同款：活跃会话不可恢复（防
// 两个进程写同一对话）；时间线数据源本就是 claude transcript 扫描，无「非
// claude 运行时」分支可判
const message = useMessage()
const resuming = ref(false)

async function resumeSession() {
  const s = props.session
  if (resuming.value || s.active) return
  resuming.value = true
  try {
    const info = await useTerminalSessionsStore().createAgent(
      t('claudeSessions.resumeName', { title: s.title.slice(0, 30) }),
      'claude',
      undefined,
      { dir: s.cwd, launchArgs: `--resume ${s.id}` },
    )
    if (!info) {
      message.error(t('claudeSessions.resumeFail'))
      return
    }
    if (info.launched === false) {
      message.warning(t('claudeSessions.resumeNoRuntime'))
    } else {
      message.success(t('claudeSessions.resumeOk', { title: s.title.slice(0, 30) }))
    }
    const agentTerminal = useAgentTerminal()
    agentTerminal.activeId.value = info.id
    await agentTerminal.open('docked')
    emit('resumed', info.id)
  } finally {
    resuming.value = false
  }
}

// ============== 导出双格式（P-20261003-44 md / P-20261003-60 原始 JSONL） ==============
// 工具条导出按钮组化为下拉：Markdown = 服务端 timeline 解析基建渲染的人读文档
//（user/assistant 分节 + 工具摘要行 + 思考引用块）；原始 JSONL = transcript
// 原文件无损直传（机读存档/再分析用，零渲染）。两者均原样保真不做敏感遮蔽——
// 导出是显式的「带走」动作。blob 下载，下载名客户端合成（axios 拦截器只回 data
// 不透 Content-Disposition，与 patch 下载同约定）；服务端同路写审计
//（claude.export，数据出域记账）
//
// 策展导出（P-20261003-144）：下拉策展组「当前过滤结果 / 书签轮」——过滤（P-81）
// 与书签（P-122）都是前端态、服务端无过滤口径，导出为前端渲染 markdown
//（utils/claudeCurationExport，版式镜像服务端渲染链 + 文档头口径注记），数据面
// = 已加载条目原文（与全量导出同保真口径，P-108 遮蔽只服务展示面）。策展 JSONL
// 不做：原始 JSONL 的「无损」语义锚定 transcript 原文件，前端只能拿到解析后
// 条目，同名异实会误导；原始 JSONL 保全量档位
//
// 复制到剪贴板变体（P-20261005-6）：导出的主用途是粘贴（发同事/贴 issue/存档
// 笔记），复制一步直达省去「下载→打开→全选复制」。与 Markdown 下载同一服务端
// 渲染端点——8MB 渲染封顶与截断注记都在服务端文档内，截断/计数语义由构造
// 一致，前端零额外护栏（大文档不进剪贴板历史：clipboardHistory 单条 100KB
// 上限天然跳过）。写剪贴板走 copyText 降级链（健壮性红线）
//
// 仅问答档（P-20261004-132）：导出按钮分化两档——完整（P-44 现状零变化）/
// 仅问答（服务端渲染层过滤只留 user/assistant 正文，工具/结果/思考过程噪声
// 跳过，贴文档/发队友读者要的是结论与建议）。档位只是同端点的 mode 查询参数，
// 取数/敏感闸/下载链全复用；下载名 -qa 尾缀与服务端 ExportQADownloadName 同约定
type ExportFormat = 'md' | 'md-qa' | 'jsonl'
/** 策展导出键：命中集 / 书签轮（前端渲染 md） */
type CurationExportKey = 'md-hits' | 'md-bm'
const exporting = ref(false)

/** blob 下载收口（既有导出下载链原样提取）：blob URL 由 a.click 触发保存，
 *  10s 后回收；两条导出路径（服务端响应 / 前端渲染文档）共用 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const exportOptions = computed<DropdownOption[]>(() => [
  { key: 'md', label: t('claudeSessions.timeline.export.mdLabel') },
  // 仅问答档（P-20261004-132）：紧随完整档（两档是同一 Markdown 形态的分流，
  // 与机读 jsonl 不同族）
  {
    key: 'md-qa',
    label: t('claudeSessions.timeline.export.mdQaLabel'),
    props: { title: t('claudeSessions.timeline.export.mdQaTip') },
  },
  { key: 'jsonl', label: t('claudeSessions.timeline.export.jsonlLabel') },
  // 复制变体（P-20261005-6）：全量档位第三项——下载族之后、策展组之前
  {
    key: 'md-copy',
    label: t('claudeSessions.timeline.export.copyMdLabel'),
    props: { title: t('claudeSessions.timeline.export.copyMdTip') },
  },
  // 策展组（P-20261003-144）：计数后缀让范围可预读；无命中/无书签禁用（空导出
  // 无意义），title 说明启用条件（禁用项的 hover 提示尽力而为，见 naive disabled 态）
  { type: 'divider', key: 'curation-div' },
  {
    key: 'md-hits',
    label: t('claudeSessions.timeline.export.hitsLabel', { n: matchIndexes.value.length }),
    disabled: matchIndexes.value.length === 0,
    props: {
      title: t(matchIndexes.value.length === 0
        ? 'claudeSessions.timeline.export.hitsEmptyTip'
        : 'claudeSessions.timeline.export.hitsTip'),
    },
  },
  {
    key: 'md-bm',
    label: t('claudeSessions.timeline.export.bmLabel', { n: bookmarks.value.length }),
    disabled: bookmarks.value.length === 0,
    props: { title: t('claudeSessions.timeline.export.bmTip') },
  },
])
function onExportSelect(key: string | number) {
  if (key === 'md' || key === 'md-qa' || key === 'jsonl') void exportSession(key)
  else if (key === 'md-copy') void copySessionMd()
  else if (key === 'md-hits' || key === 'md-bm') void exportCuration(key)
}
async function exportSession(format: ExportFormat) {
  if (exporting.value) return
  exporting.value = true
  try {
    // 内容敏感闸（P-20261004-113）：命中且未确认时服务端回 JSON warnings，
    // 统一经 fetchWithEgressGate 弹确认，确认后 confirm=1 重试；取消返回 null
    //（零下载、零成功 toast）
    const qa = format === 'md-qa'
    const blob = await fetchWithEgressGate(
      confirm => (format === 'jsonl'
        ? claudeApi.exportJsonl(props.session.id, confirm)
        : claudeApi.exportMd(props.session.id, confirm, qa ? 'qa' : undefined)) as unknown as Promise<Blob>,
      props.session.title,
    )
    if (!blob) return
    // 下载名客户端合成（与服务器 Content-Disposition 同约定）：qa 档 -qa 尾缀
    // 与服务端 ExportQADownloadName 对齐，同日双档不互覆
    const ext = format === 'jsonl' ? 'jsonl' : 'md'
    saveBlob(blob, exportFileName(props.session.title, new Date(), ext, 'claude', qa ? '-qa' : ''))
    message.success(t('claudeSessions.timeline.export.success'))
  } catch { /* 拦截器处理 */ }
  finally { exporting.value = false }
}

/** 复制 Markdown 到剪贴板（P-20261005-6）：同一 exportMd 端点取回渲染文档
 *  转 Blob 文本，经 copyText 降级链写入并按返回值分支提示（健壮性红线）。
 *  与下载共用 exporting 载入态——同钮在途防重复，取数往返期间按钮 loading。
 *  复制同样是出域动作：敏感闸第一跳 JSON 绝不进剪贴板（fetchWithEgressGate
 *  分流，确认后 confirm=1 重取） */
async function copySessionMd() {
  if (exporting.value) return
  exporting.value = true
  try {
    const blob = await fetchWithEgressGate(
      confirm => claudeApi.exportMd(props.session.id, confirm) as unknown as Promise<Blob>,
      props.session.title,
    )
    if (!blob) return
    const copied = await copyText(await blob.text())
    if (copied) message.success(t('claudeSessions.timeline.export.copySuccess'))
    else message.error(t('claudeSessions.timeline.export.copyFail'))
  } catch { /* API 失败拦截器代弹 */ }
  finally { exporting.value = false }
}

/** 书签轮条目下标（时刻正序，与顶部书签清单同序）：书签键（轮时刻）经 idxByAt
 *  反查已加载条目；指向未加载段（截断窗外）的书签落空，由导出注记如实呈现 */
const bookmarkEntryIdxs = computed(() =>
  [...bookmarks.value]
    .sort()
    .map(at => idxByAt.value.get(at))
    .filter((i): i is number => i !== undefined))

/** 策展导出（P-20261003-144）：命中集/书签轮渲染为 markdown blob 下载。范围
 *  身份 = matchIndexes（与命中高亮/仅命中同一事实源，导出即所见命中集）/ 书签
 *  集合；渲染与口径注记收口 utils/claudeCurationExport，零网络面 */
async function exportCuration(key: CurationExportKey) {
  if (exporting.value) return
  exporting.value = true
  try {
    const hits = key === 'md-hits'
    const idxs = hits ? matchIndexes.value : bookmarkEntryIdxs.value
    const doc = renderCurationMarkdown({
      title: props.session.title,
      sessionId: props.session.id,
      now: new Date(),
      entries: idxs.map(i => entries.value[i]).filter((e): e is ClaudeTimelineEntry => !!e),
      total: total.value,
      scope: hits ? 'hits' : 'bookmarks',
      query: query.value,
      regex: searchRegex.value,
      missingBookmarks: hits ? 0 : bookmarks.value.length - bookmarkEntryIdxs.value.length,
    })
    // 下载名：prefix 槽位区分策展族（claude-hits-…/claude-bookmarks-…，P-100
    // 'terminal' 前缀同槽惯例），防同日全量/策展导出互相覆盖
    saveBlob(new Blob([doc], { type: 'text/markdown;charset=utf-8' }),
      exportFileName(props.session.title, new Date(), 'md', hits ? 'claude-hits' : 'claude-bookmarks'))
    message.success(t('claudeSessions.timeline.export.success'))
  } catch {
    message.error(t('claudeSessions.timeline.export.fail'))
  } finally { exporting.value = false }
}

// ============== 分享回放链接（P-20261003-77）：现场只读展示件 ==============
// 与导出（异步带走）互补的同步分享：服务端按会话 id 生成条目快照（含思考块
// 与工具详情，P-108 敏感值已遮蔽为 ***），访客打开结构化时间线页只读浏览，
// 默认 24h TTL。创建成功即弹既有结果卡（短链复制/打开/去管理），发现入口
// 就在回放工具条——「你看 agent 刚才怎么干活的」不用先解释怎么找入口
const { createSessionShare } = useShareDialog()
const sharing = ref(false)
async function shareSession() {
  if (sharing.value) return
  sharing.value = true
  try {
    await createSessionShare(props.session.id)
  } finally {
    sharing.value = false
  }
}

// ============== AI 总结本会话（P-20261003-215）：回放页一键消化出口 ==============
// ask-agent 链发起新 claude 会话，agent 自读 transcript 全量产出结构化摘要
//（任务/关键改动/结论/遗留）。取数/装箱/创建收口 useClaudeSessionSummary；
// 这里只做宿主接线：成功后与续聊同款（激活新会话 + 开 docked 管理页 + emit
// summarized 交宿主关弹层）。transcriptPath 缺失（旧版本对端）按钮禁用兜底，
// 活跃会话不拦——读转写是只读动作，进行中会话的阶段性总结同样成立
const { summarizingId, summarize } = useClaudeSessionSummary()
const summarizing = computed(() => summarizingId.value === props.session.id)

async function summarizeSession() {
  const id = await summarize(props.session)
  if (!id) return
  const agentTerminal = useAgentTerminal()
  agentTerminal.activeId.value = id
  await agentTerminal.open('docked')
  emit('summarized', id)
}

// ============== 此轮链接复制（P-20261003-154）：会话位置可分享/收藏 ==============
// 每步 meta 行 hover 浮现复制钮：拼 origin + /project?session=&turn= 深链入
// 剪贴板（utils/clipboard copyText——健壮性红线，禁裸 navigator.clipboard）。
// turn 从 1 计（?file= 深链 line= 位号同语义），项目经会话 cwd 反查归属
// （projectIdForCwd 两 pass 匹配）——cwd 不归属任何项目时省略 project 参数
//（会话 id 全局可寻址，深链仍完整可用）；消费端回环见 useSessionReplayDeepLink
const projectStore = useProjectStore()

async function copyTurnLink(idx: number) {
  const link = buildSessionDeepLinkUrl(window.location.origin, {
    sessionId: props.session.id,
    turn: idx + 1,
    projectId: projectIdForCwd(projectStore.projects, props.session.cwd),
  })
  if (await copyText(link)) {
    message.success(t('claudeSessions.timeline.copyLink.done'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

// ============== 单条内容复制（P-20261003-185）：结论引用进笔记/文档 ==============
// 选区复制受渲染结构干扰（选中含 meta 行/折叠块等 UI 元素）；item 级复制钮
// 把该条以纯文本入剪贴板——P-44 渲染链的单条口径剥格式（user/assistant/
// result 取正文原样；tool 条目正文为空，取「工具名+输入摘要」两行），无
// markdown 装饰、无时间戳前缀，粘贴即用。复制出口走遮蔽视图 maskedEntries
//（「所见即所复制」，与 P-197 审批卡 op+target 复制出口过遮蔽同先例；原文
// 放行后复制的自然也是原文），量级有界：条目正文/输入摘要服务端已截断。
function entryPlainText(e: ClaudeTimelineEntry): string {
  if (e.kind === 'tool') return [e.tool, e.input].filter(Boolean).join('\n')
  return e.text
}

async function copyEntryText(idx: number) {
  const e = maskedEntries.value[idx]
  if (!e) return
  if (await copyText(entryPlainText(e))) {
    message.success(t('claudeSessions.timeline.copyText.done'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

// ============== 轮级书签（P-20261003-122）：结论轮星标 + 顶部清单回跳 ==============
// 长会话回放「这个结论重要，以后要回来看」此前只能记轮数：star 该 assistant 轮
//（仅 assistant 轮可标——结论在答复里，user/tool/result 是过程面）+ 回放顶部
// 书签清单（时刻+结论首行摘要）点击直达。持久域随 P-67 选型：claudecur 策展
// 文档（一会话一文档）扩 bookmarks 集合（sessionId+轮时刻即逻辑键），curation
// 端点部分更新语义增量扩展（bookmarkAdd/bookmarkRemove），timeline 响应携当前
// 书签集——回放打开即得，不依赖会话列表行的快照。
// 与既有过滤正交：书签是持久策展件，搜索/仅命中是会话内显示态，互不读写；
// 书签跳转复用 P-132 jumpToIndex（其自带「目标被仅命中折叠时退出紧凑视图」
// 语义，定位意图优先）。
const bookmarks = ref<string[]>([])
const bookmarkSet = computed(() => new Set(bookmarks.value))

/** at（RFC3339 原串）→ 条目下标：书签跳转的定位换算。个别行无时间戳不参与；
 *  assistant 优先——同一条 assistant 消息拆出的 tool_use 与答复文本同刻相邻
 * （transcript 同 timestamp），书签只标 assistant 轮，定位应落答复文本而非
 * 工具调用，故先注册 assistant 再补其余 */
const idxByAt = computed(() => {
  const m = new Map<string, number>()
  entries.value.forEach((e, i) => {
    if (e.at && e.kind === 'assistant' && !m.has(e.at)) m.set(e.at, i)
  })
  entries.value.forEach((e, i) => {
    if (e.at && !m.has(e.at)) m.set(e.at, i)
  })
  return m
})

/** 乐观切换书签（picker toggleStar 同款：先翻本地态，失败回滚 + toast）。
 *  以响应回传的权威书签集收口（服务端钳制/去重后的形态，防并发漂移） */
async function toggleBookmark(idx: number) {
  const e = entries.value[idx]
  if (!e?.at) return
  const on = bookmarkSet.value.has(e.at)
  bookmarks.value = on
    ? bookmarks.value.filter(t => t !== e.at)
    : [...bookmarks.value, e.at]
  try {
    const res = (on
      ? await claudeApi.setCuration({ sessionId: props.session.id, bookmarkRemove: e.at })
      : await claudeApi.setCuration({ sessionId: props.session.id, bookmarkAdd: e.at })
    ) as unknown as { data?: { bookmarks?: string[] } }
    if (Array.isArray(res?.data?.bookmarks)) bookmarks.value = res.data.bookmarks
  } catch {
    bookmarks.value = on ? [...bookmarks.value, e.at] : bookmarks.value.filter(t => t !== e.at)
    message.error(t('claudeSessions.timeline.bookmark.fail'))
  }
}

/** 书签清单 chip（时刻正序）：结论首行摘要取遮蔽视图 maskedEntries——清单是
 *  渲染面，与消息正文/拖拽预览同过 P-108 防线。书签指向未加载段（截断窗外
 *  的更早轮次）时只显时刻不显摘要 */
const bookmarkChips = computed(() =>
  [...bookmarks.value]
    .sort()
    .map(at => {
      const idx = idxByAt.value.get(at)
      const e = idx !== undefined ? maskedEntries.value[idx] : undefined
      return {
        at,
        clock: fmtClock(at),
        text: (e?.text ?? '').split('\n')[0]!.trim(),
      }
    }))

/** 书签跳转：目标未加载（更早分页段）先「加载更多」追加到位（无进展即止，
 *  同 locateFocus 口径——截断窗外不可达的书签如实提示，不静默跳首条） */
async function jumpToBookmark(at: string) {
  let idx = idxByAt.value.get(at)
  while (idx === undefined && entries.value.length < total.value) {
    const before = entries.value.length
    await fetchPage(entries.value.length, true)
    if (entries.value.length === before) break
    idx = idxByAt.value.get(at)
  }
  if (idx === undefined) {
    message.warning(t('claudeSessions.timeline.bookmark.missing'))
    return
  }
  await jumpToIndex(idx)
}

// ============== 轮级标签编辑（P-20261003-256）：内联输入 + 快捷复用 ==============
// 编辑器用条目内联行而非浮层：虚拟列表条目随滚动换窗，teleport 浮层的定位
// 跟不上滚动（且内联行的高度变化由既有 RO 实测回写天然消化，P-182 链路零
// 新增）。输入归一：trim + 剥前导 #（hashtag 输入惯例，与服务端 NormalizeTag
// 同口径，前端先归一让「已存在」判定在乐观期内即准确）
const tagEditingIdx = ref(-1)
const tagDraft = ref('')

// 模板 ref 不能用静态 ref 形态：编辑行位于 v-for 内（Vue 会把 ref 收集为数组），
// 用函数 ref 收单个实例（同一时刻至多一行编辑器，卸载回调置空）
let tagInputEl: { focus: () => void } | null = null
function setTagInputRef(el: unknown) {
  tagInputEl = (el as { focus: () => void } | null) ?? null
}

/** 当前编辑轮已挂的标签名集合：快捷复用 chips 的已挂态判定 */
const editorTurnTags = computed<string[]>(() => {
  const at = tagEditingIdx.value >= 0 ? entries.value[tagEditingIdx.value]?.at : undefined
  return (at ? tagsByAt.value.get(at) : undefined) ?? []
})

function toggleTagEditor(idx: number) {
  if (tagEditingIdx.value === idx) {
    tagEditingIdx.value = -1
    return
  }
  tagEditingIdx.value = idx
  tagDraft.value = ''
  void nextTick(() => tagInputEl?.focus())
}

/** 提交草稿：归一后空 = 关闭了事（误回车不打扰）；同名标签已在 = 幂等关闭；
 *  否则乐观上屏 + 落服务端（setTag） */
function commitTagDraft(idx: number) {
  const at = entries.value[idx]?.at
  const tag = tagDraft.value.trim().replace(/^#+/, '')
  tagEditingIdx.value = -1
  tagDraft.value = ''
  if (!at || !tag || (tagsByAt.value.get(at) ?? []).includes(tag)) return
  void setTag(at, tag, true)
}

/** 编辑器内快捷复用 chips：会话已有标签逐个 toggle 到当前轮——「架构/修复」
 *  分类无需重复打字，也顺带承担移除入口（已挂标签再点即摘） */
function toggleTurnTag(idx: number, tag: string) {
  const at = entries.value[idx]?.at
  if (!at) return
  void setTag(at, tag, !(tagsByAt.value.get(at) ?? []).includes(tag))
}

/** 乐观增删标签（toggleBookmark 同款：先翻本地态，失败回滚 + toast，响应回传
 *  权威集收口防并发漂移） */
async function setTag(at: string, tag: string, on: boolean) {
  const has = (tagsByAt.value.get(at) ?? []).includes(tag)
  if (has === on) return // 竞态重放防御：目标态已达成不再发请求
  tags.value = on
    ? [...tags.value, { at, tag }]
    : tags.value.filter(p => !(p.at === at && p.tag === tag))
  try {
    const res = (await claudeApi.setCuration(on
      ? { sessionId: props.session.id, tagAdd: { at, tag } }
      : { sessionId: props.session.id, tagRemove: { at, tag } }
    )) as unknown as { data?: { tags?: ClaudeTurnTag[] } }
    if (Array.isArray(res?.data?.tags)) tags.value = res.data.tags
  } catch {
    tags.value = on
      ? tags.value.filter(p => !(p.at === at && p.tag === tag))
      : [...tags.value, { at, tag }]
    message.error(t('claudeSessions.timeline.tag.fail'))
  }
}

// ============== 键盘导航（P-20261003-224）：↑↓ roving / Enter 复制 / / 聚焦搜索 ==============
// 回放导航（P-89 搜索 / P-132 进度条 / P-185 复制）此前全鼠标——键盘流是导航
// 的补全：↑↓ 在渲染列表上移动 roving 高亮（FileTreeView 键盘导航同款），Enter
// 复制该轮（P-185 单条复制链，含遮蔽视图出口），/ 直达搜索框（VS Code 列表
// 同款惯例）。roving 域 = renderList（「仅命中」下高亮只在命中内移动；首按从
// 视口中线条目起步——visibleIdx 由 P-132 滚动同步维护，回放常从半途看起，从
// 注视处开始比回顶更贴合 FileTreeView 的「从首条起步」）；滚动协调复用 P-182
// scrollToEntryPos（测量回补 + 进度位号钉住，收敛循环带序号防键盘连发拉锯）。
// i18n 无关：无新文案，复制反馈沿用 P-185 既有 toast；P-122 书签已落地，
// b 键（跳书签）留后续键盘伴生提案，此处不实现。
const navIdx = ref(-1) // roving 高亮条（entries 原下标域，-1 = 未激活）
const searchBoxRef = ref<InstanceType<typeof NInput> | null>(null)

/** ↑↓ 步进：到边即停不回绕（数百条级列表回绕会整屏跳变）；无高亮或高亮条已
 *  不在渲染域（首按/仅命中切换/查询变更/重载）时，从视口中线条目重起步 */
function navStep(dir: 1 | -1) {
  const list = renderList.value
  if (list.length === 0) return
  const cur = list.findIndex(r => r.idx === navIdx.value)
  if (cur >= 0) {
    const next = cur + dir
    if (next < 0 || next >= list.length) return
    navIdx.value = list[next]!.idx
  } else {
    // 起步点 = 首个不早于视口中线的条目（visibleIdx 由 P-132 滚动同步维护、
    // 恒在已加载域），无则域末兜底
    let start = list.findIndex(r => r.idx >= visibleIdx.value)
    if (start < 0) start = list.length - 1
    navIdx.value = list[start]!.idx
  }
  void scrollToEntryPos(navIdx.value)
}

/** 键盘处理挂 .cstl-root：弹层内任意焦点（含打开时 modal 容器的自动聚焦）冒泡
 *  可达——不必先点列表。搜索输入框内按键不参与（/ 须能输入字符，↑↓ 留给输入
 *  法候选）；焦点在行内按钮（复制钮/折叠钮/工具条/续聊）上时 Enter 是按钮原生
 *  激活语义，不重复接管防「复制+激活」双动作 */
function onRootKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      navStep(1)
      break
    case 'ArrowUp':
      e.preventDefault()
      navStep(-1)
      break
    case 'Enter':
      if (navIdx.value < 0 || target?.closest('button')) return
      e.preventDefault()
      void copyEntryText(navIdx.value)
      break
    case '/':
      // Shift+/ 产出的「?」归全局快捷键备忘单，带修饰键的组合一律不抢
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      e.preventDefault()
      searchBoxRef.value?.focus()
      break
  }
}
</script>

<template>
  <!-- 键盘导航（P-20261003-224）：容器级 keydown（↑↓/Enter//），INPUT 守卫见脚本区 -->
  <div
    class="cstl-root"
    @keydown="onRootKeydown"
  >
    <!-- 头部摘要：目录 + 步数（+ 超窗提示） -->
    <div class="cstl-head">
      <span
        class="cstl-head-cwd"
        :title="session.cwd"
      >{{ session.cwd }}</span>
      <span class="cstl-head-count">{{ t('claudeSessions.timelineSteps', { n: total }) }}</span>
      <span
        v-if="truncated"
        class="cstl-head-trunc"
      >{{ t('claudeSessions.timelineTruncated') }}</span>
    </div>

    <!-- 时间线内搜索：子串过滤即时命中 + Enter/Shift+Enter 命中间跳转 + 仅命中；
         正则开关（P-20261003-196）与终端/全局搜索同族 `.*` 语义 -->
    <div class="cstl-search">
      <n-input
        ref="searchBoxRef"
        size="small"
        clearable
        :value="searchInput"
        :placeholder="t('claudeSessions.timeline.search.placeholder')"
        :title="t('claudeSessions.timeline.search.jumpTip')"
        data-test="timeline-search-input"
        @update:value="onSearchInput"
        @keydown="onSearchKeydown"
      />
      <span
        v-if="query"
        class="cstl-search-hits"
        :class="{ 'is-none': matchIndexes.length === 0 }"
        data-test="timeline-search-hits"
      >{{ t('claudeSessions.timeline.search.hits', { n: matchIndexes.length }) }}</span>
      <!-- 正则开关（P-20261003-196）：开=按正则匹配（非法正则降级字面并提示，
           见下方警示徽标），关=字面子串（既有语义不变） -->
      <n-button
        size="tiny"
        quaternary
        class="cstl-search-regex"
        :class="{ 'is-on': searchRegex }"
        :title="t('claudeSessions.timeline.search.regexTip')"
        data-test="timeline-search-regex"
        @click="searchRegex = !searchRegex"
      >
        .*
      </n-button>
      <!-- 非法正则降级提示（P-20261003-196）：就地警示不打断输入，合法查询即消失 -->
      <span
        v-if="regexInvalid"
        class="cstl-search-regex-warn"
        data-test="timeline-search-regex-invalid"
      >{{ t('claudeSessions.timeline.search.invalidRegex') }}</span>
      <n-button
        size="tiny"
        quaternary
        class="cstl-search-only"
        :class="{ 'is-on': hitsOnly }"
        :disabled="!query"
        :title="t('claudeSessions.timeline.search.hitsOnlyTip')"
        data-test="timeline-search-hits-only"
        @click="hitsOnly = !hitsOnly"
      >
        {{ t('claudeSessions.timeline.search.hitsOnly') }}
      </n-button>
      <!-- 敏感遮蔽开关（P-20261004-14）：默认遮蔽，确认后放行原文（见脚本区） -->
      <n-button
        size="tiny"
        quaternary
        class="cstl-mask-toggle"
        :class="{ 'is-on': showOriginal }"
        :title="showOriginal ? t('claudeSessions.mask.hideTip') : t('claudeSessions.mask.showTip')"
        data-test="timeline-mask-toggle"
        @click="toggleShowOriginal"
      >
        {{ showOriginal ? t('claudeSessions.mask.hide') : t('claudeSessions.mask.show') }}
      </n-button>
      <!-- 导出双格式（P-20261003-44 md / P-20261003-60 jsonl）：下拉组化，
           触发钮在途 loading 防重复点击（下拉面板点击自身即收起，无卡面）；
           md 分完整/仅问答两档（P-20261004-132，mode 查询参数分流） -->
      <n-dropdown
        trigger="click"
        placement="bottom-end"
        :options="exportOptions"
        @select="onExportSelect"
      >
        <n-button
          size="tiny"
          quaternary
          class="cstl-export"
          :loading="exporting"
          :title="t('claudeSessions.timeline.export.tip')"
          data-test="timeline-export"
        >
          {{ t('claudeSessions.timeline.export.label') }}
          <n-icon
            size="10"
            class="cstl-export-caret"
          ><ChevronDownOutline /></n-icon>
        </n-button>
      </n-dropdown>
      <!-- 分享回放（P-20261003-77）：生成只读访客链接（含思考块/工具详情，
           默认 24h）；创建成功即弹既有结果卡（短链复制/打开/管理） -->
      <n-button
        size="tiny"
        quaternary
        class="cstl-share"
        :loading="sharing"
        :title="t('claudeSessions.timeline.share.tip')"
        data-test="timeline-share"
        @click="shareSession"
      >
        <template #icon>
          <n-icon><ShareSocialOutline /></n-icon>
        </template>
        {{ t('claudeSessions.timeline.share.label') }}
      </n-button>
      <!-- AI 总结（P-20261003-215）：agent 自读 transcript 产出结构化摘要；
           路径缺失（旧版本对端）禁用兜底，tip 注明全量阅读的成本知情 -->
      <n-button
        size="tiny"
        quaternary
        class="cstl-ai-summary"
        :loading="summarizing"
        :disabled="!session.transcriptPath"
        :title="session.transcriptPath ? t('claudeSessions.timeline.summary.tip') : t('claudeSessions.timeline.summary.noPath')"
        data-test="timeline-ai-summary"
        @click="summarizeSession"
      >
        {{ t('claudeSessions.timeline.summary.label') }}
      </n-button>
    </div>

    <!-- 时间轴进度条（P-20261003-132）：按条目索引比例拖拽跳转；拖动中浮显
         目标条目首行摘要预览（列表不动零 IO），松手滚动定位并呼吸高亮；
         title 给「当前位置 / 总数」位号（语言中立） -->
    <div
      v-if="showProgress"
      ref="barRef"
      class="cstl-progress"
      :title="`${visibleIdx + 1} / ${total}`"
      data-test="timeline-progress"
      @pointerdown="onBarDown"
      @pointermove="onBarMove"
      @pointerup="onBarUp"
      @pointercancel="onBarCancel"
    >
      <div class="cstl-progress-rail">
        <div
          class="cstl-progress-fill"
          :style="{ width: barPct }"
        />
        <div
          class="cstl-progress-thumb"
          :style="{ left: barPct }"
        />
      </div>
      <div
        v-if="barDragging"
        class="cstl-progress-tip"
        :style="{ left: dragTipPct }"
        data-test="timeline-progress-tip"
      >
        <span class="cstl-progress-pos">{{ dragPreviewPos }}</span>
        <span
          v-if="dragPreviewText"
          class="cstl-progress-text"
          v-text="dragPreviewText"
        />
      </div>
    </div>

    <!-- 书签清单（P-20261003-122）：回放顶部横排 chip（时刻 + 结论首行摘要），
         点击直达该轮（复用 P-132 jumpToIndex：虚拟化定位 + 呼吸高亮 + 紧凑视图
         退出）。单行横向滚动不折行——高度恒一行，多条书签不吃回放纵向空间；
         无书签整条不占位。摘要取遮蔽视图（脚本区 bookmarkChips 注记） -->
    <nav
      v-if="bookmarkChips.length > 0"
      class="cstl-bm-strip"
      data-test="timeline-bookmark-list"
    >
      <n-icon
        size="10"
        class="cstl-bm-strip-mark"
      ><Star /></n-icon>
      <button
        v-for="c in bookmarkChips"
        :key="c.at"
        class="cstl-bm-chip"
        data-test="timeline-bookmark-chip"
        :data-bm-at="c.at"
        :title="c.text || c.at"
        @click="jumpToBookmark(c.at)"
      >
        <span class="cstl-bm-chip-time">{{ c.clock }}</span>
        <span
          v-if="c.text"
          class="cstl-bm-chip-text"
        >{{ c.text }}</span>
      </button>
    </nav>

    <!-- 标签过滤条（P-20261003-256）：回放顶部横排 chip（#标签 + 使用轮数），
         点击切换过滤（多选 OR 语义，与「仅命中」正交叠加）。与书签清单同款
         单行横滚不折行形态；无标签整条不占位 -->
    <nav
      v-if="tagChips.length > 0"
      class="cstl-tag-strip"
      data-test="timeline-tag-list"
    >
      <n-icon
        size="10"
        class="cstl-tag-strip-mark"
      ><PricetagOutline /></n-icon>
      <button
        v-for="c in tagChips"
        :key="c.tag"
        class="cstl-tfilter"
        :class="{ 'is-on': activeTagSet.has(c.tag) }"
        data-test="timeline-tag-filter"
        :data-tag="c.tag"
        :title="t('claudeSessions.timeline.tag.filterTip', { tag: c.tag, n: c.n })"
        @click="toggleTagFilter(c.tag)"
      >
        <span class="cstl-tfilter-name">#{{ c.tag }}</span>
        <span class="cstl-tfilter-n">{{ c.n }}</span>
      </button>
    </nav>

    <!-- 列表即虚拟滚动容器（P-20261003-182）：containerProps 携切片容器 ref 与
         onScroll 切片重算；本组件自身的 scroll 监听（进度同步）经 onScrollPassive
         与之并存互不干扰。tabindex=0（P-224）：点击列表任意处（步内非按钮区）
         焦点落容器，键盘流即可开始（FileTreeView .tree-list 同款） -->
    <div
      v-bind="containerProps"
      class="cstl-list"
      tabindex="0"
      @scroll.passive="onListScroll"
    >
      <n-spin
        v-if="loading"
        size="small"
        class="cstl-loading"
      />
      <div
        v-else-if="loadError"
        class="cstl-state"
      >
        <span>{{ t('claudeSessions.timelineLoadFail') }}</span>
        <n-button
          size="tiny"
          quaternary
          @click="retry"
        >
          {{ t('claudeSessions.timelineRetry') }}
        </n-button>
      </div>
      <div
        v-else-if="entries.length === 0"
        class="cstl-state"
      >
        {{ t('claudeSessions.timelineEmpty') }}
      </div>
      <div
        v-else-if="renderList.length === 0"
        class="cstl-state"
      >
        {{ renderListEmptyText }}
      </div>
      <template v-else>
        <!-- 虚拟切片（P-20261003-182）：wrapper 撑总高+负偏移，窗口外零 DOM -->
        <div v-bind="wrapperProps">
          <div
            v-for="row in visibleSteps"
            :key="row.data.idx"
            class="cstl-step"
            :class="[`is-${row.data.e.kind}`, {
              'is-tail': row.data.idx === tailEntryIdx,
              'is-error': row.data.e.status === 'error',
              'is-hit': query && hitSet.has(row.data.idx),
              'is-hit-cur': isCurrentHit(row.data.idx),
              'is-focus': row.data.idx === focusIdx || row.data.idx === scrubIdx,
              'is-nav': row.data.idx === navIdx,
            }]"
            :data-step="row.data.idx"
          >
            <div class="cstl-rail">
              <n-icon
                size="12"
                class="cstl-dot"
              >
                <component :is="kindIcons[row.data.e.kind]" />
              </n-icon>
            </div>
            <div class="cstl-body">
              <div class="cstl-meta">
                <span class="cstl-kind">{{ kindLabel(row.data.e.kind) }}</span>
                <span
                  v-if="row.data.e.tool"
                  class="cstl-tool"
                >{{ row.data.e.tool }}</span>
                <span
                  v-if="row.data.e.at"
                  class="cstl-time"
                  :title="fmtFull(row.data.e.at)"
                >{{ fmtClock(row.data.e.at) }}</span>
                <span
                  v-if="row.data.e.at"
                  class="cstl-rel"
                >{{ relText(row.data.e.at) }}</span>
                <span
                  v-if="row.data.gap"
                  class="cstl-gap"
                >{{ row.data.gap }}</span>
                <span
                  v-if="row.data.e.status === 'error'"
                  class="cstl-status"
                >
                  <n-icon size="10"><AlertCircleOutline /></n-icon>{{ t('claudeSessions.timelineStatusError') }}
                </span>
                <!-- 轮级书签 toggle（P-20261003-122）：仅 assistant 轮可标（结论轮
                     回跳），hover/键盘聚焦浮现、已标恒显实心星；无时刻的行无定位
                     键不显示（书签键 = 轮时刻，见脚本区 P-122 节） -->
                <button
                  v-if="row.data.e.kind === 'assistant' && row.data.e.at"
                  class="cstl-bookmark"
                  :class="{ 'is-on': bookmarkSet.has(row.data.e.at) }"
                  :data-bookmark="row.data.idx"
                  :title="bookmarkSet.has(row.data.e.at) ? t('claudeSessions.timeline.bookmark.removeTip') : t('claudeSessions.timeline.bookmark.addTip')"
                  data-test="timeline-bookmark"
                  @click="toggleBookmark(row.data.idx)"
                >
                  <n-icon size="10">
                    <Star v-if="bookmarkSet.has(row.data.e.at)" />
                    <StarOutline v-else />
                  </n-icon>
                </button>
                <!-- 轮级标签（P-20261003-256）：已挂标签 chips（点击=按该标签过滤）
                     + 编辑钮（hover/键盘聚焦浮现，编辑态恒显）；无时刻的行不参与
                     （标签键 = 轮时刻，见脚本区 P-256 节） -->
                <button
                  v-for="tg in tagsByAt.get(row.data.e.at)"
                  :key="tg"
                  class="cstl-tag"
                  :class="{ 'is-active': activeTagSet.has(tg) }"
                  :data-tag-chip="tg"
                  :title="t('claudeSessions.timeline.tag.filterTip', { tag: tg, n: tagChips.find(c => c.tag === tg)?.n ?? 0 })"
                  data-test="timeline-tag-chip"
                  @click="toggleTagFilter(tg)"
                >#{{ tg }}</button>
                <button
                  v-if="row.data.e.at"
                  class="cstl-tagbtn"
                  :class="{ 'is-on': tagEditingIdx === row.data.idx }"
                  :data-tagbtn="row.data.idx"
                  :title="t('claudeSessions.timeline.tag.addTip')"
                  data-test="timeline-tag"
                  @click="toggleTagEditor(row.data.idx)"
                >
                  <n-icon size="10"><PricetagOutline /></n-icon>
                </button>
                <!-- 此轮链接复制（P-20261003-154）：hover/键盘聚焦浮现（不与既有
                     meta 信息常驻争夺空间），拼深链入剪贴板 -->
                <button
                  class="cstl-copylink"
                  :data-copylink="row.data.idx"
                  :title="t('claudeSessions.timeline.copyLink.tip')"
                  data-test="timeline-copy-link"
                  @click="copyTurnLink(row.data.idx)"
                >
                  <n-icon size="10"><CopyOutline /></n-icon>
                </button>
                <!-- 单条内容复制（P-20261003-185 回插至虚拟切片）：hover/键盘聚焦浮现，该条纯文本
                     入剪贴板（复制出口走遮蔽视图，见脚本区 entryPlainText 注记） -->
                <button
                  class="cstl-copytext"
                  :data-copytext="row.data.idx"
                  :title="t('claudeSessions.timeline.copyText.tip')"
                  data-test="timeline-copy-text"
                  @click="copyEntryText(row.data.idx)"
                >
                  <n-icon size="10">
                    <DocumentTextOutline />
                  </n-icon>
                </button>
              </div>
              <!-- 标签编辑行（P-20261003-256）：条目内联（浮层在虚拟列表滚动换窗下
                   定位跟不上，见脚本区），Enter 提交 Esc 关闭；快捷复用 chips 一并
                   承担移除入口（已挂标签再点即摘） -->
              <div
                v-if="tagEditingIdx === row.data.idx"
                class="cstl-tag-edit"
                data-test="timeline-tag-editor"
              >
                <n-input
                  :ref="setTagInputRef"
                  v-model:value="tagDraft"
                  size="tiny"
                  clearable
                  :placeholder="t('claudeSessions.timeline.tag.placeholder')"
                  data-test="timeline-tag-input"
                  @keydown.enter="commitTagDraft(row.data.idx)"
                  @keydown.esc="tagEditingIdx = -1"
                />
                <button
                  v-for="tg in tagChips"
                  :key="tg.tag"
                  class="cstl-tag-suggest"
                  :class="{ 'is-on': editorTurnTags.includes(tg.tag) }"
                  :data-tag="tg.tag"
                  :title="editorTurnTags.includes(tg.tag) ? t('claudeSessions.timeline.tag.removeTip', { tag: tg.tag }) : t('claudeSessions.timeline.tag.applyTip', { tag: tg.tag })"
                  data-test="timeline-tag-suggest"
                  @click="toggleTurnTag(row.data.idx, tg.tag)"
                >#{{ tg.tag }}</button>
              </div>
              <!-- v-text 直绑：pre-wrap 下模板换行会被渲染成空行，正文必须零模板空白 -->
              <div
                v-if="row.data.e.text"
                class="cstl-text"
                v-text="row.data.e.text"
              />
              <!-- 工具调用可折叠：收起只看输入摘要首行，展开看完整摘要 -->
              <button
                v-if="row.data.e.kind === 'tool' && row.data.e.input"
                class="cstl-input-toggle"
                :data-tool-toggle="row.data.idx"
                @click="toggleInput(row.data.idx)"
              >
                <n-icon
                  size="10"
                  class="cstl-chevron"
                  :class="{ 'is-open': expandedInputs.has(row.data.idx) }"
                >
                  <ChevronDownOutline />
                </n-icon>{{ t('claudeSessions.timelineInput') }}
              </button>
              <pre
                v-if="row.data.e.kind === 'tool' && row.data.e.input && expandedInputs.has(row.data.idx)"
                class="cstl-input-pre"
              >{{ row.data.e.input }}</pre>
            </div>
          </div>
        </div>

        <div
          v-if="showLoadMore"
          class="cstl-more"
        >
          <n-button
            size="tiny"
            quaternary
            :loading="loadingMore"
            data-test="timeline-load-more"
            @click="loadMore"
          >
            {{ t('claudeSessions.timelineLoadMore', { n: total - entries.length }) }}
          </n-button>
        </div>
      </template>
    </div>

    <!-- 续聊出口（P-20261002-96）：主按钮右置 footer，回放现场直达「继续干」；
         活跃会话隐藏（同列表行守卫：防双进程写同一对话） -->
    <div
      v-if="!session.active"
      class="cstl-footer"
    >
      <n-button
        size="small"
        type="primary"
        :loading="resuming"
        :title="t('claudeSessions.timeline.resume.tip')"
        data-test="timeline-resume"
        @click="resumeSession"
      >
        {{ t('claudeSessions.timeline.resume.label') }}
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.cstl-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.cstl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 8px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
}
.cstl-head-cwd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cstl-head-trunc { color: var(--accent-orange, #d97706); }

/* 时间线内搜索行（P-20261002-81）：输入框占满、命中徽标与「仅命中」开关靠右 */
.cstl-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px 0;
  flex-shrink: 0;
}
.cstl-search .n-input { flex: 1; }
.cstl-search-hits {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--accent-blue);
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 1px 6px;
}
.cstl-search-hits.is-none { color: var(--accent-red, #ef4444); }
.cstl-search-only.is-on { color: var(--accent-blue); font-weight: 600; }
/* 正则开关（P-20261003-196）：与「仅命中」同款 quaternary 小钮形态，开启亮蓝 */
.cstl-search-regex.is-on { color: var(--accent-blue); font-weight: 600; }
/* 非法正则降级提示（P-20261003-196）：警示色小字与命中徽标同排 */
.cstl-search-regex-warn {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--accent-yellow);
}
/* 遮蔽开关（P-20261004-14）：原文已放行时用警示色提醒「当前含敏感值」 */
.cstl-mask-toggle.is-on { color: var(--accent-yellow); font-weight: 600; }
/* 导出按钮（P-20261003-44）：工具条尾位，长文案不挤压搜索输入框 */
.cstl-export { flex-shrink: 0; }
.cstl-export-caret { margin-left: 3px; }
/* AI 总结按钮（P-20261003-215）：与导出同为工具条尾位固定钮 */
.cstl-ai-summary { flex-shrink: 0; }
/* 命中步骤左缘高亮；当前跳转定位项叠加底色便于锁定 */
.cstl-step.is-hit .cstl-body { box-shadow: inset 2px 0 0 var(--accent-blue); }
.cstl-step.is-hit-cur .cstl-body { background: var(--bg-hover); border-radius: 4px; }
/* 键盘 roving 高亮（P-20261003-224）：与 is-hit-cur 同色系但常驻（不呼吸自
   消），↑↓ 移动即跟随；高亮条同步浮现复制钮——Enter 的作用对象可见 */
.cstl-step.is-nav .cstl-body { background: var(--bg-hover); border-radius: 6px; }
.cstl-step.is-nav .cstl-copylink,
.cstl-step.is-nav .cstl-copytext,
.cstl-step.is-nav .cstl-bookmark,
.cstl-step.is-nav .cstl-tagbtn { opacity: 1; }

/* overflow-anchor:none：浏览器滚动锚定（Chrome/FF 默认开）会在测量回写改变
   上方内容高度时自动补偿 scrollTop——与虚拟列表的编程定位滚动打架（实测把
   定位目标连续推离落点、进度位号漂移），容器内禁用；落点校正归
   scrollToEntryPos 的实测位差回补循环 */
.cstl-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  padding: 10px 2px;
}
.cstl-loading { padding: 20px 0; display: flex; justify-content: center; }
.cstl-state {
  padding: 24px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* 步骤条：左轨点 + 竖线，右侧内容 */
.cstl-step {
  display: flex;
  gap: 8px;
  padding: 0 2px;
}
.cstl-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 16px;
}
.cstl-dot { margin-top: 3px; }
.cstl-rail::after {
  content: '';
  flex: 1;
  width: 1px;
  margin-top: 2px;
  background: var(--border-default);
}
/* 尾条目连线收口：虚拟切片内 :last-child 随滚动漂移，改按内容尾条判定（is-tail） */
.cstl-step.is-tail .cstl-rail::after { display: none; }
/* 定位高亮（P-20261002-82）：呼吸 2s 提示「审批时刻就在这步」，计时到由
   脚本摘除 is-focus（0.8s×2 轮 ≈ 2s，末态与初态同色故无跳变） */
.cstl-step.is-focus .cstl-body {
  border-radius: 6px;
  animation: cstl-focus-breathe 0.8s ease-in-out 2;
}
@keyframes cstl-focus-breathe {
  0%, 100% { background: transparent; }
  50% { background: var(--bg-hover); }
}
@media (prefers-reduced-motion: reduce) {
  .cstl-step.is-focus .cstl-body { animation: none; background: var(--bg-hover); }
}
.is-user .cstl-dot { color: var(--accent-blue); }
.is-assistant .cstl-dot { color: var(--brand-accent); }
.is-tool .cstl-dot { color: var(--text-secondary); }
.is-result .cstl-dot { color: var(--accent-green); }
.is-error .cstl-dot { color: var(--accent-red, #ef4444); }

.cstl-body { flex: 1; min-width: 0; padding-bottom: 12px; }
.cstl-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--text-tertiary);
}
.cstl-kind { color: var(--text-secondary); font-weight: 600; }
.cstl-tool {
  font-family: var(--font-mono);
  color: var(--accent-blue);
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 0 5px;
}
.cstl-time { font-family: var(--font-mono); }
.cstl-gap {
  font-family: var(--font-mono);
  color: var(--accent-orange, #d97706);
}
.cstl-status {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--accent-red, #ef4444);
}
/* 此轮链接复制（P-20261003-154）+ 单条内容复制（P-20261003-185）：默认隐没
   （hover/键盘聚焦浮现，可达性），同 cstl-input-toggle 的原生 button 形态
   （10px meta 行内轻量无填充） */
.cstl-copylink,
.cstl-copytext {
  display: inline-flex;
  align-items: center;
  padding: 1px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.cstl-step:hover .cstl-copylink,
.cstl-step:hover .cstl-copytext,
.cstl-copylink:focus-visible,
.cstl-copytext:focus-visible { opacity: 1; }
.cstl-copylink:hover,
.cstl-copytext:hover { color: var(--text-primary); background: var(--bg-hover); }

/* 轮级书签 toggle（P-20261003-122）：与复制钮同族 hover 显现形态；已标恒显
   实心星（accent 黄，列表行星标同色）——「这轮有书签」不被 hover 才可见的
   默认埋没 */
.cstl-bookmark {
  display: inline-flex;
  align-items: center;
  padding: 1px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.cstl-step:hover .cstl-bookmark,
.cstl-bookmark:focus-visible { opacity: 1; }
.cstl-bookmark:hover { color: var(--text-primary); background: var(--bg-hover); }
.cstl-bookmark.is-on { opacity: 1; color: var(--accent-yellow); }

/* 书签清单（P-20261003-122）：列表上方单行横排 chip，横向滚动不折行（高度恒
   一行，防多条书签吃掉回放纵向空间） */
.cstl-bm-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 4px 2px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--border-default);
}
.cstl-bm-strip-mark { flex-shrink: 0; color: var(--accent-yellow); }
.cstl-bm-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  max-width: 220px;
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: transparent;
  font-size: 10px;
  color: var(--text-secondary);
  cursor: pointer;
}
.cstl-bm-chip:hover { color: var(--text-primary); background: var(--bg-hover); }
.cstl-bm-chip-time {
  flex-shrink: 0;
  font-family: var(--font-mono);
  color: var(--accent-yellow);
}
.cstl-bm-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 标签过滤条（P-20261003-256）：与书签清单同款单行横滚形态，绿色系区分
   （书签=黄「位置」、标签=绿「语义」、搜索命中=蓝） */
.cstl-tag-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 4px 2px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--border-default);
}
.cstl-tag-strip-mark { flex-shrink: 0; color: var(--accent-green); }
.cstl-tfilter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  max-width: 220px;
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: transparent;
  font-size: 10px;
  color: var(--text-secondary);
  cursor: pointer;
}
.cstl-tfilter:hover { color: var(--text-primary); background: var(--bg-hover); }
.cstl-tfilter.is-on {
  border-color: var(--accent-green);
  color: var(--accent-green);
  font-weight: 600;
}
.cstl-tfilter-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cstl-tfilter-n {
  flex-shrink: 0;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* 条目标签 chips（P-20261003-256）：已挂恒显（语义内容非动作钮），点击=过滤 */
.cstl-tag {
  flex-shrink: 0;
  max-width: 140px;
  padding: 0 5px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: transparent;
  font-size: 10px;
  color: var(--accent-green);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.cstl-tag:hover { background: var(--bg-hover); }
.cstl-tag.is-active { border-color: var(--accent-green); font-weight: 600; }
/* 标签编辑钮（P-20261003-256）：与复制钮同族 hover 显现；编辑中恒显亮绿 */
.cstl-tagbtn {
  display: inline-flex;
  align-items: center;
  padding: 1px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.cstl-step:hover .cstl-tagbtn,
.cstl-tagbtn:focus-visible { opacity: 1; }
.cstl-tagbtn:hover { color: var(--text-primary); background: var(--bg-hover); }
.cstl-tagbtn.is-on { opacity: 1; color: var(--accent-green); }
/* 标签编辑行（P-20261003-256）：meta 行下的内联行，输入框 + 已有标签快捷复用 */
.cstl-tag-edit {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.cstl-tag-edit .n-input { flex: 1; min-width: 120px; max-width: 200px; }
.cstl-tag-suggest {
  flex-shrink: 0;
  max-width: 140px;
  padding: 0 5px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: transparent;
  font-size: 10px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.cstl-tag-suggest:hover { color: var(--text-primary); background: var(--bg-hover); }
.cstl-tag-suggest.is-on {
  border-color: var(--accent-green);
  color: var(--accent-green);
  font-weight: 600;
}

.cstl-text {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* tool 条目无正文：空节点不占位 */
.cstl-text:empty { display: none; }
/* 结果条目弱化呈现（正文是工具输出的摘要） */
.is-result .cstl-text {
  color: var(--text-secondary);
  font-size: 11px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}

.cstl-input-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 4px;
  padding: 1px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 10px;
  cursor: pointer;
}
.cstl-input-toggle:hover { color: var(--text-primary); background: var(--bg-hover); }
.cstl-chevron { transition: transform var(--motion-base); }
.cstl-chevron.is-open { transform: rotate(180deg); }
.cstl-input-pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--bg-hover);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cstl-more { display: flex; justify-content: center; padding: 4px 0 2px; }

/* 时间轴进度条（P-20261003-132）：搜索行与列表之间的细条，上下 padding 扩
   命中区不扩视觉；touch-action 关掉触摸滚动接管（拖拽手势归进度条） */
.cstl-progress {
  position: relative;
  flex-shrink: 0;
  padding: 4px 2px 6px;
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.cstl-progress-rail {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-hover);
}
.cstl-progress-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 2px;
  background: var(--accent-blue);
  opacity: 0.6;
}
.cstl-progress-thumb {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-blue);
  transform: translate(-50%, -50%);
  transition: width var(--motion-fast), height var(--motion-fast);
}
.cstl-progress:hover .cstl-progress-thumb { width: 10px; height: 10px; }
/* 拖动预览浮层：轨上方悬浮不挤占布局（同文件树 .upload-float 先例），跟随
   比例横移、钳位防裁切；pointer-events:none 防浮层截走后续 move */
.cstl-progress-tip {
  position: absolute;
  bottom: calc(100% - 4px);
  display: flex;
  align-items: baseline;
  gap: 6px;
  max-width: 96%;
  padding: 3px 8px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: var(--bg-panel);
  box-shadow: var(--shadow-pop-sm);
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
}
.cstl-progress-pos {
  flex-shrink: 0;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}
.cstl-progress-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 续聊 footer（P-20261002-96）：主按钮右置，与列表区分隔 */
.cstl-footer {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  padding: 6px 2px 2px;
  border-top: 1px solid var(--border-default);
}
</style>
