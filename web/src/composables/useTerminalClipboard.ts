import { ref, computed } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { safeStorage } from '../utils/storage'
import { useClipboardHistoryStore } from '../stores/clipboardHistory'
import { notifyUserPrefsDirty } from '../stores/userPrefsLink'
import { compressPasteImage } from '../utils/pasteImageCompress'
import { buildTerminalCodeBlock } from '../utils/terminalCodeBlock'
import { extractPasteFiles, PASTE_FILE_MAX_COUNT, pasteUploadKind, quotePastePathIfNeeded } from '../utils/pasteFiles'
import type { TermInstance } from './useTerminalInstances'
import { getLastCommandOutputRecord, getCommandOutputPromptClamp, reanchorCommandStart } from './useTerminalSession'
import { extractBufferLines } from './terminalCommandMarks'
import { useSensitiveMarkHint } from './useSensitiveMarkHint'

// 调试开关：排查粘贴问题时在浏览器 Console 执行 localStorage.setItem('sc.debug.terminalClipboard','1') 后刷新页面开启
const DEBUG = safeStorage.getItem('sc.debug.terminalClipboard') === '1'
const debug = (...args: unknown[]) => { if (DEBUG) console.log('[terminal-clipboard]', ...args) }

// 文件粘贴上传 in-flight 锁（模块级，全 pane 共享）：上传进行中再触发粘贴直接
// 去抖忽略——上传无进度 UI（v1 只出汇总 toast），连续 Ctrl+V 会并发上传同一批
// 文件并在完成后重复贴入。锁粒度全局而非每 pane：误按场景里用户只会对着一个
// 终端连按，全局锁实现最简且杜绝「多 pane 同时上传同一文件」的重复落盘
let pasteFilesInFlight = false

// 「粘贴时去尾换行」开关：从网页 / 文档复制的命令几乎都带末尾 \n，
// 直接 term.paste 会被 shell 当 Enter 立即执行；默认开启剥离
const STRIP_TRAILING_NEWLINE_KEY = 'sc.terminal.stripTrailingNewline'
// 「多行粘贴不再警告」开关：用户主动确认过风险后持久化跳过
const PASTE_NO_WARN_KEY = 'sc.terminal.pasteNoMultilineWarn'
// 「大文本粘贴阈值」（P-20261002-136）：粘贴文本超此字节数时把多行确认弹层升级为
// 体积感知版（标题/文案换大文本版）。常量起止不设设置项——大文本粘贴可能卡顿
// 界面甚至误执行重复粘贴，属知情确认而非可关闭偏好，不受「不再提示」开关豁免
export const PASTE_SIZE_WARN_BYTES = 64 * 1024

/** 「多行写入终端不再提示」偏好读取/写入（模块级，编辑器「发送选中到终端」
 *  P-20261004-21 与粘贴链共用同一开关）：用户对「多行内容进 shell」的一次知情
 *  确认对两个入口同义——粘贴确认过的不再对发送重复打扰，反之亦然。
 *  超 64KB 大文本确认不受此开关豁免（两入口同口径，见 PASTE_SIZE_WARN_BYTES 注） */
export function isPasteMultilineNoWarn(): boolean {
  return safeStorage.getItem(PASTE_NO_WARN_KEY) === '1'
}

export function setPasteMultilineNoWarn(v: boolean): void {
  safeStorage.setItem(PASTE_NO_WARN_KEY, v ? '1' : '0')
}
// UTF-8 字节数统计：模块级复用 encoder，避免每次粘贴重建；CJK 内容下
// string.length 会低估约 3 倍，阈值按真实字节算
const pasteTextEncoder = new TextEncoder()
// 「选中即复制」开关：终端里选中文本松开鼠标即写入剪贴板（claude code / VS Code
// copyOnSelection 同语义）。默认开启；设置页可关。所有终端宿主（项目/Agent/远程）
// 共用 TerminalPane 内的同一实现
export const COPY_ON_SELECT_KEY = 'sc.terminal.copyOnSelect'

/** 读取「选中即复制」开关（默认开）。每次事件现场读取而非启动时缓存，
 *  设置页切换后所有已挂载 pane 即时生效，无需跨组件通知 */
export function isCopyOnSelectEnabled(): boolean {
  return safeStorage.getItem(COPY_ON_SELECT_KEY) !== '0'
}

/** 写「选中即复制」开关（P-20261007-1 收口单一写点）：此前设置页直写
 *  safeStorage，服务端漫游链需要挂脏标记故收拢至此。开 = 回归默认清 key
 *  （同 sound/notifySimple 惯例）；即时生效语义不变（isCopyOnSelectEnabled
 *  每次 mouseup 现读，无需通知各 pane） */
export function setCopyOnSelectEnabled(v: boolean): void {
  if (v) safeStorage.removeItem(COPY_ON_SELECT_KEY)
  else safeStorage.setItem(COPY_ON_SELECT_KEY, '0')
  // 服务端漫游双写：复制选中是跨设备应一致的终端习性偏好
  notifyUserPrefsDirty()
}

export interface UseTerminalClipboardParams {
  // 从 useTerminalInstances 拿到的 Map（共享）
  termInstances: Map<string, TermInstance>
  // 粘贴上传策略（必传）：返回贴入终端的路径文本，null=上传未成功。
  // kind=image 截图压缩链 / kind=file 白名单文件链（P-20261024-2）——项目终端
  // 由 TerminalPane 的 uploadPaste prop 透传项目端点实现，远程终端传各自实现
  uploadPaste: (file: File, kind: 'image' | 'file') => Promise<string | null>
}

// 写入剪贴板的统一封装：navigator.clipboard 在非安全上下文（HTTP 非 localhost）下不可用，
// 回退到隐藏 textarea + execCommand('copy')。模块级导出，终端复制与 AI 代码块复制共用
export async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      // 多剪贴板历史（P-20261002-149）：writeText 不派发 copy 事件，终端/AI 代码块
      // 复制在此补位入史（降级路径由 copy 事件捕获链兜住，store 内去重兜住双记）
      useClipboardHistoryStore().record(text)
      return true
    } catch {
      // 权限拒绝或浏览器不支持，回退到 execCommand
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function useTerminalClipboard(params: UseTerminalClipboardParams) {
  const { termInstances } = params
  const message = useMessage()
  const { t } = useI18n()
  // 敏感内容自动检测建议（P-20261003-207）：导出落地后异步扫描，命中即建议标记
  const { suggestSensitiveMarking } = useSensitiveMarkHint()

  // ============== 状态 ==============
  const stripTrailingNewline = ref(safeStorage.getItem(STRIP_TRAILING_NEWLINE_KEY) !== '0')
  const pasteMultilineNoWarn = ref(safeStorage.getItem(PASTE_NO_WARN_KEY) === '1')

  // 多行/大文本粘贴警告 modal：暂存待粘贴文本与目标 tab，确认后再走 applyPaste。
  // large/kb 在闸门处一次性算好存 ref（体积感知版弹层文案用），避免模板对超大串重复编码
  const showPasteWarn = ref(false)
  const pendingPasteText = ref('')
  const pendingPasteTabId = ref('')
  const pendingPasteLarge = ref(false)
  const pendingPasteKb = ref(0)

  // ============== 剪贴板读写（带降级）==============
  // writeClipboard 已提升为模块级导出（上方），供终端复制与 AI 代码块复制共用

  // 读取剪贴板：navigator.clipboard 失败时无法回退（execCommand('paste') 在现代浏览器被禁用）
  // 直接抛错由调用方决定如何提示
  async function readClipboard(): Promise<string> {
    if (navigator.clipboard && window.isSecureContext) {
      return await navigator.clipboard.readText()
    }
    throw new Error('clipboard api unavailable')
  }

  // ============== 复制 ==============
  // 复制选区到剪贴板：无选区时给出提示
  async function copySelectionToClipboard(tabId: string): Promise<void> {
    const inst = termInstances.get(tabId)
    if (!inst) return
    const sel = inst.term.getSelection()
    if (!sel) {
      message.info(t('terminal.noSelection'))
      return
    }
    const ok = await writeClipboard(sel)
    if (ok) {
      message.success(t('terminal.copyDone'))
      // 复制后清除选区，符合「复制完即释放」的直觉
      inst.term.clearSelection()
    } else {
      message.error(t('terminal.copyFailed'))
    }
  }

  // 遍历 buffer 抽取纯文本：跳过 ANSI 序列污染
  // 用 translateToString(true) 自动 trim 行尾空白
  function extractBufferText(tabId: string): string {
    const inst = termInstances.get(tabId)
    if (!inst) return ''
    const buf = inst.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (!line) continue
      lines.push(line.translateToString(true))
    }
    // 去除尾部连续空行（scrollback 默认有大量空白行）
    let end = lines.length
    while (end > 0 && lines[end - 1]!.trim() === '') end--
    return lines.slice(0, end).join('\n')
  }

  // 复制全部 scrollback 内容
  async function copyAllToClipboard(tabId: string): Promise<void> {
    const text = extractBufferText(tabId)
    if (!text) {
      message.info(t('terminal.noSelection'))
      return
    }
    const ok = await writeClipboard(text)
    if (ok) message.success(t('terminal.copyDone'))
    else message.error(t('terminal.copyFailed'))
  }

  // 复制上一条命令输出（P-20261002-56）：取 OSC 133 C/D 行号记账的区间
  // [C 记账行, D 记账行]，并用提示符行钳制兜底——D 记账的 endLine 是 D 帧时刻
  // 的光标行（输出后的空行），下一条提示符渲染在该行上，按行号提取会把
  // "PS ...> " 整行扫进剪贴板；命令开始后提示符已重渲染时代数增长，区间硬上限
  // = 提示符行-1（getCommandOutputPromptClamp，fulle2e run6/run7 实测形态）。
  // D 未达（命令运行中）终点取复制时的实时内容尾。无记账（shell 集成未生效/
  // 尚无命令）或钳制后区间为空返回空串，由调用方提示。区间提取原语与「失败
  // 命令输出读取」同源（terminalCommandMarks.extractBufferLines）
  function extractLastCommandOutput(tabId: string): string {
    const inst = termInstances.get(tabId)
    const rec = getLastCommandOutputRecord(tabId)
    if (!inst || !rec) return ''
    // tmux 滞后帧兜底：D 时刻 buffer 可能未含全部回显 cell，startLine 的内容
    // 重锚在提取时刻（shell 空闲、buffer 稳定）以命令文本重做一次
    reanchorCommandStart(tabId, rec)
    const rawEnd = rec.endLine ?? inst.term.buffer.active.length - 1
    const promptClamp = getCommandOutputPromptClamp(tabId)
    return extractBufferLines(inst, rec.startLine, promptClamp !== null ? Math.min(rawEnd, promptClamp) : rawEnd)
  }

  // 复制上一条命令输出到剪贴板（右键菜单）：无输出给专门提示，成功/失败复用既有 toast
  async function copyLastCommandOutputToClipboard(tabId: string): Promise<void> {
    const text = extractLastCommandOutput(tabId)
    if (!text) {
      message.info(t('terminal.copyLast.none'))
      return
    }
    const ok = await writeClipboard(text)
    if (ok) message.success(t('terminal.copyDone'))
    else message.error(t('terminal.copyFailed'))
  }

  // 复制选区为代码块（P-20261003-270）：「复制」之外并列的第二个复制入口，纯文本
  // 复制行为零变化——选区包 ```bash 围栏 + 最近一条命令的 `$ <command>` 头，贴
  // issue/文档保留输出来源与结构。命令文本取自 OSC 133 E 帧记账（与「复制上一条
  // 命令输出」同源）；无记账（无 shell 集成/命令仍在运行）省略头行。成功同「复制」
  // 清选区（复制完即释放的既有语义）
  async function copySelectionAsCodeBlock(tabId: string): Promise<void> {
    const inst = termInstances.get(tabId)
    if (!inst) return
    const sel = inst.term.getSelection()
    if (!sel) {
      message.info(t('terminal.noSelection'))
      return
    }
    const text = buildTerminalCodeBlock(sel, getLastCommandOutputRecord(tabId)?.command)
    const ok = await writeClipboard(text)
    if (ok) {
      message.success(t('terminal.copyDone'))
      inst.term.clearSelection()
    } else {
      message.error(t('terminal.copyFailed'))
    }
  }

  // 导出为 .txt 文件下载
  function exportAsText(
    tabId: string,
    tabName: string,
  ): void {
    const text = extractBufferText(tabId)
    if (!text) {
      message.info(t('terminal.noSelection'))
      return
    }
    try {
      const name = (tabName || 'terminal').replace(/[^\w一-龥-]/g, '_')
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      // 敏感内容自动检测建议（P-20261003-207）：下载已落地才扫描，void 不 await；
      // 远程终端等不可标会话由建议链内部按 store 归属守卫跳过
      void suggestSensitiveMarking(tabId, tabName, () => text)
    } catch {
      message.error(t('terminal.copyFailed'))
    }
  }

  // ============== 粘贴 ==============
  // 实际把文本写入终端（已通过多行警告闸门）
  // term.paste 自动处理 CRLF 归一化 + bracketed paste 模式包装
  function applyPaste(text: string, tabId: string): void {
    const inst = termInstances.get(tabId)
    if (!inst) return
    // 默认剥离末尾单个换行（CRLF / LF / CR），避免 shell 立即执行
    let processed = text
    if (stripTrailingNewline.value) {
      processed = processed.replace(/\r?\n$/, '').replace(/\r$/, '')
    }
    inst.term.paste(processed)
    inst.term.focus()
  }

  // 尝试从剪贴板粘贴截图：成功返回 true（已上传 + applyPaste 路径），无图片返回 false。
  // 供右键粘贴链与 Ctrl+V 无文件时的截图兜底共用；navigator.clipboard.read() 取
  // image/* blob（OS 复制的「文件」不在 read() 暴露面内——那类走 attachNativePaste
  // 的 paste 事件链，见 P-20261024-2）
  async function tryPasteImage(tabId: string): Promise<boolean> {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return false
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imgType = item.types.find(t => t.startsWith('image/'))
        if (imgType) {
          debug('image detected, type=', imgType)
          const blob = await item.getType(imgType)
          const ext = (imgType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
          // 前端压缩（P-20261003-204）：大截图 canvas 重采样后再传，体积降一个量级；
          // 无需压缩或任一步失败时原样返回，粘贴链路零风险
          const file = await compressPasteImage(new File([blob], `pasted.${ext}`, { type: imgType }))
          debug('after compress, size=', file.size, 'type=', file.type)
          try {
            const path = await params.uploadPaste(file, 'image')
            if (path) {
              applyPaste(quotePastePathIfNeeded(path), tabId)
              return true
            }
          } catch (err) {
            console.error('[terminal-clipboard] image upload failed', err)
            message.error(t('terminal.imagePasteFailed'))
            return true // 出错也返回 true，避免再走 text 路径重复提示
          }
        }
      }
      return false
    } catch (err) {
      // read() 权限拒绝/不可用：返回 false 让调用方回退 readText
      debug('clipboard.read failed, fallback to readText', err)
      return false
    }
  }

  // 粘贴 OS 复制的文件（P-20261024-2）：逐个上传（image/* 走既有压缩链，其余
  // 走 file 白名单形态），成功者逐文件一行路径一次贴入；失败逐个 toast 不阻断。
  // 全部失败不贴入（无可贴内容），部分成功只贴成功者（如实——失败原因已逐个回告）
  async function pasteFilesToTerminal(tabId: string, rawFiles: File[]): Promise<void> {
    if (pasteFilesInFlight) return
    if (rawFiles.length > PASTE_FILE_MAX_COUNT) {
      message.warning(t('terminal.pasteFile.tooMany', { n: PASTE_FILE_MAX_COUNT }))
    }
    const files = rawFiles.slice(0, PASTE_FILE_MAX_COUNT)
    pasteFilesInFlight = true
    const paths: string[] = []
    try {
      for (const file of files) {
        const kind = pasteUploadKind(file)
        if (kind === 'unsupported') {
          message.error(t('terminal.pasteFile.unsupported', { name: file.name }))
          continue
        }
        try {
          const payload = kind === 'image' ? await compressPasteImage(file) : file
          const path = await params.uploadPaste(payload, kind)
          if (path) {
            paths.push(quotePastePathIfNeeded(path))
          } else {
            message.error(t('terminal.pasteFile.failOne', { name: file.name }))
          }
        } catch (err) {
          console.error('[terminal-clipboard] paste file upload failed', err)
          message.error(t('terminal.pasteFile.failOne', { name: file.name }))
        }
      }
    } finally {
      pasteFilesInFlight = false
    }
    if (paths.length === 0) return
    // 多文件逐文件一行一次贴入：bracketed paste（agent TUI 常态）下多行只进
    // 编辑缓冲不执行；普通 shell 无括号粘贴时路径行可见可编辑、并非命令
    applyPaste(paths.join('\n'), tabId)
    message.success(t('terminal.pasteFile.done', { n: paths.length }))
  }

  // 从剪贴板粘贴：先尝试图片，无图片走文本（多行或超阈值大文本触发警告 modal）
  async function pasteFromClipboard(tabId: string): Promise<void> {
    // 优先：剪贴板有 image（截图）→ 上传 + paste 路径，不走多行警告
    if (await tryPasteImage(tabId)) return

    let text: string
    try {
      text = await readClipboard()
    } catch {
      message.error(t('terminal.clipboardDenied'))
      return
    }
    if (!text) return

    // 弹层闸门（P-20261002-136 扩展）：①内容中间含换行（真正多行，存量条件，
    // 可被「不再提示」豁免）②超阈值大文本（体积感知版，不受「不再提示」豁免）。
    // 大文本即使单行也可能卡顿界面/造成重复粘贴事故，故独立于多行条件触发
    const stripped = text.replace(/\r?\n$/, '').replace(/\r$/, '')
    const lineCount = stripped.split(/\r\n|\r|\n/).length
    const bytes = pasteTextEncoder.encode(text).byteLength
    const isLarge = bytes > PASTE_SIZE_WARN_BYTES
    if ((lineCount > 1 && !pasteMultilineNoWarn.value) || isLarge) {
      pendingPasteText.value = text
      pendingPasteTabId.value = tabId
      pendingPasteLarge.value = isLarge
      pendingPasteKb.value = Math.round(bytes / 1024)
      showPasteWarn.value = true
      return
    }
    applyPaste(text, tabId)
  }

  // 清空 modal 暂存状态（确认/取消/关闭共用）
  function resetPendingPaste(): void {
    showPasteWarn.value = false
    pendingPasteText.value = ''
    pendingPasteTabId.value = ''
    pendingPasteLarge.value = false
    pendingPasteKb.value = 0
  }

  // 多行/大文本警告确认：写入「不再提示」后执行实际粘贴
  function confirmPasteMultiline(): void {
    if (pasteMultilineNoWarn.value) {
      setPasteMultilineNoWarn(true)
    }
    const text = pendingPasteText.value
    const tabId = pendingPasteTabId.value
    resetPendingPaste()
    applyPaste(text, tabId)
  }

  function cancelPasteMultiline(): void {
    resetPendingPaste()
  }

  // 切换「去尾换行」开关
  function toggleStripTrailingNewline(value: boolean): void {
    stripTrailingNewline.value = value
    safeStorage.setItem(STRIP_TRAILING_NEWLINE_KEY, value ? '1' : '0')
  }

  // ============== 原生 paste 事件接管（Ctrl+V 键盘粘贴的唯一数据面） ==============
  // 键控侧（useTerminalKeys）：普通 Ctrl/Cmd+V 在 xterm customKeyEventHandler
  // 返回 false——xterm 跳过该键（不 preventDefault、不发 \x16），浏览器默认动作
  // 派发原生 paste 事件到焦点元素（xterm helper textarea），本监听在 document
  // capture 相位先于 xterm 自身 paste 监听收到。放行原生事件的原因：OS 复制的
  // 文件只在 paste 事件 clipboardData.files 暴露（async clipboard.read 拿不到
  // Files——平台事实），键盘粘贴文件只有这条路（P-20261024-2）
  function attachNativePaste(textarea: HTMLTextAreaElement, tabId: string): () => void {
    debug('attachNativePaste for tab', tabId)
    const onPaste = (e: ClipboardEvent) => {
      // 归属守卫：paste 事件目标是当前焦点元素，仅当焦点在本 pane 自己的 helper
      // textarea 上时才处理，防一次粘贴扇出到全部终端（键控拦截同款守卫）
      if (document.activeElement !== textarea) return
      const dt = e.clipboardData
      // 文件优先：命中即上传贴路径
      const { files, folderLike } = extractPasteFiles(dt)
      if (files.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        void pasteFilesToTerminal(tabId, files)
        return
      }
      // 目录形态（零类型零字节项）：v1 不做目录粘贴（paste 事件不暴露目录内容，
      // 与 P-20261023-2 文件树粘贴同口径——目录走拖放/文件树），诚实引导
      if (folderLike) {
        e.preventDefault()
        e.stopPropagation()
        message.warning(t('terminal.pasteFile.folderHint'))
        return
      }
      // 文本：接管并复用 applyPaste（去尾换行；Ctrl+V 不做多行警告——与既有键控
      // 粘贴的即时性一致，多行警告只拦右键粘贴链）。不接管会让 xterm 自身的
      // paste 监听直接 triggerDataEvent，绕过去尾换行
      const text = dt?.getData('text/plain') ?? ''
      if (text) {
        e.preventDefault()
        e.stopPropagation()
        applyPaste(text, tabId)
        return
      }
      // 无文件无文本：截图兜底走既有 read() 链（压缩+上传+贴路径）。找不到图片
      // （空剪贴板/授权拒绝）静默——浏览器默认行为本就是 no-op
      void tryPasteImage(tabId)
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }


  // 查询选区长度：抽到 useTerminalInstances 统一实现，clipboard 与 contextmenu 共用

  // 预览多行粘贴内容（前 N 行）
  const pastePreviewLines = computed(() => {
    const text = pendingPasteText.value.replace(/\r?\n$/, '').replace(/\r$/, '')
    return text.split(/\r\n|\r|\n/).slice(0, 8)
  })
  const pastePreviewLineCount = computed(() => {
    const text = pendingPasteText.value.replace(/\r?\n$/, '').replace(/\r$/, '')
    return text.split(/\r\n|\r|\n/).length
  })

  return {
    // 状态
    stripTrailingNewline,
    pasteMultilineNoWarn,
    showPasteWarn,
    pendingPasteText,
    pendingPasteTabId,
    pendingPasteLarge,
    pendingPasteKb,
    pastePreviewLines,
    pastePreviewLineCount,
    // 复制
    copySelectionToClipboard,
    copySelectionAsCodeBlock,
    copyAllToClipboard,
    copyLastCommandOutputToClipboard,
    extractLastCommandOutput,
    exportAsText,
    extractBufferText,
    // 粘贴
    pasteFromClipboard,
    applyPaste,
    confirmPasteMultiline,
    cancelPasteMultiline,
    toggleStripTrailingNewline,
    // 图片/文件粘贴（原生 paste 事件接管）
    attachNativePaste,
  }
}
