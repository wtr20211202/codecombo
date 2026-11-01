import { extractPasteFiles, readImageFromClipboard, screenshotFileName, supportsClipboardRead, type ClipboardImageResult } from '../utils/pasteFiles'
import { useFileTreeInternalClipboard } from './useFileTreeClipboard'

/**
 * 文件树粘贴编排（P-20261023-2）：树聚焦时 Ctrl+V / 右键「粘贴」的单一入口。
 *
 * 通道优先级（handlePasteEvent，一次粘贴只走一条）：
 * 1. OS 多文件（clipboardData.files，提案主通道）→ uploadExternalFiles 既有链
 *    （同名确认/进度浮条/局部刷新零改动复用）；落位目录由宿主解析（选中目录/
 *    焦点项规则与拖放落位同源）；
 * 2. 目录形态项（零字节无类型，paste 事件不暴露目录内容——平台事实）→ 诚实
 *    引导「粘贴文件夹请拖入文件树」（目录拖入通道 ③b 落地后该引导可行动）；
 * 3. 内部剪贴板（树内复制/剪切）→ batch copy / move（③a）；
 * 4. 截图兜底（async clipboard.read 的 image/*）→ 落「截图-YYYYMMDD-HHmmss.png」
 *    上传并 toast 告知文件名；授权拒绝 → 降级引导；
 * 5. 浏览器不支持读剪贴板（Firefox/Safari）→ 每会话一次引导（第一次 Ctrl+V
 *    无载荷时提示能力缺失，此后静默——每次按键都弹是噪音）。
 *
 * 内联输入保护：paste 事件从 input 冒泡到树容器时会误触文件通道（往重命名框
 * 粘贴文本 ≠ 上传文件），INPUT/TEXTAREA/内联行内一律放行为文本语义。
 */

/** Firefox/Safari 无 clipboard.read 的能力引导：会话级一次（模块级标记） */
let unsupportedHintShown = false

/** 重置会话级引导标记（单测隔离用；生产不调） */
export function resetPasteUnsupportedHint(): void {
  unsupportedHintShown = false
}

export function useFileTreePaste(options: {
  projectId: () => string
  /** 粘贴落位目录（宿主解析：选中目录/焦点项/项目根） */
  destDir: () => string
  /** 上传链（useFileTreeDragDrop.uploadExternalFiles：同名确认/进度/刷新内聚） */
  uploadFiles: (files: File[], destDir: string) => Promise<void>
  /** 树内复制粘贴（batch copy 链） */
  pasteCopy: (paths: string[], destDir: string) => Promise<void>
  /** 树内剪切粘贴（move 链；消费后清板由内部处理） */
  pasteCut: (paths: string[], destDir: string) => Promise<void>
  message: { success(m: string): void; warning(m: string): void; error(m: string): void; info(m: string): void }
  t: (k: string, p?: Record<string, unknown>) => string
}) {
  const { projectId, destDir, uploadFiles, pasteCopy, pasteCut, message, t } = options
  const { canPaste, clipboard, consumeIfCut } = useFileTreeInternalClipboard()

  /** 内部剪贴板粘贴（copy → batch copy；cut → move + 消费清板） */
  function pasteInternal(targetDir: string): boolean {
    const pid = projectId()
    if (!canPaste(pid) || !clipboard.value) return false
    const { paths, mode } = clipboard.value
    if (mode === 'cut') {
      consumeIfCut()
      void pasteCut(paths, targetDir)
    } else {
      void pasteCopy(paths, targetDir)
    }
    return true
  }

  /** 截图兜底：有图即上传（toast 告知落盘文件名），denied 降级引导，none 静默 */
  async function tryScreenshotUpload(targetDir: string): Promise<void> {
    const img: ClipboardImageResult = await readImageFromClipboard()
    if (img.kind !== 'image') {
      if (img.kind === 'denied') {
        message.warning(t('fileTree.pasteClipboardDenied'))
      }
      return
    }
    const name = screenshotFileName(new Date())
    const file = new File([img.file], name, { type: img.file.type, lastModified: img.file.lastModified })
    message.info(t('fileTree.screenshotSaved', { name }))
    await uploadFiles([file], targetDir)
  }

  /** 树容器 @paste 入口（树聚焦才触发——事件落在聚焦元素上） */
  function handlePasteEvent(e: ClipboardEvent): void {
    // 内联输入（新建/重命名框）里的粘贴是文本语义，放行不接管（与
    // handleTreeKeydown 的 INPUT 守卫同口径）
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest?.('.inline-input-row'))) return

    const parsed = extractPasteFiles(e.clipboardData)
    const dir = destDir()
    if (parsed.files.length > 0) {
      e.preventDefault()
      void uploadFiles(parsed.files, dir)
      return
    }
    if (parsed.folderLike) {
      // 浏览器 paste 事件不暴露目录内容：诚实边界引导到目录拖入通道
      message.info(t('fileTree.pasteFolderHint'))
      return
    }
    if (pasteInternal(dir)) return
    if (!supportsClipboardRead()) {
      // Firefox/Safari：能力缺失引导每会话一次（此后 Ctrl+V 静默，按键噪音零）
      if (!unsupportedHintShown) {
        unsupportedHintShown = true
        message.info(t('fileTree.pasteUnsupported'))
      }
      return
    }
    void tryScreenshotUpload(dir)
  }

  // pasteInternal（内部剪贴板粘贴）同时是右键「粘贴」菜单与键盘 Ctrl+V 的
  // 执行入口（菜单项仅在 canPaste 时启用——async clipboard read 不暴露 OS
  // 文件，OS 复制的粘贴走 paste 事件主通道，见 handlePasteEvent）

  return { handlePasteEvent, pasteInternal }
}
