// 编辑器域项目文件清单缓存（P-20261005-214 自 pathCompletion.ts 提取共享）
//
// 消费方两处：字符串内路径补全（views/editor/pathCompletion）与行内路径链接层
// （views/editor/pathLinks）。两个 provider 同域同节奏（补全触发/链接计算时按需
// 拉），缓存状态单一持有——第三处消费方再各养一份会把失效链复制漂移；
// 取数原语/上限/TTL 注入缝与 Quick Open 同源（collectProjectFileList +
// swrTtlMs，P-20261003-107 提取的共享面）。失效链：同一对窗口事件
// （PROJECT_FILE_CHANGED / OPS_FILES_EXTERNAL_CHANGE，1s 尾沿去抖）+ 与 Quick
// Open 同值的 SWR TTL——agent 新建/删除文件后补全清单与链接在册校验同拍失效。
// 监听随编辑器 chunk 首次接线注册一次、随应用生命周期存活（模块单例无
// teardown 面，useEditorProblems 同姿态）。失效只清状态不预取，下次消费触发
// 惰性重拉——建议面板未打开/无链接计算时零网络开销。
import { collectProjectFileList, swrTtlMs, type PaletteFileItem } from '../../composables/projectFileList'
import { PROJECT_FILE_CHANGED } from '../../composables/useWebSocket'
import { OPS_FILES_EXTERNAL_CHANGE } from '../../utils/opsEvents'

/** 项目相对正斜杠路径的父目录；根级文件与项目根本身返回 ''（'' 即项目根） */
export function parentDir(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/** 文件路径 → 祖先目录集合（含项目根以下各层），目录钻取与导航段校验的数据基座 */
export function buildDirSet(files: readonly PaletteFileItem[]): Set<string> {
  const dirs = new Set<string>()
  for (const f of files) {
    for (let p = parentDir(f.path); p; p = parentDir(p)) dirs.add(p)
  }
  return dirs
}

let cachePid = ''
let cacheFiles: PaletteFileItem[] = []
let cacheDirs: Set<string> = new Set()
let cacheFetchedAt = 0
let inflight: Promise<void> | null = null
let invalidateTimer: ReturnType<typeof setTimeout> | null = null
let invalidationWired = false

async function loadFileList(pid: string): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { files } = await collectProjectFileList(pid)
      cachePid = pid
      cacheFiles = files
      cacheDirs = buildDirSet(files)
      cacheFetchedAt = Date.now()
    } catch {
      // 失败保持空清单：下次消费触发重试（无 loading 面，静默——补全/链接是增益）
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function invalidateFileListCache() {
  if (invalidateTimer) clearTimeout(invalidateTimer)
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null
    cachePid = ''
    cacheFiles = []
    cacheDirs = new Set()
    cacheFetchedAt = 0
  }, 1000) // 与 Quick Open 失效去抖同值：合并 agent 批量产文件的连环事件
}

function wireInvalidation() {
  if (invalidationWired) return
  invalidationWired = true
  window.addEventListener(PROJECT_FILE_CHANGED, invalidateFileListCache)
  window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, invalidateFileListCache)
}

/** 消费期取数：新鲜命中直返；陈旧回旧表 + 后台静默换新（SWR，Quick Open
 *  P-20261003-299 同语义）；键不匹配（首次/切项目/事件失效后）同步等全量
 *  拉取——消费方拿到清单再产出（首次触发多等一次取数） */
export async function getFileListForCompletion(pid: string): Promise<{ files: PaletteFileItem[]; dirs: Set<string> }> {
  wireInvalidation()
  if (cachePid === pid && cacheFiles.length > 0) {
    if (Date.now() - cacheFetchedAt < swrTtlMs()) return { files: cacheFiles, dirs: cacheDirs }
    void loadFileList(pid)
    return { files: cacheFiles, dirs: cacheDirs }
  }
  await loadFileList(pid)
  return { files: cacheFiles, dirs: cacheDirs }
}

/** 供测试用：清缓存 + 摘失效监听（生产代码不调用——模块单例随应用生命周期
 *  存活）。pathCompletion/pathLinks 的 reset*ForTests 各自委托本函数清缓存面 */
export function resetEditorFileListCacheForTests(): void {
  if (invalidateTimer) {
    clearTimeout(invalidateTimer)
    invalidateTimer = null
  }
  if (invalidationWired) {
    window.removeEventListener(PROJECT_FILE_CHANGED, invalidateFileListCache)
    window.removeEventListener(OPS_FILES_EXTERNAL_CHANGE, invalidateFileListCache)
    invalidationWired = false
  }
  cachePid = ''
  cacheFiles = []
  cacheDirs = new Set()
  cacheFetchedAt = 0
  inflight = null
}
