import { computed, reactive, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { DEFAULT_NOTE_ID, GLOBAL_NOTES_SCOPE, notesGlobalApi, notesOriginNonce, type MultiNoteMeta } from '../api/client'
import { mergeNoteLists } from '../utils/notesExternalSync'
import { useI18n } from './useI18n'
import {
  createNotesConflictResolvers, type NoteSaveState, type NotesConflictState,
} from './useNotesConflicts'
import { NOTES_EXTERNAL_UPDATE, type NotesExternalUpdateDetail } from '../utils/opsEvents'

/**
 * 笔记库数据面状态机（P-20261107-2 多篇 → P-20261107-5 作用域绑定 →
 * P-20261108-3 单库化）。
 *
 * 职责边界：数据面收在本 composable（清单/内容/保存态；冲突三动作在
 * useNotesConflicts 装配），呈现面（tab 条/侧栏/冲突条/续迁横幅）在 NotesPanel。
 *
 * 单库化（P-20261108-3）：笔记只有项目无关的 /api/notes 一个库——原「全局库|
 * 项目库」双源切换退役，引擎不再绑定作用域键（无 pid()/scopeOf()/
 * onScopeSwitch：没有可切换的作用域，也就没有「切换后迟到写串库」的面），
 * 全部读写走 notesGlobalApi。项目归属改为标题前缀约定「[项目名] 」（沉淀
 * 交接篇 / 存量迁移篇），面板标题搜索即可按项目筛。
 *
 * 覆盖保护三件套（面板侧半边）：自动保存默认带 baseUpdatedAt（载入时刻的
 * 服务端版本），409 不静默覆盖——冲突态挂起，由面板冲突条三动作裁决
 * （用我的覆盖 / 载入服务端版本 / 另存为新篇）。丢失上界诚实声明 = 防抖窗
 * （800ms），不承诺断电零丢失（beforeunload keepalive fetch 尽力而为）。
 */

/** 冲突现场对外形态（409 notes.conflict 响应载荷；字段见 useNotesConflicts） */
export type NotesConflict = NotesConflictState
export type { NoteSaveState }

/** 外部换装现场（P-20261111-4-S2 无扰换装）：引擎已把 contents 从 oldContent
 *  原子换到 newContent，呈现层据此在 DOM 写入后做光标锚定恢复 */
export interface NotesExternalSwap {
  noteId: string
  oldContent: string
  newContent: string
}

/** 保存端点原始路径（面板 beforeunload keepalive fetch 直发用）+ 本窗 nonce
 *  与其请求头名（同一直发请求需携 X-Notes-Origin 回声抑制头，头名与 axios
 *  写路径同源取值——面板单一导入面惯例） */
export { NOTES_ORIGIN_HEADER, notesOriginNonce, notesSaveUrl } from '../api/client'

// 防抖窗与单文档时代保持一致（2s 是丢失窗退化——评审修订点4维持 800ms）
export const NOTES_SAVE_DEBOUNCE_MS = 800

/** 笔记引擎工厂（单库：全部读写走 /api/notes 族） */
export function createNotesEngine() {
  const { t } = useI18n()
  const message = useMessage()

  const loading = ref(false)
  const loadFailed = ref(false)
  /** 在册篇（updatedAt 降序，服务端序） */
  const notes = ref<MultiNoteMeta[]>([])
  /** 回收站篇（独立拉取——面板回收站过滤段） */
  const trash = ref<MultiNoteMeta[]>([])
  /** 当前编辑篇 */
  const activeId = ref('')
  /** 各篇编辑面内容（按 noteId 键空间；切换 tab 不丢编辑态） */
  const contents = reactive<Record<string, string>>({})
  /** 各篇乐观校验基准（载入时刻的 updatedAt） */
  const bases = reactive<Record<string, string>>({})
  /** 各篇保存态（per-note 状态机——dirty/saving/error 互不牵连） */
  const saveStates = reactive<Record<string, NoteSaveState>>({})
  /** 挂起的冲突（同一时刻至多一条——冲突条是模态裁决面） */
  const conflict = ref<NotesConflictState | null>(null)

  // per-note 防抖定时器（非响应式——纯计时面）
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  // per-note 在途令牌：乱序保存响应不落地（切 tab/重载后旧响应覆盖新内容防线）
  const saveTokens = new Map<string, number>()
  // 占位默认篇集合（非响应式——逻辑判定面）：库为空时客户端合成的可编辑面，
  // 未落盘不出现在服务端清单；首次保存经服务端 default-upsert 落真身后摘除
  const placeholderIds = new Set<string>()

  const activeNote = computed(() => notes.value.find(n => n.id === activeId.value) || null)
  const activeContent = computed(() => (activeId.value ? contents[activeId.value] ?? '' : ''))
  const activeSaveState = computed<NoteSaveState>(() => (activeId.value ? saveStates[activeId.value] ?? 'idle' : 'idle'))
  /** 有挂起修改的篇（卸载 flush 的对象集） */
  const dirtyIds = computed(() => Object.keys(saveStates).filter(id => saveStates[id] === 'dirty' || saveStates[id] === 'error'))

  /** 占位默认篇（未落盘草稿）判定——面板「已保存」闪示与命名追问的门控 */
  function isPlaceholder(noteId: string): boolean {
    return placeholderIds.has(noteId)
  }

  function isTooLarge(e: unknown): boolean {
    const err = e as { status?: number; response?: { status?: number } }
    return err?.status === 413 || err?.response?.status === 413
  }

  /** 拉取在册清单并保底选中一篇（首开/清单重建共用）。保留内容缓存——
   *  清单刷新不清 contents（未保存编辑态不因外部清单变化丢失）。
   *  quiet（P-20261111-4-S2 外部更新后台刷新）：不翻 loading（loading 态会把
   *  面板 body 整体换成 NSpin——编辑器/侧栏卸载重挂 = 光标/焦点/undo 全丢），
   *  清单经 mergeNoteLists 按 id 复用未变更条目对象身份（keyed 行零 DOM 写入，
   *  仅变更项原地更新）；失败保持现面不切错误态（后台静默刷新宁欠勿扰，下轮
   *  事件或用户动作再试） */
  async function loadList(opts?: { quiet?: boolean }): Promise<void> {
    const quiet = opts?.quiet === true
    if (!quiet) {
      loading.value = true
      loadFailed.value = false
    }
    try {
      const res = await notesGlobalApi.list()
      notes.value = mergeNoteLists(notes.value, res.data ?? [])
      placeholderIds.clear()
      synthesizePlaceholderIfEmpty()
      if (!notes.value.some(n => n.id === activeId.value)) {
        activeId.value = notes.value[0]?.id ?? ''
      }
      // 新进清单的篇拉一次内容（已有缓存的篇不动——未保存编辑优先）
      await ensureLoaded(activeId.value)
      loadFailed.value = false
    } catch {
      if (!quiet) loadFailed.value = true
    } finally {
      if (!quiet) loading.value = false
    }
  }

  /** 拉取回收站清单（面板打开回收站过滤段时） */
  async function loadTrash(): Promise<void> {
    try {
      const res = await notesGlobalApi.list(true)
      trash.value = res.data ?? []
    } catch {
      trash.value = []
    }
  }

  /** 空库占位默认篇合成：id=DEFAULT_NOTE_ID——保住「打开即可打字」契约（首写
   *  经服务端 default-upsert 落真身）；未保存即切走/关面板 = 草稿丢弃（零服务端
   *  副作用，读路径零写盘红线） */
  function synthesizePlaceholderIfEmpty(): void {
    if (notes.value.length > 0) return
    const ph: MultiNoteMeta = { id: DEFAULT_NOTE_ID, title: '', updatedAt: new Date().toISOString(), size: 0 }
    notes.value = [ph]
    placeholderIds.add(ph.id)
    activeId.value = ph.id
    if (contents[ph.id] === undefined) {
      contents[ph.id] = ''
      saveStates[ph.id] = 'idle'
    }
  }

  /** 单篇内容进缓存并记乐观基准（已有内容 = 有未保存编辑，不覆盖） */
  async function ensureLoaded(noteId: string): Promise<void> {
    if (!noteId || contents[noteId] !== undefined) return
    if (placeholderIds.has(noteId)) {
      // 占位篇无服务端实体：空内容起步，首写经 PUT default upsert 落真身
      contents[noteId] = ''
      saveStates[noteId] = 'idle'
      return
    }
    try {
      const res = await notesGlobalApi.get(noteId)
      const n = res.data
      if (contents[noteId] === undefined) {
        contents[noteId] = n.content
        bases[noteId] = n.updatedAt
        if (saveStates[noteId] === undefined) saveStates[noteId] = 'idle'
      }
    } catch {
      // 单篇读取失败不拖垮面板：contents 留空串，保存时服务端 404 会如实上抛
      if (contents[noteId] === undefined) {
        contents[noteId] = ''
        saveStates[noteId] = 'idle'
      }
    }
  }

  /** 切换当前篇（先保住旧篇挂起编辑——flush 由面板统一驱动，这里只切焦点） */
  async function select(noteId: string): Promise<void> {
    if (!noteId || noteId === activeId.value) return
    activeId.value = noteId
    await ensureLoaded(noteId)
  }

  /** 新建一篇（空标题走服务端空串；内容空——空即建的 notepad 直觉）。
   *  成功即就地摘除空库占位篇 tab：占位被真身取代后清单收敛此前依赖服务端
   *  created 回声广播触发 loadList，S1 回声抑制（同 nonce 跳过）后本窗写路径
   *  自收口（零网络往返的确定性形态；占位如有挂起草稿仅摘 tab——内容缓存与
   *  dirty 态保留，flushAll 仍会经 default-upsert 落真身） */
  async function createNote(title?: string): Promise<MultiNoteMeta | null> {
    try {
      const res = await notesGlobalApi.create({ title: title ?? '' })
      const n = res.data
      notes.value = [toMeta(n), ...notes.value]
      contents[n.id] = n.content
      bases[n.id] = n.updatedAt
      saveStates[n.id] = 'idle'
      activeId.value = n.id
      discardPlaceholdersLocally()
      return toMeta(n)
    } catch (e) {
      message.error((e as { userMessage?: string }).userMessage || t('notes.panel.createFailed'))
      return null
    }
  }

  /** 就地摘除全部空库占位篇（清单面移除 + 占位标记清除）：createNote 成功后
   *  库已非空，占位 tab 退出。内容缓存刻意不清（未保存编辑不因清单变化丢失
   *  ——loadList 同纪律） */
  function discardPlaceholdersLocally(): void {
    if (placeholderIds.size === 0) return
    const ids = [...placeholderIds]
    notes.value = notes.value.filter(x => !placeholderIds.has(x.id))
    for (const id of ids) placeholderIds.delete(id)
  }

  /** 重命名（乐观更新本地清单；服务端失败回滚 + 提示） */
  async function renameNote(noteId: string, title: string): Promise<boolean> {
    const prev = notes.value.find(n => n.id === noteId)?.title ?? ''
    if (prev === title) return true
    // 保存态为 dirty 时改名会连带把未保存内容一起 PUT——先把内容落盘（改名
    // 携内容是服务端 PUT 语义的一部分），失败则整个改名失败
    try {
      const res = await notesGlobalApi.save(noteId, { content: contents[noteId] ?? '', title, baseUpdatedAt: bases[noteId] })
      applySaved(res.data)
      return true
    } catch (e) {
      if (!handleConflict(noteId, e)) {
        message.error((e as { userMessage?: string }).userMessage || t('notes.panel.renameFailed'))
      }
      return false
    }
  }

  /** 编辑面输入入口：记内容 + 排防抖保存 */
  function edit(noteId: string, content: string): void {
    contents[noteId] = content
    saveStates[noteId] = 'dirty'
    const t0 = timers.get(noteId)
    if (t0) clearTimeout(t0)
    timers.set(noteId, setTimeout(() => { void flushSave(noteId) }, NOTES_SAVE_DEBOUNCE_MS))
  }

  /** 立即落盘指定篇（防抖到期/blur/冲突裁决/快捷保存共用）。baseUpdatedAt
   *  恒带——409 由 handleConflict 挂起冲突条，绝不静默覆盖 */
  async function flushSave(noteId: string): Promise<void> {
    const t0 = timers.get(noteId)
    if (t0) { clearTimeout(t0); timers.delete(noteId) }
    const st = saveStates[noteId]
    if ((st !== 'dirty' && st !== 'error') || !noteId) return
    const token = (saveTokens.get(noteId) ?? 0) + 1
    saveTokens.set(noteId, token)
    saveStates[noteId] = 'saving'
    try {
      const res = await notesGlobalApi.save(noteId, { content: contents[noteId] ?? '', baseUpdatedAt: bases[noteId] })
      if (saveTokens.get(noteId) !== token) return // 乱序响应：已过期不落地
      applySaved(res.data)
    } catch (e) {
      if (saveTokens.get(noteId) !== token) return
      if (handleConflict(noteId, e)) return
      saveStates[noteId] = 'error'
      message.error(
        (e as { userMessage?: string }).userMessage
        || (isTooLarge(e) ? t('notes.panel.tooLarge') : t('notes.panel.saveFailed')),
      )
    }
  }

  /** 落盘全部挂起篇（卸载/visibilitychange hidden 共用；逐篇独立——单篇失败
   *  不阻断其余，错误态留面板可见） */
  async function flushAll(): Promise<void> {
    const ids = [...dirtyIds.value]
    await Promise.allSettled(ids.map(id => flushSave(id)))
  }

  /** 保存成功回写：内容/基准/状态/清单序（updatedAt 降序重排——服务端权威） */
  function applySaved(n: { id: string; title: string; updatedAt: string; size?: number }): void {
    placeholderIds.delete(n.id) // 占位篇落真身（default-upsert 首写路径）
    bases[n.id] = n.updatedAt
    // saving→idle（本响应收口）；dirty（保存期间又有输入）→保持 dirty 让下一轮
    // 防抖继续（本响应的基准已更新，下轮保存带上即是新基准）；error 态由 catch
    // 分支处置不经此（成功路径抵达时 error 已是重试轮，等价 saving）
    saveStates[n.id] = saveStates[n.id] === 'dirty' ? 'dirty' : 'idle'
    const idx = notes.value.findIndex(x => x.id === n.id)
    if (idx >= 0) {
      const meta = notes.value[idx]
      if (!meta) return
      meta.title = n.title
      meta.updatedAt = n.updatedAt
      if (typeof n.size === 'number') meta.size = n.size
      // updatedAt 降序维护：保存过的篇提前（活跃编辑面跟随，不跳变——只有
      // 非当前篇移动，当前篇恒在首位或原地）
      notes.value.splice(idx, 1)
      notes.value.unshift(meta)
    }
  }

  /** 409 冲突挂起（冲突条三动作的数据源）。返回是否为冲突分支。
   *  错误形态双认（isTooLarge 同款）：api/http.ts 响应拦截器把 axios 错误重铸
   *  为 AppError（status/data 平铺，data=响应体结构化载荷）——真实链路的 409
   *  形态是 err.status + err.data.code；axios 原形（err.response.*）留作兜底
   *  （单测桩直注 axios 形态）。〔修 P-20261111-4-S2 e2e 揭出的既有缺陷：
   *  原只认 axios 原形，真实保存链的 409 永远落 error toast 不挂冲突条〕 */
  function handleConflict(noteId: string, e: unknown): boolean {
    const err = e as {
      status?: number
      data?: { code?: string; currentContent?: string; currentUpdatedAt?: string }
      response?: { status?: number; data?: { code?: string; currentContent?: string; currentUpdatedAt?: string } }
    }
    const status = err?.response?.status ?? err?.status
    const payload = err?.response?.data ?? err?.data
    if (status !== 409 || payload?.code !== 'notes.conflict') return false
    conflict.value = {
      noteId,
      currentContent: payload?.currentContent ?? '',
      currentUpdatedAt: payload?.currentUpdatedAt ?? '',
    }
    saveStates[noteId] = 'error'
    return true
  }

  /** 软删进回收站（当前篇被删时先切到相邻篇——焦点不悬空）。
   *  占位篇（未落盘草稿）无服务端实体：就地弃稿并重合成空占位 */
  async function trashNote(noteId: string): Promise<void> {
    if (placeholderIds.has(noteId)) {
      placeholderIds.delete(noteId)
      notes.value = notes.value.filter(n => n.id !== noteId)
      delete contents[noteId]
      delete bases[noteId]
      delete saveStates[noteId]
      const t0 = timers.get(noteId)
      if (t0) { clearTimeout(t0); timers.delete(noteId) }
      synthesizePlaceholderIfEmpty()
      return
    }
    try {
      await notesGlobalApi.remove(noteId)
      notes.value = notes.value.filter(n => n.id !== noteId)
      delete saveStates[noteId]
      delete contents[noteId]
      delete bases[noteId]
      const t0 = timers.get(noteId)
      if (t0) { clearTimeout(t0); timers.delete(noteId) }
      if (activeId.value === noteId) {
        activeId.value = notes.value[0]?.id ?? ''
        await ensureLoaded(activeId.value)
      }
      void loadTrash()
    } catch (e) {
      message.error((e as { userMessage?: string }).userMessage || t('notes.panel.trashFailed'))
    }
  }

  /** 回收站恢复（幂等；恢复后清单重拉进在册序） */
  async function restoreNote(noteId: string): Promise<void> {
    try {
      await notesGlobalApi.restore(noteId)
      trash.value = trash.value.filter(n => n.id !== noteId)
      await loadList()
    } catch (e) {
      message.error((e as { userMessage?: string }).userMessage || t('notes.panel.restoreFailed'))
    }
  }

  /** 彻底删除（人侧；面板二次确认后到达这里） */
  async function purgeNote(noteId: string): Promise<void> {
    try {
      await notesGlobalApi.purge(noteId)
      trash.value = trash.value.filter(n => n.id !== noteId)
    } catch (e) {
      message.error((e as { userMessage?: string }).userMessage || t('notes.panel.purgeFailed'))
    }
  }

  /** 外部更新后的单篇无扰重读（P-20261111-4-S2 换装核心，onExternalUpdate /
   *  focusNote 共用）：GET 服务端真值 → 与编辑面现值 diff——
   *  · 逐字节相同（S1 漏网的回声/异窗写同内容/服务端重写同值）：只保鲜 bases
   *    不触碰 contents（Vue :value 值不变不回写 DOM，textarea 光标/选区/undo
   *    零扰动）。基准保鲜是同内容态的关键半边：外部写推进了服务端 updatedAt，
   *    不同步基准会让下一轮本地保存拿旧 base 误触 409 冲突条；
   *  · 不同：原子换值并返回换装现场（光标锚定数据源）。守卫链——占位篇无
   *    服务端实体不换装、取数前非 idle 不换装、取数期间用户又输入（contents
   *    已偏离快照）不换装、取数后保存链路在动不换装：人的输入优先（宁欠勿
   *    覆盖），真冲突由 baseUpdatedAt 409 冲突条兜底。单篇读取失败维持现值
   *    （loadList 已刷清单，不拖垮外部更新链路） */
  async function reloadNoteExternal(noteId: string): Promise<NotesExternalSwap | null> {
    if (!noteId || placeholderIds.has(noteId)) return null
    const before = contents[noteId]
    if (before === undefined || saveStates[noteId] !== 'idle') return null
    let fresh: { content: string; updatedAt: string }
    try {
      const res = await notesGlobalApi.get(noteId)
      fresh = res.data
    } catch {
      return null
    }
    if (contents[noteId] !== before) return null // 取数期间用户输入：让位
    if (saveStates[noteId] !== 'idle') return null // 保存链路在动（saving/error）：不换装
    if (before === fresh.content) {
      bases[noteId] = fresh.updatedAt
      return null
    }
    contents[noteId] = fresh.content
    bases[noteId] = fresh.updatedAt
    return { noteId, oldContent: before, newContent: fresh.content }
  }

  /** 外部变更事件入口（服务端 notes.updated 直通分发 + 前端内部
   *  sc:notes-external-update 同址消费）：无挂起编辑即重拉清单与当前篇——
   *  有挂起编辑时只刷清单（标题/新篇可见），内容让位人的输入（宁欠勿覆盖，
   *  冲突由 baseUpdatedAt 兜底）。只认笔记库作用域键（GLOBAL_NOTES_SCOPE）——
   *  旧版本服务端/旧事件形态带项目 id 的一律忽略（单库化后无项目库可对位）。
   *  回声抑制（P-20261111-4 S1）：本窗写请求（防抖自动保存/新建/删除）成功的
   *  服务端广播经 payload.origin 回带本窗 nonce，同 nonce 整体跳过——整篇重读
   *  会重置 textarea 光标/undo 栈打断连续输入，loadList 全量重拉伴侧栏闪动，
   *  而本窗写路径已就地维护清单与内容（保存 echo 无信息量）。无 origin（旧
   *  服务端/服务端自发起迁移广播/前端内部事件）或异窗 nonce 照常处理——
   *  宁多刷不漏刷，clipboard.arrived origin 同构。
   *  无扰换装（P-20261111-4 S2 兜底层）：清单走 quiet 后台合并（loading 态会
   *  卸载面板 body，侧栏/编辑器全量重挂）；当前篇/聚焦篇重读经
   *  reloadNoteExternal diff 后决定触碰与否，发生内容换装时返回现场给呈现层
   *  做光标锚定恢复。
   *  focus（前端内部事件：沉淀写回）→ 重拉后聚焦该篇；该篇无挂起编辑时无扰
   *  重读，确保刚追加的沉淀节可见 */
  async function onExternalUpdate(detail?: NotesExternalUpdateDetail): Promise<NotesExternalSwap | null> {
    if (!detail || detail.projectId !== GLOBAL_NOTES_SCOPE) return null
    if (detail.origin && detail.origin === notesOriginNonce()) return null
    const focusId = detail.focus ? detail.noteId : undefined
    if (dirtyIds.value.length > 0) {
      await loadList({ quiet: true })
      return focusId ? focusNote(focusId) : null
    }
    await loadList({ quiet: true })
    if (focusId) return focusNote(focusId)
    if (activeId.value) {
      // 无未保存编辑：单篇无扰重读（同内容零触碰/异内容换装，内容级外部改写即时可见）
      return reloadNoteExternal(activeId.value)
    }
    return null
  }

  /** 聚焦指定篇（外部写回后的「点啥显示啥」）：已缓存篇无扰重读（同内容零
   *  触碰/异内容换装返回现场），未缓存篇照旧拉取，挂起编辑保留（人的输入
   *  优先，保存时 409 兜底） */
  async function focusNote(noteId: string): Promise<NotesExternalSwap | null> {
    if (!notes.value.some(n => n.id === noteId)) return null
    activeId.value = noteId
    if (contents[noteId] === undefined) {
      await ensureLoaded(noteId)
      return null
    }
    return reloadNoteExternal(noteId)
  }

  function toMeta(n: { id: string; title: string; updatedAt: string; size?: number }): MultiNoteMeta {
    return { id: n.id, title: n.title, updatedAt: n.updatedAt, size: n.size ?? 0 }
  }

  // 冲突三动作装配（useNotesConflicts 显式 deps 注入——依赖单向不回引引擎；
  // handleConflict 留在引擎内：flushSave 的 409 分支就地挂起冲突现场）
  const { resolveConflictOverwrite, resolveConflictLoadServer, resolveConflictSaveAsNew } =
    createNotesConflictResolvers({ conflict, contents, bases, saveStates, notes, applySaved, createNote, edit, flushSave, message, t })

  return {
    // state
    loading, loadFailed, notes, trash, activeId, contents, bases, saveStates, conflict,
    // computed
    activeNote, activeContent, activeSaveState, dirtyIds,
    // ops
    isPlaceholder,
    loadList, loadTrash, select, createNote, renameNote, edit, flushSave, flushAll,
    trashNote, restoreNote, purgeNote, onExternalUpdate, focusNote,
    resolveConflictOverwrite, resolveConflictLoadServer, resolveConflictSaveAsNew,
  }
}

export type NotesEngine = ReturnType<typeof createNotesEngine>

/**
 * 单例引擎（NotesPanel 唯一入口）：全应用只一个状态机实例——宿主两形态（项目
 * 页主区 / 首页 overlay）路由互斥挂载，防抖定时器与在途请求跨宿主存活。
 * 首次调用须在组件 setup 内（useMessage 依赖 naive 注入上下文）
 */
let singletonEngine: NotesEngine | null = null

export function useNotesMulti(): NotesEngine {
  if (!singletonEngine) {
    singletonEngine = createNotesEngine()
  }
  return singletonEngine
}

/** 测试隔离口：重置单例引擎（vitest beforeEach 用——生产不触达） */
export function resetNotesEngines(): void {
  singletonEngine = null
}

// NOTES_EXTERNAL_UPDATE 重新导出：面板单一导入面（composable 事件入口与
// 常量同源，NotesPanel 不必同时 import opsEvents）
export { NOTES_EXTERNAL_UPDATE }
