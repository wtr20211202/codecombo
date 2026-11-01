/**
 * useOpenFiles 域拆分（P-20261003-98）：核心打开集域——双组模型、打开/关闭/
 * 切换族、关闭栈与项目切换清场。从 useOpenFiles.ts 原地迁出，行为零变化；
 * 跨域引用（草稿清理、自动保存、冲突解除、分屏收组）一律经 ctx（见 context.ts
 * 头注的填充时序纪律）。远程文件装载（loadRemoteInto/retryRemoteFile）属
 * 「打开/重开」动作的远端分支，与打开集同域。
 */
import { computed, getCurrentScope, nextTick, onScopeDispose, ref, watch } from 'vue'
import { projectApi, remoteHostApi } from '../../api/client'
import { AppError } from '../../api/error-types'
import { isRemoteEditorPath, parseRemoteEditorPath } from '../../utils/remoteEditorPath'
import { registerBeforeProjectSwitchHook } from '../../stores/project'
import type { EditorConfigEffective } from '../../utils/editorConfig'
import { confirmDialog } from '../useDialog'
import type { OpenFilesCtx } from './context'
import { isUntitledPath } from './types'
import type { ClosedFileRecord, EditorGroup, OpenFile, OpenFileOptions, SplitDirection } from './types'

/** 关闭栈上限：足够覆盖一次误操作回溯，防长会话无限增长 */
const CLOSED_FILES_MAX = 10

export function createCore(ctx: OpenFilesCtx): void {
  const { projectStore } = ctx
  const { onPushRecent, onRemoveRecent, onDisposeModel } = ctx.hooks

  // --- 状态 ---
  // 分屏 MVP 双组模型：groups 恒为两元素（组 1 可能为空），splitOpen 控制组 1
  // 是否渲染。openFiles/activeFileIndex 是组 0 的兼容视图（writable computed），
  // 全部既有调用方（键盘快捷键、uiState 持久化、扁平列表单测）语义不变；
  // openFile 等核心操作面向「活跃组」，单组场景下活跃组恒为组 0，行为等价
  function createGroup(): EditorGroup {
    return { files: [], activeIndex: -1 }
  }
  const groups = ctx.groups = ref<EditorGroup[]>([createGroup(), createGroup()])
  const activeGroup = ctx.activeGroup = ref(0)
  ctx.splitOpen = ref(false)
  const splitOpen = ctx.splitOpen
  // 分屏方向（P-20261005-230 正交拆分）：缺省横向 = P-13 既有行为；只影响
  // EditorArea 双组容器的排列轴，两组清单/活跃位与方向正交（切方向零状态重建）
  ctx.splitDirection = ref<SplitDirection>('horizontal')
  const splitDirection = ctx.splitDirection

  /** 组 0 文件列表（兼容视图）：uiState 持久化与既有单测的锚点 */
  ctx.openFiles = computed<OpenFile[]>({
    get: () => groups.value[0]!.files,
    set: (v) => { groups.value[0]!.files = v },
  })
  /** 组 0 活跃下标（兼容视图） */
  ctx.activeFileIndex = computed<number>({
    get: () => groups.value[0]!.activeIndex,
    set: (v) => { groups.value[0]!.activeIndex = v },
  })
  /** 全组去重文件视图（共享对象只计一次）：脏检查/最近文件/剪贴板对比等跨组消费用 */
  ctx.allOpenFiles = computed<OpenFile[]>(() => {
    const seen = new Set<OpenFile>()
    const out: OpenFile[] = []
    for (const g of groups.value) {
      for (const f of g.files) {
        if (!seen.has(f)) { seen.add(f); out.push(f) }
      }
    }
    return out
  })
  // 最近关闭栈（栈顶 = 最近关闭）：closeFile/批量关闭入栈，重开弹栈
  const closedFiles = ctx.closedFiles = ref<ClosedFileRecord[]>([])
  ctx.canReopenClosed = computed(() => closedFiles.value.length > 0)

  /** 活跃组当前文件：保存/大纲/面包屑跟随用户正在看的编辑器（点编辑器区切活跃组） */
  ctx.currentFile = computed(() => {
    const g = groups.value[activeGroup.value]
    if (!g) return null
    return g.activeIndex >= 0 ? g.files[g.activeIndex] ?? null : null
  })

  ctx.hasUnsavedChanges = computed(() =>
    groups.value.some(g => g.files.some(f => f.content !== f.originalContent)),
  )

  function groupAt(gi: number): EditorGroup {
    return groups.value[gi] ?? groups.value[0]!
  }
  ctx.groupAt = groupAt

  /** 按路径全组查找（返回组号 + 组内下标）；共享对象模型下同路径全工程至多一份对象 */
  ctx.findOpenFile = function findOpenFile(path) {
    for (let gi = 0; gi < groups.value.length; gi++) {
      const idx = groups.value[gi]!.files.findIndex(f => f.path === path)
      if (idx >= 0) return { gi, idx }
    }
    return null
  }

  /** 路径在目标组之外是否仍打开：共享对象还有别组引用时不释放 model、不入关闭栈 */
  ctx.isPathOpenElsewhere = function isPathOpenElsewhere(path, exceptGi) {
    return groups.value.some((g, i) => i !== exceptGi && g.files.some(f => f.path === path))
  }

  // 项目切换守卫（P-20261003-105）：project store 切换族（selectProject/
  // selectProjectExplicit）落定前回调本守卫——有未保存内容的打开 tab 时确认
  // 「有 N 份未保存草稿将丢弃」，取消 = 留在原项目。计数口径与下方清场 watch
  // 对齐：远程 tab 跨项目保留、diff 视图无用户编辑内容，均不计；untitled 草稿
  // 计入（其 IndexedDB 备份仅启动期恢复，会话内切回不重建 tab）。无脏 tab 时
  // 同步放行——store 侧保留同步赋值语义，深链「切完即开」等既有同步时序零变化。
  // 与清场 watch 成对：守卫拦前置决策，watch 管确认后的清场
  const disposeSwitchGuard = registerBeforeProjectSwitchHook(() => {
    const dirty = ctx.allOpenFiles.value.filter((f) =>
      f.content !== f.originalContent && !f.isDiff && !isRemoteEditorPath(f.path))
    if (dirty.length === 0) return true
    return confirmDialog({
      type: 'warning',
      title: ctx.t('layout.projectSwitchDraftsTitle'),
      content: ctx.t('layout.projectSwitchDraftsConfirm', { n: String(dirty.length) }),
    })
  })
  // Layout 卸载即摘守卫：守卫闭包持有本实例 ctx（per-call 状态，卸载后不重置），
  // 残留会让首页进项目的切换误弹确认。后创建实例的注销自校验身份（见 store 侧）
  if (getCurrentScope()) onScopeDispose(disposeSwitchGuard)

  // 项目切换：打开文件属于原项目上下文，路径在新项目下会指向同名/不存在的
  // 文件（保存会写进错误的仓库）。语义对齐页面刷新（刷新本就不保留未保存
  // 内容）：静默清空全部打开文件。diff 视图无 Monaco model，无需释放。
  // 例外：远程文件（remote: 伪路径）寻址远端主机不属项目上下文，跨项目保留
  // （未保存内容不丢）
  watch(() => projectStore.currentProjectId, (nv, ov) => {
    if (!ov || nv === ov) return
    for (const g of groups.value) {
      for (const f of g.files) {
        if (!f.isDiff && !isRemoteEditorPath(f.path)) onDisposeModel?.(f.path)
      }
      g.files = g.files.filter(f => isRemoteEditorPath(f.path))
      if (g.activeIndex >= g.files.length) g.activeIndex = g.files.length - 1
    }
    // 分屏随项目上下文一并收起（组 1 的远程签保留但不可见，再分屏时复现）
    activeGroup.value = 0
    splitOpen.value = false
    // 关闭栈同属旧项目上下文：跨项目恢复会把路径开进错误仓库，一并清空
    closedFiles.value = []
    // 待决草稿提示同属旧项目上下文；DB 草稿保留——切回项目重开文件会重新探测。
    // 远程签的提示跨项目保留（P-20261004-116）：远程签本身跨项目保留、其草稿
    // 键不随项目走（persist 域固定命名空间），切走时 tab 仍开着、切回无重开
    // 动作不重新探测——清了就再也不会出现
    ctx.draftOffers.value = ctx.draftOffers.value.filter(o => isRemoteEditorPath(o.path))
    // 自动保存挂起防抖与 409 熔断同属旧项目上下文，一并清空（防抖到点本有
    // findOpenFile 空守卫，此处显式清是双保险）
    ctx.cancelAllAutoSave()
  })

  /** 关闭入栈（最近关闭优先恢复）：同路径去重（重开再关不留陈旧副本），
   *  diff 视图不入栈——path 是 diff: 伪键，无法按路径重开。
   *  所有「文件真正关闭且他组未共享」的路径都经此漏斗：关闭即清草稿
   *  （用户已在未保存确认中明确放弃，重开不应再提示恢复）。untitled 草稿
   *  的关闭同样在此清账（P-20261003-97 确认丢弃 = 清 untitled 命名空间记录） */
  function pushClosedFile(file: OpenFile) {
    if (file.isDiff) return
    ctx.clearFileDraft(projectStore.currentProjectId, file.path)
    // 未命名草稿不可按路径重开（untitled://N 非真实磁盘路径，重开必 404），
    // 不入关闭栈
    if (isUntitledPath(file.path)) return
    closedFiles.value = closedFiles.value.filter(f => f.path !== file.path)
    closedFiles.value.push({ path: file.path, name: file.name })
    if (closedFiles.value.length > CLOSED_FILES_MAX) closedFiles.value.shift()
  }

  /** 组感知的关闭入栈：他组仍打开的文件不入栈（VS Code 惯例：还开着的不算「关闭」） */
  function pushClosedFileFromGroup(file: OpenFile, gi: number) {
    if (file.isDiff) return
    if (ctx.isPathOpenElsewhere(file.path, gi)) return
    pushClosedFile(file)
  }

  // --- 核心操作 ---

  /** 按对象身份从所有组摘除占位并修复各组 activeIndex（打开失败/超大守卫）：
   *  共享对象可能已被同步进他组，按下标 splice 会漏删/误删 */
  function removeOpenFileObject(file: OpenFile) {
    for (const g of groups.value) {
      const i = g.files.indexOf(file)
      if (i < 0) continue
      g.files.splice(i, 1)
      if (g.activeIndex >= g.files.length) g.activeIndex = g.files.length - 1
      else if (g.activeIndex > i) g.activeIndex--
      else if (g.activeIndex === i) g.activeIndex = Math.min(i, g.files.length - 1)
    }
  }

  /** 预览类来源（Quick Open/命令面板/全工程搜索/深链）可复用的预览位：未编辑
   *  且非 diff/草稿/固定的预览 tab（loading 中的占位同样可复用——异步加载完成
   *  时按 path 守卫写入，被后续打开换装后迟到的响应自然丢弃）。同组至多一个
   *  预览位，命中首个即可 */
  function findPreviewSlot(g: EditorGroup): number {
    return g.files.findIndex(f =>
      f.isPreview && !f.isDiff && !isUntitledPath(f.path) && !f.pinned
      && f.content === f.originalContent)
  }

  /** insertAt 落位钳制（P-20261004-74）：插入位是 dragover 期对当时打开集算的
   *  下标，drop 打开之间打开集可能已前行（并发打开/恢复链），钳进 [0, len]
   *  防 splice 越界；缺省/非有限数 = 组尾（openFile 既有 push 语义） */
  function clampInsertAt(g: EditorGroup, at: number | undefined): number {
    if (typeof at !== 'number' || !Number.isFinite(at)) return g.files.length
    return Math.min(Math.max(0, Math.round(at)), g.files.length)
  }

  /** 打开文件到指定组：目标组已有 → 激活；他组已有 → 共享同一 OpenFile 对象
   *  （同 buffer：内容/脏态/编码天然同步，Monaco 同 model 挂多编辑器官方支持）；
   *  预览类来源且存在未编辑预览位 → 原地换装复用；都没有 → 占位 + 异步加载。
   *  opts.insertAt 指定新落组的插入位（P-20261004-74 树拖到 tab 条按落点插入）：
   *  缺省 = 组尾（与既有 push 语义一致），越界钳到最近合法边界 */
  async function openFileInto(gi: number, file: { path: string; name: string }, opts?: OpenFileOptions) {
    const g = groupAt(gi)
    const existIdx = g.files.findIndex(f => f.path === file.path)
    if (existIdx >= 0) {
      g.activeIndex = existIdx
      return
    }
    const elsewhere = ctx.findOpenFile(file.path)
    if (elsewhere && elsewhere.gi !== gi) {
      const shared = groups.value[elsewhere.gi]!.files[elsewhere.idx]!
      const at = clampInsertAt(g, opts?.insertAt)
      g.files.splice(at, 0, shared)
      g.activeIndex = at
      return
    }
    // 预览类来源：命中未编辑预览位则原地换装（替换 path 与加载流，槽位下标
    // 与激活位置不变）——快速翻看候选文件不再堆积一排临时 tab。旧文件 viewState
    // 不迁移（快照按 model URI 键控，model 随下述释放被 onWillDispose 清除，
    // 旧 key 自然失效属预期）；旧 Monaco model 待渲染层随 path 切变换挂完成后再
    // 释放（同步释放会命中仍在挂载中的 model，同 saveUntitledAs 口径）
    const slotIdx = opts?.preview ? findPreviewSlot(g) : -1
    const fresh: OpenFile = {
      path: file.path,
      name: file.name,
      content: '',
      originalContent: '',
      loading: true,
      isPreview: opts?.preview || undefined,
    }
    let fileIdx: number
    if (slotIdx >= 0) {
      const oldPath = g.files[slotIdx]!.path
      g.files.splice(slotIdx, 1, fresh)
      fileIdx = slotIdx
      g.activeIndex = slotIdx
      if (!ctx.isPathOpenElsewhere(oldPath, gi)) {
        void nextTick(() => onDisposeModel?.(oldPath))
      }
    } else {
      // insertAt 指定位插入（组尾 = 缺省 push 等价）；fileIdx 随插入位走，
      // 装载完成后的 path 守卫按新下标取占位
      const at = clampInsertAt(g, opts?.insertAt)
      g.files.splice(at, 0, fresh)
      fileIdx = at
      g.activeIndex = at
    }

    // 远程主机文件（remote:<hostId>:<path> 伪路径，P-20261003-15）：内容与
    // 冲突基线走远端 content 端点，不经项目策略/项目读取/最近文件链，
    // 也不要求当前有选中项目（远程管理与项目正交）
    const remote = parseRemoteEditorPath(file.path)
    if (remote) {
      await loadRemoteInto(g, fileIdx, fresh, remote)
      return
    }

    if (!projectStore.currentProjectId) return
    const projectId = projectStore.currentProjectId

    // 策略先行：一次 stat 决定呈现方式（too-large/binary 不拉全文）。
    // silent（批量恢复链）连 404（文件已删）也不弹拦截器错误
    // editorconfig（P-20261003-95）：随策略响应同点位下发生效缩进约定，
    // 查询失败走旧读取路径兜底时无该约定（回落全局设置）
    let ec: EditorConfigEffective | undefined
    try {
      const pol = await projectApi.filePolicy(projectId, file.path, opts?.silent ? { silent: true } : undefined) as { data?: { kind?: string; size?: number; sizeHuman?: string; reason?: string }; editorconfig?: EditorConfigEffective } | undefined
      const d = pol?.data
      ec = pol?.editorconfig
      if (d && (d.kind === 'too-large' || d.kind === 'binary')) {
        const f = g.files[fileIdx]
        // path 守卫：槽位可能已被后续预览打开换装，迟到的元信息不写入新文件
        if (f && f.path === file.path) {
          f.loading = false
          f.meta = { kind: d.kind, size: d.size || 0, sizeHuman: d.sizeHuman || '', reason: d.reason }
        }
        return
      }
    } catch {
      // 策略查询失败 → 走旧读取路径兜底（服务端 ReadFile 自身仍有策略拦截）
    }

    try {
      const res = await projectApi.readFile(projectId, file.path, opts?.silent ? { silent: true } : undefined)
      const content = res.data || ''
      // 大文件守卫：超大文本进 Monaco 会拖垮分词与渲染（Monaco 自身 ~20MB 模型上限）。
      // 超限直接拒开并移除占位 tab（服务端 10MB 上限内仍可能命中此守卫）
      if (content.length > 8_000_000) {
        removeOpenFileObject(fresh)
        console.warn('[editor] file too large to open:', file.path, content.length)
        return
      }
      const f = g.files[fileIdx]
      // path 守卫：预览位换装后迟到的读取响应不写入新文件（内容/编码/hash/
      // 草稿探测整包丢弃）
      if (f && f.path === file.path) {
        f.content = content
        f.originalContent = content
        // 服务端探测的原编码（GBK 等）：保存时回传，避免一次编辑把文件转成 UTF-8
        f.encoding = typeof (res as any)?.encoding === 'string' ? (res as any).encoding : ''
        // 磁盘内容 hash：保存冲突检测基线（部分预览/旧响应无此字段 → 不检测）
        f.baseHash = typeof (res as any)?.hash === 'string' ? (res as any).hash : ''
        // .editorconfig 生效缩进约定：编辑器按文件套 model options（undefined = 无配置）
        f.editorconfig = ec
        f.loading = false
        // 草稿恢复探测（P-20261002-6）：磁盘内容就绪后比对 IndexedDB 草稿，
        // 比磁盘新才入队提示（陈旧草稿在探测内静默清除）
        void ctx.probeDraftRestore(projectId, f)
      }
      onPushRecent?.({
        path: file.path,
        name: file.name,
        projectId: projectStore.currentProjectId || '',
        projectName: projectStore.currentProject?.name || '',
        // id 会随项目重建轮换，路径才是稳定键（欢迎页最近文件按此回退匹配）
        projectPath: projectStore.currentProject?.path || '',
        ts: Date.now(),
      })
    } catch {
      removeOpenFileObject(fresh)
      // 打不开的文件（已删除/移走）从最近文件列表清掉：否则欢迎页僵尸条目
      // 每次点击都报错且永不消失
      onRemoveRecent?.(file.path)
    }
  }
  ctx.openFileInto = openFileInto

  /** 远程文件内容装载（openFileInto 的远端分支 + 横幅重试共用）：
   *  成功 = 内容/编码/baseHash 就位；415/413 = 元信息卡（二进制/超大，与本地
   *  呈现策略同语义）；其余失败 = tab 保留 + 离线只读降级（不崩不静默丢签，
   *  重试入口在横幅）。path 守卫同本地读取：占位被后续打开换装后迟到响应丢弃 */
  async function loadRemoteInto(
    g: EditorGroup, fileIdx: number, fresh: OpenFile,
    remote: { hostId: string; rpath: string; name: string },
  ) {
    try {
      // 拦截器直回 body（AxiosResponse 外壳已剥），泛型与实形不符处按仓内
      // 惯例 as unknown as 收窄（RemoteFilePane transfer 同款）
      const res = await remoteHostApi.files.content(remote.hostId, remote.rpath, { silent: true }) as unknown as { data?: string; encoding?: string; hash?: string }
      const content = res?.data || ''
      const f = g.files[fileIdx]
      if (f && f.path === fresh.path) {
        f.content = content
        f.originalContent = content
        f.encoding = typeof res?.encoding === 'string' ? res.encoding : ''
        f.baseHash = typeof res?.hash === 'string' ? res.hash : ''
        f.remoteOffline = false
        f.loading = false
        // 草稿恢复探测（P-20261004-116，本地打开链 probeDraftRestore 同款）：
        // 远端内容与冲突基线就绪后比对 IndexedDB 草稿——persist 域按伪路径路由
        // 到远程固定命名空间，比远端新才入队提示；远端已前行（hash 不一致）的
        // 陈旧草稿在探测内静默清除。projectId 入参对远程键无意义（路由忽略），
        // 传当前值仅为签名一致
        void ctx.probeDraftRestore(projectStore.currentProjectId, f)
        // 「最近远程」候选（P-20261004-137）：成功装载即记录——关签后 Quick Open
        // 远程层仍能搜到；重试/启动恢复重挂同走本链，记录随最近一次成功前移
        ctx.hooks.onPushRemoteRecent?.({
          hostId: remote.hostId, rpath: remote.rpath, name: remote.name, ts: Date.now(),
        })
      }
    } catch (err) {
      const f = g.files[fileIdx]
      if (f && f.path === fresh.path) {
        f.loading = false
        if (err instanceof AppError && err.status === 415) {
          f.meta = { kind: 'binary', size: 0, sizeHuman: '' }
        } else if (err instanceof AppError && err.status === 413) {
          f.meta = { kind: 'too-large', size: 0, sizeHuman: '' }
        } else {
          f.remoteOffline = true
          // 404 = 主机记录已删（见 dialEditClient）；惰性清最近远程死条目，
          // 主机暂时不可达（502）保留记录——恢复后仍可一键重开
          if (err instanceof AppError && err.status === 404) {
            ctx.hooks.onRemoveRemoteRecent?.(remote.hostId, remote.rpath)
          }
        }
      }
    }
  }

  /** 打开文件（进活跃组；单组兼容语义下活跃组恒为组 0，与历史行为等价） */
  ctx.openFile = async function openFile(file, opts) {
    await openFileInto(ctx.activeGroup.value, file, opts)
  }

  /** 通过路径字符串打开文件 */
  ctx.openFileByPath = async function openFileByPath(filePath, opts) {
    // 远程伪路径寻址远端主机、不属项目上下文（远程管理与项目正交，useLayoutShell
    // 的「在编辑器打开」注释同口径）：首页（无项目）Quick Open 远程层选中/深链
    // 行定位同样可达；本地路径维持「无当前项目即无处落」守卫
    if (!projectStore.currentProjectId && !isRemoteEditorPath(filePath)) return
    const name = filePath.split('/').pop() || filePath
    await ctx.openFile({ path: filePath, name }, opts)
  }

  /** 重新打开最近关闭的标签（弹栈，最近关闭先恢复）。文件已被删除时走
   *  openFile 既有失败降级（拦截器提示 + 从最近文件清单清理） */
  ctx.reopenClosedFile = async function reopenClosedFile() {
    const last = closedFiles.value.pop()
    if (!last) return
    await ctx.openFileByPath(last.path)
  }

  // --- 切换 ---

  /** 切换指定组到指定索引的标签 */
  ctx.switchFileInGroup = function switchFileInGroup(gi, index) {
    const g = groupAt(gi)
    if (index >= 0 && index < g.files.length) {
      g.activeIndex = index
    }
  }

  /** 切换到指定索引的标签（兼容入口：作用于活跃组） */
  ctx.switchFile = function switchFile(index) {
    ctx.switchFileInGroup(ctx.activeGroup.value, index)
  }

  /** 活跃组内 ±1 环绕切换标签（原 cycleEditorTab 的组感知化）：Ctrl+Tab 循环
   *  （cycleEditorTab）与 Ctrl+PgUp/PgDn 线性切换（switchTab，P-20261002-135）
   *  两个键位语义共用本条组感知切换链，实现只动活跃组（P-13 恒双组模型） */
  ctx.cycleActiveTab = function cycleActiveTab(delta) {
    const g = groupAt(ctx.activeGroup.value)
    const len = g.files.length
    if (len === 0) return
    let next = g.activeIndex
    if (delta < 0) next = (next - 1 + len) % len
    else next = (next + 1) % len
    g.activeIndex = next
  }

  /** 关闭活跃组当前标签（Ctrl+W 组感知化） */
  ctx.closeActiveGroupTab = function closeActiveGroupTab() {
    const g = groupAt(ctx.activeGroup.value)
    if (g.activeIndex >= 0) void ctx.closeFileInGroup(ctx.activeGroup.value, g.activeIndex)
  }

  // --- 关闭 ---

  /** 关闭指定组的文件标签 */
  async function closeFileInGroup(gi: number, index: number) {
    const g = groupAt(gi)
    const file = g.files[index]
    if (file && file.content !== file.originalContent) {
      if (!await confirmDialog({
        type: 'warning',
        title: ctx.t('layout.unsavedCloseTitle'),
        content: ctx.t('layout.unsavedCloseConfirm', { name: file.name }),
      })) return
    }
    // 共享对象他组仍打开：不释放 model、不入关闭栈（另一组的标签/撤销栈完好）
    const stillOpenElsewhere = file ? ctx.isPathOpenElsewhere(file.path, gi) : false
    if (file && !file.isDiff && !stillOpenElsewhere) {
      onDisposeModel?.(file.path)
    }
    g.files.splice(index, 1)
    if (file && !stillOpenElsewhere) {
      // 缓冲随关闭真正退场：取消挂起自动保存防抖、解除 409 熔断（重开即新基线）
      ctx.cancelAutoSave(file.path)
      ctx.autoSaveBlocked.delete(file.path)
      pushClosedFile(file)
    }
    if (g.activeIndex >= g.files.length) {
      g.activeIndex = g.files.length - 1
    } else if (g.activeIndex > index) {
      g.activeIndex--
    } else if (g.activeIndex === index) {
      g.activeIndex = Math.min(index, g.files.length - 1)
    }
    // 分屏组最后一签关闭 → 收起分屏（VS Code 惯例：组空即收组）
    if (gi === 1 && splitOpen.value && g.files.length === 0) {
      ctx.closeSplit()
    }
  }
  ctx.closeFileInGroup = closeFileInGroup

  /** 关闭文件标签（兼容入口：作用于活跃组） */
  ctx.closeFile = function closeFile(index) {
    return closeFileInGroup(ctx.activeGroup.value, index)
  }

  /** 关闭其他标签（保留 index；组内操作，右键菜单归属组） */
  async function closeOtherTabsInGroup(gi: number, idx: number) {
    const g = groupAt(gi)
    const file = g.files[idx]
    if (!file) return
    for (let i = g.files.length - 1; i >= 0; i--) {
      if (i !== idx) {
        const f = g.files[i]
        if (f && f.content !== f.originalContent) {
          if (!await confirmDialog({
            type: 'warning',
            title: ctx.t('layout.unsavedCloseTitle'),
            content: ctx.t('layout.unsavedCloseConfirm', { name: f.name }),
          })) return
        }
      }
    }
    // 批量关闭同样入栈（VS Code 同惯例：Close Others 也能一步重开）；按
    // 升序遍历使栈顶 = 最右侧被关标签，恢复顺序与逐个关闭一致
    const closedOthers = g.files.filter((_, i) => i !== idx)
    g.files = [file]
    g.activeIndex = 0
    for (const f of closedOthers) pushClosedFileFromGroup(f, gi)
  }
  ctx.closeOtherTabsInGroup = closeOtherTabsInGroup

  /** 关闭其他标签（兼容入口：作用于活跃组） */
  ctx.closeOtherTabs = function closeOtherTabs(idx) {
    return closeOtherTabsInGroup(ctx.activeGroup.value, idx)
  }

  /** 关闭指定组的所有标签 */
  async function closeAllTabsInGroup(gi: number) {
    const g = groupAt(gi)
    const unsaved = g.files.filter(f => f.content !== f.originalContent)
    if (unsaved.length > 0) {
      if (!await confirmDialog({
        type: 'warning',
        title: ctx.t('layout.unsavedCloseTitle'),
        content: ctx.t('layout.unsavedCloseAllConfirm', { n: String(unsaved.length) }),
      })) return
    }
    const closedAll = g.files.slice()
    g.files = []
    g.activeIndex = -1
    for (const f of closedAll) pushClosedFileFromGroup(f, gi)
    // 分屏组清空 → 收起分屏
    if (gi === 1 && splitOpen.value) ctx.closeSplit()
  }
  ctx.closeAllTabsInGroup = closeAllTabsInGroup

  /** 关闭所有标签（兼容入口：作用于活跃组） */
  ctx.closeAllTabs = function closeAllTabs() {
    return closeAllTabsInGroup(ctx.activeGroup.value)
  }

  /** 关闭指定组所有已保存且未固定的标签 */
  async function closeSavedTabsInGroup(gi: number) {
    const g = groupAt(gi)
    const keepPaths = new Set<string>()
    g.files.forEach((f) => {
      if (f.pinned || f.content !== f.originalContent) keepPaths.add(f.path)
    })
    if (keepPaths.size === g.files.length) return
    const activePath = g.activeIndex >= 0 ? g.files[g.activeIndex]?.path : undefined
    const closedSaved = g.files.filter(f => !keepPaths.has(f.path))
    g.files = g.files.filter(f => keepPaths.has(f.path))
    g.activeIndex = activePath ? g.files.findIndex(f => f.path === activePath) : -1
    for (const f of closedSaved) pushClosedFileFromGroup(f, gi)
  }
  ctx.closeSavedTabsInGroup = closeSavedTabsInGroup

  /** 关闭所有已保存且未固定的标签（兼容入口：作用于活跃组） */
  ctx.closeSavedTabs = function closeSavedTabs() {
    return closeSavedTabsInGroup(ctx.activeGroup.value)
  }

  /** 关闭指定组右侧标签（保留 idx 及之前） */
  async function closeTabsToRightInGroup(gi: number, idx: number) {
    const g = groupAt(gi)
    for (let i = g.files.length - 1; i > idx; i--) {
      const f = g.files[i]
      if (f && f.content !== f.originalContent) {
        if (!await confirmDialog({
          type: 'warning',
          title: ctx.t('layout.unsavedCloseTitle'),
          content: ctx.t('layout.unsavedCloseConfirm', { name: f.name }),
        })) return
      }
    }
    const closedRight = g.files.slice(idx + 1)
    g.files.splice(idx + 1)
    if (g.activeIndex >= g.files.length) {
      g.activeIndex = g.files.length - 1
    }
    for (const f of closedRight) pushClosedFileFromGroup(f, gi)
  }
  ctx.closeTabsToRightInGroup = closeTabsToRightInGroup

  /** 关闭右侧标签（兼容入口：作用于活跃组） */
  ctx.closeTabsToRight = function closeTabsToRight(idx) {
    return closeTabsToRightInGroup(ctx.activeGroup.value, idx)
  }

  /** 收集未保存文件列表（供实例切换前确认用）：覆盖两组，共享对象去重 */
  ctx.getUnsavedFiles = function getUnsavedFiles() {
    return ctx.allOpenFiles.value.filter(f => f.content !== f.originalContent)
  }

  /** 更新文件内容（由编辑器 v-model 触发）：全组按路径同步——共享对象下同
   *  路径至多一份对象，遍历两组是防御性写法（即使将来出现独立副本也不漂移）。
   *  草稿联动：变脏 → 防抖落库；撤销回净态 → 草稿与挂起写入一并清。
   *  自动保存联动（afterDelay 档）：变脏 → 排程停手防抖；回净态 → 取消挂起防抖 */
  ctx.updateContent = function updateContent(path, content) {
    for (const g of groups.value) {
      for (const f of g.files) {
        if (f.path === path) {
          f.content = content
          // 预览 tab 编辑即转正（VS Code 惯例）：首次内容变更摘除预览位，
          // 之后切走切回、同类来源再开都不再复用替换
          if (f.isPreview && f.content !== f.originalContent) f.isPreview = false
          if (f.isDiff) continue
          if (f.content !== f.originalContent) {
            ctx.scheduleDraftWrite(f)
            ctx.scheduleAutoSave(f)
          }
          else {
            ctx.clearFileDraft(projectStore.currentProjectId, path)
            ctx.cancelAutoSave(path)
          }
        }
      }
    }
  }

  /** 远程离线横幅「重试」：重拉远端内容（415/413 转元信息卡，成功摘离线位）。
   *  有未保存修改先确认放弃——重拉以远端内容覆盖缓冲，盲重试会无声丢编辑 */
  ctx.retryRemoteFile = async function retryRemoteFile(path) {
    const found = ctx.findOpenFile(path)
    if (!found) return
    const g = groups.value[found.gi]!
    const f = g.files[found.idx]!
    const remote = parseRemoteEditorPath(path)
    if (!remote || f.isDiff) return
    if (f.content !== f.originalContent) {
      const ok = await confirmDialog({
        type: 'warning',
        title: ctx.t('editor.remote.retryDirtyTitle'),
        content: ctx.t('editor.remote.retryDirtyBody', { name: f.name }),
      })
      if (!ok) return
    }
    f.loading = true
    f.remoteOffline = false
    await loadRemoteInto(g, found.idx, f, remote)
  }
}
