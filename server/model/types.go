package model

import "time"

type Project struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Path          string `json:"path"`
	CurrentBranch string `json:"currentBranch"`
	RemoteURL     string `json:"remoteURL"`
	Valid         bool   `json:"valid"`   // 路径仍然存在且可访问（目录被删/移动后为 false）
	GitRepo       bool   `json:"gitRepo"` // 是否 git 仓库（非 git 工作区是合法项目，Git 功能降级）
	Frozen        bool   `json:"frozen"`  // 项目冻结（P-20261003-9）：首页折入尾部弱化分区并跳过 ahead/behind 批量探测，功能面不变
	Locked        bool   `json:"locked"`  // 项目硬锁（P-20261004-3）：归档不可变档——写族端点 403、读面全放行
}

type FileStatus struct {
	Path    string `json:"path"`
	Status  string `json:"status"` // Modified, Added, Deleted, Untracked, Renamed, Copied
	Staged  bool   `json:"staged"`
	OldPath string `json:"oldPath,omitempty"`
}

type Commit struct {
	Hash      string    `json:"hash"`
	ShortHash string    `json:"shortHash"`
	Message   string    `json:"message"`
	Body      string    `json:"body,omitempty"` // 完整提交信息（含多行 body），用于详情展示
	Author    string    `json:"author"`
	Email     string    `json:"email"`
	Date      time.Time `json:"date"`
	Parents   []string  `json:"parents"`
	Refs      []string  `json:"refs"`
	GpgStatus string    `json:"gpgStatus"` // G=good, B=bad, U=unknown, N=no signature
}

type Branch struct {
	Name      string `json:"name"`
	IsCurrent bool   `json:"isCurrent"`
	IsRemote  bool   `json:"isRemote"`
	IsMerged  bool   `json:"isMerged"`
	Upstream  string `json:"upstream"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	// 分离头指针（detached HEAD）时为 true，Commit 字段保存短 hash
	IsDetached     bool   `json:"isDetached"`
	DetachedCommit string `json:"detachedCommit"`
}

type Tag struct {
	Name   string    `json:"name"`
	Commit string    `json:"commit"`
	Date   time.Time `json:"date"`
}

type Remote struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Type string `json:"type"` // fetch, push
}

type StashEntry struct {
	Index   int       `json:"index"`
	Message string    `json:"message"`
	Date    time.Time `json:"date"`
	// Hash stash 提交的完整 OID（P-20261003-264 稳定引用）：index 是移位语义
	//（drop 0 后原 1 变 0），跨标签页并发操作会错位；hash 不随栈位漂移，
	// 操作入口据此定位。增量字段——旧前端忽略无感
	Hash string `json:"hash"`
	// Branch 条目创建时所在分支（P-20261006-48）：git 自带 `On <branch>:` /
	// `WIP on <branch>:` reflog 前缀提取，非标形态留空；omitempty——旧前端忽略
	// 无感，恢复提示匹配端以「分支为空不命中」降级
	Branch string `json:"branch,omitempty"`
}

type DiffHunk struct {
	OldStart int    `json:"oldStart"`
	OldLines int    `json:"oldLines"`
	NewStart int    `json:"newStart"`
	NewLines int    `json:"newLines"`
	Content  string `json:"content"`
}

type FileDiff struct {
	Path    string     `json:"path"`
	OldPath string     `json:"oldPath,omitempty"`
	Status  string     `json:"status"`
	Hunks   []DiffHunk `json:"hunks"`
}

type BlameLine struct {
	LineNo  int       `json:"lineNo"`
	Hash    string    `json:"hash"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
	Summary string    `json:"summary"`
	Content string    `json:"content"`
}

// API请求结构体

type AddProjectRequest struct {
	Name string `json:"name" binding:"required"`
	Path string `json:"path" binding:"required"`
}

// RelocateProjectRequest 项目重新定位请求：项目 ID/名称不变，仅更新 path
type RelocateProjectRequest struct {
	Path string `json:"path" binding:"required"`
}

// SetProjectFrozenRequest 项目冻结/解冻请求（P-20261003-9）：布尔开关，其余配置不动
type SetProjectFrozenRequest struct {
	Frozen bool `json:"frozen"`
}

// SetProjectLockedRequest 项目硬锁锁定/解锁请求（P-20261004-3）：布尔开关，
// 其余配置不动；双向审计（project.lock / project.unlock）
type SetProjectLockedRequest struct {
	Locked bool `json:"locked"`
}

type CommitRequest struct {
	Message string   `json:"message" binding:"required"`
	Files   []string `json:"files"`
	Amend   bool     `json:"amend"`
	Signoff bool     `json:"signoff"`
	Author  string   `json:"author"`
}

type StageRequest struct {
	Files []string `json:"files" binding:"required"`
	// Ref 回滚基准（P-20261008-11 文件历史聚合时间线的 git 条目恢复）：可选增量
	// 字段，缺省/空 = HEAD（既有整文件回滚语义不变）；非空 = 检出该提交的文件
	// 版本进工作区。形态校验在 git.Rollback（拒绝 flag 形态/空白），ref 不存在
	// 由 git 自身报错走 respondGitError
	Ref string `json:"ref,omitempty"`
}

type CreateBranchRequest struct {
	Name     string `json:"name" binding:"required"`
	Checkout bool   `json:"checkout"`
}

type CheckoutRequest struct {
	Branch string `json:"branch" binding:"required"`
	// AutoStash 脏工作区自动暂存恢复链（P-20261003-203）：true 时服务端一次
	// 完成 stash → checkout → stash pop（失败路径与安全语义见
	// git.CheckoutWithAutoStash）。增量可选字段，缺省 false 走原 checkout，
	// 旧客户端不受影响
	AutoStash bool `json:"autoStash"`
}

type MergeRequest struct {
	Source string `json:"source" binding:"required"`
	// Strategy 合并策略（P-20261007-18）：""=默认合并（缺省=历史语义，旧调用方
	// 不带字段零变化）；"squash"=压平合并（--squash + 单条汇总提交）。服务端
	// 白名单枚举校验，非法 400
	Strategy string `json:"strategy"`
	// Message squash 汇总提交消息：空 = 服务端自动生成默认消息
	//「(<source>) N commits: 首末提交标题」；仅 strategy=squash 时消费
	Message string `json:"message"`
}

type RebaseRequest struct {
	Branch string `json:"branch" binding:"required"`
}

type PushRequest struct {
	Remote         string `json:"remote"`
	Branch         string `json:"branch"`
	RemoteBranch   string `json:"remoteBranch"` // 远程分支名，默认等于 Branch
	SetUpstream    bool   `json:"setUpstream"`  // 是否 --set-upstream
	Force          bool   `json:"force"`
	ForceWithLease bool   `json:"forceWithLease"`
	Tags           bool   `json:"tags"`
	FollowTags     bool   `json:"followTags"`
}

type PullRequest struct {
	Remote string `json:"remote"`
	Branch string `json:"branch"`
}

type FetchRequest struct {
	Remote string `json:"remote"`
}

type StashRequest struct {
	Message          string `json:"message"`
	IncludeUntracked bool   `json:"includeUntracked"`
	// Scope 创建范围三态（P-20261003-119 选择性 stash）："all"（缺省 = 旧调用方
	// 不带字段的现状全量语义）/ "staged"（仅已暂存，需 git 2.35+，版本不足服务端
	// 降级拒绝）/ "unstaged"（仅未暂存，工作区保留已暂存部分）
	Scope string `json:"scope"`
}

type StashApplyRequest struct {
	Index int `json:"index"`
	// Hash 稳定引用（P-20261003-264）：非空时优先于 Index，服务端按当前
	// stash 栈解析为栈位后执行；已 drop/pop 的旧 hash 明确拒绝不错位。
	// 增量可选字段，旧调用方不带 hash 走原 index 语义零变化
	Hash string `json:"hash"`
}

// StashBranchRequest stash 应用到新分支（P-20261003-263 实验性应用）：
// Name 校验走 gitops.validateRefName（与建分支/改名同规则），分支冲突拒绝在
// git.StashBranch 预检
type StashBranchRequest struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	// Hash 稳定引用（P-20261003-264）：语义同 StashApplyRequest.Hash——
	// 非空时优先，index 保留渐进兼容
	Hash string `json:"hash"`
}

type CreateTagRequest struct {
	Name      string `json:"name" binding:"required"`
	Commit    string `json:"commit"`
	Annotated bool   `json:"annotated"`
	Message   string `json:"message"`
}

type CherryPickRequest struct {
	Commit string `json:"commit" binding:"required"`
}

type RevertRequest struct {
	Commit string `json:"commit" binding:"required"`
}

type ResetRequest struct {
	Mode   string `json:"mode"` // soft, mixed, hard
	Commit string `json:"commit"`
}

// WebSocket消息
type WSMessage struct {
	Type string      `json:"type"` // file.changed, branch.changed, commit.added, operation.progress, git.command
	Data interface{} `json:"data"`
}

// CommandLog 是单条 git 命令执行记录，通过 WS git.command 消息推送到前端命令标签
// 字段与前端 web/src/stores/console.ts 的 CommandLog 接口对齐
type CommandLog struct {
	Command   string `json:"command"` // 固定 "git"
	Args      string `json:"args"`    // 空格连接的参数
	Output    string `json:"output"`  // stdout 完整内容，不截断
	Error     string `json:"error"`   // stderr 完整内容，不截断
	WorkDir   string `json:"workDir"`
	Timestamp string `json:"timestamp"` // RFC3339
}

// 更新相关类型

// CheckUpdateResponse 检查更新响应
type CheckUpdateResponse struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	HasUpdate      bool   `json:"hasUpdate"`
	Changelog      string `json:"changelog"`
	DownloadURL    string `json:"downloadUrl"`
	FileSize       int64  `json:"fileSize"`
	// 检查失败细分（beta.2 误报实锚：此前一切检查错误吞成 hasUpdate:false，
	// 前端再依「分发源字段为空」猜成「未配置更新源」——而自更新源已内置，
	// 真缺源仅剩「配置的非法分发源被拒」一途）。零值省略，成功路径零负担
	SourceMissing bool `json:"sourceMissing,omitempty"`
	// ChannelEmpty 当前通道无版本可查（stable=/releases/latest 恒排 prerelease，
	// 仓库只有 beta/rc 时 404）——提示用户开预发布通道跟进
	ChannelEmpty bool `json:"channelEmpty,omitempty"`
	// CheckError 其余检查失败原文（网络/DNS/限流等），前端如实呈现不再吞
	CheckError string `json:"checkError,omitempty"`
	// CompanionFetchFailed 有可用更新，但伴随校验资产（.sha256/.sig）在 release
	// 里却没取到，且已注定过不了校验——此刻点更新会被拒（P-20261109-9，旧口径
	// 吞错后误报「release 没提供」）。只在「真会被拒」时置位（与 ApplyUpdate
	// 下载前拒绝同源判定 update.CompanionPreflight）；面板据此即时提示、更新
	// 按钮保持可点（点击会 skipCache 重拉一次）。CompanionFetchError 为逐资产
	// 拉取失败原因
	CompanionFetchFailed bool   `json:"companionFetchFailed,omitempty"`
	CompanionFetchError  string `json:"companionFetchError,omitempty"`
}

// UpdateStatusResponse 更新状态响应
type UpdateStatusResponse struct {
	Status      string `json:"status"`
	Progress    int64  `json:"progress"`
	Total       int64  `json:"total"`
	Version     string `json:"version"`
	Error       string `json:"error"`
	Result      string `json:"result,omitempty"` // success/failed/rolled_back
	ResultError string `json:"resultError,omitempty"`
	// ResultAt 结果文件落盘时刻（RFC3339 UTC，P-20261109-10）：版本面板「上次
	// 更新」块回显时间，零值省略
	ResultAt string `json:"resultAt,omitempty"`
}

// LockConfig 锁定机制配置，持久化到 docstore 集合 "lock" 的 "config" 文档
type LockConfig struct {
	Enabled         bool   `json:"enabled"`         // 锁定功能开关，默认 true
	AutoLockEnabled bool   `json:"autoLockEnabled"` // 自动锁定开关，默认 true
	AutoLockMinutes int    `json:"autoLockMinutes"` // 自动锁定时长（分钟），默认 120
	TokenTTLMinutes int    `json:"tokenTTLMinutes"` // token 滑动过期时长（分钟），默认 120
	PasswordHash    string `json:"passwordHash"`    // bcrypt 哈希
}

// LockPublicState 对外公开的锁定状态（不含密码哈希）
type LockPublicState struct {
	Enabled           bool `json:"enabled"`
	AutoLockEnabled   bool `json:"autoLockEnabled"`
	AutoLockMinutes   int  `json:"autoLockMinutes"`
	TokenTTLMinutes   int  `json:"tokenTTLMinutes"`
	IsDefaultPassword bool `json:"isDefaultPassword"` // 对非 localhost 请求不返回
}
