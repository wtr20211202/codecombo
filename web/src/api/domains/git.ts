// Git / 项目域 API：项目、仓库操作、diff、日志、分支、远程、高级操作等
import type { AxiosRequestConfig } from 'axios'
import api from '../http'
import { filesArchivePathsQuery } from '../../utils/directDownload'

// 项目管理
export const projectApi = {
  list: () => api.get('/projects'),
  get: (id: string) => api.get(`/projects/${id}`),
  add: (data: { name: string; path: string }) => api.post('/projects', data),
  // 重新定位项目路径（目录搬家/换盘/改名后恢复有效态）：ID/名称不变仅换 path，
  // uiState/终端历史等按项目 ID 关联的状态全保留
  relocate: (id: string, path: string) => api.put(`/projects/${id}`, { path }),
  // 冻结/解冻（P-20261003-9）：布尔开关，仅影响首页呈现（尾部分区）与 ahead/behind 批量探测
  setFrozen: (id: string, frozen: boolean) => api.put(`/projects/${id}/frozen`, { frozen }),
  // 硬锁锁定/解锁（P-20261004-3）：locked 归档不可变档——写族端点 403、读面放行；
  // 服务端双向审计（project.lock / project.unlock）
  setLocked: (id: string, locked: boolean) => api.put(`/projects/${id}/locked`, { locked }),
  // closeAgentSessions（P-20261006-36）：删除时一并关闭驻留该项目的智能体
  // 会话（kind=agent、创建目录在项目根内）——确认框勾选后携带；缺省 = 服务端
  // 默认保留（agent 可能正收尾长任务，保守不杀）
  remove: (id: string, closeAgentSessions?: boolean) =>
    api.delete(`/projects/${id}`, closeAgentSessions ? { params: { closeAgentSessions: 1 } } : undefined),
  // config 可传 silent（P-20261003-47 审批卡 target 点击链静默探测用）
  status: (id: string, config?: AxiosRequestConfig) => api.get(`/projects/${id}/status`, config),
  branches: (id: string) => api.get(`/projects/${id}/branches`),
  tags: (id: string) => api.get(`/projects/${id}/tags`),
  remotes: (id: string) => api.get(`/projects/${id}/remotes`),
  aheadBehind: (id: string, config?: AxiosRequestConfig) => api.get(`/projects/${id}/ahead-behind`, config),
  // 全项目批量查询（首页/项目页一次请求替代 N 次扇出）
  aheadBehindAll: (config?: AxiosRequestConfig) => api.get('/ahead-behind', config),
  // config 尾参（filePolicy 同款先例）：项目规则扫描以 silent 拉根清单做存在性
  // 探测——失效路径项目的 500 是预期结果，不弹拦截器全局错误
  fileTree: (id: string, path?: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${id}/file-tree`, { params: { path }, ...config }),
  // Quick Open 专用：单请求扁平文件列表（服务端一次遍历，性能优化）
  fileList: (id: string, max?: number) => api.get(`/projects/${id}/file-list`, { params: max ? { max } : undefined }),
  searchContent: (id: string, params: {
    q: string
    case?: '1' | '0'
    word?: '1' | '0'
    regex?: '1' | '0'
    glob?: string
    max?: number
  }, config?: AxiosRequestConfig) => api.get(`/projects/${id}/search`, { params, ...config }),
  // 跨项目批量搜索（结果按项目分组返回；单项目失败只在该组标记 error）。
  // ids 为注册项目 id 列表（逗号拼接）
  searchProjectsContent: (ids: string[], params: {
    q: string
    case?: '1' | '0'
    word?: '1' | '0'
    regex?: '1' | '0'
    glob?: string
    max?: number
  }) => api.get('/search/projects', { params: { ids: ids.join(','), ...params } }),
  // TODO/FIXME 注释标记扫描（P-20261002-25）：复用内容搜索后端按文件分组返回；
  // total 为命中行总数，truncated = 超出服务端 500 上限被截断
  projectTodos: (id: string) => api.get(`/projects/${id}/todos`),
  // 项目笔记 projectNotes/saveProjectNotes（GET/PUT /projects/:id/notes 兼容 shim）
  // 随 P-20261108-3 笔记单库化退役——笔记只剩项目无关的 /api/notes 族（notesGlobalApi）
  readFile: (id: string, path: string, config?: AxiosRequestConfig) => api.get(`/projects/${id}/file`, { params: { path }, ...config }),
  // 文件预览策略（text/too-large/binary 分级决策）：打开前查询，超大/二进制不拉内容
  // config 可选（如终端文件链接的存在性探测传 silent：404 是预期结果，不弹错误提示）
  filePolicy: (id: string, path: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${id}/file-policy`, { params: { path }, ...config }),
  // 单文件/目录/多选批量下载（P-20261030-2 直链化）：取包不再走 axios blob
  //（整包进内存、1GB 级零反馈），改 utils/directDownload 构造同源直链由浏览器
  // 下载条原生承接。此处仅保留 probe（JSON 预估 + 敏感命中清单，取包前弹
  // 警示框）与 files-archive 的手工 paths 序列化（axios 默认 paths[]= 与服务端
  // QueryArray 形态不匹配，remote.ts files/archive 同款手工拼装）
  dirArchiveProbe: (id: string, path: string) =>
    api.get(`/projects/${id}/dir-archive`, { params: { path, probe: 1 } }),
  // 多选批量归档下载（P-20261003-250）：选中项集合（文件/目录混合）打包 zip，
  // probe/override 敏感扫描流与 dir-archive 同款
  filesArchiveProbe: (id: string, paths: string[]) =>
    api.get(`/projects/${id}/files-archive?${filesArchivePathsQuery(paths)}&probe=1`),
  // encoding：服务端 ReadFile 探测到的原编码（如 "gbk"）原样回传，按原编码落盘；
  // 空 = UTF-8。
  // baseHash：打开文件时记录的磁盘内容 hash（ReadFile 响应的 hash 字段）。
  // 非空时服务端与磁盘当前内容比对，不一致返回 409（保存冲突检测，防覆盖
  // agent/其他会话的写入）；缺省 = 直写，与历史行为一致（调用方：编辑器保存流）
  writeFile: (id: string, path: string, content: string, config?: AxiosRequestConfig, encoding?: string, baseHash?: string) => {
    const body: Record<string, string> = { path, content }
    if (encoding) body.encoding = encoding
    if (baseHash) body.baseHash = baseHash
    return api.put(`/projects/${id}/file`, body, config)
  },
  createFile: (id: string, path: string, content?: string) => api.post(`/projects/${id}/file/create`, { path, content: content || '' }),
  createDir: (id: string, path: string) => api.post(`/projects/${id}/file/mkdir`, { path }),
  // config 可选：行内重命名对 409 目标已存在走 silent + 行内红提示（预期分支
  // 不叠拦截器 toast，同 writeFile 冲突检测模式）；拖拽移动等其他调用方缺省
  // 保持拦截器 toast
  renameFile: (id: string, oldPath: string, newPath: string, config?: AxiosRequestConfig) =>
    api.post(`/projects/${id}/file/rename`, { oldPath, newPath }, config),
  deleteFile: (id: string, path: string) => api.post(`/projects/${id}/file/delete`, { path }),
  // 创建副本（P-20261004-135）：服务端同目录 <stem>-copyN.<ext> 复制（文件字节级/
  // 目录递归整树，O_EXCL 绝不覆盖既有条目）。响应 path 是新路径唯一权威（命名
  // 自增在服务端）——树右键链据此刷新并选中新文件，不自行拼名
  duplicateFile: (id: string, path: string) => api.post(`/projects/${id}/files/duplicate`, { path }),
  // 文件批量操作（P-20261006-39；copy 形态 P-20261023-2）：move/delete/rename/
  // copy 四形态单请求收口，逐条结构化结果（results:[{path,status:'ok'|'skipped'|
  // 'error',error?}]，失败不中断批次；服务端护栏单批 ≤200）。config 可选——批量
  // 链走 silent，汇总反馈由调用方一次给出，拦截器不逐批叠 toast
  batchFiles: (
    id: string,
    body: {
      action: 'move' | 'delete' | 'rename' | 'copy'
      entries?: string[]
      destDir?: string
      renames?: Array<{ oldPath: string; newPath: string }>
    },
    config?: AxiosRequestConfig,
  ) => api.post(`/projects/${id}/files/batch`, body, config),
  // 删除确认的递归规模统计（P-20261002-137）：目录删除前查「N 文件/M 目录/共 X」
  // 知情确认；silent——统计是确认弹层的增强面，失败退化为既有盲确认文案，
  // 不让拦截器对这种预期内失败叠错误 toast
  fileStat: (id: string, path: string) => api.get(`/projects/${id}/file/stat`, { params: { path }, silent: true }),
  // config 可选（P-20261003-117）：文件树逐文件上传走 silent——失败面由树头
  // 浮条清单承接，拦截器不再逐文件叠错误 toast；其余调用方缺省行为不变。
  // overwrite（P-20261003-230）：同名覆盖档——缺省 false = 服务端跳过同名
  // （skipped 携「file already exists」稳定原因），true = 放行替换既有目标
  // （同名确认框选「覆盖」后携带；axios 丢弃 falsy，不带键即默认跳过档）。
  // relPaths（P-20261023-2）：与 files 逐序对齐的相对路径旁挂字段（multipart
  // filename 按规范被服务端解析层剥成 basename，目录拖入的子路径经此携带；
  // 长度对齐才发，缺省零变化）
  uploadFiles: (id: string, files: File[], dest?: string, config?: AxiosRequestConfig, overwrite?: boolean, relPaths?: string[]) => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    if (relPaths && relPaths.length === files.length && relPaths.some(p => p.includes('/'))) {
      form.append('paths', JSON.stringify(relPaths))
    }
    return api.post(`/projects/${id}/file/upload`, form, {
      params: { ...(dest ? { dest } : {}), ...(overwrite ? { overwrite: 1 } : {}) },
      headers: { 'Content-Type': 'multipart/form-data' },
      ...config,
    })
  },
  // 在系统资源管理器中显示（P-20261003-323）：服务端按平台 exec 宿主文件管理器
  // 定位目标（win explorer /select、mac open -R、linux xdg-open 退化目录语义）；
  // headless 实例 501（KNOWN_ERROR 映射双语文案），失败走拦截器提示
  revealInSystem: (id: string, path: string) => api.post(`/projects/${id}/reveal`, { path }),
}

// 目录浏览
export const browseApi = {
  list: (path?: string) => api.get('/browse', { params: { path } }),
}

// 提交操作
export const commitApi = {
  stage: (projectId: string, files: string[]) =>
    api.post(`/projects/${projectId}/stage`, { files }),
  unstage: (projectId: string, files: string[]) =>
    api.post(`/projects/${projectId}/unstage`, { files }),
  commit: (projectId: string, message: string, files?: string[], amend?: boolean, signoff?: boolean, author?: string, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/commit`, { message, files, amend, signoff, author }, config),
  amendMessage: (projectId: string, message: string) =>
    api.post(`/projects/${projectId}/commit/amend-message`, { message }),
  // ref 可选（P-20261008-11 文件历史时间线 git 条目恢复）：缺省 = 既有整文件
  // 回滚语义（HEAD）；非空 = 检出该提交的文件版本进工作区，与回滚同为改写
  // 工作区的高危写，确认闸在调用方 UI（FileHistoryView 恢复钮）
  rollback: (projectId: string, files: string[], ref?: string) =>
    api.post(`/projects/${projectId}/rollback`, ref ? { files, ref } : { files }),
  // 提交信息改写（HEAD amend / 历史 rebase reword）
  getCommitPushed: (projectId: string, commit: string) =>
    api.get(`/projects/${projectId}/commit/${commit}/pushed`),
  rewordMessage: (projectId: string, commit: string, message: string, confirmPushed = false) =>
    api.post(`/projects/${projectId}/commit/${commit}/reword`, { message, confirmPushed }),
  // commit.template 模板内容（P-20261003-172）：提交框初始化空态预填；
  // 未配置/读取失败服务端统一返回空串，调用方静默跳过
  getTemplate: (projectId: string) =>
    api.get(`/projects/${projectId}/commit-template`),
  // 拆分建议逐组执行（P-20261003-278）：确认弹层预览后的分组方案整包下发，
  // 服务端逐组 stage+commit（写队列域）返回逐组报告——组级失败不报 HTTP 错
  // （报告本体承载中断面），仅请求级畸形 400。timeout 0：循环耗时随组数线性
  // 增长（20 组上限 × git 命令级秒耗），不吃 30s 全局默认
  executeSplit: (projectId: string, groups: CommitSplitGroupPayload[]) =>
    api.post<CommitSplitReport>(`/projects/${projectId}/commit-split-execute`, { groups }, { timeout: 0 }),
}

// 拆分建议分组 wire 形态（P-20261003-278，server/git CommitSplitGroup 镜像）
export interface CommitSplitGroupPayload {
  name: string
  files: string[]
  subject: string
}

// 逐组执行报告（server/git CommitSplitReport 镜像）：failed 非空 ⇒ 其后
// remaining 个组未执行。组间靠 pathspec 提交隔离——分组外已暂存内容不卷入
// 任何组、保持暂存态（不会出现「拒绝执行」的预检分支）
export interface CommitSplitReport {
  total: number
  executed: { index: number; name: string; subject: string; commit: string }[]
  failed: { index: number; name: string; subject: string; step: 'stage' | 'commit'; error: string } | null
  remaining: number
}

// index.lock 遗留锁一键清理（P-20261002-150）：服务端 mtime 双重校验防误删活锁，
// 未达阈值 409 拒绝（拦截器提示），锁不存在幂等成功（removed=false）
export const gitLockApi = {
  cleanup: (projectId: string) => api.post(`/projects/${projectId}/index-lock/cleanup`),
}

// 工作区未提交变更单文件行数（P-20261003-219，server/git NumstatFile 镜像）：
// binary=true 时 additions/deletions 恒 0（二进制不数行）；行数是示意口径
//（未跟踪大文件只数前 1MB、最多补计 200 个文件，服务端同注）
export interface NumstatFile {
  path: string
  additions: number
  deletions: number
  binary?: boolean
}

// 分支对比
// 大 diff 超时审计补齐（P-20261002-53）：同 diffApi，跨 ref 对比在大分支差异下可超 30s
export const branchDiffApi = {
  listFiles: (projectId: string, from: string, to: string) =>
    api.get(`/projects/${projectId}/branch-diff`, { params: { from, to }, timeout: 0 }),
  getFileDiff: (projectId: string, from: string, to: string, file: string) =>
    api.get(`/projects/${projectId}/branch-file-diff`, { params: { from, to, file }, timeout: 0 }),
}

// 任意版本对比（复用 branch-diff API，传入 commit hash）
export const compareApi = branchDiffApi

// 差异查看
// 大 diff 超时审计补齐（P-20261002-53）：仓库级/单文件/跨 ref diff 与 blame 在
// 大仓库上可超 axios 30s 全局默认——timeout: 0 不设前端上限，服务端 git 子进程
// 自身走 git_timeout 只读档（60s）兜底，前端掐断早于服务端会造成「假失败真在跑」
export const diffApi = {
  getDiff: (projectId: string, staged?: boolean) =>
    api.get(`/projects/${projectId}/diff`, { params: { staged }, timeout: 0 }),
  // 工作区逐文件行数统计（P-20261003-219 变更树「复制变更摘要」数据面）：
  // numstat HEAD（含已暂存）+ 未跟踪行数补计；config 可选（复制动作传
  // silent——取数失败由调用方就地反馈，不叠拦截器全局错误 toast）
  getNumstat: (projectId: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/numstat`, config),
  // config 尾参（showFile/filePolicy 同款先例）：审批卡 target 浮窗（P-20261003-253）
  // 以 silent 拉差异——hover 链的失败只在浮窗内降级提示，不弹拦截器全局错误
  getFileDiff: (projectId: string, file: string, staged?: boolean, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/file/diff`, { params: { file, staged }, timeout: 0, ...config }),
  getCommitDiff: (projectId: string, commit: string, file?: string) =>
    api.get(`/projects/${projectId}/diff/${commit}`, { params: file ? { file } : undefined, timeout: 0 }),
  // ref 可选：按该提交/引用 blame（blame 上一版导航 P-20261002-65，形如
  // "8 位短 hash^"），缺省 undefined = 工作树当前态，行为不变
  blame: (projectId: string, file: string, ref?: string) =>
    api.get(`/projects/${projectId}/blame`, { params: ref ? { file, ref } : { file }, timeout: 0 }),
  getFileHunks: (projectId: string, file: string, staged?: boolean) =>
    api.get(`/projects/${projectId}/file/hunks`, { params: { file, staged } }),
  stageHunk: (projectId: string, file: string, hunkIndex: number) =>
    api.post(`/projects/${projectId}/hunk/stage`, { file, hunkIndex }),
  unstageHunk: (projectId: string, file: string, hunkIndex: number) =>
    api.post(`/projects/${projectId}/hunk/unstage`, { file, hunkIndex }),
  // 回滚工作区单个 hunk（P-20261003-49）：git apply -R 只动工作区不动暂存区；
  // 块已被再改 → 409 + 稳定标记，拦截器映射「此变更块已变化」文案
  discardHunk: (projectId: string, file: string, hunkIndex: number) =>
    api.post(`/projects/${projectId}/hunk/discard`, { file, hunkIndex }),
}

// 日志
export const logApi = {
  // config 尾参（diffApi.getFileDiff 同款先例）：分支悬停浮窗（P-20261003-274）
  // 以 silent 拉 hover 预览——失败只在浮窗内降级提示，不弹拦截器全局错误
  getLog: (projectId: string, params?: { branch?: string; limit?: number; skip?: number; author?: string; since?: string; until?: string }, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/log`, { params, ...config }),
  search: (projectId: string, query: string) =>
    api.get(`/projects/${projectId}/log/search`, { params: { query } }),
  getFileLog: (projectId: string, file: string) =>
    api.get(`/projects/${projectId}/log/file`, { params: { file } }),
  getCommitFiles: (projectId: string, commit: string) =>
    api.get(`/projects/${projectId}/commit/${commit}/files`),
  getRecentMessages: (projectId: string) =>
    api.get(`/projects/${projectId}/log/recent-messages`),
  // 推送前 ahead 预览（P-20261003-151）：当前分支领先 upstream 的提交清单
  // （`git log @{upstream}..HEAD`，最新在前，limit 封顶预览条数）。响应体经
  // 拦截器解包为 { data: 提交数组, noUpstream?: true }——上游缺失/未 tracking
  // 时 data 为空且 noUpstream=true，调用方跳过预览只留注记（消费形态同
  // CommitsPanel 的 emptyRepo 先例）；silent：预览失败降级为纯计数行，不在
  // 打开推送弹窗时弹红 toast
  getAhead: (projectId: string, limit = 20) =>
    api.get(`/projects/${projectId}/log`, { params: { range: 'ahead', limit }, silent: true }),
  // 分支比较弹层的提交区间（P-20261003-233）：from=基线（当前分支/HEAD）、
  // to=参照（分支/Tag/hash）；unique=true 仅参照独有（from..to 单向），缺省
  // from...to 对称差双向全量。基线缺失（from 不可解析）服务端降级返回 to 全量
  // 历史 + noBase 标志（消费形态同 getAhead 的 noUpstream 先例）；silent：区间
  // 清单是弹层辅助面，失败由弹层就地降级提示，不在打开弹窗时叠拦截器全局红 toast
  getCompare: (projectId: string, from: string, to: string, unique = false, limit = 100) =>
    api.get(`/projects/${projectId}/log`, {
      params: { range: 'compare', from, to, ...(unique ? { unique: 1 } : {}), limit },
      silent: true,
    }),
}

// 分支
// 自动暂存切换链结果（P-20261003-203，服务端 git.CheckoutWithAutoStash 的
// 结构化上报；切换成功 200 响应的 autoStash 字段）
export interface AutoStashResult {
  stashed: boolean   // 本次实际新建了 stash 条目（执行时工作区已干净则 false）
  restored: boolean  // 已在目标分支成功 pop（变更回来了）
  stashKept: boolean // pop 冲突等失败：stash 条目保留（变更未丢，可切回原分支恢复）
}

// 可恢复的 autoStash 条目（P-20261006-48，服务端 git.RecoverableAutoStash 镜像）：
// checkout 成功响应的 recoverableStash 字段——检出目标分支上留有「切走前自动暂存」
// 的条目（On <branch>: + auto: checkout to 双注记匹配，多条取最新）。index 是
// 落档时刻的栈位（pop/drop 会使更高位前移），恢复链须按 branch+message 重定位，
// 不直接消费；files 为提示文案量词（服务端探测失败按 0）
export interface RecoverableStashHint {
  index: number
  branch: string
  message: string
  files: number
}

// 合并预演冲突文件（P-20261005-174，服务端 git.MergePreviewConflictFile 镜像）：
// 删除-修改类无冲突标记，只回 status 不回段（hunkCount/ours/theirs 缺省）
export interface MergePreviewConflictFile {
  path: string
  status: 'both-modified' | 'both-added' | 'deleted-by-us' | 'deleted-by-them'
  hunkCount?: number
  ours?: string
  theirs?: string
}

// 合并预演合成面统计：HEAD → 合成树的差异聚合（本次合并将带入的变更量）
export interface MergePreviewStat {
  files: number
  insertions: number
  deletions: number
}

// 合并预演结果（服务端 git.MergePreviewResult 镜像）：clean=true 绿态可干净
// 合并；false 红态看 conflicts。cleanCount = 合成面变更文件中不在冲突清单的
// 个数（红态「其余干净并入 N 个文件」）；零值 stat = source 已被包含（无变更）
export interface MergePreviewResult {
  clean: boolean
  treeOid?: string
  conflicts: MergePreviewConflictFile[]
  cleanCount: number
  stat?: MergePreviewStat
}

export const branchApi = {
  list: (projectId: string) => api.get(`/projects/${projectId}/branches`),
  create: (projectId: string, name: string, checkout?: boolean, startPoint?: string) =>
    api.post(`/projects/${projectId}/branches`, { name, checkout, startPoint }),
  // autoStash（P-20261003-203）：脏工作区确认框「自动暂存并恢复」档——服务端
  // 一次完成 stash → checkout → stash pop；响应体经拦截器解包为
  // { message, autoStash?, recoverableStash? }（调用方按 autoStash.stashKept
  // 分支提示；recoverableStash 为切回原分支的恢复提示字段，P-20261006-48）
  checkout: (projectId: string, branch: string, autoStash = false) =>
    api.post<{ message: string; autoStash?: AutoStashResult; recoverableStash?: RecoverableStashHint }>(
      `/projects/${projectId}/checkout`, { branch, autoStash },
    ),
  checkoutAndUpdate: (projectId: string, branch: string) =>
    api.post(`/projects/${projectId}/checkout-update`, { branch }),
  // config 可选透传（清理已合并分支向导批量删用 silent 抑制逐项错误 toast）
  delete: (projectId: string, name: string, force?: boolean, config?: AxiosRequestConfig) =>
    api.delete(`/projects/${projectId}/branches`, { params: { name, force }, ...config }),
  // 合并分支。strategy（P-20261007-18）缺省 = 默认合并（历史语义）；'squash' =
  // 压平合并（--squash + 单条汇总提交），message 为汇总提交消息（空 = 服务端
  // 自动生成「(source) N commits: 首末提交标题」）。config 可选透传（errorLabel 等）
  merge: (projectId: string, source: string, strategy?: string, message?: string, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/merge`, { source, strategy, message }, config),
  // 合并预演（P-20261005-174）：merge-tree 只读原语不动工作区；git <2.38 端点
  // 501（入口已按 GET /branches 的 mergePreviewSupported 隐藏，501 是直接
  // 调用方的兜底真话）。silent：失败由弹层就地降级提示，不在打开弹窗时叠
  // 拦截器全局红 toast。泛型 = 响应体形态（拦截器解包 axios response 后运行时
  // 值即 body，AutoStashResult 同款注记）
  mergePreview: (projectId: string, branch: string) =>
    api.get<{ data: MergePreviewResult }>(`/projects/${projectId}/merge-preview`, { params: { branch }, silent: true }),
  rebase: (projectId: string, branch: string, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/rebase`, { branch }, config),
  rename: (projectId: string, oldName: string, newName: string) =>
    api.post(`/projects/${projectId}/branches/rename`, { oldName, newName }),
  setUpstream: (projectId: string, branch: string, remote: string, remoteBranch: string) =>
    api.post(`/projects/${projectId}/branches/set-upstream`, { branch, remote, remoteBranch }),
}

// 远程操作
// ── 涉网端点超时矩阵（P-20261002-53）──
// axios 全局默认 30s（http.ts）只适合快端点；fetch/pull/push/ls-remote/LFS 等
// 涉网操作在大仓库/慢网络下会被前端提前掐断，而服务端 git 子进程仍在跑
// （用户误判失败重试 → 并发 git 进程 → 锁冲突/重复推送）。统一 timeout: 0
// 不设前端上限，由服务端 git_timeout 网络档兜底（gitNetworkTimeout，默认
// 900s、settings.gitNetworkTimeoutSec 可配）——服务端是唯一权威时序源；
// timeout: 0 放在展开 config 之前，调用方仍可按需覆盖。
export const remoteApi = {
  list: (projectId: string, config?: AxiosRequestConfig) => api.get(`/projects/${projectId}/remotes`, config),
  add: (projectId: string, name: string, url: string) =>
    api.post(`/projects/${projectId}/remotes`, { name, url }),
  remove: (projectId: string, name: string) =>
    api.delete(`/projects/${projectId}/remotes/${name}`),
  fetch: (projectId: string, remote?: string, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/fetch`, { remote }, { timeout: 0, ...config }),
  // 回执增量带 newCommits（P-20261003-202 结果摘要）：本次拉进来的新提交数
  //（服务端 pull 前后 HEAD rev-list 计数）；-1/旧服务端缺字段 = 无法计量
  pull: (projectId: string, remote?: string, branch?: string, config?: AxiosRequestConfig) =>
    api.post<{ data: string; newCommits?: number }>(`/projects/${projectId}/pull`, { remote, branch }, { timeout: 0, ...config }),
  push: (projectId: string, remote?: string, branch?: string, force?: boolean, forceWithLease?: boolean, tags?: boolean, followTags?: boolean, remoteBranch?: string, setUpstream?: boolean, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/push`, { remote, branch, force, forceWithLease, tags, followTags, remoteBranch, setUpstream }, { timeout: 0, ...config }),
  // remote-branch-exists 服务端走 git ls-remote --heads（涉网，需注入凭据）
  checkBranchExists: (projectId: string, remote: string, branch: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/remote-branch-exists`, { params: { remote, branch }, timeout: 0, ...config }),
  // 一键全部拉取（P-20261002-41）：全项目批量 fetch（服务端并发池逐项目调既有
  // fetch、失败隔离逐项报告）。整批耗时 = 最慢项目，同涉网矩阵 timeout: 0
  fetchAll: (config?: AxiosRequestConfig) =>
    api.post('/fetch-all', undefined, { timeout: 0, ...config }),
}

// 批量拉取单项目结果（P-20261002-41 失败隔离逐项报告；error 空 = 成功）
export interface FetchAllItem {
  projectId: string
  name: string
  ok: boolean
  error?: string
}

// Stash 创建范围三态（P-20261003-119 选择性 stash，server/git/stash.go 常量同源
// 镜像；'all' 不下发——缺省即全量，保持旧服务端兼容）
export type StashScope = 'staged' | 'unstaged'

// Stash 稳定引用（P-20261003-264）：index 是移位语义（drop 0 后原 1 变 0），
// 多标签页并发操作会错位；hash 是 stash 提交的完整 OID，不随栈位漂移。
// 列表项同时带两者：有 hash 时操作链优先传 hash，旧服务端无 hash 字段时缺省，
// 走 index 回退（渐进兼容——服务端 index 入口不删）
export interface StashRef {
  index: number
  hash?: string
}

// 寻址路径段：hash 优先，index 回退（服务端 /stashes/:ref/diff 与 /stash/:ref
// 同时接受两种形态）
function stashRefSegment(ref: StashRef): string {
  return ref.hash || String(ref.index)
}

// 请求体形态：hash 与 index 同时下发——服务端 hash 优先、index 仅作旧服务端
// 回退；hash 缺省时请求体与改造前完全一致
function stashRefBody(ref: StashRef): { index: number; hash?: string } {
  return ref.hash ? { index: ref.index, hash: ref.hash } : { index: ref.index }
}

// Stash
export const stashApi = {  list: (projectId: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/stashes`, config),
  // 查看 stash 内容 diff（P-20261002-89：stash show -p --include-untracked，服务端已截文；
  // P-20261003-264：有 hash 时按 hash 稳定寻址，index 回退保留）
  diff: (projectId: string, ref: StashRef) =>
    api.get(`/projects/${projectId}/stashes/${stashRefSegment(ref)}/diff`),
  // scope（P-20261003-119）：'staged'=仅已暂存（服务端 git 2.35+ 检测不过会以稳定
  // 标记拒绝，弹窗侧应先按 list 的 stagedSupported 禁用该档）；'unstaged'=仅未暂存；
  // 缺省=全量（现状）。axios 丢弃 undefined 字段，不带 scope 的旧调用方零变化
  create: (projectId: string, message?: string, includeUntracked?: boolean, scope?: StashScope, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/stash`, { message, includeUntracked, scope }, config),
  // config 可选透传（P-20261006-48 恢复链用 silent 自管冲突 warning 提示，
  // 不叠拦截器全局错误 toast；既有调用方零变化）
  pop: (projectId: string, ref: StashRef, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/stash/pop`, stashRefBody(ref), config),
  // 应用到新分支（P-20261003-263 实验性应用）：git stash branch——checkout -b
  // （基于 stash 原基线）+ apply 原子链，成功后新分支被检出、stash 条目按 git
  // 语义移除；分支名冲突服务端预检拒绝（稳定原文 KNOWN_ERROR_I18N 映射）。
  // P-20261003-264：hash 稳定引用随请求体下发
  applyToBranch: (projectId: string, ref: StashRef, name: string) =>
    api.post(`/projects/${projectId}/stash/branch`, { ...stashRefBody(ref), name }),
  apply: (projectId: string, ref: StashRef) =>
    api.post(`/projects/${projectId}/stash/apply`, stashRefBody(ref)),
  drop: (projectId: string, ref: StashRef) =>
    api.delete(`/projects/${projectId}/stash/${stashRefSegment(ref)}`),
}

// 标签
export const tagApi = {
  list: (projectId: string) => api.get(`/projects/${projectId}/tags`),
  create: (projectId: string, data: { name: string; commit?: string; annotated?: boolean; message?: string }) =>
    api.post(`/projects/${projectId}/tags`, data),
  delete: (projectId: string, name: string) =>
    api.delete(`/projects/${projectId}/tags`, { params: { name } }),
}

// 提交模板
export const templateApi = {
  list: () => api.get('/commit-templates'),
  create: (data: { name: string; content: string }) =>
    api.post('/commit-templates', data),
  remove: (name: string) =>
    api.delete(`/commit-templates/${name}`),
}

// Git Config
export const gitConfigApi = {
  get: (projectId: string) => api.get(`/projects/${projectId}/git-config`),
  set: (projectId: string, data: Record<string, string>) => api.put(`/projects/${projectId}/git-config`, data),
}

// 高级操作
export const advancedApi = {
  cherryPick: (projectId: string, commit: string) =>
    api.post(`/projects/${projectId}/cherry-pick`, { commit }),
  revert: (projectId: string, commit: string) =>
    api.post(`/projects/${projectId}/revert`, { commit }),
  reset: (projectId: string, mode: string, commit?: string) =>
    api.post(`/projects/${projectId}/reset`, { mode, commit }),
  squash: (projectId: string, commits: string[], message?: string) =>
    api.post(`/projects/${projectId}/squash`, { commits, message }),
  dropCommit: (projectId: string, commit: string) =>
    api.post(`/projects/${projectId}/drop-commit`, { commit }),
  extract: (projectId: string, commit: string, files: string[], message?: string) =>
    api.post(`/projects/${projectId}/extract`, { commit, files, message }),
}

// Reflog
export const reflogApi = {
  list: (projectId: string, ref?: string, limit?: number) =>
    api.get(`/projects/${projectId}/reflog`, { params: { ref, limit } }),
  getDiff: (projectId: string, hash: string) =>
    api.get(`/projects/${projectId}/reflog/${hash}/diff`),
  reset: (projectId: string, hash: string, mode?: string) =>
    api.post(`/projects/${projectId}/reflog/reset`, { hash, mode }),
}

// Clone（异步任务）
export const cloneApi = {
  start: (data: { url: string; dir: string; branch?: string; depth?: number; name?: string; sshKeyId?: string }, config?: AxiosRequestConfig) =>
    api.post<{ taskId: string }>('/clone', data, config),
  cancel: (taskId: string) => api.post(`/clone/${taskId}/cancel`),
  // 克隆前远端分支预取（P-20261003-93）：ls-remote --heads，凭据注入语义同克隆
  //（SSH 地址按 sshKeyId 精确取钥匙）。失败 502 稳定标记 remote branch prefetch
  // failed——前端 useCloneBranchPrefetch 静默捕获落行内提示，不阻断克隆
  branches: (data: { url: string; sshKeyId?: string }, config?: AxiosRequestConfig) =>
    api.post<string[]>('/clone/branches', data, config),
}

// Patch
export type PatchScope = 'worktree' | 'staged' | 'head'
export const patchApi = {
  export: (projectId: string, data: { commits?: string[]; from?: string; to?: string; staged?: boolean; confirm?: boolean }) =>
    api.post(`/projects/${projectId}/patch/export`, data),
  import: (projectId: string, data: { content: string; apply?: boolean }) =>
    api.post(`/projects/${projectId}/patch/import`, data),
  check: (projectId: string, data: { content: string }) =>
    api.post(`/projects/${projectId}/patch/check`, data),
  // 未提交变更导出 .patch 下载（P-20261003-72）：blob 直收，timeout 0（大补丁不限时）。
  // confirm（P-20261004-97）：补丁含敏感命名文件时服务端拦回 JSON {warnings}
  // 不出附件——确认后带 confirm=1 重放（terminal 导出 / dir-archive 同流出域闸）
  downloadPatch: (projectId: string, scope: PatchScope, confirm = false) =>
    api.get<Blob>(`/projects/${projectId}/patch`, {
      params: { scope, ...(confirm ? { confirm: 1 } : {}) },
      responseType: 'blob',
      timeout: 0,
    }),
}

// 批量替换（服务端执行链，P-20261004-114）+ 替换历史（P-20261004-66）
export interface ReplaceExecOptions {
  pattern: string
  replacement?: string
  glob?: string
  maxFiles?: number
  caseSensitive?: boolean
  wholeWord?: boolean
  useRegex?: boolean
  /** 敏感命中二次确认（409 files.sensitive_confirm_required 后的重试档） */
  confirmSensitive?: boolean
  /** 执行范围圈定：前端预览弹层的文件勾选清单（≤500 条，命中集收窄到该子集） */
  paths?: string[]
  /** 保留大小写（P-20261006-16）：替换输出跟随命中词形态（全小写原样 / 全大写
   *  大写化 / Title 首字母大写化，混合不猜）——与 caseSensitive 正交（匹配 vs
   *  输出），预览与执行同参透传保「所见即所得」 */
  preserveCase?: boolean
}
export interface ReplaceChangedFile { path: string; hits: number }
export interface ReplaceExecResult {
  backup?: { name: string; empty?: boolean }
  changed: ReplaceChangedFile[]
  skipped?: { path: string; reason: string }[]
  conflicts?: string[]
  totalHits: number
  truncated?: boolean
  sensitiveHits?: string[]
}
export interface ReplaceHistFile { path: string; hits: number }
export interface ReplaceHistEntry {
  id: string
  time: string
  pattern: string
  replacement?: string
  useRegex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  /** 保留大小写（P-20261006-16）：选项快照随历史留档，面板徽标同族 */
  preserveCase?: boolean
  files: number
  hits: number
  skipped?: number
  conflicts?: number
  changed?: ReplaceHistFile[]
  backupName?: string
  backupEmpty?: boolean
  patchBytes?: number
  patchTruncated?: boolean
  restorable: boolean
}
export interface ReplaceRestoreResult {
  restored: string[]
  /** 未还原的 untracked 命中文件数（>0 = 有文件的替换不在备份基线内，走单文件本地历史） */
  untracked: number
}
export const replaceApi = {
  preview: (projectId: string, data: ReplaceExecOptions) =>
    api.post(`/projects/${projectId}/replace/preview`, data),
  // execute / backups / restore：silent（错误 toast 由调用方按语义出——执行链
  // 的敏感 409 要弹确认框而非通用错误 toast，还原面板就地报错，双 toast 叠加
  // 反而糊；错误账目照常入错误中心，仅跳过全局 toast）
  execute: (projectId: string, data: ReplaceExecOptions) =>
    api.post<{ data: ReplaceExecResult }>(`/projects/${projectId}/replace`, data, { timeout: 0, silent: true }),
  backups: (projectId: string, name: string) =>
    api.get<{ data: string }>(`/projects/${projectId}/replace/backups`, { params: { name }, timeout: 0, silent: true }),
  history: (projectId: string) =>
    api.get<{ data: ReplaceHistEntry[] }>(`/projects/${projectId}/replace/history`),
  restore: (projectId: string, entryId: string) =>
    api.post<{ data: ReplaceRestoreResult }>(`/projects/${projectId}/replace/history/${encodeURIComponent(entryId)}/restore`, {}, { timeout: 0, silent: true }),
}

// .gitignore
export const gitignoreApi = {
  get: (projectId: string) => api.get(`/projects/${projectId}/gitignore`),
  update: (projectId: string, content: string) =>
    api.put(`/projects/${projectId}/gitignore`, { content }),
  addRule: (projectId: string, rule: string) =>
    api.post(`/projects/${projectId}/gitignore/rule`, { rule }),
}

// git exclude（本地排除，不修改 .gitignore）
export const gitexcludeApi = {
  addRule: (projectId: string, rule: string) =>
    api.post(`/projects/${projectId}/git-exclude/rule`, { rule }),
}

// .gitattributes
export const gitattributesApi = {
  get: (projectId: string) => api.get(`/projects/${projectId}/gitattributes`),
  update: (projectId: string, content: string) =>
    api.put(`/projects/${projectId}/gitattributes`, { content }),
  addRule: (projectId: string, rule: string) =>
    api.post(`/projects/${projectId}/gitattributes/rule`, { rule }),
}

// Submodule
export const submoduleApi = {
  list: (projectId: string) => api.get(`/projects/${projectId}/submodules`),
  add: (projectId: string, data: { url: string; path?: string; branch?: string }) =>
    api.post(`/projects/${projectId}/submodules`, data),
  // update --init --recursive 会从网络克隆/拉取子模块（涉网），同矩阵走 timeout: 0
  update: (projectId: string, data: { init?: boolean; recursive?: boolean }) =>
    api.post(`/projects/${projectId}/submodules/update`, data, { timeout: 0 }),
  remove: (projectId: string, path: string) =>
    api.delete(`/projects/${projectId}/submodules`, { data: { path } }),
}

// GPG
export const gpgApi = {
  getStatus: (projectId: string) => api.get(`/projects/${projectId}/gpg`),
  toggle: (projectId: string, enable: boolean) =>
    api.post(`/projects/${projectId}/gpg/toggle`, { enable }),
}

// LFS
export const lfsApi = {
  getStatus: (projectId: string) => api.get(`/projects/${projectId}/lfs`),
  install: (projectId: string) => api.post(`/projects/${projectId}/lfs/install`),
  track: (projectId: string, pattern: string) =>
    api.post(`/projects/${projectId}/lfs/track`, { pattern }),
  untrack: (projectId: string, pattern: string) =>
    api.post(`/projects/${projectId}/lfs/untrack`, { pattern }),
  // pull/push 传输真实对象文件（涉网，可远超 30s），同远程操作矩阵走 timeout: 0
  pull: (projectId: string) => api.post(`/projects/${projectId}/lfs/pull`, undefined, { timeout: 0 }),
  push: (projectId: string) => api.post(`/projects/${projectId}/lfs/push`, undefined, { timeout: 0 }),
}

// Hooks
export const hookApi = {
  list: (projectId: string) => api.get(`/projects/${projectId}/hooks`),
  get: (projectId: string, name: string) => api.get(`/projects/${projectId}/hooks/${name}`),
  update: (projectId: string, name: string, data: { content: string; enabled: boolean }) =>
    api.put(`/projects/${projectId}/hooks/${name}`, data),
}

// Worktree
export const worktreeApi = {
  list: (projectId: string) => api.get(`/projects/${projectId}/worktrees`),
  add: (projectId: string, data: { path: string; branch?: string; ref?: string }) =>
    api.post(`/projects/${projectId}/worktrees`, data),
  remove: (projectId: string, data: { path: string; force?: boolean }) =>
    api.delete(`/projects/${projectId}/worktrees`, { data }),
  prune: (projectId: string) => api.post(`/projects/${projectId}/worktrees/prune`),
  move: (projectId: string, oldPath: string, newPath: string) =>
    api.post(`/projects/${projectId}/worktrees/move`, { oldPath, newPath }),
  lock: (projectId: string, path: string, reason?: string) =>
    api.post(`/projects/${projectId}/worktrees/lock`, { path, reason }),
  unlock: (projectId: string, path: string) =>
    api.post(`/projects/${projectId}/worktrees/unlock`, { path }),
}

// PR
export const prApi = {
  create: (projectId: string) => api.post(`/projects/${projectId}/create-pr`),
}

// 逐块冲突分段（P-20261003-59）：GET /conflicts/parsed 扩展响应的块元素。
// base 仅 diff3/zdiff3 形态存在（P-20261004-28 起逐块可解析），双子段冲突
// 恒无 base；base 仅作参考展示（前端默认折叠），不参与逐块合成写回
export interface ConflictHunk {
  ours: string
  theirs: string
  base?: string
  startLine: number
  endLine: number
}

// 冲突解决
export const conflictApi = {
  list: (projectId: string) => api.get(`/projects/${projectId}/conflicts`),
  // content/parsed 响应增量带 hash（磁盘当前内容 sha256）：解决写回时作 baseHash
  // 乐观锁基线（P-20261004-27），旧服务端无该字段 → undefined 直写兼容
  getContent: (projectId: string, file: string) =>
    api.get(`/projects/${projectId}/conflicts/content`, { params: { file } }),
  getParsed: (projectId: string, file: string) =>
    api.get(`/projects/${projectId}/conflicts/parsed`, { params: { file } }),
  resolve: (projectId: string, file: string, strategy: string) =>
    api.post(`/projects/${projectId}/conflicts/resolve`, { file, strategy }),
  // encoding：getContent 响应带回的服务端探测原编码，解决冲突写回时原样传
  // baseHash：载入解析时的磁盘内容 hash——非空时服务端写回前比对，失配 409
  // 携 currentContent（对齐 WriteFile）；空 = 旧调用方兼容直写
  resolveWithContent: (projectId: string, file: string, content: string, encoding?: string, baseHash?: string) => {
    const body: Record<string, string> = { file, content }
    if (encoding) body.encoding = encoding
    if (baseHash) body.baseHash = baseHash
    return api.post(`/projects/${projectId}/conflicts/resolve-content`, body)
  },
}

// Interactive Rebase（P-20261003-324 提交整理：重排/squash/drop/reword 可视化编辑器）
// actions 按应用序（最老在前，与 getTodo 返回序同向）；onto 为空 = 根提交区间
export type RebaseStepAction = 'pick' | 'squash' | 'reword' | 'drop'
export interface RebaseStep {
  action: RebaseStepAction
  hash: string
  msg: string
  /** 仅 reword 合法：新提交消息（服务端无 TTY，reword 必须自带消息） */
  newMessage?: string
}
export const rebaseApi = {
  // onto 为空且未带 commit = 根提交区间；commit（「整理自此提交起」目标提交）
  // 由服务端换算基准（其父或 root），响应体附解析后的 onto
  getTodo: (projectId: string, onto: string, commit?: string) =>
    api.get<RebaseStep[]>(`/projects/${projectId}/rebase/todo`, { params: commit ? { commit } : (onto ? { onto } : {}) }),
  interactive: (projectId: string, onto: string, actions: RebaseStep[], confirmPushed = false, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/rebase/interactive`, { onto, actions, confirmPushed }, config),
  abort: (projectId: string) => api.post(`/projects/${projectId}/rebase/abort`),
  continue: (projectId: string) => api.post(`/projects/${projectId}/rebase/continue`),
}

// Changelist（P-20261007-19 UI 落地）：变更列表条目（服务端 config.Changelist 镜像；
// projectId 空 = 存量全局条目，在所有项目可见）
export interface Changelist {
  name: string
  files: string[]
  active: boolean
  projectId?: string
}
export const changelistApi = {
  // projectId 过滤为「该项目 + 存量全局」可见集；缺省返回全部（legacy 形态）
  list: (projectId?: string) => api.get('/changelists', { params: projectId ? { projectId } : {} }),
  create: (name: string, projectId?: string) => api.post('/changelists', { name, projectId }),
  remove: (name: string, projectId?: string) =>
    api.delete(`/changelists/${encodeURIComponent(name)}`, { params: projectId ? { projectId } : {} }),
  setActive: (name: string, projectId?: string) => api.put('/changelists/active', { name, projectId }),
  moveFile: (changelist: string, file: string, projectId?: string) =>
    api.put('/changelists/move-file', { changelist, file, projectId }),
}

// Shelve 搁置（组内文件未提交变更整体入 stash 条目，消息带 shelve: 标识）；
// created=false = 组内文件当前无变更、服务端未产生条目（如实回告不谎报成功）
export const shelveApi = {
  shelve: (projectId: string, files: string[], message?: string) =>
    api.post<{ created?: boolean }>(`/projects/${projectId}/shelve`, { files, message }),
}

// 目录历史
export const dirLogApi = {
  getLog: (projectId: string, path: string, limit?: number, skip?: number) =>
    api.get(`/projects/${projectId}/log/directory`, { params: { path, limit, skip } }),
}

// 版本快照浏览
export const snapshotApi = {
  // showFile：按 ref 读取文件内容（Diff 旧版本侧数据源）。
  // 注：/tree 端点是工作区目录列表（不支持 ref），快照树语义未实现，
  // 勿在此添加 listTree——需要提交树时走 commitApi 或 git log --name-only
  showFile: (projectId: string, ref: string, path: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/blob`, { params: { ref, path }, ...config }),
}

// 本地文件历史（P-20261002-130）：写路径快照（覆盖/重命名前旧内容自动留档）
// 的查询与恢复。versionId 为服务端返回的版本寻址串（UnixNano 超 JS 安全整数，
// 全程字符串，前端不拆不拼）
export const fileHistoryApi = {
  list: (projectId: string, path: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/file/history`, { params: { path }, ...config }),
  content: (projectId: string, path: string, versionId: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/file/history/content`, { params: { path, id: versionId }, ...config }),
  restore: (projectId: string, path: string, versionId: string, config?: AxiosRequestConfig) =>
    api.post(`/projects/${projectId}/file/history/restore`, { path, id: versionId }, config),
}

// 文件改动来源归因（P-20261005-170）：watcher 事件 × 会话命令窗的对账账面
// 只读查询。path 传项目相对 slash 路径 = 该路径的最近归因；不传 = 全部路径
// 最近事件（「项目刚刚发生了什么」口径）
export interface FsAttributionRef {
  terminalId: string
  sessionName: string
  command?: string
  exitCode?: number
  running?: boolean
  startedAt: string
  endedAt?: string
}

export interface FsAttributionEvent {
  at: string
  path: string
  op?: string
  source: 'command' | 'editor' | 'unattributed'
  attributions?: FsAttributionRef[]
  overlap?: boolean
}

export const fsAttributionApi = {
  list: (projectId: string, path = '', limit = 50, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/fs-attribution`, { params: path ? { path, limit } : { limit }, ...config }),
}

// 文件回收站（P-20261003-304）：删除先入站（7 天保留），列表/恢复/彻底删。
// entryId 是服务端条目目录名（含原文件名字符），拼路径段时 encodeURIComponent；
// restore 需 silent——409 目标已存在是预期分支（拦截器 KNOWN_ERROR 映射已覆盖，
// 但浮层内行级失败由调用方就地反馈更准），purge 常规拦截器提示
export interface TrashEntry {
  id: string
  path: string          // 原项目相对路径（恢复目标；degraded 条目为空串）
  name: string          // 展示名
  isDir: boolean
  size: number
  deletedAtMs: number   // unix 毫秒
  degraded?: boolean    // manifest 缺失：path 不可知，仅可彻底删除
}

export const trashApi = {
  list: (projectId: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/trash`, config),
  // asName（P-20261006-15）：重命名恢复，只换叶子名保留原父目录（服务端
  // basename 守卫，命中已存在目标照旧 409——步进建议名是调用方职责）
  restore: (projectId: string, entryId: string, config?: AxiosRequestConfig, asName?: string) =>
    api.post(
      `/projects/${projectId}/trash/${encodeURIComponent(entryId)}/restore`,
      undefined,
      asName ? { ...config, params: { ...config?.params, as: asName } } : config,
    ),
  purge: (projectId: string, entryId: string, config?: AxiosRequestConfig) =>
    api.delete(`/projects/${projectId}/trash/${encodeURIComponent(entryId)}`, config),
}

// 任务运行器：扫描项目 manifest 返回所有可用任务
export interface TaskItem {
  source: string   // npm/make/maven/gradle/go/cargo/python/just/taskfile/vscode/scripts
  name: string
  command: string
  cwd: string      // 任务所在子目录（相对项目根，"" 表示根目录）
}

export const tasksApi = {
  // 后端返回 {data: TaskItem[]}，axios 拦截器已解包外层 response.data
  list: (projectId: string) =>
    api.get<{ data: TaskItem[] }>(`/projects/${projectId}/tasks`),
}
