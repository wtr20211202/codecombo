/**
 * useOpenFiles 域拆分（P-20261003-98）：共享类型层。
 *
 * useOpenFiles.ts 曾是全仓最大 composable（>1700 行），按域拆为 openfiles/
 * 子模块后，数据类型与「untitled 内部键」这类零依赖纯函数收敛在此——
 * 各域模块与对外入口（useOpenFiles.ts）都只从这里取类型，域间不互相 import，
 * 循环依赖门禁（import-x/no-cycle）按构造即零命中。
 *
 * 注意：对外消费方一律从 '@/composables/useOpenFiles' 取这些导出（入口再导出），
 * 不要绕过入口直接 import 本文件。
 */
import type { EditorConfigEffective } from '../../utils/editorConfig'

/** 编辑器标签页中的打开文件 */
export interface OpenFile {
  path: string
  name: string
  content: string
  originalContent: string
  loading: boolean
  isDiff?: boolean
  diffOldContent?: string
  diffOldLabel?: string
  diffNewLabel?: string
  pinned?: boolean
  /** 预览 tab（预览标签模式 P-20261002-50）：预览类来源打开时置位，斜体展示；
   *  编辑/双击（固定）/手动 pin 转正，未编辑前被同类来源复用替换 */
  isPreview?: boolean
  language?: string
  /** 服务端探测的文件原编码（如 "gbk"）：保存时回传按原编码落盘，空 = UTF-8 */
  encoding?: string
  /** 打开时磁盘内容的 sha256（服务端 ReadFile 响应 hash 字段）：保存时作为
   *  baseHash 回传，服务端与磁盘当前内容比对，不一致返回 409——保存冲突检测，
   *  防止陈旧内存内容静默覆盖 agent/其他会话在编辑间隙写入的磁盘内容。
   *  空/缺省（旧响应、diff 视图）= 不检测，保存行为与历史一致 */
  baseHash?: string
  /** 远程主机离线降级（P-20261003-15，remote:<hostId>:<path> 伪路径专用）：
   *  打开失败（主机不可达/已删）或保存网络失败置位——tab 保留 + 顶横幅 +
   *  只读，不崩不静默丢签；重试成功（重开/保存）即摘除 */
  remoteOffline?: boolean
  /** 预览策略结果（服务端 filepolicy）：非文本/超大文件不拉内容，仅展示元信息卡 */
  meta?: OpenFileMeta
  /** .editorconfig 生效缩进约定（P-20261003-95）：服务端 file-policy 响应随行
   *  下发（打开链同点位零新增请求）；undefined = 项目无配置/未命中，编辑器
   *  回落全局设置。消费方 MonacoEditor 经 resolveIndentOptions 合成 model
   *  options（editorconfig > 全局设置） */
  editorconfig?: EditorConfigEffective
}

/** 服务端 filepolicy 对 too-large / binary 的元信息（字段与后端 Decision 对齐） */
export interface OpenFileMeta {
  kind: 'too-large' | 'binary'
  size: number
  sizeHuman: string
  reason?: string
}

/** 最近关闭的文件记录（重新打开已关闭标签，对标 VS Code Reopen Closed Editor） */
export interface ClosedFileRecord {
  path: string
  name: string
}

/** 打开来源选项（预览标签模式 P-20261002-50）：preview = 预览类来源（Quick Open/
 *  命令面板/全工程搜索/深链）——活跃组存在未编辑预览 tab 时复用替换该位而非新开；
 *  缺省 = 固定 tab（文件树/欢迎页/分屏/重开等明确动作） */
export interface OpenFileOptions {
  preview?: boolean
  /** 静默打开（P-20261002-94 分屏清单恢复专用）：打不开的文件（已删等）不逐个
   *  弹拦截器错误 toast，由恢复链汇总一条降级提示（toast 一条而非 N 条） */
  silent?: boolean
  /** 指定插入位（P-20261004-74 树拖文件到 tab 条按落点插入）：新落组的签
   *  （他组共享对象 / 全新占位）splice 到该下标而非组尾，缺省 = 组尾，越界
   *  钳到最近合法边界；目标组已开该文件时忽略（仅激活既有签，不移动）；
   *  预览位换装来源不适用（换装保位，两来源互斥不共存） */
  insertAt?: number
}

/** 待决草稿恢复提示（打开文件探测到比磁盘新的未保存草稿时入队，提示条消费队首） */
export interface DraftOffer {
  /** 草稿键的项目维度：本地 = 项目 id；远程伪路径（P-20261004-116）= persist 域
   *  固定命名空间常量（远程签不属项目上下文，键跨项目稳定）。恢复/丢弃/预览
   *  动作回传本字段即可，persist 域内部按 path 再路由 */
  projectId: string
  path: string
  name: string
  /** 草稿全文（接受恢复时写回文件） */
  content: string
  /** 草稿最后写入时间戳（提示条展示） */
  savedAt: number
}

/** 编辑器组（分屏 MVP 固定双组）：组 0 为主组（承载既有扁平列表语义），
 *  组 1 为右侧分屏组。后续扩展多组时在此模型上增删即可 */
export interface EditorGroup {
  files: OpenFile[]
  activeIndex: number
}

/** 分屏方向（P-20261005-230 正交拆分，词表与终端域 paneDirection 对称）：
 *  horizontal = 左右并排（P-13 既有形态、缺省值）；vertical = 上下堆叠。
 *  持久化缺省/脏值一律回落 horizontal——旧布局（无该字段）行为完全不变 */
export type SplitDirection = 'horizontal' | 'vertical'

/** 单文件保存流结果：自动保存链据此决策（conflict = 409 已弹对话框，熔断重试） */
export type WriteFileResult = 'saved' | 'conflict' | 'error'

/** 未命名草稿内部路径前缀（untitled://N，P-20261002-24）：草稿不落盘、保存时
 *  走另存为流转真实路径。Monaco model URI（file:///untitled://N）对该形态
 *  parse/toString 稳定且互异，可复用按 path 键控的 model 缓存与共享分屏逻辑 */
export const UNTITLED_PATH_PREFIX = 'untitled://'

/** 路径是否为未命名草稿内部键（持久化/关闭栈/草稿 DB 等按 path 落地的消费方据此排除） */
export function isUntitledPath(path: string): boolean {
  return path.startsWith(UNTITLED_PATH_PREFIX)
}

/** 提供给宿主组件的回调 */
export interface OpenFileHooks {
  /** 文件打开成功后将路径推送到"最近文件"列表（projectPath 为稳定键：projectId 会随项目重建轮换） */
  onPushRecent?: (item: { path: string; name: string; projectId: string; projectName: string; projectPath: string; ts: number }) => void
  /** 打开文件失败（文件已删除等）：把该路径从最近文件列表移除（僵尸条目清理） */
  onRemoveRecent?: (path: string) => void
  /** 远程文件打开/保存成功（P-20261004-137）：记录「最近远程」候选，供
   *  Quick Open 远程层在文件关闭后仍可直达（useRemoteRecentFiles 单例消费） */
  onPushRemoteRecent?: (entry: { hostId: string; rpath: string; name: string; ts: number }) => void
  /** 远程打开/保存命中 404（主机已删）：惰性清对应最近远程条目（removeRecent 同款） */
  onRemoveRemoteRecent?: (hostId: string, rpath: string) => void
  /** 关闭非 diff 文件时释放 Monaco model */
  onDisposeModel?: (path: string) => void
  /** 未命名草稿另存为成功后回调（宿主用于刷新文件树并定位新文件） */
  onUntitledSavedAs?: (path: string) => void
}
