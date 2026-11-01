/**
 * useOpenFiles 域拆分（P-20261003-98）：持久化映射域——未保存草稿的 IndexedDB
 * 落库/恢复探测（P-20261002-6，对标 VS Code hot exit）与自动保存挂接
 * （P-20261002-129，afterDelay 档）。两条防抖链同构：内容变更 → 尾沿定时器 →
 * 走既有链路（草稿落 draftDb / 保存走 writeOpenFile 带 baseHash 冲突检测）。
 * 从 useOpenFiles.ts 原地迁出，行为零变化；跨域引用（findOpenFile/groups/
 * writeOpenFile）经 ctx。
 */
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import { AUTOSAVE_DELAY_MIN } from '../../stores/font'
import { projectApi } from '../../api/client'
import { AppError } from '../../api/error-types'
import { DRAFT_SAVED_BEACON_KEY, listFileDrafts, readDraft, readUntitledDraft, removeDraft, removeDrafts, removeUntitledDraft, saveDraft, saveUntitledDraft } from '../../utils/draftDb'
import type { DraftRecord, DraftSavedBeacon } from '../../utils/draftDb'
import { isRemoteEditorPath } from '../../utils/remoteEditorPath'
import type { OpenFilesCtx } from './context'
import { isUntitledPath } from './types'
import type { DraftOffer, OpenFile } from './types'

/** 远程伪路径草稿的固定命名空间（draftDb 的 projectId 槽位，P-20261004-116——
 *  P-15「远程签不进草稿」自认边界的兑现）：远程签寻址远端主机、跨项目保留且
 *  不要求选中项目（P-20261003-15），草稿键若随当前项目走，无项目编辑不落库、
 *  切项目后漂移探测不到——故以常量命名空间与项目域解耦。项目 id 是服务端
 *  uuid，常量恒不碰撞；removeProjectDrafts 按项目前缀清账也天然不波及远程
 *  草稿。伪路径自带 hostId+远端路径，键内主机/路径维度天然隔离。
 *  导出仅供单测/e2e 断言键值（生产消费方一律经 draftProjectOf 路由，不直接引用） */
export const REMOTE_DRAFT_PROJECT = 'remote-editor'

/** 草稿键的项目维度路由：远程伪路径固定命名空间，其余（本地/untitled）原样 */
function draftProjectOf(projectId: string, path: string): string {
  return isRemoteEditorPath(path) ? REMOTE_DRAFT_PROJECT : projectId
}

export function createPersist(ctx: OpenFilesCtx): void {
  const { projectStore, fontStore } = ctx

  // ── 未保存草稿（P-20261002-6）：脏文件防抖 2s 落 IndexedDB，误关/崩溃后
  // 重开文件时探测提示恢复。对标 VS Code hot exit——编辑器基本功。
  // 环境不可用（隐私模式等）由 draftDb 静默降级，此处零感知

  /** 待决恢复提示队列（bootstrap 恢复多标签可连发多条；提示条消费队首） */
  const draftOffers = ctx.draftOffers = ref<DraftOffer[]>([])
  ctx.draftOffer = computed(() => draftOffers.value[0] ?? null)

  /** 草稿防抖时长（尾沿触发：停手 2s 后落库一次） */
  const DRAFT_DEBOUNCE_MS = 2_000

  interface DraftJob {
    timer: ReturnType<typeof setTimeout>
    projectId: string
    path: string
    file: OpenFile
  }
  /** 挂起中的防抖写入：闭包持有文件对象——项目切换清空打开列表后，
   * 最后一次内容仍能落库（DB 草稿跨项目保留，切回重开可再探） */
  const draftJobs = new Map<string, DraftJob>()

  function jobKey(projectId: string, path: string): string {
    return `${projectId}\u0000${path}`
  }

  // ── 多标签草稿写竞争保护（P-20261006-8）：IndexedDB 草稿跨标签页共享且
  // last-write-wins——双 tab 同开一文件时，后写方的防抖落库会无声踩掉先写方的
  // 草稿（tab A 的 WIP 被 tab B 覆盖，崩溃恢复拿到被踩内容；自动保存机制使
  // 互踩无声，关 tab 才发现丢）。治理（P-20261002-8 uiState 键级 patch 的草稿域
  // 对称）：①轻同步信标——draftDb 两条写路径成功后广播 localStorage 信标（见
  // draftDb.ts 信标节注），本域监听 storage 事件，收到且本页更旧（savedAt 判定）
  // → 重载 DB 值 + 顶部轻提示，互踩从无声丢变可见同步；②乒乓检测兜底——窗口内
  // 反复收到同一文件的对方更新（交替写互覆的信号）→ warning 提示用户关一处。
  // 防打断：本文件 2s 内有键盘活动（scheduleDraftWrite 的编辑时间戳）时不重载
  // ——打字中被覆盖是更差体验，静默窗过后对方的下一次写入仍会跟进。

  /** 静默窗：文件最后一次键盘活动 N ms 内不重载（保守防打断的落地口径） */
  const DRAFT_SYNC_QUIET_MS = 2_000
  /** 乒乓检测窗口/命中数：窗口内收到 N 次对方更新 → 提示关一处（触发后窗口重开） */
  const DRAFT_SYNC_PINGPONG_MS = 60_000
  const DRAFT_SYNC_PINGPONG_HITS = 3

  /** 每文件跨标签同步态：stamp = 本页已知最新草稿写入时刻（自写 attempt 即记，
   *  收到更新的对方写入后推进）；editAt = 最后键盘活动时刻（静默窗判定）；
   *  hits = 窗口内收到的对方更新时刻（乒乓检测）。生命周期随文件草稿域
   *  （clearFileDraft 一并清），无全局无界增长 */
  interface DraftSyncState {
    stamp: number
    editAt: number
    hits: number[]
  }
  const draftSyncStates = new Map<string, DraftSyncState>()

  function draftSyncStateOf(key: string): DraftSyncState {
    let st = draftSyncStates.get(key)
    if (!st) {
      st = { stamp: 0, editAt: 0, hits: [] }
      draftSyncStates.set(key, st)
    }
    return st
  }

  /** 本页自写记账：attempt 时刻即推进 stamp（语义见 writeDraftNow 注） */
  function markDraftSelfWrite(projectId: string, path: string, savedAt: number) {
    draftSyncStateOf(jobKey(projectId, path)).stamp = savedAt
  }

  /** 立即落库一次草稿（防抖尾沿/卸载抢跑共用）。干净态不写；>2MB 由
   *  saveDraft 拒收（DB 保留旧草稿供降级恢复）。untitled 草稿走 draftDb 的
   *  untitled 命名空间（P-20261003-97 热退出持久，key 仍为 untitled://N 内部键），
   *  无磁盘基线故不带 baseHash；远程伪路径照走 saveDraft（projectId 已由
   *  scheduleDraftWrite 路由为固定命名空间，baseHash = 远端 content 端点 hash，
   *  恢复探测据此判陈旧），2MB 上限沿本地同语义。落库成功后 draftDb 内部广播
   *  跨标签信标（P-20261006-8）；本页同步态的 stamp 在 attempt 时刻记账（成功
   *  与否都算「本页更新」）——写失败/超限拒写时 DB 里没有本页内容，若再接受
   *  更旧的信标回灌等于双重丢失，保守以本页内存为准 */
  function writeDraftNow(projectId: string, path: string, file: OpenFile) {
    if (file.isDiff || file.content === file.originalContent) return
    const savedAt = Date.now()
    markDraftSelfWrite(projectId, path, savedAt)
    if (isUntitledPath(path)) {
      void saveUntitledDraft(projectId, path, { content: file.content, savedAt })
      return
    }
    void saveDraft(projectId, path, {
      content: file.content,
      savedAt,
      baseHash: file.baseHash || '',
    })
  }

  /** 脏文件草稿防抖写入（updateContent 触发，按 projectId+path 去抖）。
   *  未命名草稿参与（P-20261003-97）：落 untitled 命名空间，启动恢复重建 tab——
   *  原先视为无人认领的死数据，恢复链（restoreUntitledDrafts）落地后即为
   *  可认领的热退出备份；远程文件参与（P-20261004-116，兑现 P-15 自认边界）：
   *  remote: 伪路径经 draftProjectOf 落固定命名空间——改远端配置（P-15 点名
   *  核心场景）中途崩溃/断连，未保存修改与本地同样有底。本地键要求当前有
   *  选中项目，远程键不要求（远程编辑与项目正交） */
  ctx.scheduleDraftWrite = function scheduleDraftWrite(file) {
    if (file.isDiff) return
    if (!isRemoteEditorPath(file.path) && !projectStore.currentProjectId) return
    const projectId = draftProjectOf(projectStore.currentProjectId, file.path)
    const key = jobKey(projectId, file.path)
    // 键盘活动时间戳（P-20261006-8 静默窗判定源）：updateContent 每次编辑都会
    // 走到这里，是「用户正在此文件上打字」的现成信号，零新增埋点
    draftSyncStateOf(key).editAt = Date.now()
    const prev = draftJobs.get(key)
    if (prev) clearTimeout(prev.timer)
    const job: DraftJob = {
      projectId,
      path: file.path,
      file,
      timer: setTimeout(() => {
        draftJobs.delete(key)
        writeDraftNow(job.projectId, job.path, job.file)
      }, DRAFT_DEBOUNCE_MS),
    }
    draftJobs.set(key, job)
  }

  /** 草稿终态清理（保存成功/关闭文件/丢弃/撤销回净态共用）：取消挂起防抖
   *  + 删 DB 草稿 + 摘除待决恢复提示。untitled 路径清 untitled 命名空间
   *  （另存为转正/确认丢弃/回净态，P-20261003-97），无恢复提示可摘 */
  ctx.clearFileDraft = function clearFileDraft(projectId, path) {
    // 远程伪路径经路由落固定命名空间：调用方传入的 projectId（当前项目，可能
    // 为空或已切他项目）对远程键无意义——保存成功/关闭/丢弃等清理链全走本口
    const p = draftProjectOf(projectId, path)
    const key = jobKey(p, path)
    const job = draftJobs.get(key)
    if (job) {
      clearTimeout(job.timer)
      draftJobs.delete(key)
    }
    // 跨标签同步态随草稿域清账（P-20261006-8）：文件已关/已保存/已回净态，
    // 本页不再是该草稿的竞争方——此后同键信标一律不再重载（保存成功后的
    // 陈旧对方草稿由 baseHash 守卫挡住，见信标处理）
    draftSyncStates.delete(key)
    if (!isUntitledPath(path)) {
      draftOffers.value = draftOffers.value.filter(o => !(o.projectId === p && o.path === path))
      void removeDraft(p, path)
      return
    }
    void removeUntitledDraft(p, path)
  }

  function offerDraftRestore(offer: DraftOffer) {
    // 同路径去重（重复打开同文件只保留最新一条）
    draftOffers.value = draftOffers.value.filter(o => !(o.projectId === offer.projectId && o.path === offer.path))
    draftOffers.value.push(offer)
  }

  /** 打开文件后探测可恢复草稿：磁盘自草稿写入后未变（hash 一致）才提示；
   *  陈旧草稿（磁盘已前行）与无价值草稿（与磁盘一致）静默清除。探测异步
   *  落地前文件可能被关闭/编辑，逐项守卫 */
  ctx.probeDraftRestore = async function probeDraftRestore(projectId, file) {
    // 远程伪路径路由到固定命名空间（写入侧同路由，两侧必一致才能探到）
    const p = draftProjectOf(projectId, file.path)
    try {
      const draft = await readDraft(p, file.path)
      if (!draft || !draft.content) return
      if (draft.content === file.content) {
        void removeDraft(p, file.path)
        return
      }
      if (draft.baseHash && file.baseHash && draft.baseHash !== file.baseHash) {
        void removeDraft(p, file.path)
        return
      }
      if (file.content !== file.originalContent) {
        void removeDraft(p, file.path)
        return
      }
      // 文件已被关闭（占位被摘除）：提示无落点，草稿留待下次打开再探
      if (!ctx.findOpenFile(file.path)) return
      offerDraftRestore({ projectId: p, path: file.path, name: file.name, content: draft.content, savedAt: draft.savedAt })
    } catch { /* 探测失败不影响打开 */ }
  }

  /** 接受草稿恢复（提示条「恢复草稿」）：草稿写回仍打开且干净的文件。
   *  文件已关闭/已被再编辑 = 提示过期，草稿作废，不覆盖内存内容 */
  ctx.applyDraftRestore = function applyDraftRestore(projectId, path) {
    const p = draftProjectOf(projectId, path)
    const idx = draftOffers.value.findIndex(o => o.projectId === p && o.path === path)
    if (idx < 0) return
    const offer = draftOffers.value[idx]!
    draftOffers.value.splice(idx, 1)
    const found = ctx.findOpenFile(path)
    const f = found ? ctx.groups.value[found.gi]!.files[found.idx]! : null
    if (!f || f.isDiff) {
      void removeDraft(p, path)
      return
    }
    if (f.content !== f.originalContent) {
      void removeDraft(p, path)
      return
    }
    f.content = offer.content
    // DB 草稿保留：恢复后内容与草稿一致，保存成功即清；期间再崩仍可恢复
  }

  /** 丢弃草稿恢复（提示条「丢弃」）：DB 草稿删除，提示条摘除 */
  ctx.discardDraftRestore = function discardDraftRestore(projectId, path) {
    ctx.clearFileDraft(projectId, path)
  }

  /** 草稿对比预览（提示条第三键「对比预览」，P-20261004-71）：草稿 vs 磁盘
   *  现内容并排 diff。动机：提示条可能出自几小时前的崩溃，期间磁盘可能已被
   *  agent/他人再改（提示条是静态快照，不随磁盘变化刷新）——盲恢复=陈旧覆盖
   *  新内容，盲丢弃=丢掉工作，先看差异再回提示条做知情决策。
   *  左 = 草稿内容（优取 IndexedDB 现值——探测后草稿仍可能被同路径脏文件
   *  防抖重写，落库值比探测快照新；读失败退回快照），右 = 磁盘现内容
   *  （openDiffView 的 newRef 缺省路径走 readFile 现拉；远程伪路径走既有
   *  content 端点分支现拉远端——P-20261004-116 预览零新增取数形态）。
   *  oldRef 时间戳与 openConflictDiff 同口径：每次点击都新鲜两侧取数，防同键
   *  旧标签遮住最新磁盘变化。只读动作：不消费 offer，恢复/丢弃语义零变化 */
  ctx.previewDraftRestore = async function previewDraftRestore(projectId, path) {
    const p = draftProjectOf(projectId, path)
    const idx = draftOffers.value.findIndex(o => o.projectId === p && o.path === path)
    if (idx < 0) return
    const offer = draftOffers.value[idx]!
    let draftContent = offer.content
    try {
      const draft = await readDraft(p, path)
      if (draft?.content) draftContent = draft.content
    } catch { /* 环境不可用（draftDb 静默降级同源）：退回探测时快照 */ }
    void ctx.openDiffView({
      path,
      name: offer.name,
      oldRef: `draft-${Date.now()}`,
      leftContent: draftContent,
      oldLabel: ctx.t('editor.draft.diffRefLabel'),
    })
  }

  // ── 草稿库陈旧对账（P-20261003-152）：文件已被删除（git/agent/外部流程）
  // 的草稿永久滞留 IndexedDB——恢复探测只在文件打开成功后触发（core 打开链），
  // 已删文件永远轮不到自己的草稿被清。启动恢复落地后对账一次：逐草稿 silent
  // 探测文件存在性，已不存在的整批清掉并一条汇总提示。清理只走启动期一次、
  // 不挂在文件删除动作上：删除后同会话内文件还可能被重建（撤销删除/重新
  // 创建），跨会话仍缺席才是「陈旧」的可靠信号

  /** 单轮对账探测上限：草稿无总量上限（按路径累积），年久失修的项目可能
   *  积到几十上百条——封顶防启动期一次发太多请求，超出部分留待下次启动
   *  继续对账（渐进收敛，不清零不阻塞） */
  const DRAFT_RECONCILE_MAX = 100
  /** 存在性探测并发：本地实例单发即可，远程代理/弱网下串行会拖长尾，
   *  小批量并行折中（浏览器同域并发本身有限，批次只是防突发） */
  const DRAFT_RECONCILE_BATCH = 8

  /** 启动对账当前项目的文件草稿：磁盘已不存在的 → 标记陈旧并清理 + 一条
   *  汇总提示；存活草稿不动（照常参与打开时恢复探测）。由 bootstrap 恢复链
   *  在项目恢复落地后调用（不 await，后台对账不阻塞余下恢复）。
   *  误判保护：项目路径已失效（valid=false，服务端 ListProjects 现查）时整段
   *  跳过——项目不可达 ≠ 文件被删，此时逐文件探测全是 404，会误清整库；
   *  探测中非 404 的失败（网络抖动/服务端异常）同样保守保留不清理 */
  ctx.reconcileStaleDrafts = async function reconcileStaleDrafts() {
    const projectId = projectStore.currentProjectId
    if (!projectId) return
    // 项目维度守卫（③）：valid 是服务端随项目列表现查的路径可达位，boot
    // fetchProjects 刚刷新过——false = 目录被删/搬家/换盘未重定位
    const proj = projectStore.currentProject
    if (!proj || proj.valid === false) return
    let rows: Awaited<ReturnType<typeof listFileDrafts>>
    try {
      rows = await listFileDrafts(projectId)
    } catch { return } // 环境不可用由 draftDb 静默降级，此处防御兜底
    if (rows.length === 0) return
    const candidates = rows.slice(0, DRAFT_RECONCILE_MAX).map(r => r.path)
    const stale: string[] = []
    for (let i = 0; i < candidates.length; i += DRAFT_RECONCILE_BATCH) {
      const verdicts = await Promise.all(candidates.slice(i, i + DRAFT_RECONCILE_BATCH).map(async (path) => {
        try {
          await projectApi.filePolicy(projectId, path, { silent: true })
          return false // 存活：照常保留
        } catch (err) {
          // 404 = 磁盘确定已无此文件 → 陈旧；其余（网络/423/500/400）保守保留，
          // 宁可滞留到下次启动再探，绝不因一次探测失败丢未保存内容
          return err instanceof AppError && err.status === 404
        }
      }))
      for (let j = 0; j < verdicts.length; j++) {
        if (verdicts[j]) stale.push(candidates[i + j]!)
      }
    }
    if (stale.length === 0) return
    void removeDrafts(projectId, stale)
    ctx.message.info(ctx.t('editor.draft.staleCleaned', { n: String(stale.length) }))
  }

  // ── 信标接收与重载（P-20261006-8 ①）：storage 事件天然只来自其他标签页，
  // 自写信标不回环（浏览器语义，settingsSync 同款依赖）。判定链：项目维度对位
  // → 文件在本页打开且非 diff → savedAt 比本页已知更新 → 乒乓记账 → 静默窗
  // → 读 DB 草稿（等待期竞态复核）→ baseHash 陈旧守卫 → 内容一致短路 → 重载
  async function onDraftSavedBeacon(project: string, path: string, savedAt: number) {
    // 项目维度对位：本页当前上下文路由出的草稿键必须与信标一致——不同项目的
    // 同路径文件互不波及；远程伪路径两侧都路由到固定命名空间，跨项目有效
    const p = draftProjectOf(projectStore.currentProjectId, path)
    if (p !== project) return
    const found = ctx.findOpenFile(path)
    if (!found) return
    const f = ctx.groups.value[found.gi]!.files[found.idx]!
    if (f.isDiff) return
    const st = draftSyncStateOf(jobKey(p, path))
    if (savedAt <= st.stamp) return // 本页已知更新（自写或已跟进）：无需同步
    // 乒乓检测（②）先于静默窗记账：编辑中被静默窗跳过的同步同样是「另一标签
    // 页在写此文件」的信号——正是提示用户关一处的场景
    const now = Date.now()
    st.hits = st.hits.filter(t => now - t < DRAFT_SYNC_PINGPONG_MS)
    st.hits.push(now)
    if (st.hits.length >= DRAFT_SYNC_PINGPONG_HITS) {
      st.hits = []
      ctx.message.warning(ctx.t('editor.draft.conflictOtherTab', { name: f.name }))
    }
    // 静默窗防打断：本页 2s 内在此文件上有键盘活动 → 保守不重载，同步留待
    // 对方下一次写入或本页写入后由 savedAt 判定自然收敛
    if (now - st.editAt < DRAFT_SYNC_QUIET_MS) return
    let draft: DraftRecord | null
    try {
      draft = isUntitledPath(path) ? await readUntitledDraft(p, path) : await readDraft(p, path)
    } catch { return } // 环境不可用由 draftDb 静默降级，此处防御兜底
    if (!draft || !draft.content) return
    if (draft.savedAt <= st.stamp) return // 读库等待期本页已自写更新：放弃回灌
    // 磁盘已前行（草稿基线 ≠ 本页磁盘基线）：草稿对本页已陈旧——典型是对方
    // 已把内容保存落盘，恢复/重载交由既有打开探测与外部改写链，不回灌旧内容
    if (draft.baseHash && f.baseHash && draft.baseHash !== f.baseHash) return
    if (draft.content === f.content || draft.content === f.originalContent) {
      st.stamp = draft.savedAt // 内容已一致（含对方草稿无价值形态）：静默对账
      return
    }
    st.stamp = draft.savedAt
    f.content = draft.content
    // originalContent/baseHash 不动：文件保持脏态、磁盘基线不变——重载的是
    // 对方的未保存草稿不是磁盘内容，保存仍走既有冲突检测链
    ctx.message.info(ctx.t('editor.draft.syncedFromOtherTab', { name: f.name }))
  }

  function onDraftStorageEvent(e: StorageEvent) {
    if (e.key !== DRAFT_SAVED_BEACON_KEY) return
    try {
      const raw = e.newValue
      if (!raw) return
      const payload = JSON.parse(raw) as Partial<DraftSavedBeacon>
      if (typeof payload.project !== 'string' || typeof payload.path !== 'string'
        || typeof payload.savedAt !== 'number' || !Number.isFinite(payload.savedAt)) return
      void onDraftSavedBeacon(payload.project, payload.path, payload.savedAt)
    } catch { /* 载荷异常静默：信标是纯增益，草稿本体已落库 */ }
  }

  /** 卸载前抢跑挂起的防抖写入（IndexedDB 异步 best-effort：已发起的事务
   *  多数能在页面卸载后完成；失败则退回上一次防抖落库的草稿） */
  function flushPendingDrafts() {
    for (const job of draftJobs.values()) {
      clearTimeout(job.timer)
      writeDraftNow(job.projectId, job.path, job.file)
    }
    draftJobs.clear()
  }
  function onDraftPageHide() { flushPendingDrafts() }

  // ── 编辑器自动保存（P-20261002-129，对标 VS Code files.autoSave afterDelay 档）：
  // 内容变更停手 autoSaveDelayMs 后自动走既有保存链 writeOpenFile——baseHash 冲突
  // 检测自然生效；409 不自动覆盖，弹既有三选对话框交用户裁决，同时把该路径加入
  // 熔断集停掉自动重试（防对话框连弹），覆盖/读盘裁决回净态后自动解除。
  // off 档零挂接，行为与历史一致

  /** 挂起中的自动保存防抖（path → timer，尾沿触发，与草稿防抖同构） */
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 409 待裁决熔断集：冲突对话框未裁决前停掉该路径的自动保存 */
  const autoSaveBlocked = ctx.autoSaveBlocked = new Set<string>()

  ctx.cancelAutoSave = function cancelAutoSave(path) {
    const timer = autoSaveTimers.get(path)
    if (timer) {
      clearTimeout(timer)
      autoSaveTimers.delete(path)
    }
  }

  /** 项目切换清场：取消全部挂起防抖并解除熔断（挂起态同属旧项目上下文） */
  ctx.cancelAllAutoSave = function cancelAllAutoSave() {
    for (const timer of autoSaveTimers.values()) clearTimeout(timer)
    autoSaveTimers.clear()
    autoSaveBlocked.clear()
  }

  /** 内容变更后的自动保存排程（updateContent 调用）：档位关 / 不可存形态
   *  （diff 视图、未命名草稿、远程文件——自动保存撞上主机离线会连发失败请求，
   *  远程编辑走显式 Ctrl+S；P-20261004-116 远程参与的是草稿防丢底不是自动保存，
   *  P-15 显式保存语义保持不变）/ 熔断中不排程；停手到点且文件仍脏才写 */
  ctx.scheduleAutoSave = function scheduleAutoSave(file) {
    if (fontStore.editor.autoSave !== 'afterDelay') return
    if (file.isDiff || isUntitledPath(file.path) || isRemoteEditorPath(file.path)) return
    if (!projectStore.currentProjectId) return
    if (autoSaveBlocked.has(file.path)) return
    const path = file.path
    ctx.cancelAutoSave(path)
    autoSaveTimers.set(path, setTimeout(() => {
      autoSaveTimers.delete(path)
      void runAutoSave(path)
    }, Math.max(AUTOSAVE_DELAY_MIN, fontStore.editor.autoSaveDelayMs)))
  }

  /** 防抖到点：文件已关/已回净态则丢弃，仍脏才写。走既有保存链（含 baseHash
   *  检测），成功不弹 toast——自动保存的落盘反馈是脏标记消失，逐次 toast 刷屏 */
  async function runAutoSave(path: string) {
    const found = ctx.findOpenFile(path)
    if (!found) return
    const f = ctx.groups.value[found.gi]!.files[found.idx]!
    if (f.isDiff || f.content === f.originalContent) return
    if (await ctx.writeOpenFile(f, { toast: false }) === 'conflict') autoSaveBlocked.add(path)
  }

  // 草稿防抖写入的卸载抢跑（pagehide 对刷新/关闭/移动端后台化均可靠）
  // + 跨标签信标监听（P-20261006-8），同点注册同点摘除
  window.addEventListener('pagehide', onDraftPageHide)
  window.addEventListener('storage', onDraftStorageEvent)
  if (getCurrentScope()) {
    onScopeDispose(() => {
      window.removeEventListener('pagehide', onDraftPageHide)
      window.removeEventListener('storage', onDraftStorageEvent)
    })
  }
}
