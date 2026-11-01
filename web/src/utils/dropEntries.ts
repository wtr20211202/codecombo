/**
 * 拖放目录枚举（P-20261023-2③b）：OS 目录拖入文件树——webkitGetAsEntry() 递归
 * 枚举整树展平为「相对路径名 File 集」，交既有 uploadExternalFiles 链（逐文件
 * 队列/同名确认/进度浮条零改动复用）；服务端 upload 旁挂 paths 字段按段建目录
 * 落盘。此前的拖放链只吃 dataTransfer.files 平铺，目录拖入实际不可用（提案修正
 * 了原案的不实声明），本模块是「拖文件夹进项目」的首次落地。
 *
 * 平台事实（为什么必须在事件同步期取 entry）：
 * - DataTransferItemList 在事件 handler 返回后即失效，但同步取得的
 *   FileSystemEntry 对象跨微任务仍可用——因此本模块入口先同步收集 entry，
 *   再进入异步递归；
 * - webkitGetAsEntry 在 Chromium/Firefox/Safari 的拖放场景均可用，与 paste
 *   通道（paste 事件不暴露目录）的支持矩阵互补。
 *
 * File 名改写：File 对象不可变，用 Blob 引用构造新 File（File([file], relPath)
 * 是惰性引用不复制字节，大文件零拷贝成本），multipart filename 携带相对路径，
 * 服务端经 paths 旁挂字段收口。
 */

/** 目录拖入收集的文件数上限：整树枚举是无界 walk，拖入 node_modules 级目录
 *  （10 万+ 文件）会既挂浏览器又制造上传风暴；触顶截断由调用方如实提示
 *  （远超单次拖入的合理规模，正常使用不可达） */
export const DROP_ENTRY_FILE_CAP = 2000

export interface DropCollectResult {
  files: File[]
  /** 触顶截断：已收集 DROP_ENTRY_FILE_CAP 个文件后停止枚举，树未走完 */
  truncated: boolean
}

/** 是否值得走 entry 枚举：至少一个目录条目才走（纯文件拖入维持 dt.files 平铺
 *  既有路径零行为变化；items 无 webkitGetAsEntry 方法（老浏览器/合成事件）→
 *  null = 调用方回落平铺）。注意本函数必须在事件 handler 同步期调用（取 entry） */
export function hasDirectoryEntry(dt: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dt.items || [])) {
    // 防御性可选调用：类型库恒有 webkitGetAsEntry，运行时老引擎可能缺失
    const entry = (item as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  return entries
}

/** entry.file / reader.readEntries 的 Promise 包装：回调式是 webkitGetAsEntry
 *  的既有规范形态，三引擎普遍支持（Chromium 新增的 Promise 变体不混用——双轨
 *  并接会引入回调与 Promise 的双重完成路径，无收益） */
function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve as (f: File) => void, reject as (e: DOMException) => void)
  })
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve as (es: FileSystemEntry[]) => void, reject as (e: DOMException) => void)
  })
}

/** 递归枚举目录（readEntries 每批 ≤100 条，必须循环取到空批才完整——单次调用
 *  只返回首批是规范语义也是常见踩坑点）；任一子项失败跳过该项继续（局部残缺
 *  优于整体放弃，失败面由上传链的逐文件 skipped 如实呈现） */
async function walkDir(dir: FileSystemDirectoryEntry, prefix: string, out: File[], state: { truncated: boolean }): Promise<void> {
  const reader = dir.createReader()
  for (;;) {
    let batch: FileSystemEntry[]
    try {
      batch = await readEntries(reader)
    } catch {
      return // 目录不可读（权限/竞态消失）：该子树放弃
    }
    if (batch.length === 0) return
    for (const e of batch) {
      if (out.length >= DROP_ENTRY_FILE_CAP) {
        state.truncated = true
        return
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isFile) await collectFile(e as FileSystemFileEntry, rel, out)
      else if (e.isDirectory) await walkDir(e as FileSystemDirectoryEntry, rel, out, state)
    }
  }
}

async function collectFile(entry: FileSystemFileEntry, rel: string, out: File[]): Promise<void> {
  try {
    const f = await entryFile(entry)
    // Blob 引用式改名：File([file], rel) 不复制字节，读出在 multipart 发送期
    out.push(new File([f], rel, { type: f.type, lastModified: f.lastModified }))
  } catch {
    // 单文件不可读（被占用/权限）：跳过，局部残缺由用户从落盘结果看见
  }
}

/** 拖放事件 → 展平文件集。entries 为空（纯文件拖入/无 entry 支持）返回 null，
 *  调用方回落 dt.files 平铺既有链。fullPath 去掉首位分隔符即拖入根的相对路径
 *  （拖入目录名保留为落位子目录——资源管理器整目录拖拽的用户预期）。空目录
 *  展平后无文件（上传通道不产空目录，诚实局限：拖入的空文件夹不落盘） */
export async function collectDropFiles(entries: FileSystemEntry[]): Promise<DropCollectResult | null> {
  if (entries.length === 0) return null
  if (!entries.some(e => e.isDirectory)) return null // 无目录：维持平铺链
  const out: File[] = []
  const state = { truncated: false }
  for (const e of entries) {
    if (out.length >= DROP_ENTRY_FILE_CAP) {
      state.truncated = true
      break
    }
    const rel = e.name
    if (e.isFile) await collectFile(e as FileSystemFileEntry, rel, out)
    else if (e.isDirectory) await walkDir(e as FileSystemDirectoryEntry, rel, out, state)
  }
  return { files: out, truncated: state.truncated }
}
