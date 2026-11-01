// 远程主机域 API：主机凭据、远程终端、诊断、远程命令执行
import type { AxiosRequestConfig } from 'axios'
import api, { getCurrentInstanceContext } from '../http'

// 远程主机认证方式
export type RemoteHostAuthType = 'password' | 'sshkey' | 'pem'

// 远程主机凭据
export interface RemoteHost {
  id: string
  name: string
  host: string
  port: number
  user: string
  authType: RemoteHostAuthType
  /** sftp（默认，终端/部署/文件管理全能力）| ftp（仅文件管理，明文协议） */
  protocol?: 'sftp' | 'ftp'
  password?: string
  sshKeyId?: string
  pemContent?: string
  fingerprint?: string
  /** per-host 关闭 SSH 主机密钥 TOFU 校验（内网完全信任场景，默认开启校验） */
  hostKeyVerifyDisabled?: boolean
  createdAt: string
  updatedAt: string
}

// SSH 主机密钥钉扎状态（TOFU 指纹，P-20261003-34）
export interface RemoteHostKeyPin {
  pinned: boolean
  fingerprint?: string
  algo?: string
}

export const remoteHostApi = {
  // config：部署失败通知「交给智能体修复」（P-20261003-289）按 hostId 尽力
  // 解析主机名走 silent——名称只是展示增强，失败降级裸地址不弹错误 toast
  list: (config?: AxiosRequestConfig) => api.get<{ data: RemoteHost[] }>('/remotehosts', config),
  create: (data: {
    name: string
    host: string
    port: number
    user: string
    authType: RemoteHostAuthType
    protocol?: 'sftp' | 'ftp'
    password?: string
    sshKeyId?: string
    pemContent?: string
    hostKeyVerifyDisabled?: boolean
  }) => api.post<{ data: RemoteHost }>('/remotehosts', data),
  update: (id: string, data: Partial<{
    name: string
    host: string
    port: number
    user: string
    authType: RemoteHostAuthType
    protocol: 'sftp' | 'ftp'
    password: string
    sshKeyId: string
    pemContent: string
    hostKeyVerifyDisabled?: boolean
  }>) => api.put<{ data: RemoteHost }>(`/remotehosts/${id}`, data),
  remove: (id: string) => api.delete(`/remotehosts/${id}`),
  // 复制主机（XShell 式复制/粘贴会话）：服务端完成凭据复制，返回新主机（无敏感明文）
  duplicate: (id: string, name?: string) =>
    api.post<{ data: RemoteHost }>(`/remotehosts/${id}/duplicate`, { name }),
  // 导出全部主机：POST 口令生成加密信封（主机凭据 + 被引用的 SSH 私钥整体加密，文件内无明文）；
  // blob 由调用方触发保存。口令遗失无法恢复，调用方需明确提示
  exportAll: (passphrase: string) =>
    api.post('/remotehosts/export', { passphrase }, { responseType: 'blob', timeout: 0 }),
  // 导入主机：file 为口令加密信封（附 passphrase）或旧版明文数组（向后兼容）；
  // ID 重建、凭据重新加密落盘、SSH 私钥按指纹去重并重映射 sshKeyId
  importAll: (file: unknown, passphrase?: string) =>
    api.post<{ data: { imported: number; legacy?: boolean; failed: { name: string; error: string }[] } }>(
      '/remotehosts/import', { file, passphrase }, { timeout: 0 }),
  test: (id: string) => api.post(`/remotehosts/${id}/test`),
  // SSH 主机密钥钉扎（TOFU）：查看当前指纹 + 重置（合法迁移场景重新首录，
  // 重置动作入审计与通知中心）
  hostKey: (id: string, config?: AxiosRequestConfig) =>
    api.get<{ data: RemoteHostKeyPin }>(`/remotehosts/${id}/hostkey`, config),
  resetHostKey: (id: string) =>
    api.post<{ data: { pinned: boolean } }>(`/remotehosts/${id}/hostkey/reset`),
  // 未保存表单参数直测连通性（新增/编辑弹窗「测试连接」按钮）：
  // id = 编辑目标主机，凭据留空时服务端按「保持原值」回填已存凭据（与保存语义一致）；
  // 拦截器直接返回 body = { ok, whoami, os, arch, error }，凭据错误等业务失败不抛错
  testParams: (payload: {
    id?: string
    host: string
    port: number
    user: string
    protocol?: string
    authType?: string
    password?: string
    sshKeyId?: string | null
    pemContent?: string
  }, config?: AxiosRequestConfig) =>
    api.post<{ ok: boolean; whoami?: string; os?: string; arch?: string; error?: string }>(
      '/remotehosts/test', payload, config),
  // 在线状态批量查询（TCP 端口级探测，服务端 30s 周期缓存）
  status: (config?: AxiosRequestConfig) =>
    api.get<{ data: Record<string, { state: string; lastCheck?: number; latencyMs?: number }> }>(
      '/remotehosts/status', config),
  // 远程主机终端会话（/remote 控制台用）
  listTerminals: (id: string, config?: AxiosRequestConfig) =>
    api.get<{ data: { id: string; hostId: string; rows: number; cols: number; createdAt: string }[] }>(
      `/remotehosts/${id}/terminals`, config),
  // 跨主机聚合列全部远程终端会话（P-20261005-11）：广播 popover「远程主机」
  // 分组取数原语——一次请求替代逐主机 N 查询；host 为别名（未命名回落 hostId）
  listAllTerminals: (config?: AxiosRequestConfig) =>
    api.get<{ data: RemoteTerminalSessionRef[] }>('/remotehosts/terminals', config),
  // tmuxName：重开场景回传既有 tmux 会话名（服务端 terminalRemoteTmux 开启时 attach-or-create）；
  // silent：拦截器已弹 toast，调用方本地再弹会双提示
  createTerminal: (
    id: string, rows: number, cols: number,
    opts?: { config?: AxiosRequestConfig; tmuxName?: string },
  ) =>
    api.post<{ data: { sessionId: string; hostId: string; rows: number; cols: number; createdAt: string; tmuxName?: string } }>(
      `/remotehosts/${id}/terminals`,
      { rows, cols, ...(opts?.tmuxName ? { tmuxName: opts.tmuxName } : {}) },
      opts?.config,
    ),
  closeTerminal: (id: string, sessionId: string) =>
    api.delete(`/remotehosts/${id}/terminals/${sessionId}`),
  resizeTerminal: (id: string, sessionId: string, rows: number, cols: number, config?: AxiosRequestConfig) =>
    api.put(`/remotehosts/${id}/terminals/${sessionId}/resize`, { rows, cols }, config),
  // 权威重绘（远端 tmux refresh-client；原生 shell 会话服务端 no-op）。
  // 失败恒 200 + ok:false，重绘属自愈增强不弹错
  redrawTerminal: (id: string, sessionId: string, config?: AxiosRequestConfig) =>
    api.put<{ data: { ok: boolean; noop?: boolean; error?: string } }>(
      `/remotehosts/${id}/terminals/${sessionId}/redraw`, undefined, config),
  // 远程终端输出历史（P-20261005-210 会话输出对比的远程侧取数）：裸 octet-stream
  // 与项目终端 scrollback 端点同构（含 ANSI），剥 ANSI 由调用方客户端处理
  //（utils stripAnsiText 同源）——远程侧无服务端 ExportText，快照取数走此原语
  terminalScrollback: (id: string, sessionId: string, config?: AxiosRequestConfig) =>
    api.get<ArrayBuffer>(`/remotehosts/${id}/terminals/${sessionId}/scrollback`, {
      responseType: 'arraybuffer', ...config,
    }),
  // 粘贴图片 SFTP 上传远程 /tmp，返回远程路径文本（贴入终端供 CLI 读取）
  uploadPasteImage: (id: string, blob: Blob) => {
    const form = new FormData()
    form.append('image', blob)
    return api.post<{ data: { path: string; size: number } }>(`/remotehosts/${id}/paste-image`, form)
  },
  // 粘贴文件 SFTP 上传远程 /tmp（P-20261024-2）：paste 事件捕获的 OS 复制文件
  //（扩展名白名单/20MB 上限由服务端判定），与截图形态同端点、按 multipart 字段分派
  uploadPasteFile: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.post<{ data: { path: string; size: number } }>(`/remotehosts/${id}/paste-image`, form)
  },
  // ============== 文件管理（SFTP） ==============
  files: {
    list: (id: string, path: string, config?: AxiosRequestConfig) =>
      api.get<{ data: { path: string; entries: RemoteDirEntry[] } }>(
        `/remotehosts/${id}/files/list`, { params: { path }, ...config }),
    // 编辑器读（VS Code Remote 式，P-20261003-15）：文本全文 + 内容 hash
    // （保存冲突检测基线）+ 探测编码标签；二进制 415 / 超大 413 /
    // 主机不可达 502。silent：二进制/超大走元信息卡是预期分支，不弹错误 toast
    content: (id: string, path: string, config?: AxiosRequestConfig) =>
      api.get<{ data: string; path: string; hash?: string; encoding?: string }>(
        `/remotehosts/${id}/files/content`, { params: { path }, ...config }),
    // 编辑器保存回写：content 为 UTF-8 文本 base64；baseHash 非空 = 冲突检测
    // （远端已变 409）；encoding = 打开时探测的原编码回写。silent 语义同上
    writeContent: (
      id: string, path: string, contentB64: string,
      opts?: { baseHash?: string; encoding?: string; config?: AxiosRequestConfig },
    ) =>
      api.put<{ message: string; hash: string }>(
        `/remotehosts/${id}/files/content`,
        {
          path,
          content: contentB64,
          ...(opts?.encoding ? { encoding: opts.encoding } : {}),
          ...(opts?.baseHash ? { baseHash: opts.baseHash } : {}),
        },
        opts?.config),
    // blob 下载（调用方负责触发保存）；大文件关闭 axios 超时
    download: (id: string, path: string) =>
      api.get<Blob>(`/remotehosts/${id}/files/download`, {
        params: { path }, responseType: 'blob', timeout: 0,
      }),
    // 归档 zip 下载（目录/多选通用；服务端流式打包，不落盘）
    downloadArchive: (id: string, paths: string[]) =>
      api.get<Blob>(
        `/remotehosts/${id}/files/archive?${paths.map(p => `paths=${encodeURIComponent(p)}`).join('&')}`,
        { responseType: 'blob', timeout: 0 }),
    // 批量上传（一次拨号传完，单文件也是 N=1；部分失败以 failed 回报）
    uploadMany: (id: string, dir: string, files: File[]) => {
      const form = new FormData()
      form.append('path', dir)
      for (const f of files) form.append('files', f)
      return api.post<{ data: { saved: { name: string; path: string; size: number }[]; failed: { name: string; error: string }[] } }>(
        `/remotehosts/${id}/files/upload`, form, { timeout: 0 })
    },
    mkdir: (id: string, path: string) =>
      api.post(`/remotehosts/${id}/files/mkdir`, { path }),
    rename: (id: string, from: string, to: string) =>
      api.post(`/remotehosts/${id}/files/rename`, { from, to }),
    remove: (id: string, paths: string[]) =>
      api.post<{ data: { deleted: string[]; failed: { path: string; error: string }[] } }>(
        `/remotehosts/${id}/files/delete`, { paths }, { timeout: 0 }),
    transfer: (id: string, paths: string[], targetHostIds: string[], targetDir?: string) =>
      api.post<{ data: { results: { hostId: string; ok: boolean; files?: number; error?: string }[] } }>(
        `/remotehosts/${id}/files/transfer`,
        { paths, targetHostIds, targetDir }, { timeout: 0 }),
  },
}

// SSH 本地转发隧道条目（P-20261004-5）：远端回环端口 → 实例本机临时口
export interface RemoteTunnel {
  hostId: string
  remotePort: number
  localPort: number
  createdAt: string
  lastActive: string
}

// 隧道三端点：预览面板联动（preview.port 带 hostId 时前端开隧道拿映射口）
// 与 agent 自助开隧道（手册 remote 节）共用。同 (host, remotePort) 服务端
// 幂等复用——重试/重复上报不重复占口；上限命中返回 409
export const tunnelApi = {
  open: (id: string, remotePort: number, config?: AxiosRequestConfig) =>
    api.post<{ data: RemoteTunnel }>(`/remotehosts/${id}/tunnels`, { remotePort }, config),
  list: (id: string, config?: AxiosRequestConfig) =>
    api.get<{ data: RemoteTunnel[] }>(`/remotehosts/${id}/tunnels`, config),
  close: (id: string, localPort: number) =>
    api.delete(`/remotehosts/${id}/tunnels/${localPort}`),
}

// 远程目录项（SFTP ReadDir）
export interface RemoteDirEntry {
  name: string
  size: number
  mode: string
  isDir: boolean
  mtime: number
}

// 跨主机聚合的远程终端会话引用（GET /remotehosts/terminals 列表项，
// P-20261005-11）：id 直投 broadcast-write ids；host 为展示别名
export interface RemoteTerminalSessionRef {
  id: string
  hostId: string
  host: string
  createdAt: string
}

// 远程终端 WS 地址：裸字节双向 relay，:id 为 sessionId（hostId 创建时已绑定）。
// 远程实例上下文走 /ws/proxy 通用转发（与 /ws/terminal 同机制）
export const getRemoteTerminalWsUrl = (sessionId: string) => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const { instanceId, isRemote } = getCurrentInstanceContext()
  if (isRemote && instanceId) {
    return `${proto}//${location.host}/ws/proxy/${instanceId}/remote-terminal/${sessionId}`
  }
  return `${proto}//${location.host}/ws/remote-terminal/${sessionId}`
}

// 远程主机诊断
export interface DiagItem {
  key: string
  label: string
  output: string
  exitCode: number
  error?: string
}

// 诊断快照摘要：服务端从诊断输出提取的结构化数值（全文报告不落盘）。
// 字段缺省 = 该项未采集到，消费方按「无数据」隐藏而非当 0 展示
export interface DiagSnapshot {
  time?: string
  diskAvailMB?: number
  diskTotalMB?: number
  memUsedMB?: number
  load1?: number
  load5?: number
  load15?: number
  failedServices?: number
  cpuPercent?: number
}

// 三指标差值（cur-prev）：磁盘比可用 / 内存比用量 / 负载比 1 分钟
export interface DiagDelta {
  diskAvailMB: number
  memUsedMB: number
  load1: number
}

// 与上一次诊断的对比（服务端内联下发，前端免二次请求）
export interface DiagCompare {
  prev: DiagSnapshot
  delta: DiagDelta
}

export interface DiagnoseResult {
  ok: boolean
  durationMs: number
  items: DiagItem[]
  error?: string
  compare?: DiagCompare
}

// 列表悬停用的单主机最近诊断趋势摘要（最近一次值 + 与再上一次的差值）
export interface DiagHistSummary {
  lastTime?: string
  prevTime?: string
  runs: number
  diskAvailMB?: number
  diskAvailDeltaMB?: number
  memUsedMB?: number
  memUsedDeltaMB?: number
  load1?: number
  load1Delta?: number
}

export const diagnoseApi = {
  // 后端无 data 包装（响应体即 DiagnoseResult 本体）——断言为直出类型，调用侧免 any
  run: (hostId: string) =>
    api.post<DiagnoseResult>(`/remotehosts/${hostId}/diagnose`, undefined, { timeout: 90_000 }) as unknown as Promise<DiagnoseResult>,
}

// ============== 批量诊断与横向对比（P-20261004-58） ==============

// 单台主机的批量诊断结果：只带结构化摘要、不带全文命令输出（全文是单主机
// 诊断弹窗的职责，横向对比只需要数值面）；snapshot 缺省 = 未采集（按无数据
// 呈现，不当 0），error 非空 = 该台结构化降级（FTP/凭据/拨号/未找到）
export interface DiagBatchResult {
  hostId: string
  name: string
  ok: boolean
  durationMs: number
  error?: string
  snapshot?: DiagSnapshot
}

export interface DiagBatchResponse {
  /** 与请求 ids 同序（并行完成序不稳定，服务端按请求位回填） */
  results: DiagBatchResult[]
  /** 整批墙钟耗时（并行扇出） */
  durationMs: number
}

export const diagnoseBatchApi = {
  // 多主机并行扇出单主机只读命令集（服务端并发限流）。逐台失败是结构化
  // 200 响应由对比表呈现，不走拦截器错误 toast（silent）；扇出耗时与主机数
  // 正相关，关闭 axios 超时（服务端有单台 60s 上限 + ids≤50 批量上限兜底）
  run: (hostIds: string[], config?: AxiosRequestConfig) =>
    api.post<{ data: DiagBatchResponse }>('/remotehosts/diagnose-batch', { ids: hostIds }, {
      timeout: 0,
      silent: true,
      ...config,
    }),
}

export const diagHistApi = {
  // 各主机最近诊断趋势摘要（远程主机列表悬停展示）；silent：锁定态窗口不弹 toast
  summary: (config?: AxiosRequestConfig) =>
    api.get<{ data: Record<string, DiagHistSummary> }>('/remotehosts/diaghist', config),
}

// 远程命令执行结果
export interface RemoteExecResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

export const remoteExecApi = {
  // 后端无 data 包装（响应体即 RemoteExecResult 本体）——断言为直出类型，调用侧免 any
  run: (hostId: string, cmd: string) =>
    api.post<RemoteExecResult>(`/remotehosts/${hostId}/exec`, { cmd }, { timeout: 90_000 }) as unknown as Promise<RemoteExecResult>,
}

// ============== 本地-远端同项目 Git 对照（P-20261004-34） ==============

// 对照单侧（本地/远端同构）：head 为完整 40 位哈希；available=false 时看
// unavailableReason（稳定枚举，前端 i18n 映射）+ unavailableDetail（底层原文，排障用）
export interface GitCompareSide {
  available: boolean
  head?: string
  branch?: string
  dirtyCount: number
  unavailableReason?: 'notGitRepo' | 'pathMissing' | 'gitMissing' | 'unreachable' | 'timeout' | 'error'
  unavailableDetail?: string
}

// 两端 HEAD 先后关系（服务端在本地仓库做 ancestry 推算）：
// unknown = 远端 HEAD 对象本地不可见（远端有本地未 fetch 的提交），需先 fetch 才能判定
export interface GitCompareBehind {
  relation: 'same' | 'remoteBehind' | 'remoteAhead' | 'diverged' | 'unknown'
  remoteBehindCount?: number
  localBehindCount?: number
}

export interface GitCompareResult {
  local: GitCompareSide
  remote: GitCompareSide
  behind?: GitCompareBehind
  remotePath: string
  pathRemembered: boolean
  durationMs: number
  error?: string
}

export const gitCompareApi = {
  // 对照（只读单往返）：remotePath 缺省时服务端回填 host+project 维度的持久
  // 记忆（响应 pathRemembered=true 标明）。silent：降级形态（远端不可达等）
  // 是结构化 200 响应由卡片呈现，不走拦截器错误 toast；20s SSH 超时之上放宽
  compare: (hostId: string, projectId: string, remotePath?: string, config?: AxiosRequestConfig) =>
    api.get<{ data: GitCompareResult }>(`/remotehosts/${hostId}/git-compare`, {
      params: { projectId, ...(remotePath ? { remotePath } : {}) },
      timeout: 60_000,
      silent: true,
      ...config,
    }),
  // 记忆/清除远端路径（remotePath 空 = 清除）；GET 对照纯读不落盘，写走此口
  savePath: (hostId: string, projectId: string, remotePath: string) =>
    api.put<{ data: { ok: boolean; remembered: boolean } }>(`/remotehosts/${hostId}/git-compare-path`, {
      projectId,
      remotePath,
    }),
}
