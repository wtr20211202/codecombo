import { computed, reactive, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { DEFAULT_NOTE_ID, GLOBAL_NOTES_SCOPE, notesGlobalApi, notesOriginNonce, type MultiNoteMeta } from '../api/client'
import { mergeNoteLists } from '../utils/notesExternalSync'
import { useUIStateStore } from '../stores/uiState'
import { useInstanceStore } from '../stores/instance'
import { collectNoteTags, normalizeNoteTags } from '../utils/noteTags'
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
 *
 * 活动篇持久化（P-20261112-6-S2 写作现场）：select()/createNote() 成功即写
 * uiState notesView.activeId（占位篇不记——无服务端实体），loadList 保底选篇
 * 两段式（持久化 id 仍在清单 → 选中它，否则回落 updatedAt 首篇）。恢复与 S1
 * 开态恢复同窗：restoreNotesViewOnce 置开 → NotesPanel 懒挂载 → loadList
 * 落位，不另设恢复链。focusNote（沉淀聚焦）刻意不写（程序化「点啥显示啥」，
 * 任务口径只收用户选篇两点）。
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
  /** 在册篇（updatedAt 降序，服务端序；标签过滤激活时 = 服务端过滤后的子集） */
  const notes = ref<MultiNoteMeta[]>([])
  /** 回收站篇（独立拉取——面板回收站过滤段） */
  const trash = ref<MultiNoteMeta[]>([])
  /** 侧栏标签过滤态（P-20261112-7 S3）：空串=无过滤；非空=清单拉取携 ?tag=
   *  服务端过滤（引擎级单源——侧栏徽记/标签行 chip 两个入口都落到这里，
   *  侧栏标题搜索是清单落地后的本地过滤，两者 AND 叠加）。与回收站段互不
   *  干扰：loadTrash 恒全量拉取，过滤只作用于在册清单 */
  const tagFilter = ref('')
  /** 当前编辑篇 */
  const activeId = ref('')
  /** 各篇编辑面内容（按 noteId 键空间；切换 tab 不丢编辑态） */
  const contents = reactive<Record<string, string>>({})
  /** 各篇乐观校验基准（载入时刻的 updatedAt） */
  const bases = reactive<Record<string, string>>({})
  /** 各篇保存态（per-note 状态机——dirty/saving/error 互不牵连） */
  const saveStates = reactive<Record<string, NoteSaveState>>({})
  /** 各篇编辑面标签（P-20261112-7 S2 标签行本地真值，全量编辑面——add/remove
   *  都写完整数组；未写入过的篇回落清单 meta.tags） */
  const tags = reactive<Record<string, string[]>>({})
  /** 各篇标签编辑挂起（flushSave 携 tags 整体替换的唯一判据——纯内容保存不带
   *  tags，nil 不动他窗/他端标签；「挂起期间未落盘的标签编辑」冲突裁决链同源） */
  const tagsDirty = reactive<Record<string, boolean>>({})
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
  /** 当前篇编辑面标签（编辑面值优先——写过的篇回落清单 meta.tags 兜底） */
  const activeTags = computed<string[]>(() => {
    const id = activeId.value
    if (!id) return []
    return tags[id] ?? notes.value.find(n => n.id === id)?.tags ?? []
  })
  /** 全库既有标签去重集合（标签行「+」自动补全候选；清单序保序——热门笔记
   *  标签先出现。回收站篇不入：trash 清单按需拉取，恢复后清单刷新自然纳入。
   *  标签过滤激活时 = 过滤子集的标签集合（服务端过滤清单即引擎清单，候选池
   *  随过滤收窄——补全只能命中被过滤篇的协标签；另输新标签不受影响，属可
   *  接受边界而非缺陷） */
  const allTags = computed<string[]>(() => collectNoteTags(notes.value))
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

  // ============== 活动篇持久化（P-20261112-6-S2 写作现场） ==============
  // 键族命名循 S1 已落形态：notesView 命名空间子字段 activeId（open 同族），
  // get/save 同款键级补丁即时写（uiState store）。恢复时序与 S1
  // restoreNotesViewOnce 同窗：恢复置开 → NotesPanel 懒挂载 → onMounted
  // loadList → 保底选篇两段式在此落位（不另设恢复链）。

  /** 持久化活动篇（写端）：select()/createNote() 成功即写。占位篇不记——无服务
   *  端实体，刷新后恢复面无意义（库非空时占位必已摘除，天然落不进存档；双重
   *  守卫防语义漂移）。focusNote（沉淀写回聚焦）刻意不写：程序化「点啥显示啥」
   *  非用户选篇动作，任务口径只收 select/createNote 两点。写失败静默——读端
   *  两段式第二段（updatedAt 首篇）天然兜底，不做重试面 */
  function persistActiveId(noteId: string): void {
    if (!noteId || placeholderIds.has(noteId)) return
    try {
      void useUIStateStore().saveNotesViewActiveId(noteId)
    } catch { /* pinia 未激活等环境问题静默（persistNotesViewOpen 同款） */ }
  }

  // 恢复数据源（读端）：持久化活动篇读回。按实例 memo——uiState 记录按实例分存
  // （patchNamespaces 以调用时点 currentInstanceId 落键），引擎单例跨实例切换存活，
  // 实例切换后重读防跨实例串选；读失败/旧存档无键 = ''，两段式落第二段（向后兼容
  // 零迁移）。首个 loadList（分支命中时）消费，其后 memo 命中零额外请求
  let restoredActiveId = ''
  let restoredActiveIdFor = ''
  let restoredActiveIdReady: Promise<void> | null = null

  function ensureRestoredActiveId(): Promise<void> {
    const iid = useInstanceStore().currentInstanceId
    if (restoredActiveIdReady && restoredActiveIdFor === iid) return restoredActiveIdReady
    restoredActiveIdFor = iid
    restoredActiveIdReady = (async () => {
      try {
        restoredActiveId = await useUIStateStore().getNotesViewActiveId()
      } catch {
        restoredActiveId = ''
      }
    })()
    return restoredActiveIdReady
  }

  /** 拉取在册清单并保底选中一篇（首开/清单重建/过滤切换共用）。保留内容缓存——
   *  清单刷新不清 contents（未保存编辑态不因外部清单变化丢失）。
   *  保底选篇两段式（P-20261112-6-S2，仅当前篇不在清单时触发——已有选中不打扰）：
   *  持久化活动篇仍在清单 → 选中它；否则回落 updatedAt 首篇（服务端序）。

   *  拉取参数随 tagFilter 拼装（P-20261112-7 S3）：过滤激活时服务端只回匹配篇，
   *  notes 即过滤子集（tab 条/侧栏清单同源收窄；清过滤即全量回归）。   *  quiet（P-20261111-4-S2 外部更新后台刷新）：不翻 loading（loading 态会把
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
      const res = await notesGlobalApi.list(tagFilter.value ? { tag: tagFilter.value } : undefined)
      notes.value = mergeNoteLists(notes.value, res.data ?? [])
      placeholderIds.clear()
      synthesizePlaceholderIfEmpty()
      if (!notes.value.some(n => n.id === activeId.value)) {
        // 保底选篇两段式（P-20261112-6-S2）：①持久化活动篇仍在清单 → 选中它
        // （写作现场刷新后原篇落位）；②否则回落 updatedAt 首篇（服务端序，
        // 原规则）。旧存档无键 = '' → 天然落第二段，向后兼容零迁移。
        // 等待读回窗口内用户已点选在册篇（或占位合成落位）：人的输入优先，
        // 恢复让位（本窗竞态守卫，与 onExternalUpdate 宁欠勿覆盖同哲学）
        await ensureRestoredActiveId()
        if (!notes.value.some(n => n.id === activeId.value)) {
          activeId.value = (restoredActiveId && notes.value.some(n => n.id === restoredActiveId))
            ? restoredActiveId
            : notes.value[0]?.id ?? ''
        }
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

  /** 切换标签过滤（侧栏徽记/标签行 chip 点击入口，P-20261112-7 S3）：同值幂等
   *  （重复点同一徽记/摊开 chip 不产生无谓重拉）；变更即重拉清单——过滤口径
   *  单源在服务端 ?tag=（精确匹配真值），前端不做二次过滤。空串入参 = 清过滤 */
  async function setTagFilter(tag: string): Promise<void> {
    const next = tag.trim()
    if (next === tagFilter.value) return
    tagFilter.value = next
    await loadList()
  }

  /** 清除标签过滤恢复全量清单（侧栏过滤胶囊 x 入口）；无过滤时幂等零动作 */
  async function clearTagFilter(): Promise<void> {
    if (!tagFilter.value) return
    tagFilter.value = ''
    await loadList()
  }

  /** 拉取回收站清单（面板打开回收站过滤段时）——恒全量：标签过滤只作用于
   *  在册清单，与回收站段互不干扰口径（服务端 ?tag&trash 可叠加是给 agent
   *  通道的完整能力，人侧 UI 不混用） */
  async function loadTrash(): Promise<void> {
    try {
      const res = await notesGlobalApi.list({ trash: true })
      trash.value = res.data ?? []
    } catch {
      trash.value = []
    }
  }

  /** 空库占位默认篇合成：id=DEFAULT_NOTE_ID——保住「打开即可打字」契约（首写
   *  经服务端 default-upsert 落真身）；未保存即切走/关面板 = 草稿丢弃（零服务端
   *  副作用，读路径零写盘红线）。标签过滤激活且过滤结果为空时同样合成（空的是
   *  过滤子集不是库——主区仍有可编辑面，清过滤即回归全量；侧栏空态用过滤语境
   *  文案如实表达「没有带该标签的笔记」） */
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
      if (tags[noteId] === undefined) tags[noteId] = []
      saveStates[noteId] = 'idle'
      return
    }
    try {
      const res = await notesGlobalApi.get(noteId)
      const n = res.data
      if (contents[noteId] === undefined) {
        contents[noteId] = n.content
        bases[noteId] = n.updatedAt
        if (tags[noteId] === undefined) tags[noteId] = n.tags ?? []
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

  /** 切换当前篇（先保住旧篇挂起编辑——flush 由面板统一驱动，这里只切焦点）。
   *  选定成功即持久化活动篇（P-20261112-6-S2：刷新后原篇落位，占位篇不记） */
  async function select(noteId: string): Promise<void> {
    if (!noteId || noteId === activeId.value) return
    activeId.value = noteId
    persistActiveId(noteId)
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
      tags[n.id] = n.tags ?? []
      saveStates[n.id] = 'idle'
      activeId.value = n.id
      persistActiveId(n.id) // 新建即激活即持久化（真身有服务端实体，占位已被取代）
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

  /** 标签编辑入口（P-20261112-7 S2 标签行 add/remove 共用，全量编辑面——传入
   *  完整数组）：归一化后与编辑面现值比对，无变化短路（chips x 误点/补全重复
   *  选择不产生无谓 PUT）；有变化标 tagsDirty（flushSave 携 tags 整体替换的
   *  判据）并排防抖保存——与内容变更共用同一 per-note 定时器，同窗编辑合并
   *  一次 PUT，409 冲突保护同链（baseUpdatedAt 同源）。冲突挂起（error 态）
   *  期间编辑标签同样进链：防抖 flushSave 重试即刷新冲突现场，裁决动作按
   *  tagsDirty 携带（评审修订点：挂起期间未落盘的标签编辑不丢） */
  function editTags(noteId: string, next: string[]): void {
    if (!noteId) return
    const normalized = normalizeNoteTags(next)
    const cur = tags[noteId] ?? notes.value.find(n => n.id === noteId)?.tags ?? []
    if (cur.length === normalized.length && cur.every((t, i) => t === normalized[i])) return
    tags[noteId] = normalized
    tagsDirty[noteId] = true
    saveStates[noteId] = 'dirty'
    const t0 = timers.get(noteId)
    if (t0) clearTimeout(t0)
    timers.set(noteId, setTimeout(() => { void flushSave(noteId) }, NOTES_SAVE_DEBOUNCE_MS))
  }

  /** 立即落盘指定篇（防抖到期/blur/冲突裁决/快捷保存共用）。baseUpdatedAt
   *  恒带——409 由 handleConflict 挂起冲突条，绝不静默覆盖。tags 仅在标签
   *  编辑挂起时携带（整体替换语义——tagsDirty 即「本窗有未落盘标签编辑」，
   *  与内容同窗合并一次 PUT；纯内容保存不带 tags，服务端 nil 保全他窗标签） */
  async function flushSave(noteId: string): Promise<void> {
    const t0 = timers.get(noteId)
    if (t0) { clearTimeout(t0); timers.delete(noteId) }
    const st = saveStates[noteId]
    if ((st !== 'dirty' && st !== 'error') || !noteId) return
    const token = (saveTokens.get(noteId) ?? 0) + 1
    saveTokens.set(noteId, token)
    const carryTags = tagsDirty[noteId] === true
    saveStates[noteId] = 'saving'
    try {
      const res = await notesGlobalApi.save(noteId, {
        content: contents[noteId] ?? '',
        ...(carryTags ? { tags: tags[noteId] ?? [] } : {}),
        baseUpdatedAt: bases[noteId],
      })
      if (saveTokens.get(noteId) !== token) return // 乱序响应：已过期不落地
      applySaved(res.data, carryTags)
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

  /** 保存成功回写：内容/基准/状态/清单序（updatedAt 降序重排——服务端权威）。
   *  tagsSynced：本请求携 tags 时为 true——编辑面标签同步响应真值并清 tagsDirty；
   *  不带 tags 的保存（纯内容/重命名）不动标签状态（请求期 editTags 的挂起编辑
   *  保持，下一轮防抖携 tags 落盘） */
  function applySaved(n: { id: string; title: string; updatedAt: string; size?: number; tags?: string[] }, tagsSynced = false): void {
    placeholderIds.delete(n.id) // 占位篇落真身（default-upsert 首写路径）
    bases[n.id] = n.updatedAt
    if (tagsSynced) {
      tags[n.id] = n.tags ?? []
      tagsDirty[n.id] = false
    }
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
      // 清单 meta.tags 同步（S3 侧栏徽记数据源）：本请求携 tags 时响应真值即
      // 服务端权威——只更新清单面，不动编辑面 tags（applySaved 开头已同步）。
      // 不携 tags 的保存（纯内容/重命名）清单标签不动（nil 保全同口径）
      if (tagsSynced) {
        if (n.tags?.length) meta.tags = n.tags
        else delete meta.tags
      }
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
      data?: { code?: string; currentContent?: string; currentUpdatedAt?: string; currentTags?: string[] }
      response?: { status?: number; data?: { code?: string; currentContent?: string; currentUpdatedAt?: string; currentTags?: string[] } }
    }
    const status = err?.response?.status ?? err?.status
    const payload = err?.response?.data ?? err?.data
    if (status !== 409 || payload?.code !== 'notes.conflict') return false
    conflict.value = {
      noteId,
      currentContent: payload?.currentContent ?? '',
      currentUpdatedAt: payload?.currentUpdatedAt ?? '',
      // S2 冲突裁决链随件：载入服务端版本时本地标签编辑一并放弃，编辑面标签
      // 回落此真值（服务端 409 快照三字段自洽；异常缺省由裁决侧清单 meta 兜底）
      currentTags: payload?.currentTags,
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
      delete tags[noteId]
      delete tagsDirty[noteId]
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
      delete tags[noteId]
      delete tagsDirty[noteId]
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
   *    （loadList 已刷清单，不拖垮外部更新链路）。idle 守卫同样保证无挂起
   *    标签编辑（tagsDirty=true ⇔ saveStates 非 idle）——外部写回的标签真值
   *    （含仅改标签的写入）两分支同批同步编辑面，无光标/undo 顾虑 */
  async function reloadNoteExternal(noteId: string): Promise<NotesExternalSwap | null> {
    if (!noteId || placeholderIds.has(noteId)) return null
    const before = contents[noteId]
    if (before === undefined || saveStates[noteId] !== 'idle') return null
    let fresh: { content: string; updatedAt: string; tags?: string[] }
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
      tags[noteId] = fresh.tags ?? []
      return null
    }
    contents[noteId] = fresh.content
    bases[noteId] = fresh.updatedAt
    tags[noteId] = fresh.tags ?? []
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

  function toMeta(n: { id: string; title: string; updatedAt: string; size?: number; tags?: string[] }): MultiNoteMeta {
    return { id: n.id, title: n.title, updatedAt: n.updatedAt, size: n.size ?? 0, ...(n.tags?.length ? { tags: n.tags } : {}) }
  }

  /** 递增 per-note 在途令牌（冲突裁决动作共用）：409 挂起期间 editTags 会排出
   *  防抖重试 PUT，若裁决（overwrite 写回 / load-server 回落 / save-as-new 转移）
   *  与该重试并发，其迟到的 409 响应会在裁决完成后重挂冲突条——裁决前递增
   *  令牌使既有在途响应过期，flushSave 的乱序守卫（saveTokens 比对）就地丢弃 */
  function bumpSaveToken(noteId: string): void {
    saveTokens.set(noteId, (saveTokens.get(noteId) ?? 0) + 1)
  }

  // 冲突三动作装配（useNotesConflicts 显式 deps 注入——依赖单向不回引引擎；
  // handleConflict 留在引擎内：flushSave 的 409 分支就地挂起冲突现场。
  // S2 标签裁决链：tags/tagsDirty/editTags 随件——挂起期间未落盘的本地标签
  // 编辑在三动作路径各自承接，不静默丢弃）
  const { resolveConflictOverwrite, resolveConflictLoadServer, resolveConflictSaveAsNew } =
    createNotesConflictResolvers({ conflict, contents, bases, saveStates, notes, tags, tagsDirty, applySaved, createNote, edit, editTags, flushSave, bumpSaveToken, message, t })

  return {
    // state
    loading, loadFailed, notes, trash, tagFilter, activeId, contents, bases, tags, tagsDirty, saveStates, conflict,
    // computed
    activeNote, activeContent, activeSaveState, activeTags, allTags, dirtyIds,
    // ops
    isPlaceholder,
    loadList, loadTrash, setTagFilter, clearTagFilter, select, createNote, renameNote, edit, editTags, flushSave, flushAll,
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
