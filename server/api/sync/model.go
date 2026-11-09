package sync

import (
	"fmt"
	"strings"
)

// 同步单元模型（P-20261023-1 具体方案①）。
//
// 单元 = 项目本体（project）+ 可选上下文包。跨实例稳定键 UnitKey：
//   - 项目本体：project:<rootBasename>（两端各自注册的项目 ID 是本机 uuid，
//     不跨实例稳定；目录基名是用户可直接对上的自然标识，同名冲突即不同单元）
//   - 项目上下文：<kind>:<rootBasename>（sessions/crons；notes/notes-multi
//     已随 P-20261108-3 笔记单库化退役，见 IsRetiredKind）
//   - 全局单元：snippets / runtimes / approvals / chains（不挂项目）
//
// 指纹 = 单元内全部文件（规范化正斜杠相对路径 + size）排序后 sha256——
// 跨平台稳定（分隔符归一；不取 mtime，跨平台漂移见风险注记）。内容 hash
// 慢档留作后续独立件（首版 size+路径档，同 size 同路径不同内容的窗口可忽略：
// 同步场景的目标是「搬运到一致」，不是内容寻址存储）。

// 单元 kind 词汇（API 面稳定值，旧对端未知 kind 忽略——既有口径）
const (
	UnitProject   = "project"   // 项目本体（目录树；含 .git 与否由 mode 决定）
	UnitSessions  = "sessions"  // agent 会话记录与策展（claude transcripts + 策展）
	UnitCrons     = "crons"     // 项目域定时任务（agentcron，Dir 在项目内）
	UnitSnippets  = "snippets"  // 代码/命令片段（global scope；host 域不入）
	UnitRuntimes  = "runtimes"  // 自定义智能体运行时注册（settings 域）
	UnitApprovals = "approvals" // 审批规则表（settings 域，整体替换语义）
	UnitChains    = "chains"    // 会话接续链定义
	UnitUIState   = "uistate"   // 前端 UI 偏好（书签/树展开/组等，Merge 语义）

	// UnitDeliver 非项目目录/文件轻投递（文件树右键「同步到其他实例」）：
	// 不注册项目，对端按显式 dest 纯落位
	UnitDeliver = "deliver"

	// UnitCredentials 手动携密同步的凭据档单元（P-20261024-3）。**刻意不进**
	// unitContexts / 默认 manifest / plan 四态 / 定时同步词表——凭据档只在
	// 用户手动勾选（ExecuteRequest.IncludeCredentials）时经专用 E2E 通道搬运，
	// 任何枚举面/自动化面构造性排除（红线守卫见 execute.go credGuard）
	UnitCredentials = "credentials"
)

// 退役单元 kind（P-20261108-3 笔记单库化）：notes（项目笔记默认篇）与
// notes-multi（项目多篇笔记库）随项目作用域笔记整链退役——笔记改为项目无关的
// 全局笔记库，**不再随实例同步**（跨实例全局库车道明示放弃，用户经导出人工
// 搬运）。kind 词汇保留只为识别旧对端的回流：
//   - 本端 manifest 不再产出、resolveUnitPayloads 拒绝打包；
//   - 落位侧 landOneUnit 显式拒收（旧对端推来的笔记单元经旧 landNotes 链会直写
//     项目作用域键——新实例 UI 恒全局库看不见 = 静默半态，P-20261107-2a 复审#4
//     「静默分叉」同类，故拒收并回告错误让对端结果卡标红）；
//   - plan 遇旧对端 manifest 携带的笔记单元标 PlanRetired（不可勾选、对账红点），
//     执行请求显式点名的退役单元逐个记失败（结果卡红点 + 单元行错误文案），
//     不发起传输
const (
	UnitNotes      = "notes"
	UnitNotesMulti = "notes-multi"
)

// retiredNotesUnitError 退役笔记单元的统一回告（落位拒收/打包拒绝/执行跳过三面
// 同一文案——对端结果卡与本端单元行可直接对上；英文语言中立稳定串）
const retiredNotesUnitError = "notes units are retired (P-20261108-3): notes live in the global notes library and no longer sync between instances"

// IsRetiredKind 单元 kind 是否已退役（笔记单库化）
func IsRetiredKind(kind string) bool {
	return kind == UnitNotes || kind == UnitNotesMulti
}

// isRetiredUnitKey 单元键是否指向退役 kind
func isRetiredUnitKey(key string) bool {
	kind, _ := ParseUnitKey(key)
	return IsRetiredKind(kind)
}

// unitContexts 项目上下文 kind 集（plan/manifest 上下文包勾选的词表）。
// 笔记单元已退役（P-20261108-3，见上方退役注记），不在词表内
var unitContexts = []string{UnitSessions, UnitCrons, UnitUIState}

// IsContextKind 单元 kind 是否项目上下文包
func IsContextKind(kind string) bool {
	for _, k := range unitContexts {
		if k == kind {
			return true
		}
	}
	return false
}

// ContextKinds 项目上下文 kind 词表（前端勾选面）
func ContextKinds() []string { return append([]string(nil), unitContexts...) }

// UnitKey 项目域单元键构造（rootBasename = 项目根目录基名）
func UnitKey(kind, rootBasename string) string {
	return kind + ":" + rootBasename
}

// ParseUnitKey 拆解单元键 → (kind, rootBasename)。全局单元无冒号段，
// 返回 (kind, "")
func ParseUnitKey(key string) (string, string) {
	if i := strings.IndexByte(key, ':'); i >= 0 {
		return key[:i], key[i+1:]
	}
	return key, ""
}

// ProjectKeyOf 上下文单元所属项目单元键（全局单元/项目本体返回 ""）
func ProjectKeyOf(unitKey string) string {
	kind, base := ParseUnitKey(unitKey)
	if base == "" || kind == UnitProject || kind == UnitDeliver {
		return ""
	}
	return UnitKey(UnitProject, base)
}

// 单元聚合条目（manifest/plan 的公共形状）
type UnitEntry struct {
	Key string `json:"key"` // 跨实例稳定单元键
	// Kind 单元 kind（project/sessions/crons/snippets/runtimes/approvals/chains/uistate/deliver；
	// 旧对端 manifest 可能仍带已退役的 notes/notes-multi）
	Kind string `json:"kind"`
	// ProjectKey 所属项目单元键（上下文单元携带；全局单元空）
	ProjectKey string `json:"projectKey,omitempty"`
	// Name 展示名（项目名/单元名）
	Name string `json:"name"`
	// Fingerprint 聚合指纹（sha256 hex；内容单元为空串=无内容）
	Fingerprint string `json:"fingerprint"`
	// Size 总字节（文件内容或 JSON 载荷）
	Size int64 `json:"size"`
	// Files 文件数（JSON 单元 0/1）
	Files int `json:"files"`
	// Path 本端绝对路径（仅 manifest 消费方与登记方同机时有意义——本端
	// manifest 面板展示用；入 plan 对账只认 Key/Fingerprint。对端 manifest
	// 的 Path 用于「落位到对端哪条绝对路径」的 plan 预览明示）
	Path string `json:"path,omitempty"`
	// GitRepo 项目本体是否 git 仓库（双向协作建议走 remote/fetch 的 UI 提示依据）
	GitRepo bool `json:"gitRepo,omitempty"`
	// Excluded .gitignore/默认规则排除条目数（manifest 展示「已排除 N 项」）
	Excluded int `json:"excluded,omitempty"`
	// Truncated 枚举触顶截断（条目护栏，真实指纹未知——plan 侧按冲突档保守处置）
	Truncated bool `json:"truncated,omitempty"`
	// Exists 单元当前是否有效（项目路径消失=无效，plan 跳过并如实标注）
	Exists bool `json:"exists"`
}

// ManifestResponse GET /api/sync/manifest 响应
type ManifestResponse struct {
	Units    []UnitEntry `json:"units"`
	DiskFree int64       `json:"diskFree"` // 磁盘可用字节（落位预检数据源）
	// DestRoot 对端落位默认前缀（本端 plan 预览「将落到对端 <DestRoot>/<名>」）
	DestRoot string `json:"destRoot"`
	// Version 对端版本（能力降级文案「对端实例需升级」的数据源之一）
	Version string `json:"version,omitempty"`
}

// PlanState 四态判定词汇（二审增强①：同步账本基线是判定正确性前提）
const (
	PlanSynced     = "synced"      // 两端=基线 → 跳过
	PlanLocalNewer = "local-newer" // 本端变+对端未变 → 可安全推送
	PlanPeerNewer  = "peer-newer"  // 对端变+本端未变 → 可安全拉取
	PlanConflict   = "conflict"    // 两端都变 → 冲突（默认不勾，逐项/批量裁决）
	PlanNew        = "new"         // 无基线（首次）→ 新增档
	// PlanRetired 退役单元（P-20261108-3：旧对端 manifest 携带的 notes/notes-multi
	// 笔记单元）→ 不可执行：action=skip、selected=false，UI 标红让用户知情
	// 「笔记不再随实例同步」，杜绝静默半态
	PlanRetired = "retired"
)

// PlanActionType 单行 plan 建议动作：push / pull / skip（synced 或不可执行）
const (
	PlanPush = "push"
	PlanPull = "pull"
	PlanSkip = "skip"
)

// PlanRow plan 预览单行
type PlanRow struct {
	UnitEntry
	// State 四态判定（Plan* 词汇）
	State string `json:"state"`
	// Action 建议动作（push/pull/skip；方向由用户选择拉/推决定新增档的落向）
	Action string `json:"action"`
	// Selected 默认勾选（新增/单向更新默认勾，冲突默认不勾标黄）
	Selected bool `json:"selected"`
	// BaselineMissing 无基线（首次同步该单元）
	BaselineMissing bool `json:"baselineMissing,omitempty"`
	// GitBothChanged 双 git 仓库且两端都变——建议走 git 自身 remote/fetch
	// 而非文件级同步（风险节注记的 UI 呈现）
	GitBothChanged bool `json:"gitBothChanged,omitempty"`
	// DestPath 对端落位绝对路径预览（push 方向；= 对端 DestRoot + basename）
	DestPath string `json:"destPath,omitempty"`
	// LastSyncedAt 上次同步时刻（账本；无基线空）
	LastSyncedAt string `json:"lastSyncedAt,omitempty"`
	// LastDirection 上次同步方向
	LastDirection string `json:"lastDirection,omitempty"`
}

// PlanResponse POST /api/sync/plan 响应
type PlanResponse struct {
	Rows         []PlanRow `json:"rows"`
	PeerDiskFree int64     `json:"peerDiskFree"`
	// PeerDiskInsufficient 对端磁盘可用空间小于待传总量（plan 预览直接红不盲传）
	PeerDiskInsufficient bool `json:"peerDiskInsufficient,omitempty"`
	// TotalBytes 勾选单元待传总量（进度条总量来自 manifest 枚举）
	TotalBytes int64 `json:"totalBytes"`
	// PeerOnline 对端探测状态（offline 时 rows 为空并给原因）
	PeerOnline  bool   `json:"peerOnline"`
	PeerStatus  string `json:"peerStatus,omitempty"`
	PeerVersion string `json:"peerVersion,omitempty"`
	// PeerUnsupported 对端未声明 sync 能力族（旧版本）——「对端实例需升级」
	PeerUnsupported bool   `json:"peerUnsupported,omitempty"`
	Message         string `json:"message,omitempty"`
}

// syncCapability /api/meta 能力族声明值（meta.go capabilities 登记；对端探测判定）
const syncCapability = "sync"

// syncMetaHeader 对端落位元数据头（raw zip body + 头承载元数据，免 multipart）
const syncMetaHeader = "X-Sync-Meta"

// credPairFpHeader 携密同步的配对密钥短指纹头（pull 方向服务端按指纹选配对钥
// 封 E2E 信封；无头/指纹不配 = 拒绝服务）
const credPairFpHeader = "X-Sync-Pair-Fp"

// TransferMeta 落位元数据（zip 传输伴随的自描述：包内单元清单与落位参数）
type TransferMeta struct {
	// Units 包内单元（与包内 data/ 目录一一对应）
	Units []TransferUnit `json:"units"`
	// DestRoot 对端落位根（拉取方推送时声明；空 = 对端默认配置）
	DestRoot string `json:"destRoot,omitempty"`
	// IncludeIgnored 含被忽略文件（对端 fingerprint 校验对齐口径）
	IncludeIgnored bool `json:"includeIgnored,omitempty"`
}

// TransferUnit 包内单单元元数据
type TransferUnit struct {
	Key string `json:"key"`
	// Kind 单元 kind
	Kind string `json:"kind"`
	// Name 展示名（项目名）
	Name string `json:"name"`
	// DirName 项目落位目录名（项目单元/deliver 单元携带；= 源端根目录基名）
	DirName string `json:"dirName,omitempty"`
	// SrcPath 源端项目绝对路径（crons Dir 重映射锚点；仅单元间搬运语义消费，
	// 对端不持久化该字段）
	SrcPath string `json:"srcPath,omitempty"`
	// Fingerprint 源端指纹（对端落位完成后原样回账）
	Fingerprint string `json:"fingerprint,omitempty"`
	// Size 源端总字节（对端磁盘预检复核）
	Size int64 `json:"size,omitempty"`
	// Dest deliver 单元的对端目标相对路径（destRoot 内白名单前缀校验）
	Dest string `json:"dest,omitempty"`
	// Entries 包内该单元文件数（落位对账）
	Entries int `json:"entries,omitempty"`
}

// unitEntryErr 构造错误响应的稳定前缀（shared.Error 的 msg 之外的 code 通道
// 走 errmarkers 既有注册表；本包错误多为文案型，直接 fmt）
func errf(format string, args ...any) error { return fmt.Errorf(format, args...) }

// rootBasename 路径基名（跨平台：两种分隔符都剥；尾分隔符先剥）
func rootBasename(p string) string {
	p = strings.TrimRight(p, `\/`)
	if p == "" {
		return ""
	}
	if i := strings.LastIndexAny(p, `\/`); i >= 0 {
		p = p[i+1:]
	}
	return p
}

// normalizeSlashes 反斜杠归一为正斜杠（不走 filepath.ToSlash——它在 Linux
// 是恒等操作，归一语义与宿主解耦三平台显式一致；watch/external.go 同款先例）
func normalizeSlashes(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// sanitizeZipName zip 包内条目名消毒：拒绝绝对路径与盘符形态、剥离 ".."
// 段（zip-slip 双保险——对端落位侧还有前缀校验），非 Windows 主机产生的
// 反斜杠名归一为 /。返回空串 = 条目不可落位（跳过并计数）
func sanitizeZipName(name string) string {
	name = normalizeSlashes(name)
	name = strings.TrimLeft(name, "/")
	if name == "" {
		return ""
	}
	// 盘符形态（C:/...）剥掉盘符段
	if len(name) >= 2 && name[1] == ':' {
		name = strings.TrimLeft(name[2:], "/")
	}
	if name == "" {
		return ""
	}
	parts := strings.Split(name, "/")
	out := make([]string, 0, len(parts))
	for _, seg := range parts {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return "" // 穿越形态整条拒绝（不做「回退」语义——包名不可信）
		}
		// Windows 保留名与非法字符不在这里穷举——落位侧按目标平台文件语义
		// 原样创建，创建失败即该条目失败入账（与上传链同态度）
		out = append(out, seg)
	}
	return strings.Join(out, "/")
}
