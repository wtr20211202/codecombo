import { ref, computed } from 'vue'
import type { Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import type { RemoteDirEntry, RemoteHost } from '../api/client'
import { copyText } from '../utils/clipboard'

// 远程文件面板右键菜单（自 RemoteFilePane 原样搬运，P-20261002-27）：
// n-data-table 的 rowProps 事件绑定在虚拟滚动下不可靠（监听未落到 tr），
// 改为在自有容器上统一监听 contextmenu，用 closest('tr') 反查目标行；
// 命中行 → 行菜单（多选感知：右键已勾选行时整组操作），未命中 → 目录级菜单。
// 动作经 actions 回调集回接宿主（文件操作在 useRemoteFileBrowser）。
export interface RemoteFileContextActions {
  list: () => void
  mkdir: () => void
  pickUpload: () => void
  enter: (e: RemoteDirEntry) => void
  download: (names: string[]) => void
  // 打开「传输到主机」弹窗（弹窗状态由宿主持有）
  openTransfer: () => void
  // 在编辑器打开（P-20261003-15：remote:<hostId>:<path> 伪路径挂编辑器标签）
  openEditor: (name: string) => void
  rename: (name: string) => void
  remove: (names: string[]) => void
}

export interface UseRemoteFileContextMenuDeps {
  // 当前主机（copyurl 组资源 URL / canTransfer 判定）
  host: () => RemoteHost | null
  // 目录条目（行反查按名称匹配）
  entries: Ref<RemoteDirEntry[]>
  // 勾选集（多选组操作 + 空白右键单选落地）
  checked: Ref<string[]>
  cwd: Ref<string>
  joinPath: (dir: string, name: string) => string
  actions: RemoteFileContextActions
}

export function useRemoteFileContextMenu(deps: UseRemoteFileContextMenuDeps) {
  const { t } = useI18n()
  const message = useMessage()

  const ctxShow = ref(false)
  const ctxX = ref(0)
  const ctxY = ref(0)
  const ctxRow = ref<RemoteDirEntry | null>(null)

  /** 右键命中的行是否属于多选组 */
  const ctxMulti = computed(() =>
    ctxRow.value !== null && deps.checked.value.length > 1 && deps.checked.value.includes(ctxRow.value.name))

  const canTransfer = computed(() => deps.host()?.protocol !== 'ftp')

  // 编辑器读写仅 SSH(SFTP) 主机（服务端 content 端点同守卫：FTP 无对称的
  // 原子覆盖/权限保留通道）
  const canOpenInEditor = computed(() => deps.host()?.protocol !== 'ftp')

  function onBgContext(ev: MouseEvent) {
    ev.preventDefault()
    const tr = (ev.target as HTMLElement).closest('tr')
    let row: RemoteDirEntry | null = null
    if (tr) {
      const nameEl = tr.querySelector('.rfc-name')
      const name = nameEl?.textContent?.replace(/\/$/, '') || ''
      row = deps.entries.value.find(e => e.name === name) || null
      if (row && !deps.checked.value.includes(row.name)) deps.checked.value = [row.name]
    }
    ctxX.value = ev.clientX
    ctxY.value = ev.clientY
    ctxRow.value = row
    ctxShow.value = true
  }

  function closeCtx() {
    ctxShow.value = false
    ctxRow.value = null
  }

  const ctxOptions = computed(() => {
    if (!ctxRow.value) {
      // 空白区：目录级操作
      return [
        { key: 'refresh', label: t('common.refresh') },
        { key: 'mkdir', label: t('remoteFiles.mkdir') },
        { key: 'upload', label: t('remoteFiles.upload') },
      ]
    }
    const multi = ctxMulti.value
    const n = deps.checked.value.length
    const withCount = (label: string) => (multi ? `${label}（${n}）` : label)
    const opts: { key: string; label: string; danger?: boolean }[] = []
    if (multi) {
      opts.push({ key: 'download', label: withCount(t('remoteFiles.download')) })
      if (canTransfer.value) opts.push({ key: 'transfer', label: t('remoteFiles.transfer') })
      opts.push({ key: 'copypath', label: t('remoteFiles.copyPath') })
      opts.push({ key: 'delete', label: withCount(t('common.delete')) })
    } else if (ctxRow.value.isDir) {
      opts.push({ key: 'open', label: t('remoteFiles.ctxOpen') })
      opts.push({ key: 'download', label: t('remoteFiles.downloadZip') })
      if (canTransfer.value) opts.push({ key: 'transfer', label: t('remoteFiles.transfer') })
      opts.push({ key: 'rename', label: t('common.rename') })
      opts.push({ key: 'copypath', label: t('remoteFiles.copyPath') })
      opts.push({ key: 'copyurl', label: t('remoteFiles.copyUrl') })
      opts.push({ key: 'delete', label: t('common.delete') })
    } else {
      if (canOpenInEditor.value) opts.push({ key: 'openEditor', label: t('remoteFiles.ctxOpenEditor') })
      opts.push({ key: 'download', label: t('remoteFiles.download') })
      if (canTransfer.value) opts.push({ key: 'transfer', label: t('remoteFiles.transfer') })
      opts.push({ key: 'rename', label: t('common.rename') })
      opts.push({ key: 'copypath', label: t('remoteFiles.copyPath') })
      opts.push({ key: 'copyurl', label: t('remoteFiles.copyUrl') })
      opts.push({ key: 'copyname', label: t('remoteFiles.copyName') })
      opts.push({ key: 'delete', label: t('common.delete') })
    }
    return opts
  })

  async function onCtxSelect(key: string) {
    const row = ctxRow.value
    closeCtx()
    if (key === 'refresh') { deps.actions.list(); return }
    if (key === 'mkdir') { deps.actions.mkdir(); return }
    if (key === 'upload') { deps.actions.pickUpload(); return }
    if (!row) return
    const names = ctxMulti.value ? [...deps.checked.value] : [row.name]
    switch (key) {
      case 'open': if (row.isDir) deps.actions.enter(row); break
      case 'openEditor': if (!row.isDir) deps.actions.openEditor(row.name); break
      case 'download': deps.actions.download(names); break
      case 'transfer': deps.actions.openTransfer(); break
      case 'rename': deps.actions.rename(row.name); break
      case 'copypath': {
        const ok = await copyText(names.map(n => deps.joinPath(deps.cwd.value, n)).join('\n'))
        if (ok) message.success(t('remoteFiles.copied'))
        else message.error(t('common.copyFailed'))
        break
      }
      case 'copyurl': {
        // 复制资源 URL：ftp://user@host[:port]/path | sftp://...（标准端口 21/22
        // 省略；不含密码）。多选时每行一条
        const h = deps.host()
        if (!h) break
        const proto = h.protocol === 'ftp' ? 'ftp' : 'sftp'
        const defaultPort = proto === 'ftp' ? 21 : 22
        const portPart = h.port && h.port !== defaultPort ? `:${h.port}` : ''
        const userPart = h.user ? `${encodeURIComponent(h.user)}@` : ''
        const urls = names.map(n => `${proto}://${userPart}${h.host}${portPart}${encodeURI(deps.joinPath(deps.cwd.value, n))}`)
        const ok = await copyText(urls.join('\n'))
        if (ok) message.success(t('remoteFiles.urlCopied'))
        else message.error(t('common.copyFailed'))
        break
      }
      case 'copyname': {
        const ok = await copyText(row.name)
        if (ok) message.success(t('remoteFiles.copied'))
        else message.error(t('common.copyFailed'))
        break
      }
      case 'delete': deps.actions.remove(names); break
    }
  }

  return {
    ctxShow,
    ctxX,
    ctxY,
    onBgContext,
    closeCtx,
    ctxOptions,
    onCtxSelect,
  }
}
