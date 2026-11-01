import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import { projectApi } from '../api/client'
import { confirmUploadSameName } from './useDialog'
import { useLayoutLockStore } from '../stores/layoutLock'
import { collectDropFiles, hasDirectoryEntry, DROP_ENTRY_FILE_CAP } from '../utils/dropEntries'
import type { FileEntry } from './useFileTreeContext'

/**
 * 文件树拖拽（自 FileTreeView.vue 抽出）：
 * 树内拖拽移动 = renameFile；浏览器外部文件拖入 = 上传到目标目录（根空白处上传到项目根）。
 * 多选拖拽（P-20261003-160）：起点在宿主多选集合内且 ≥2 时整组随行，落目录走
 * 批量端点单请求收口（P-20261006-39）——单文件路径保持既有语义零改动
 * （dataTransfer 仍只携锚点路径，终端 pane / tab 头等单路径消费者不受影响，
 * 多选集合经 ref 树内传递）。
 * 外部文件上传（P-20261003-117）：逐文件串行队列 + 聚合进度（N/M + 当前文件名，
 * 细条浮于树头）+ 失败清单定点/全部重试——原单发大请求进度全黑且一损俱损。
 * 同名覆盖确认（P-20261003-230）：入队前对目标目录清单求交，命中同名弹
 * 「跳过/覆盖」确认（默认跳过）——服务端同名跳过是兜底权威，本检测只做发现面。
 * 目录拖入（P-20261023-2③b）：webkitGetAsEntry 递归枚举展平为相对路径文件集
 * 走同一上传链（服务端 paths 旁挂字段按段建目录）——此前拖放链只吃平铺 files，
 * 目录拖入实际不可用。
 */

/** 批量移动单批上限：批量端点单请求收口（P-20261006-39）后仍保留的前端量级
 *  护栏（端点自身护栏 ≤200 在其上；与 bulk-agent ≤20 / 上传 skipped 报告同族
 *  的量级护栏），封顶防大全会话长时间占用；超出部分不动并如实报告 */
export const MOVE_BATCH_CAP = 50

/** 上传批次账目（P-20261003-117）：一次 drop / 一次重试 = 一批，批内文件共同
 *  结算 toast（成功 n 个沿用既有聚合文案）与目标目录刷新；remaining 归零即结算 */
interface UploadBatch {
  dest: string
  remaining: number
  saved: number
  failed: number
}

/** 上传队列条目：dest 随条目走（失败重试可落回原目录，跨批次目录可不同）；
 *  pid 入队时快照——队列排空耗时可能横跨项目切换，逐请求现取会把剩余文件
 *  上传到切换后的项目（跨项目错投）；overwrite 随条目走（P-20261003-230：
 *  同批确认「覆盖」的文件带覆盖档请求，跳过档/重试各持原语义）；
 *  relPath（P-20261023-2）：目录拖入的相对路径旁挂名（file.name 即相对路径，
 *  含 / 才携带——multipart filename 被服务端解析层剥 basename，子路径经
 *  paths 字段落位） */
interface UploadQueueItem {
  pid: string
  file: File
  dest: string
  batch: UploadBatch
  overwrite: boolean
  relPath?: string
}

/** 失败清单条目：保留 File 引用供重试再入队（重读磁盘不可行——拖入的文件
 *  句柄是这次会话唯一的字节来源）；pid 同条目快照（重试落回原项目）；
 *  overwrite 一并快照（覆盖档失败重试保持覆盖意图，跳过档不升格） */
export interface UploadFailedItem {
  pid: string
  file: File
  dest: string
  overwrite: boolean
}

/** 名单摘要（前 3 项 + … 截断，useFileTreeContext.summarizeNames 同族惯例） */
function summarizeNames(names: string[]): string {
  return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')
}

export function useFileTreeDragDrop(options: {
  projectId: () => string
  /** 宿主持有的多选集合（P-20261002-20）：dragstart 时判断整组随行（所有权归宿主） */
  selectedPaths?: Ref<Set<string>>
  refreshTargetPath: (dirPath: string) => Promise<void>
  refreshRoot: () => Promise<void>
  message: { success(m: string): void; warning(m: string): void; error(m: string): void }
  t: (k: string, p?: Record<string, unknown>) => string
  /** 同名覆盖确认（P-20261003-230）：批次命中同名文件时弹确认，返回用户选择；
   *  null/'cancel' = 取消（整批不动）。缺省走 useDialog 的 confirmUploadSameName
   *  离散对话框；单测注入替身 */
  confirmSameName?: (names: string[], dest: string) => Promise<'skip' | 'overwrite' | 'cancel'>
}) {
  const { projectId, selectedPaths, refreshTargetPath, refreshRoot, message, t } = options

  const draggedEntry = ref<FileEntry | null>(null)
  // 本次拖拽随行的完整路径清单（单文件 = [锚点]；多选 = 集合快照）。
  // 只在树内 drop 消费——落点兄弟组件（终端 pane 等）仍按 dataTransfer 单路径语义
  const draggingPaths = ref<string[] | null>(null)
  const dropTarget = ref<string | null>(null)
  // 上传队列态（P-20261003-117）：uploading = 泵送中（整队列排空）；done/total =
  // 本次可见会话的文件计数（全部成功自动归零撤浮条）；current = 泵送中文件名；
  // failed = 失败清单（浮条常驻为可重试面）
  const uploading = ref(false)
  const uploadDone = ref(0)
  const uploadTotal = ref(0)
  const uploadCurrent = ref('')
  const uploadFailed = ref<UploadFailedItem[]>([])
  const uploadVisible = computed(() => uploading.value || uploadFailed.value.length > 0)
  const uploadHover = ref(false)
  // 批量移动进行中（moveEntries 生命周期，宿主可挂忙碌态）
  const moving = ref(false)

  function onDragStart(e: DragEvent, entry: FileEntry) {
    // 布局锁定（P-20261003-180）：树内移动/多选拖拽移动统一短路——dragstart
    // preventDefault 即整个拖拽不启动；浏览器外部文件拖入（上传 P-117）不经
    // 本 handler（页面内不触发 dragstart），锁定不受影响
    if (useLayoutLockStore().interceptDrag(e)) return
    draggedEntry.value = entry
    // 多选随行判定与右键批量菜单同口径：起点在集合内且 ≥2 才整组走
    const sel = selectedPaths?.value
    draggingPaths.value = sel && sel.size >= 2 && sel.has(entry.path)
      ? [...sel]
      : [entry.path]
    e.dataTransfer!.effectAllowed = 'copyMove'
    // 自定义类型供终端 pane / tab 头识别「内部路径拖拽」（drop = 粘贴路径）；
    // text/plain 兜底（Firefox 无 setData 不进入拖拽态）。
    // 多选拖拽保持只写锚点单路径：这两个 payload 的既有消费者都按单路径解读
    e.dataTransfer!.setData('application/x-sc-file-path', entry.path)
    e.dataTransfer!.setData('text/plain', entry.path)
  }

  // 判断当前拖拽是否来自浏览器外部（文件上传）
  function hasExternalFiles(e: DragEvent): boolean {
    if (!e.dataTransfer) return false
    // 外部文件拖入时 types 通常包含 "Files"
    return Array.from(e.dataTransfer.types || []).includes('Files')
  }

  function onDragOver(e: DragEvent, entry: FileEntry) {
    // 外部文件上传：目录或根都允许
    if (hasExternalFiles(e)) {
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
      if (entry.isDir) dropTarget.value = entry.path
      return
    }
    if (!draggedEntry.value) return
    e.preventDefault()
    if (entry.isDir && entry.path !== draggedEntry.value.path) {
      dropTarget.value = entry.path
      e.dataTransfer!.dropEffect = 'move'
    }
  }

  function onDragLeave() {
    dropTarget.value = null
  }

  // ============== 外部文件上传（P-20261003-117） ==============
  // 拖入与右键选择器共用 uploadExternalFiles 入队。原单发大请求（整批一个
  // multipart）三弊：进度全黑（成败只有最后一刻知道）、一损俱损（一个文件
  // 网络抖动整批失败无从重试）、大文件挤占整批 30s 超时——改为逐文件串行
  // POST：每文件独立成败（失败进清单可定点/全部重试），进度按 N/M 文件粒度
  // 推进。量级考量：串行不并发，拖入典型几十个文件，每请求一次 RTT 换逐文件
  // 可见性；服务端「10GB/请求」等护栏语义不变（每文件一请求反而不再挤占）。
  // silent 调用：失败面由浮条清单承接，拦截器不再逐文件叠错误 toast。
  const uploadQueue: UploadQueueItem[] = []
  // 泵送单飞：并发入队（上传中再拖一批）汇入同一泵循环，返回同一 Promise
  let pumpPromise: Promise<void> | null = null

  async function uploadExternalFiles(files: File[], dirPath: string): Promise<void> {
    const pid = projectId()
    if (!pid || files.length === 0) return
    // 同名检测（P-20261003-230）：一次 drop 一发目标目录清单 GET（用户手势级
    // 低频动作，非热路径），按文件名精确求交——大小写差异刻意不做前端归一
    // （前端禁大小写不敏感路径假设），交由服务端 os.Stat 按宿主文件系统真实
    // 语义兜底跳过。清单失败降级「视为无同名」直传：服务端默认跳过同名仍是
    // 安全网，检测失败绝不阻塞上传
    let conflictNames = new Set<string>()
    try {
      const res: any = await projectApi.fileTree(pid, dirPath || undefined, { silent: true })
      const existing = new Set(((res?.data || []) as Array<{ name: string }>).map(e => e.name))
      conflictNames = new Set(files.filter(f => existing.has(f.name)).map(f => f.name))
    } catch { conflictNames = new Set() }
    let overwrite = false
    if (conflictNames.size > 0) {
      const choice = await (options.confirmSameName ?? confirmUploadSameName)(
        [...conflictNames], dirPath,
      ).catch(() => 'cancel' as const)
      if (choice === 'cancel') return // 取消：整批不动（用户显式放弃这次拖入）
      overwrite = choice === 'overwrite'
    }
    const skippedNames = overwrite ? [] : files.filter(f => conflictNames.has(f.name)).map(f => f.name)
    if (skippedNames.length > 0) {
      // 跳过档即时反馈：被跳过清单就地可见，成败面继续由批次结算承接
      message.warning(t('fileTree.uploadSameNameSkipped', { n: skippedNames.length, names: summarizeNames(skippedNames) }))
    }
    const toUpload = overwrite ? files : files.filter(f => !conflictNames.has(f.name))
    if (toUpload.length === 0) return // 全被跳过：不立批次不浮条，toast 已如实呈现
    const batch: UploadBatch = { dest: dirPath, remaining: toUpload.length, saved: 0, failed: 0 }
    for (const f of toUpload) {
      uploadQueue.push({
        pid, file: f, dest: dirPath, batch, overwrite,
        // 目录拖入展平名（含 / 子路径）：multipart filename 会被服务端解析层
        // 剥成 basename，相对路径经 paths 旁挂字段落位（单段名不带字段零变化）
        relPath: f.name.includes('/') ? f.name : undefined,
      })
    }
    uploadTotal.value += toUpload.length
    return pumpUploadQueue()
  }

  function pumpUploadQueue(): Promise<void> {
    if (pumpPromise) return pumpPromise
    pumpPromise = (async () => {
      uploading.value = true
      try {
        while (uploadQueue.length > 0) {
          const item = uploadQueue.shift()!
          uploadCurrent.value = item.file.name
          try {
            // 拦截器已解包 envelope；单文件请求响应体为 {message, saved, skipped, dest}
            const res: any = await projectApi.uploadFiles(item.pid, [item.file], item.dest || undefined, { silent: true }, item.overwrite, item.relPath ? [item.relPath] : undefined)
            // saved 只认服务端确认落地的文件——单文件请求被服务端跳过（超限/
            // 文件名非法/同名兜底）时 saved 为空，不得计入批次成功数（沿用逐条
            // warning，不入失败清单：重试同样理由会再跳过，可行动的是改名/清理
            // 或经同名确认后的覆盖档而非盲目重试）
            if ((res?.saved || []).length > 0) item.batch.saved++
            for (const sk of res?.skipped || []) message.warning(`${sk.name}: ${sk.reason}`)
          } catch {
            item.batch.failed++
            uploadFailed.value.push({ pid: item.pid, file: item.file, dest: item.dest, overwrite: item.overwrite })
          }
          uploadDone.value++
          item.batch.remaining--
          if (item.batch.remaining === 0) await finalizeUploadBatch(item.batch)
        }
      } finally {
        uploading.value = false
        uploadCurrent.value = ''
        // 完成即撤：无失败遗留时归零计数收浮条（失败清单在 = 面板转为重试面）
        if (uploadFailed.value.length === 0) resetUploadProgress()
        pumpPromise = null
      }
    })()
    return pumpPromise
  }

  // 批结算：成功 toast 沿用聚合文案（仅全批无失败时——批内有失败时浮条清单
  // 已如实呈现，成功 toast 与失败面板同屏是噪音）；有落地才刷目标目录（与
  // 原实现「saved 为空不刷树」同口径）
  async function finalizeUploadBatch(batch: UploadBatch): Promise<void> {
    if (batch.saved > 0 && batch.failed === 0) {
      message.success(t('fileTree.uploadSuccess', { n: batch.saved, dir: batch.dest || '/' }))
    }
    if (batch.saved > 0) await refreshTargetPath(batch.dest)
  }

  function resetUploadProgress(): void {
    uploadDone.value = 0
    uploadTotal.value = 0
  }

  // 失败重试：再入队（失败集 = 逐个/全部同一条路），按「项目+目标目录」分组
  // 成批——失败项可能来自不同 drop 批次的不同目录/项目，聚合文案按目录各自
  // 结算，pid 沿用失败时的快照（重试落回原项目，不受当前选中项目影响）
  function retryUploadFailed(items: UploadFailedItem[]): Promise<void> {
    if (items.length === 0) return Promise.resolve()
    const byDest = new Map<string, UploadFailedItem[]>()
    for (const it of items) {
      const list = byDest.get(it.dest)
      if (list) list.push(it)
      else byDest.set(it.dest, [it])
    }
    const picked = new Set(items)
    uploadFailed.value = uploadFailed.value.filter(f => !picked.has(f))
    for (const [dest, list] of byDest) {
      const batch: UploadBatch = { dest, remaining: list.length, saved: 0, failed: 0 }
      for (const it of list) {
        uploadQueue.push({
          pid: it.pid, file: it.file, dest, batch, overwrite: it.overwrite,
          relPath: it.file.name.includes('/') ? it.file.name : undefined,
        })
      }
      uploadTotal.value += list.length
    }
    return pumpUploadQueue()
  }

  function retryUploadOne(item: UploadFailedItem): Promise<void> {
    return retryUploadFailed([item])
  }

  function retryUploadAllFailed(): Promise<void> {
    return retryUploadFailed([...uploadFailed.value])
  }

  // 手动撤下（失败放弃）：清单与计数清零，浮条消失；文件未上传的事实由用户
  // 主动确认（低价值数据可重拖，免确认与 terminal-history 条目删除同先例）
  function dismissUploadPanel(): void {
    uploadFailed.value = []
    resetUploadProgress()
  }

  async function onDrop(e: DragEvent, targetEntry: FileEntry) {
    e.preventDefault()
    // 行级 drop 已完整处理（外部上传/树内移动），阻断冒泡到 .tree-list 的
    // onRootDrop——否则目录行落点会再触发一次「上传到项目根」的双重上传
    // （存量 bug：单发大请求时代是静默双写根目录，P-20261003-117 逐文件
    // 队列把第二次暴露为失败清单重复项/e2e 可见）
    e.stopPropagation()
    dropTarget.value = null

    // 优先处理外部文件上传（含目录拖入）：entry 必须在事件同步期取得
    //（DataTransferItemList 出了 handler 即失效，见 dropEntries 头注）
    if (hasExternalFiles(e) && e.dataTransfer) {
      const entries = hasDirectoryEntry(e.dataTransfer)
      const dest = targetEntry.isDir ? targetEntry.path : targetEntry.path.split('/').slice(0, -1).join('/')
      // 仅存在目录条目时才走递归展平（纯文件拖入返回 null，维持平铺既有链）
      const collected = await collectDropFiles(entries)
      if (collected) {
        if (collected.truncated) {
          message.warning(t('fileTree.dropFolderTruncated', { n: DROP_ENTRY_FILE_CAP }))
        }
        if (collected.files.length > 0) await uploadExternalFiles(collected.files, dest)
        return // 目录拖入已处置（含空目录/截断），不回落平铺
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await uploadExternalFiles(Array.from(e.dataTransfer.files), dest)
        return
      }
    }

    if (!draggedEntry.value || !targetEntry.isDir) return
    const paths = draggingPaths.value && draggingPaths.value.length > 0
      ? draggingPaths.value
      : [draggedEntry.value.path]
    // 单文件移动：保持既有语义（原地守卫 + movedTo toast + 目标目录局部刷新）
    if (paths.length === 1) {
      const sourcePath = paths[0]!
      const sourceName = sourcePath.split('/').pop() || sourcePath
      if (sourcePath === targetEntry.path) return
      if (sourcePath.startsWith(targetEntry.path + '/')) return // 不能移入自身子目录
      try {
        await projectApi.renameFile(projectId(), sourcePath, `${targetEntry.path}/${sourceName}`)
        message.success(t('fileTree.movedTo', { path: `${targetEntry.path}/${sourceName}` }))
        await refreshTargetPath(targetEntry.path)
      } catch { /* 拦截器处理 */ }
    } else {
      // 多选批量移动（P-20261003-160）：逐个 rename，重名等冲突逐个跳过报告不中断
      await moveEntries(paths, targetEntry.path)
    }
    draggedEntry.value = null
    draggingPaths.value = null
  }

  // ============== 批量移动核心（P-20261003-160） ==============
  // 右键「移动到…」与多选拖拽共用：批量端点单请求收口（P-20261006-39，此前
  // 逐个调单路径 renameFile = N 次串行往返），N≤MOVE_BATCH_CAP 量级护栏保留，
  // 失败/冲突按逐条结果报告、不中断批次（P-117 目标防护服务端化为逐条 error
  // 「file already exists」= 目标已存在同名，是预期分支而非错误面）。
  // silent 调用：拦截器不逐条 toast，汇总反馈由本函数一次性给出
  async function moveEntries(paths: string[], targetDir: string): Promise<void> {
    // targetDir 允许空串（= 项目根，batch 端点 destDir 缺省同语义）——剪切粘贴
    // 到根区空白（P-20261023-2③a）与 MoveToDialog 选根共用此路径
    if (!projectId() || paths.length === 0 || targetDir === undefined) return
    // 嵌套去重：条目已在另一选中目录子树内时随父目录一起走，单独 rename
    // 必然旧路径缺失失败——先剔除（排序后仅向前查前缀即可，O(n²) 量级可忽略：
    // n≤多选集合大小，UI 逐点选撑不到大数；服务端同规则兜底为逐条 skipped）
    const sorted = [...paths].sort()
    const items = sorted.filter(p => !sorted.some(q => p.startsWith(q + '/')))
    const capped = items.slice(0, MOVE_BATCH_CAP)
    const overflow = items.length - capped.length

    moving.value = true
    let ok = 0
    const skipped: Array<{ name: string; reason: string }> = []
    try {
      // 移入自身/自身子目录：语义 no-op（目标会随移动消失或成环），预筛就地
      // 跳过（服务端同判定兜底为 skipped），不送出注定 no-op 的条目
      const work = capped.filter(p => {
        if (p === targetDir || p.startsWith(targetDir + '/')) {
          skipped.push({ name: p.split('/').pop() || p, reason: t('fileTree.batchMove.skipInsideSelf') })
          return false
        }
        return true
      })
      if (work.length > 0) {
        try {
          // 拦截器已解包 envelope；响应体为 {ok, skipped, failed, results}
          const res: any = await projectApi.batchFiles(
            projectId(),
            { action: 'move', entries: work, destDir: targetDir },
            { silent: true },
          )
          for (const r of (res?.results || []) as Array<{ path: string; status: string; error?: string }>) {
            if (r.status === 'ok') {
              ok++
              continue
            }
            skipped.push({
              name: r.path.split('/').pop() || r.path,
              // error 稳定原文「file already exists」= P-117 目标存在防护（重名）
              reason: r.error === 'file already exists'
                ? t('fileTree.batchMove.skipExists')
                : t('fileTree.batchMove.skipFailed'),
            })
          }
        } catch {
          // 整批请求级失败（网络抖动/5xx）：silent 下拦截器不提示，块内条目
          // 逐条计入跳过清单——半成可见，不静默吞批
          for (const p of work) {
            skipped.push({ name: p.split('/').pop() || p, reason: t('fileTree.batchMove.skipFailed') })
          }
        }
      }
      if (ok > 0) await refreshRoot() // 命中的父目录不定（跨层级多选）：整树刷新（保留展开状态）
    } finally {
      moving.value = false
    }

    if (overflow > 0) message.warning(t('fileTree.batchMove.cap', { cap: MOVE_BATCH_CAP, n: overflow }))
    if (skipped.length === 0) {
      message.success(t('fileTree.batchMove.done', { n: ok, dir: targetDir }))
    } else {
      // 跳过清单取前 3 项摘要（summarizeNames 同款截断惯例），失败项不让批次「静默半成」
      const heads = skipped.slice(0, 3)
        .map(s => t('fileTree.batchMove.skipItem', { name: s.name, reason: s.reason }))
        .join(', ')
      const itemsNote = heads + (skipped.length > 3 ? '…' : '')
      message.warning(t('fileTree.batchMove.partial', { ok, dir: targetDir, failed: skipped.length, items: itemsNote }))
    }
  }

  // ============== 批量复制核心（P-20261023-2③a 树内复制/粘贴） ==============
  // 右键「复制」+ Ctrl+V（或「粘贴」菜单）共用：batch 端点 copy 形态单请求
  // 收口（服务端递归整树 + 同名「-副本N」步进自动改名——复制要的是新副本，
  // 与上传的跳过/覆盖语义刻意分开）。跳过映射与 moveEntries 同形（copy 无
  // 「目标已存在」分支：同名由服务端步进改名消化，不会逐条 error）。
  // silent 调用：汇总反馈由本函数一次给出（moveEntries 同款）
  async function copyEntries(paths: string[], targetDir: string): Promise<void> {
    if (!projectId() || paths.length === 0 || targetDir === undefined) return
    // 嵌套去重：与 moveEntries 同规则（子条目随父目录整树复制，单独提交必重复）
    const sorted = [...paths].sort()
    const items = sorted.filter(p => !sorted.some(q => p.startsWith(q + '/')))
    const capped = items.slice(0, MOVE_BATCH_CAP)
    const overflow = items.length - capped.length

    moving.value = true
    let ok = 0
    const skipped: Array<{ name: string; reason: string }> = []
    try {
      // 复制方向守卫预筛：目标目录在源条目子树内（含相等）= 复制自吞无终止，
      // 服务端同判定兜底为 skipped（与 move 的「源在目标内」方向相反）
      const work = capped.filter(p => {
        if (targetDir === p || targetDir.startsWith(p + '/')) {
          skipped.push({ name: p.split('/').pop() || p, reason: t('fileTree.batchCopy.skipInsideSelf') })
          return false
        }
        return true
      })
      if (work.length > 0) {
        try {
          const res: any = await projectApi.batchFiles(
            projectId(),
            { action: 'copy', entries: work, destDir: targetDir },
            { silent: true },
          )
          for (const r of (res?.results || []) as Array<{ path: string; status: string }>) {
            if (r.status === 'ok') {
              ok++
              continue
            }
            skipped.push({ name: r.path.split('/').pop() || r.path, reason: t('fileTree.batchCopy.skipFailed') })
          }
        } catch {
          // 整批请求级失败：块内条目逐条计入跳过清单，不静默吞批（moveEntries 同款）
          for (const p of work) {
            skipped.push({ name: p.split('/').pop() || p, reason: t('fileTree.batchCopy.skipFailed') })
          }
        }
      }
      if (ok > 0) await refreshRoot() // 副本落点含新目录名（-副本N 步进），整树刷新
    } finally {
      moving.value = false
    }

    if (overflow > 0) message.warning(t('fileTree.batchCopy.cap', { cap: MOVE_BATCH_CAP, n: overflow }))
    if (skipped.length === 0) {
      message.success(t('fileTree.batchCopy.done', { n: ok, dir: targetDir || '/' }))
    } else {
      const heads = skipped.slice(0, 3)
        .map(s => t('fileTree.batchMove.skipItem', { name: s.name, reason: s.reason }))
        .join(', ')
      const itemsNote = heads + (skipped.length > 3 ? '…' : '')
      message.warning(t('fileTree.batchCopy.partial', { ok, dir: targetDir || '/', failed: skipped.length, items: itemsNote }))
    }
  }

  // 根级拖放：拖到空白处上传到项目根（目录拖入与行级 onDrop 同一 entry 链）
  function onRootDragOver(e: DragEvent) {
    if (hasExternalFiles(e)) {
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
  }

  async function onRootDrop(e: DragEvent) {
    if (hasExternalFiles(e) && e.dataTransfer) {
      const entries = hasDirectoryEntry(e.dataTransfer)
      const collected = await collectDropFiles(entries)
      if (collected) {
        if (collected.truncated) {
          message.warning(t('fileTree.dropFolderTruncated', { n: DROP_ENTRY_FILE_CAP }))
        }
        if (collected.files.length > 0) await uploadExternalFiles(collected.files, '')
        return
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        e.preventDefault()
        const files = Array.from(e.dataTransfer.files)
        await uploadExternalFiles(files, '')
      }
    }
  }

  return {
    draggedEntry, draggingPaths, dropTarget, moving,
    uploading, uploadDone, uploadTotal, uploadCurrent, uploadFailed, uploadVisible, uploadHover,
    hasExternalFiles, uploadExternalFiles, onDragStart, onDragOver, onDragLeave, onDrop, onRootDragOver, onRootDrop,
    retryUploadOne, retryUploadAllFailed, dismissUploadPanel,
    moveEntries, copyEntries,
  }
}
