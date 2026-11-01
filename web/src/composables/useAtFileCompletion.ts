// agent 会话输入框 @ 文件引用补全（P-20261005-196）——Cursor 式上下文提顿
//
// 会话里「提到某个文件」是高频动作：@path 对 Claude Code CLI 是原生文件引用
// 语义（@ 即上下文注入），对 dsh 至少是明确路径文本——两运行时如实区分不做
// 补偿（提案③）。本模块收敛三件事：
//   - 触发检测（detectAtTrigger 纯函数）：光标前最近 @ 且前缀为行首/空白，
//     邮箱 user@host / 汉字紧贴不误触；@ 到光标间含空白即退出补全语境
//   - 条目构建（buildAtSuggestions 纯函数）：文件形态 = Quick Open 同款
//     utils/fuzzy 子序列打分过滤（完整相对路径展示、目录段淡化在浮层组件做）；
//     目录形态（P-196 修正案）= @src/ 后仅列直接子目录（选中注入目录相对
//     路径；文件引用由无斜杠形态的全路径子序列覆盖，两形态互不混列）
//   - 浮层状态机 + 清单取数：复用 projectFileList 原语（P-20261003-107），
//     缓存各消费方自持（Quick Open / 编辑器补全 / 本处节奏不同——projectFileList
//     头注同款分工），失效源与 SWR TTL 同源同值
// IME 守卫：naive-ui Input 在合成期间抑制 update:value/input 回调（Input.mjs
// handleInput 的 isComposing 短路），故只挂 naive 的 @input 回调天然「上屏期间
// 不触发」；compositionstart 再显式收浮层（合成中的文本不该参与旧浮层过滤）。
// 远程文件（P-20261004-137 在队）不进补全集：agent 会话在本地项目域，清单取
// 数只按本地项目 id（提案边界）。
import { ref } from 'vue'
import { collectProjectFileList, swrTtlMs, type PaletteFileItem } from './projectFileList'
import { fuzzyScoreWeighted } from '../utils/fuzzy'
import { PROJECT_FILE_CHANGED } from './useWebSocket'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'

/** 补全条目上限（提案②）：与编辑器路径补全 PATH_SUGGESTION_CAP 同值口径 */
export const AT_SUGGESTION_CAP = 100

/** 触发片段长度上限：超长的 @ 串是文本不是补全意图（防极端粘贴拖垮打分） */
export const AT_FRAG_MAX_LEN = 200

export interface AtTrigger {
  /** @ 字符在全文中的下标（插入替换区间起点） */
  start: number
  /** @ 到光标之间的片段（不含 @；可为空 = 刚敲 @） */
  frag: string
}

/**
 * @ 触发检测：取光标前文本里最后一个 @，其前必须是文本开头或空白（行首/
 * 空白边界——邮箱 user@host 的 @ 前是字母数字不触发，中文「联系@xx」紧贴
 * 同样不触发），@ 到光标之间不得含空白（含空白 = @ 已成过去时，不是补全
 * 语境）。片段超长视为普通文本。
 */
export function detectAtTrigger(textBeforeCursor: string): AtTrigger | null {
  const at = textBeforeCursor.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(textBeforeCursor[at - 1]!)) return null
  const frag = textBeforeCursor.slice(at + 1)
  if (frag.length > AT_FRAG_MAX_LEN) return null
  if (/\s/.test(frag)) return null
  return { start: at, frag }
}

export interface AtSuggestion {
  /** 插入路径（项目相对 / 分隔；目录带尾 /） */
  path: string
  kind: 'file' | 'dir'
  /** 排序分（越大越前；同分按路径短→长、字典序） */
  score: number
}

/** 文件路径 → 祖先目录集合（清单只有文件，目录条目由此派生——编辑器域
 *  pathCompletion.buildDirSet 同款口径，本地实现避免组件层反向依赖 views） */
export function collectDirSet(files: readonly PaletteFileItem[]): Set<string> {
  const dirs = new Set<string>()
  for (const f of files) {
    for (let i = f.path.indexOf('/'); i !== -1; i = f.path.indexOf('/', i + 1)) {
      dirs.add(f.path.slice(0, i))
    }
  }
  return dirs
}

/** 目录形态（frag 含 /）：nav 段逐一校验为真实目录（`C:/x` 类非项目路径与
 *  口语串自然零条目——pathCompletion.resolvePathRequest 同款防御），条目 =
 *  基准目录的直接子目录（仅目录，P-196 修正案），尾段按子序列模糊过滤 */
function buildDirSuggestions(
  dirs: ReadonlySet<string>,
  frag: string,
): AtSuggestion[] {
  const segs = frag.split('/')
  const filter = segs.pop() || ''
  let base = ''
  for (const seg of segs) {
    if (!seg || seg === '.') continue
    const next = base ? `${base}/${seg}` : seg
    if (!dirs.has(next)) return []
    base = next
  }
  const baseSlash = base ? `${base}/` : ''
  const hits: AtSuggestion[] = []
  for (const d of dirs) {
    if (baseSlash && !d.startsWith(baseSlash)) continue
    const rest = baseSlash ? d.slice(baseSlash.length) : d
    if (!rest || rest.includes('/')) continue // 只列直接子目录
    const score = fuzzyScoreWeighted(filter, rest)
    if (score === null) continue
    hits.push({ path: `${baseSlash}${rest}/`, kind: 'dir', score })
  }
  return hits
}

/**
 * 补全条目构建：
 * - frag 含 /（目录形态）：上述仅目录钻取/引用
 * - 否则（文件形态）：全相对路径上 Quick Open 同款子序列打分
 *   （fuzzyScoreWeighted：主字段文件名 ×2 + 路径），空片段 = 全量按
 *   「短路径优先」列出（刚敲 @ 的浏览入口，上限内截断）
 */
export function buildAtSuggestions(
  files: readonly PaletteFileItem[],
  dirs: ReadonlySet<string>,
  frag: string,
): AtSuggestion[] {
  let hits: AtSuggestion[]
  if (frag.includes('/')) {
    hits = buildDirSuggestions(dirs, frag)
  } else {
    hits = []
    for (const f of files) {
      const score = fuzzyScoreWeighted(frag, f.name, f.path)
      if (score !== null) hits.push({ path: f.path, kind: 'file', score })
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    .slice(0, AT_SUGGESTION_CAP)
}

// ── 清单缓存（模块单例，与 Quick Open/编辑器补全各自独立同姿态）──
//
// 取数原语/失效源/TTL 同源（collectProjectFileList + 两个窗口事件 + 1s 尾沿
// 去抖 + swrTtlMs）；多键少量缓存（队列面板可同时开两个不同项目会话的浮层，
// 单键缓存会在两浮层间互相顶掉反复重拉），FIFO 淘汰防无界内存。

interface FileListEntry { files: PaletteFileItem[]; dirs: Set<string>; fetchedAt: number }

const CACHE_MAX_PROJECTS = 4
const fileListCache = new Map<string, FileListEntry>()
let inflightPid = ''
let inflight: Promise<void> | null = null
let invalidateTimer: ReturnType<typeof setTimeout> | null = null
let invalidationWired = false

const EMPTY_ENTRY: FileListEntry = { files: [], dirs: new Set(), fetchedAt: 0 }

async function loadFileList(pid: string): Promise<void> {
  if (inflight && inflightPid === pid) return inflight
  inflightPid = pid
  inflight = (async () => {
    try {
      const { files } = await collectProjectFileList(pid)
      if (fileListCache.size >= CACHE_MAX_PROJECTS && !fileListCache.has(pid)) {
        const oldest = fileListCache.keys().next().value
        if (oldest !== undefined) fileListCache.delete(oldest)
      }
      fileListCache.set(pid, { files, dirs: collectDirSet(files), fetchedAt: Date.now() })
    } catch {
      // 静默保持空清单：补全是增益路径，下次触发重试（pathCompletion 同姿态）
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function invalidateFileListCache() {
  if (invalidateTimer) clearTimeout(invalidateTimer)
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null
    fileListCache.clear()
  }, 1000) // 与 Quick Open / 编辑器补全失效去抖同值：合并 agent 批量产文件的连环事件
}

function wireInvalidation() {
  if (invalidationWired) return
  invalidationWired = true
  window.addEventListener(PROJECT_FILE_CHANGED, invalidateFileListCache)
  window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, invalidateFileListCache)
}

/** 补全期取数：新鲜命中直返；陈旧回旧表 + 后台静默换新（SWR 同语义）；无表
 *  同步等全量拉取（首次触发多等一次取数，出条目即可信） */
async function getFileListForCompletion(pid: string): Promise<FileListEntry> {
  const hit = fileListCache.get(pid)
  if (hit) {
    if (Date.now() - hit.fetchedAt < swrTtlMs()) return hit
    void loadFileList(pid)
    return hit
  }
  await loadFileList(pid)
  return fileListCache.get(pid) ?? EMPTY_ENTRY
}

// ── 浮层状态机（宿主只做接线，见 UseAtFileCompletionOptions）──

export interface UseAtFileCompletionOptions {
  /** 清单归属项目 id getter：对话框用当前项目，队列面板按会话所属项目（无
   *  归属信息时回落当前项目） */
  projectId: () => string
  /** 输入框全文 getter（v-model 终值） */
  getText: () => string
  /** 光标位置 getter（selectionStart；不可得时回落文本长度） */
  getCursor: () => number
  /** 应用插入：把 [start, end) 替换为 replacement 并落光标于其尾（宿主按
   *  各自输入元素实现） */
  applyText: (start: number, end: number, replacement: string) => void
  /** 输入元素 getter：浮层 fixed 锚定与视口翻转 */
  getAnchorEl: () => HTMLElement | null
}

/** 浮层 fixed 定位样式（px 字符串；bottom 形态用于下方空间不足时的上翻） */
export interface AtPopoverPlacement {
  left: string
  top?: string
  bottom?: string
}

const POPOVER_GAP_PX = 4
const POPOVER_MAX_HEIGHT_PX = 248
const POPOVER_WIDTH_PX = 420

export function useAtFileCompletion(options: UseAtFileCompletionOptions) {
  const open = ref(false)
  const items = ref<AtSuggestion[]>([])
  const activeIndex = ref(0)
  const placement = ref<AtPopoverPlacement>({ left: '0px', top: '0px' })
  /** 当前浮层对应的触发点（null = 关闭态）；闭包内可变态不进响应式 */
  let trigger: AtTrigger | null = null
  /** 取数 await 期间的竞态守卫：新输入推进代次，旧响应过期作废 */
  let evalSeq = 0
  /** Enter 已在 keydown 被浮层消费（宿主 keyup 分支按此放行——队列输入的
   *  Enter 排队挂 keyup，keydown 的 preventDefault 拦不住它） */
  let enterConsumed = false
  // IME 合成标记：naive 已在合成期抑制 @input（见模块头注），这里显式收
  // 浮层 + 挡 evaluate（合成中的候选文本不该驱动浮层）
  let isComposing = false

  function close(): void {
    evalSeq++ // 使在途 evaluate 作废：失焦/Esc 关闭后，迟到的取数不得再弹层
    open.value = false
    trigger = null
    items.value = []
    activeIndex.value = 0
  }

  /** 浮层 fixed 定位：锚定输入元素底沿；下方视口空间不足翻到上方（侧栏底部
   *  行的队列输入场景）。宽度钳在视口内，高度固定上限（无内容测量，转场态
   *  足够） */
  function updatePlacement(): void {
    const el = options.getAnchorEl()
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH_PX - 4))
    const spaceBelow = window.innerHeight - rect.bottom
    placement.value = spaceBelow < POPOVER_MAX_HEIGHT_PX + POPOVER_GAP_PX + 40
      ? { left: `${left}px`, bottom: `${window.innerHeight - rect.top + POPOVER_GAP_PX}px` }
      : { left: `${left}px`, top: `${rect.bottom + POPOVER_GAP_PX}px` }
  }

  /** 触发评估：naive @input（合成期被抑制）与 compositionend 后调用 */
  async function evaluate(): Promise<void> {
    if (isComposing) return
    const seq = ++evalSeq
    const t = detectAtTrigger(options.getText().slice(0, options.getCursor()))
    trigger = t
    if (!t) {
      if (open.value) close()
      return
    }
    const pid = options.projectId()
    if (!pid) {
      close()
      return
    }
    const { files, dirs } = await getFileListForCompletion(pid)
    if (seq !== evalSeq) return // 取数期间有更新的输入/关闭，本次作废
    const list = buildAtSuggestions(files, dirs, t.frag)
    if (list.length === 0) {
      if (open.value) close()
      return
    }
    items.value = list
    activeIndex.value = 0
    open.value = true
    updatePlacement()
  }

  function onCompositionStart(): void {
    isComposing = true
    enterConsumed = false
    close()
  }

  function onCompositionEnd(): void {
    isComposing = false
    void evaluate()
  }

  /** naive @input 回调（合成期不触发）：每个提交后的输入重新评估触发 */
  function onInput(): void {
    enterConsumed = false
    void evaluate()
  }

  /** 浮层关闭后焦点回置锚点（失焦关闭链里点击浮层条目用 mousedown.prevent
   *  保焦，此函数只服务 Esc/程序性关闭后的键盘连续性） */
  function focusAnchor(): void {
    options.getAnchorEl()?.focus()
  }

  /** 选中条目：以「@相对路径 」原样入文本（提案③），关浮层并回置焦点 */
  function select(index: number): void {
    const t = trigger
    const item = items.value[index]
    if (!t || !item) return
    options.applyText(t.start, t.start + 1 + t.frag.length, `@${item.path} `)
    close()
    focusAnchor()
  }

  function moveActive(delta: number): void {
    const n = items.value.length
    if (n === 0) return
    activeIndex.value = (activeIndex.value + delta + n) % n
  }

  /**
   * 输入元素 keydown 分流：仅浮层在场时接管 ↑↓/Enter/Esc（其余按键与浮层
   * 关闭态零变化）。Esc stopPropagation 防 n-modal focus-trap（document
   * bubble 监听）同键关弹层；Enter preventDefault 防插入换行，stopPropagation
   * 同理防弹层级 Esc/Enter 链。返回值供宿主透传（无需额外处理）。
   */
  function onKeydown(e: KeyboardEvent): void {
    if (!open.value) return
    if (e.isComposing) return // IME 合成中的键是候选操作，放行（ApprovalCard 同款守卫）
    enterConsumed = false
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveActive(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveActive(-1)
        break
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        enterConsumed = true
        select(activeIndex.value)
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        focusAnchor()
        break
    }
  }

  /** 宿主 keyup Enter 分流：浮层消费过的 Enter（keydown 选中）不再触发既有
   *  keyup 动作（如队列输入的排队提交）。返回 true = 已消费，宿主跳过 */
  function consumeEnterKeyup(): boolean {
    if (!enterConsumed) return false
    enterConsumed = false
    return true
  }

  /** focusout 关浮层（focusout 会冒泡，原生 blur 不冒——挂在 n-input 根上
   *  收得到内部 textarea/input 的失焦）；无条件 close——open 为 false 但取数
   *  在途时也要作废在途评估（迟到响应不得在失焦后弹层）。浮层条目
   *  mousedown.prevent 保焦，点选不经过此链 */
  function onFocusout(): void {
    close()
  }

  /** 浮层条目 hover 同步活动项（键盘/指针双通道高亮一致） */
  function onHover(index: number): void {
    activeIndex.value = index
  }

  return {
    open,
    items,
    activeIndex,
    placement,
    close,
    onInput,
    onKeydown,
    onCompositionStart,
    onCompositionEnd,
    onFocusout,
    onHover,
    select,
    consumeEnterKeyup,
  }
}

/** 供测试用：清缓存 + 摘失效监听（生产代码不调用——模块单例随应用生命周期
 *  存活，pathCompletion.resetPathCompletionForTests 同姿态） */
export function resetAtFileCompletionForTests(): void {
  if (invalidateTimer) {
    clearTimeout(invalidateTimer)
    invalidateTimer = null
  }
  if (invalidationWired) {
    window.removeEventListener(PROJECT_FILE_CHANGED, invalidateFileListCache)
    window.removeEventListener(OPS_FILES_EXTERNAL_CHANGE, invalidateFileListCache)
    invalidationWired = false
  }
  fileListCache.clear()
  inflight = null
  inflightPid = ''
}
