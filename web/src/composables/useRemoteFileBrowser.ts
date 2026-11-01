import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { remoteHostApi } from '../api/client'
import type { RemoteDirEntry, RemoteHost } from '../api/client'
import { confirmDialog, promptDialog } from './useDialog'
import { friendlyRemoteError } from '../utils/remoteErrors'
import { safeStorage } from '../utils/storage'
import {
  isRootPath, upsertRecentPath, pinFromHistory, unpinToHistory, parsePathMem,
} from '../utils/remotePathMemory'

// 远程主机文件面板的目录模型 + 导航 + 文件操作（自 RemoteFilePane 原样搬运，P-20261002-27）：
// 列目录/路径直达/面包屑/上级 + 上传/下载/新建目录/重命名/删除。
// host 由宿主经 getter 注入（props.host 的响应式读取），checked/entries/cwd 等状态在本
// composable 内创建并返回给宿主（工具条/表格/右键菜单/互传弹窗共用）。

/** 跨面板互传的拖拽 MIME（另一主机面板拖入 → 上抛宿主互传） */
export const X_SC_REMOTE = 'application/x-sc-remote-files'

export interface UseRemoteFileBrowserDeps {
  // 当前主机（宿主 props.host 的 getter，保持响应性）
  host: () => RemoteHost | null
  // 名称过滤（宿主 UI 态）：过滤变化清空勾选
  filterText: Ref<string>
}

export function useRemoteFileBrowser(deps: UseRemoteFileBrowserDeps) {
  const { t } = useI18n()
  const message = useMessage()

  const cwd = ref('/')
  const entries = ref<RemoteDirEntry[]>([])
  const loading = ref(false)
  const checked = ref<string[]>([])
  // 列表请求代数守卫：快速连续跳转时旧响应后到会覆盖新目录内容
  let listGen = 0

  const filteredEntries = computed(() => {
    const q = deps.filterText.value.trim().toLowerCase()
    if (!q) return entries.value
    return entries.value.filter(e => e.name.toLowerCase().includes(q))
  })

  watch(deps.filterText, () => { checked.value = [] })

  function rememberCwd(): void {
    const host = deps.host()
    if (host) {
      safeStorage.setItem(`sc.rfm.cwd.${host.id}`, cwd.value)
    }
  }

  function restoreCwdFor(hostId?: string): string {
    if (hostId) {
      try {
        const saved = localStorage.getItem(`sc.rfm.cwd.${hostId}`)
        // POSIX 根路径或 Windows 远程主机的盘符路径（C:/Users/x）均合法
        if (saved && (saved.startsWith('/') || DRIVE_PATH_RE.test(saved))) return saved
      } catch { /* 无痕模式忽略 */ }
    }
    return '/'
  }

  // Windows 远程主机（OpenSSH on Windows）的盘符路径：前端统一以 / 分隔保存。
  // 识别盘符形态以正确处理记忆恢复/路径直达/面包屑/返回上级
  const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/

  function driveRootOf(p: string): string | null {
    const m = p.match(/^([A-Za-z]:)[\\/]?/)
    return m ? `${m[1]}/` : null
  }

  /** 名称 → entry（选中项类型判定用） */
  const entryMap = computed(() => new Map(entries.value.map(e => [e.name, e])))

  function joinPath(dir: string, name: string): string {
    if (dir === '/') return `/${name}`
    return `${dir}/${name}`
  }

  /** 面包屑段（/ 或盘符根 → 根，逐级） */
  const crumbs = computed(() => {
    const parts = cwd.value.split('/').filter(Boolean)
    const root = driveRootOf(cwd.value)
    if (root) {
      // 盘符路径：根段为 C:/，其后逐级拼接
      return [
        { name: root, path: root },
        ...parts.slice(1).map((p, i) => ({ name: p, path: `${root}${parts.slice(1, i + 1).join('/')}` })),
      ]
    }
    return [{ name: '/', path: '/' }, ...parts.map((p, i) => ({ name: p, path: `/${parts.slice(0, i + 1).join('/')}` }))]
  })

  async function list() {
    const host = deps.host()
    if (!host) return
    loading.value = true
    checked.value = []
    const gen = ++listGen
    try {
      const res = await remoteHostApi.files.list(host.id, cwd.value, { silent: true }) as unknown as { data?: { entries?: RemoteDirEntry[] } }
      if (gen !== listGen) return // 已有更新的请求，丢弃过期响应
      entries.value = res.data?.entries || []
    } catch (e: unknown) {
      if (gen !== listGen) return
      entries.value = []
      message.error(fileErrMsg(e, t('remoteFiles.listFailed')))
    } finally {
      if (gen === listGen) loading.value = false
    }
  }

  function fileErrMsg(e: unknown, fallback: string): string {
    const raw = (e as { rawMessage?: string })?.rawMessage || (e as { message?: string })?.message || ''
    // 底层报错（ssh dial 认证失败/连接拒绝等）映射为可行动提示，原文见控制台
    return raw ? `${fallback}: ${friendlyRemoteError(raw, t)}` : fallback
  }

  function enter(e: RemoteDirEntry) {
    cwd.value = joinPath(cwd.value, e.name)
  }

  function up() {
    // 盘符路径：根是 C:/ 而非 /；已在根时不再上跳（Windows 主机上 / 无意义）
    const root = driveRootOf(cwd.value)
    if (root) {
      if (cwd.value === root) return
      const idx = cwd.value.lastIndexOf('/')
      cwd.value = idx > root.length - 1 ? cwd.value.slice(0, idx) : root
      return
    }
    if (cwd.value === '/') return
    const idx = cwd.value.lastIndexOf('/')
    cwd.value = idx <= 0 ? '/' : cwd.value.slice(0, idx)
  }

  // ============== 路径直达 ==============

  const showPathInput = ref(false)
  const pathDraft = ref('')

  function openPathEdit() {
    pathDraft.value = cwd.value
    showPathInput.value = true
  }

  function jumpPath() {
    const raw = pathDraft.value.trim()
    showPathInput.value = false
    if (!raw || raw === cwd.value) return
    // 反斜杠归一为斜杠；POSIX 路径缺前导 / 时补全，盘符路径原样
    const p = raw.replace(/\\/g, '/')
    cwd.value = p.startsWith('/') || DRIVE_PATH_RE.test(p) ? p : `/${p}`
  }

  // ============== 路径历史 + pin（P-20261006-19）==============
  // 每主机最近路径（LRU 上限 10）与手动 pin（上限 5）置顶，快选下拉一次点选直达。
  // 设备本地偏好口径：localStorage safeStorage 通道按主机 key 隔离
  // （sc.rfm.mem.<hostId>，与 sc.rfm.cwd.<hostId> 同族），列表纯语义在
  // utils/remotePathMemory（伴随单测）。路径失效（远端目录被删）不特殊处理：
  // 快选跳转失败走 list() 既有错误提示。

  const recentPaths = ref<string[]>([])
  const pinnedPaths = ref<string[]>([])

  function memKeyOf(hostId: string): string {
    return `sc.rfm.mem.${hostId}`
  }

  function loadPathMem(hostId?: string): void {
    recentPaths.value = []
    pinnedPaths.value = []
    if (!hostId) return
    const mem = parsePathMem(safeStorage.getItem(memKeyOf(hostId)))
    recentPaths.value = mem.recent
    pinnedPaths.value = mem.pins
  }

  function persistPathMem(): void {
    const host = deps.host()
    if (!host) return
    safeStorage.setItem(memKeyOf(host.id), JSON.stringify({ recent: recentPaths.value, pins: pinnedPaths.value }))
  }

  /** 当前路径入史：根不入史（面包屑一键可达，无导航价值）；pin 过的常驻置顶不重复入史 */
  function rememberRecentPath(): void {
    const host = deps.host()
    const p = cwd.value
    if (!host || isRootPath(p) || pinnedPaths.value.includes(p)) return
    recentPaths.value = upsertRecentPath(recentPaths.value, p)
    persistPathMem()
  }

  function togglePinPath(p: string): void {
    const next = pinnedPaths.value.includes(p)
      ? unpinToHistory(pinnedPaths.value, recentPaths.value, p)
      : pinFromHistory(pinnedPaths.value, recentPaths.value, p)
    pinnedPaths.value = next.pins
    recentPaths.value = next.recent
    persistPathMem()
  }

  // ============== 上传（文件选择 + OS 拖入共用） ==============

  const uploadInput = ref<HTMLInputElement | null>(null)
  function pickUpload() {
    uploadInput.value?.click()
  }
  async function onUploadPicked(ev: Event) {
    const input = ev.target as HTMLInputElement
    const files = Array.from(input.files || [])
    input.value = ''
    await uploadFiles(files)
  }

  async function uploadFiles(files: File[]) {
    const host = deps.host()
    if (!host || files.length === 0) return
    // 批量一次拨号传完（此前逐文件上传 = N 次 SSH 拨号+认证）
    try {
      const res = await remoteHostApi.files.uploadMany(host.id, cwd.value, files) as unknown as {
        data?: { saved?: { name: string }[]; failed?: { name: string; error: string }[] }
      }
      const saved = res.data?.saved || []
      const failed = res.data?.failed || []
      if (saved.length > 0) message.success(t('remoteFiles.uploaded', { n: saved.length }))
      for (const f of failed) {
        message.error(`${f.name}: ${friendlyRemoteError(f.error || '', t)}`)
      }
      if (saved.length > 0) await list()
    } catch (e: unknown) {
      message.error(fileErrMsg(e, t('remoteFiles.uploadFailed', { name: files[0]?.name || '' })))
    }
  }

  // ============== 下载 ==============

  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  async function download(names: string[]) {
    const host = deps.host()
    const first = names[0]
    if (!host || !first) return
    // 单文件走原下载端点；目录/多选走归档端点（一次拨号，服务端 zip 流式打包）
    const singleFile = names.length === 1 && !entryMap.value.get(first)?.isDir
    if (singleFile) {
      const name = first
      try {
        const blob = await remoteHostApi.files.download(host.id, joinPath(cwd.value, name)) as unknown as Blob
        saveBlob(blob, name)
        message.success(t('remoteFiles.downloaded', { n: 1 }))
      } catch (e: unknown) {
        message.error(fileErrMsg(e, t('remoteFiles.downloadFailed', { name })))
      }
      return
    }
    try {
      const blob = await remoteHostApi.files.downloadArchive(
        host.id, names.map(n => joinPath(cwd.value, n)),
      ) as unknown as Blob
      const fname = names.length === 1
        ? `${first}.zip`
        : `archive-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.zip`
      saveBlob(blob, fname)
      message.success(t('remoteFiles.downloaded', { n: names.length }))
    } catch (e: unknown) {
      message.error(fileErrMsg(e, t('remoteFiles.downloadFailed', { name: names.join('、') })))
    }
  }

  // ============== 新建目录 / 重命名 / 删除 ==============

  async function mkdir() {
    const host = deps.host()
    if (!host) return
    const name = await promptDialog({ title: t('remoteFiles.mkdirTitle'), label: t('remoteFiles.mkdirLabel') })
    if (!name || !name.trim()) return
    try {
      await remoteHostApi.files.mkdir(host.id, joinPath(cwd.value, name.trim()))
      await list()
    } catch (e: unknown) {
      message.error(fileErrMsg(e, t('remoteFiles.mkdirFailed')))
    }
  }

  async function rename(name: string) {
    const host = deps.host()
    if (!host) return
    const next = await promptDialog({ title: t('remoteFiles.renameTitle'), label: t('remoteFiles.renameLabel'), defaultValue: name })
    if (!next || !next.trim() || next.trim() === name) return
    try {
      await remoteHostApi.files.rename(host.id, joinPath(cwd.value, name), joinPath(cwd.value, next.trim()))
      await list()
    } catch (e: unknown) {
      message.error(fileErrMsg(e, t('remoteFiles.renameFailed')))
    }
  }

  async function remove(names: string[]) {
    const host = deps.host()
    if (!host || names.length === 0) return
    const ok = await confirmDialog({
      title: t('remoteFiles.deleteTitle'),
      content: t('remoteFiles.deleteConfirm', { names: names.join('、') }),
      type: 'warning',
    })
    if (!ok) return
    try {
      const res = await remoteHostApi.files.remove(
        host.id, names.map(n => joinPath(cwd.value, n)),
      ) as unknown as { data?: { deleted?: string[]; failed?: { path: string; error: string }[] } }
      const failed = res.data?.failed || []
      if (failed.length > 0) {
        message.error(t('remoteFiles.deletePartial', {
          n: failed.length,
          msg: friendlyRemoteError(failed[0]?.error || '', t),
        }))
      } else {
        message.success(t('remoteFiles.deleted', { n: res.data?.deleted?.length || 0 }))
      }
      await list()
    } catch (e: unknown) {
      message.error(fileErrMsg(e, t('remoteFiles.deleteFailed')))
    }
  }

  // 面板自包含：切换宿主从根目录列出；cwd 任何变化（进入/上级/面包屑/直达）
  // 统一由 watcher 驱动加载——此前 enter/面包屑只改路径不刷新列表，属存量缺陷
  watch(cwd, () => {
    rememberCwd()
    rememberRecentPath()
    void list()
  })

  watch(() => deps.host()?.id, () => {
    // 路径历史/pin 先按新主机装载：随后 cwd 恢复触发的 rememberRecentPath
    // 才能正确判定「已 pin 不重复入史」
    loadPathMem(deps.host()?.id)
    // 恢复该主机上次浏览的目录（按 host 分别记忆；无记录从根开始）。
    // 恢复值与当前值相同（典型：首次打开、无历史记录，都是 /）时 cwd watcher
    // 不会触发——此时必须显式 list()，否则面板挂载后永远空表（存量缺陷：
    // 旧环境靠残留的 localStorage 目录记录掩盖了该路径）
    const restored = restoreCwdFor(deps.host()?.id)
    if (restored !== cwd.value) {
      cwd.value = restored
    } else {
      void list()
    }
  }, { immediate: true })

  return {
    cwd,
    entries,
    loading,
    checked,
    filteredEntries,
    entryMap,
    crumbs,
    joinPath,
    list,
    enter,
    up,
    fileErrMsg,
    showPathInput,
    pathDraft,
    openPathEdit,
    jumpPath,
    recentPaths,
    pinnedPaths,
    togglePinPath,
    uploadInput,
    pickUpload,
    onUploadPicked,
    uploadFiles,
    download,
    mkdir,
    rename,
    remove,
  }
}
