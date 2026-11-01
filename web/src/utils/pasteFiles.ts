/**
 * 文件树粘贴通道解析（P-20261023-2）：OS 复制文件 Ctrl+V 直达项目上传。
 *
 * 通道分级（提案 ①④）：
 * - 主通道 = paste ClipboardEvent 的 clipboardData.files：Chromium 对 OS 多文件
 *   复制可靠暴露完整 File[]，且 paste 事件免剪贴板读授权（比 async clipboard
 *   read 的单文件限制更稳、少一步权限框打扰）；
 * - 目录形态探测：DataTransferItem 在 paste 下无 webkitGetAsEntry（浏览器不暴露
 *   目录内容——平台事实），零字节无类型项是目录粘贴的可识别特征，据此给出
 *   「请拖入文件树」的诚实引导而非静默无反应；
 * - 截图兜底 = navigator.clipboard.read()：剪贴板无 Files 但有 image/* 时落成
 *   「截图-YYYYMMDD-HHmmss.png」上传（需用户手势 + secure context + 授权，
 *   拒绝/不支持由调用方降级引导，不反复弹权限框——read 只在显式 Ctrl+V 手势里
 *   调用，浏览器对拒绝态会记住并在后续调用直接失败不再询问）。
 *
 * 全部函数纯/无副作用（read 除外），DataTransfer 形状鸭子类型便于单测。
 */

/** paste 事件的文件载荷：files = 可直传的文件集；folderLike = 检测到目录形态
 *  项（调用方据此出「拖入文件树」引导）。两者互斥（有 files 就不走目录引导） */
export interface PasteFilesResult {
  files: File[]
  folderLike: boolean
}

/** 从 paste 事件的 DataTransfer 解析文件载荷。clipboardData 可能不存在
 *  （部分合成事件），一律安全回落。folderLike 判定 = kind==='file' 且 type 为空
 *  （目录项在 paste 下无类型无字节；真实文件必有 MIME 类型或非零字节——零字节
 *  文件复制在文件管理器中极罕见且误报的代价只是一条引导 toast） */
export function extractPasteFiles(dt: DataTransfer | null | undefined): PasteFilesResult {
  if (!dt) return { files: [], folderLike: false }
  const files = Array.from(dt.files || [])
  if (files.length > 0) return { files, folderLike: false }
  // types 含 'Files' 而 files 为空：Chromium 目录粘贴的典型形态（有 Files 声明
  // 无可用 File）；即便 types 不含（Firefox），逐项 kind/type 兜底判定
  const typesHasFiles = Array.from(dt.types || []).includes('Files')
  let folderLike = false
  if (typesHasFiles || dt.items) {
    for (const item of Array.from(dt.items || [])) {
      if (item.kind === 'file' && !item.type) {
        folderLike = true
        break
      }
    }
    if (!folderLike && typesHasFiles) folderLike = true
  }
  return { files: [], folderLike }
}

/** async clipboard.read 能力探测（截图兜底通道的前置）：Firefox/Safari 无
 *  clipboard.read，调用方据此降级引导，绝不调用不存在的方法 */
export function supportsClipboardRead(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.clipboard
    && typeof navigator.clipboard.read === 'function'
}

/** 截图文件名（提案 ② 命名式）：截图-YYYYMMDD-HHmmss.png。纯函数便于单测 */
export function screenshotFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `截图-${d}-${t}.png`
}

/** 截图兜底通道的读取结果：image = 待上传文件；denied = 授权拒绝/读取失败
 *  （调用方出降级引导——用户按了 Ctrl+V 期待发生点什么，静默等于坏掉）；
 *  none = 剪贴板无图片（普通文本/空剪贴板，静默——对每次文本粘贴弹引导是噪音） */
export type ClipboardImageResult =
  | { kind: 'image'; file: File }
  | { kind: 'denied' }
  | { kind: 'none' }

/** 从 async clipboard 读取图片（截图兜底通道）：取首个含 image/* 类型的
 *  ClipboardItem，blob 转 File（扩展名随 MIME 主类型；非常见图片类型回落 png
 *  命名——浏览器截图面板实质只有 png）。不支持的浏览器返回 none（调用方应先用
 *  supportsClipboardRead 分流）；read() 抛错（NotAllowedError 授权拒绝等）归
 *  denied——只在显式 Ctrl+V 手势里调用，浏览器对拒绝态会记住、后续调用直接
 *  失败不再弹框（「不反复弹权限框」由平台语义保证） */
export async function readImageFromClipboard(): Promise<ClipboardImageResult> {
  if (!supportsClipboardRead()) return { kind: 'none' }
  let items: ClipboardItem[]
  try {
    items = await navigator.clipboard.read()
  } catch {
    return { kind: 'denied' }
  }
  for (const item of items) {
    const imageType = item.types.find(t => t.startsWith('image/'))
    if (!imageType) continue
    try {
      const blob = await item.getType(imageType)
      const ext = imageType === 'image/jpeg' ? '.jpg' : imageType === 'image/gif' ? '.gif' : imageType === 'image/webp' ? '.webp' : '.png'
      return { kind: 'image', file: new File([blob], `image${ext}`, { type: imageType }) }
    } catch {
      return { kind: 'denied' }
    }
  }
  return { kind: 'none' }
}

// ============== 终端文件粘贴（P-20261024-2） ==============
// 终端内 Ctrl+V 粘贴 OS 复制的文件：上传到服务端临时目录（sc-paste-*），
// 路径文本贴入终端。纯函数部分（上限/白名单/引号/分派）沉在本文件，编排
// （in-flight 锁、toast、applyPaste）在 useTerminalClipboard。

/** 单次粘贴文件数上限（P-20261024-2 提案口径）。服务端无批量请求形态（前端每
 *  请求上传一个 file），单次总量闸只在前端——本值即真实闸 */
export const PASTE_FILE_MAX_COUNT = 5

/** 终端文件粘贴白名单（与 server/api/terminal/terminal_paste_image.go
 *  pasteFileAllowedExts 及 server/api/remote/remotehost_terminal.go
 *  remotePasteFileExt 三处对账）。前端白名单只是预筛——为的是「不支持类型」
 *  的即时可读反馈（免得到服务端 400 才知道），判定的唯一事实源在服务端 */
const PASTE_FILE_ALLOWED_EXTS = new Set([
  // 图片（OS 里复制的图片文件走 file 形态；截图 blob 才走 image 形态）
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  // 纯文本 / 结构化文本
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.xml', '.yml', '.yaml', '.toml',
  '.ini', '.cfg', '.conf', '.sql', '.html', '.htm', '.css',
  // 常见源码
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
  '.rb', '.php', '.lua', '.pl', '.r',
  '.dart', '.vue', '.svelte',
  // office / 文档
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub',
  // 压缩包
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
])

/** 扩展名解析：File.name 只有 basename（浏览器 paste 不暴露路径），小写归一；
 *  无扩展名返回 ''（Makefile 等 v1 白名单外——引导走文件树上传链） */
function pasteFileExtOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function isAllowedPasteFileExt(name: string): boolean {
  return PASTE_FILE_ALLOWED_EXTS.has(pasteFileExtOf(name))
}

/** 单个粘贴文件的上传分派：image/*（截图 blob、OS 复制的图片）走既有 image
 *  压缩上传链（P-20261003-204 语义不变）；其余按扩展名白名单走 file 形态；
 *  白名单外返回 unsupported（调用方出「不支持类型」反馈） */
export type PasteUploadKind = 'image' | 'file' | 'unsupported'
export function pasteUploadKind(file: { name: string; type: string }): PasteUploadKind {
  if (file.type.startsWith('image/')) return 'image'
  return isAllowedPasteFileExt(file.name) ? 'file' : 'unsupported'
}

/** 路径含空白字符时用双引号包裹（Windows 绝对路径常见空格——TempDir 落在
 *  带空格用户名下并不罕见；bash/PowerShell/cmd 双引号均合法），其余原样。
 *  claude 会话与普通 shell 对引号包裹的路径都能正确消费 */
export function quotePastePathIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p
}
