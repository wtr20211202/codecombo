package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
)

// ShareKind 分享形态。零值/缺失按文件分享解读（存量记录 JSON 里没有
// kind 字段，反序列化后恰为空串——默认规则保证旧数据零迁移）
type ShareKind string

const (
	// ShareKindFile 项目内文件/目录分享（内容实时读盘，不落库）
	ShareKindFile ShareKind = "file"
	// ShareKindSnippet 文本片段分享（排障贴短链：内容随记录落库，不绑项目）
	ShareKindSnippet ShareKind = "snippet"
	// ShareKindTerminal 终端只读直播分享（P-20261003-306）：token→终端会话，
	// 经直播馈线（liveterm）向访客推遮蔽化只读字节流，无输入端点。
	// 内容不落库（进程内有界尾流），记录只持会话锚点与元数据
	ShareKindTerminal ShareKind = "terminal"
	// ShareKindTermFrozen 终端输出时点冻结分享（P-20261005-205）：创建时刻的
	// scrollback 定格快照（遮蔽净化后的纯文本）落盘为单文件快照（P-320 目录
	// 快照的单文件形态，住同一 SnapshotsRoot 隔离区），会话继续跑、快照定格，
	// 会话关闭后链接仍可访问（独立 TTL 管理）。记录持会话锚点 + 内容哈希
	//（ContentHash，快照身份与幂等定位键），内容本体永不进记录
	ShareKindTermFrozen ShareKind = "terminal-frozen"
	// ShareKindCast 会话回放分享（P-20261004-103）：把一次录制（asciinema v2
	// cast）以只读回放页分享出去——创建时把 cast 文件快照进 SnapshotsRoot
	// 隔离区（异步 walkthrough 语义：分享后录制继续写也不影响访客所见），
	// 访客页 xterm 按时序回放 + OSC133 章节跳转。锚点是 RecordingID（录制
	// 索引 id，内容身份），TerminalID 只作来源会话的展示元数据；内容本体
	// 永不进记录。默认 TTL 短档（CastShareTTL 1 小时，可显式调整）
	ShareKindCast ShareKind = "cast"
	// ShareKindSession 会话回放只读分享（P-20261003-77）：把一条 Claude
	// 会话的完整回放（user/assistant/thinking/tool/result，含思考块与工具
	// 详情）以只读时间线页分享出去——「你看 agent 刚才怎么干活的」的现场
	// 展示件。创建时把解析后的条目快照进 SnapshotsRoot 隔离区（快照即净本，
	// P-108 模式集已在落盘前遮蔽），会话继续写/被删除都不影响访客所见。
	// 锚点是 SessionID（transcript id，幂等/短链/快照目录的稳定键）；内容本体
	// 永不进记录。默认 TTL 24 小时（SessionShareTTL，可显式调短，上限同值）
	ShareKindSession ShareKind = "session"

	// MaxSnippetBytes snippet 内容上限（32KiB）。排障贴/配置片段的真实量级
	// 远低于此；上限兜底防把落库分享当无限 pastebin（大内容请走文件分享）
	MaxSnippetBytes = 32 << 10

	// SnippetTTL snippet 保留窗口：创建即定 24 小时，到期由清理 ticker 删除。
	// 与文件分享「不自动过期」的既有评审决定刻意区分（见 ShareStore 注释）：
	// 片段临时性强、暴露面应短——过期即删是安全边界而非功能缺陷
	SnippetTTL = 24 * time.Hour

	// TerminalLiveTTL 终端直播默认保留窗口：直播是临时暴露面（远程结对/
	// 教学场景，看完了就该断），缺省 30 分钟防「忘了撤销的直播」长尾外泄；
	// 创建请求可显式覆盖（ttlMinutes），到期随 CleanupExpired 与 snippet 同
	// 管线清理
	TerminalLiveTTL = 30 * time.Minute

	// TerminalLiveTTLMax 直播 TTL 上限：直播不是持久分享形态，上限 24h——
	// 需要更长的暴露窗口应开文件分享而非挂着终端直播
	TerminalLiveTTLMax = 24 * time.Hour

	// CastShareTTL 会话回放分享默认保留窗口：1 小时。回放是「发过去看一眼」
	// 的异步 walkthrough 语义——内容含全量终端输出回显，暴露面应短；一次
	// 看完的时效语义与直播的临时性同族，但比 30 分钟直播多留一点缓冲。
	// 创建请求可显式覆盖（ttlMinutes），上限 CastShareTTLMax；调整走既有
	// SetExpiry 管线，到期随 CleanupExpired 与快照孤儿对账同一清账通道
	CastShareTTL = time.Hour

	// CastShareTTLMax 回放分享 TTL 上限：回放不是持久分享形态，上限 24h——
	// 需要长期留档应导出 cast 文件或走冻结文件分享（与直播上限同口径）
	CastShareTTLMax = 24 * time.Hour

	// SessionShareTTL 会话回放分享默认保留窗口：24 小时（2026-10-19 产品
	// 拍板档）。会话回放含思考块与工具详情，属高信息量出域面——一天覆盖
	// 「远程同事/手机看一眼现场」的协作节奏，又不会成为长期挂着的暴露面。
	// 创建请求可显式调短（ttlMinutes），上限同值（SessionShareTTLMax）；
	// 到期随 CleanupExpired + 快照孤儿对账同一清账通道
	SessionShareTTL = 24 * time.Hour

	// SessionShareTTLMax 会话回放分享 TTL 上限：与默认同值——本形态不提供
	// 长留存档（长期留档走 md/JSONL 导出或冻结文件分享）
	SessionShareTTLMax = 24 * time.Hour

	// snippetTokenNamespace snippet token 派生的保留命名空间（DeriveShareToken
	// 的 projectID 入参）。含 NUL 字节而真实项目 ID 不可能包含 → 与文件分享的
	// token 空间物理隔离，不存在同 token 双形态歧义
	snippetTokenNamespace = "\x00snippet"

	// frozenBatchTokenNamespace 多路径冻结分享（P-20261008-1）的保留命名空间：
	// 键 = projectID\x00<排序后的 path1>\x00<path2>…。与单路径 frozen 物理隔离
	// （即使批量集合只有一个路径也得到独立短链——「一个文件的选择集」与「单文件
	// 分享」是两条记录，避免同 token 双语义）；NUL 隔离同 snippet/terminal。
	// 路径集合先经 CanonicalSharePaths 排序去重，集合顺序不影响短链（同集合
	// 恒同链的幂等语义）
	frozenBatchTokenNamespace = "\x00frozen-batch"

	// terminalTokenNamespace 终端直播 token 派生的保留命名空间：按会话 ID
	// 派生（同一会话重复开直播得到同一短链，与文件分享「同目标恒同链」
	// 语义同构）；NUL 隔离同上
	terminalTokenNamespace = "\x00terminal"

	// frozenTokenNamespace 冻结快照分享（P-20261003-320）的保留命名空间：
	// 键 = projectID\x00path。独立命名空间让同一目标可同时存在 live 与 frozen
	// 两条分享（各自独立短链），互不挤占幂等定位；NUL 隔离同 snippet/terminal
	frozenTokenNamespace = "\x00frozen"

	// termFrozenTokenNamespace 终端输出冻结分享（P-20261005-205）的保留命名
	// 空间：键 = terminalID\x00contentHash。与 terminal（直播）物理隔离——
	// 同一会话可同时存在直播与多条快照链（每次定格内容不同 → 不同短链，
	// 「同一段输出恒同一短链」的 snippet 语义同构：内容哈希参与派生，遮蔽
	// 净化后内容相同的两次定格自然落到同一条链上）
	termFrozenTokenNamespace = "\x00termfrozen"

	// castTokenNamespace 会话回放分享（P-20261004-103）的保留命名空间：
	// 键 = recordingID。一次录制恒对应一条回放链（重复分享得到同一短链，
	// 与 snippet 的内容确定性派生同构；录制内容在创建时快照定格，重分享
	// 刷新快照但同一 recordingID 仍派生同一 token）。NUL 隔离同上
	castTokenNamespace = "\x00cast"

	// sessionTokenNamespace 会话回放只读分享（P-20261003-77）的保留命名
	// 空间：键 = sessionID。同一会话重复分享恒同链（转写内容在创建时快照
	// 定格，重分享刷新快照跟进新增回合，倒计时不续期）。NUL 隔离同上
	sessionTokenNamespace = "\x00session"

	// FrozenTTL 冻结分享的默认保留窗口：30 天清账（P-20261003-320）。冻结副本
	// 是落盘数据（车道 2 快照目录），必须有界留存防「冻结一次留一辈子」的磁盘
	// 长尾；评审/留证场景 30 天足够走完反馈闭环，需要更长可在结果卡显式调
	//（SetExpiry 同管线，快照随记录存活）
	FrozenTTL = 30 * 24 * time.Hour

	// ViewOnceGrace 一次性分享（P-20261006-27）的失效宽限窗：访客在确认页
	// 显式确认（POST /s/{token}/view，P-20261020-3）即武装倒计时，窗内重复
	// 访问仍可见（防「打开即刷新断连」的误杀——访客网络闪断重进不该吃闭门
	// 羹），窗后失效。10 分钟覆盖「看一眼 + 来回切换窗口」的真实阅读节奏，
	// 又不给转发留有效窗口
	ViewOnceGrace = 10 * time.Minute
)

// Share 一条分享记录（分享子服务的元数据）：file 形态 = 文件/目录短链
// （内容始终实时读自项目目录，不在落库范围）；snippet 形态 = 独立文本片段
// （Content 随记录落库、不绑项目、24h 自动过期）
type Share struct {
	// Token 分享短链标识（稳定派生，见 DeriveShareToken）
	Token string `json:"token"`
	// Kind 分享形态（file | snippet；零值按 file 解读）
	Kind ShareKind `json:"kind,omitempty"`
	// ProjectID 所属项目（分享根 = 项目目录；snippet 恒空——不绑项目）
	ProjectID string `json:"projectId"`
	// ProjectName 创建时的项目名快照（项目删除后列表仍可辨识；服务端
	// 解析根目录以 ProjectID 为准）
	ProjectName string `json:"projectName"`
	// Path 项目内相对路径（/ 分隔；空串 = 整个项目根；snippet 恒空）
	Path string `json:"path"`
	// Paths 多路径冻结分享（P-20261008-1）的选择集：非空 = 一条把 N 个
	// 项目相对路径各自定格进同一副本的批量短链（跨目录评审包）。MVP 仅
	// frozen 模式（live 多锚定根语义复杂，创建面拒绝）；Path 恒空、IsDir
	// 恒 false（集合本身不是单根），访客页按 manifest 逐项列出路径。集合
	// 规范化为排序去重后的形态（CanonicalSharePaths）——同集合顺序无关幂等。
	// 旧记录无此字段 → 零值 nil = 单路径既有语义，零迁移
	Paths []string `json:"paths,omitempty"`
	// Name 展示名（文件/目录名或片段标题；根分享为项目名）
	Name string `json:"name"`
	// IsDir 目录分享（分享页提供递归目录浏览 + 打包下载；snippet 恒 false）
	IsDir bool `json:"isDir"`
	// Size file = 创建时快照的文件字节数（目录恒 0；分享页展示实时大小）；
	// snippet = 内容字节数（落库即定值）
	Size int64 `json:"size"`
	// Content snippet 形态的文本内容（≤ MaxSnippetBytes；file 恒空）
	Content string `json:"content,omitempty"`
	// CreatedAt 首次分享时间（幂等重建不刷新）
	CreatedAt time.Time `json:"createdAt"`
	// ExpiresAt 过期时点（零值 = 永不过期）。snippet 创建即定 now+SnippetTTL，
	// 幂等重建不刷新——倒计时是安全边界，不因重复分享被无限续期；file 形态
	// 为 opt-in TTL（P-20261003-29）：默认永久（A2 决策不变），创建对话框
	// 显式选择后落值，调整走 SetExpiry、到期随 CleanupExpired 清理
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
	// Rotate 轮换代际（P-20261002-72 泄露应对；0 = 原生派生）。参与 token
	// 派生：每轮换一次 +1 → 新短链，旧短链随记录迁键立即失效。幂等创建
	// 保留该代际——同目标重复分享拿到的是当前（轮换后）短链，而不是回到
	// 已泄露的旧代际链
	Rotate int `json:"rotate,omitempty"`
	// Hits 短链被打开/下载的累计次数（P-20261002-14 访问指标）。访客面
	// 内存聚合后批量落盘（见 share.HitCounter），旧文档无此字段 → 零值
	// 即「未访问」，零迁移。一次性分享只记显式确认（POST /s/{token}/view，
	// P-20261020-3）——预览抓取 GET/HEAD 不计数
	Hits int64 `json:"hits,omitempty"`
	// LastAccessAt 最近一次命中时点（零值 = 从未被访问）。随 Hits 同批
	// 落盘，管理列表以相对时间展示
	LastAccessAt time.Time `json:"lastAccessAt,omitempty"`
	// TerminalID 终端直播形态的会话锚点（terminal/terminal-frozen 形态专有；
	// file/snippet 恒空）。直播访客推流按它反查终端会话（会话已关闭则访客页
	// 呈现「已结束」）；冻结快照形态它只参与 token/快照目录派生——快照内容
	// 在创建时刻已定格，不依赖会话存活
	TerminalID string `json:"terminalId,omitempty"`
	// ContentHash 终端输出冻结快照的内容哈希（terminal-frozen 专有，hex sha256；
	// 其余形态恒空）。三重身份：①幂等定位键（同 (TerminalID, ContentHash) 的
	// 重复定格 = 同一条链，snippet 按内容定位同构）；②快照目录名的稳定派生
	// 锚（与 FrozenNativeToken 同款「零代际值锚目录」——rotate 换链副本不动，
	// 轮换后的记录仍能从 TerminalID+ContentHash 重算目录名）；③记录不持内容
	// 本体（可达 16MB 的净化文本住车道 2 快照文件），旧文档无此字段 → 零值
	// 兼容零迁移
	ContentHash string `json:"contentHash,omitempty"`
	// RecordingID 会话回放形态的录制锚点（cast 专有；其余形态恒空）。录制
	// 元数据索引 id，是 token 派生/快照目录名的稳定键与幂等定位键（同一次
	// 录制重复分享恒同链）；内容本体是 SnapshotsRoot 下的 cast 快照文件，
	// 记录不持内容。TerminalID 在 cast 形态只承载来源会话（展示/跳转元数据），
	// 不承担内容锚点职责。旧文档无此字段 → 零值兼容零迁移
	RecordingID string `json:"recordingId,omitempty"`
	// SessionID 会话回放只读分享的会话锚点（session 专有；其余形态恒空）。
	// Claude transcript 的 session id，是 token 派生/快照目录名的稳定键与
	// 幂等定位键（同一会话重复分享恒同链）；内容本体是 SnapshotsRoot 下的
	// 会话条目快照文件，记录不持内容。旧文档无此字段 → 零值兼容零迁移
	SessionID string `json:"sessionId,omitempty"`
	// Frozen 冻结快照分享（P-20261003-320，file 形态的模式标记）：创建时把
	// 分享根复制进隔离快照目录（<DataDir>/artifacts/share-snapshots/），访客
	// 读副本而非项目目录——内容定格（后续开发不影响访客所见）且敏感扫描
	// 即对副本本身（所见即所扫）。零值 false = live 活视图（既有形态，存量
	// 记录零迁移）。副本目录名 = 零代际派生 token（FrozenNativeToken）——
	// 轮换代际不改变零代际值，rotate 换短链副本不动；撤销/过期清账即删
	Frozen bool `json:"frozen,omitempty"`
	// PassphraseHash 访问口令门（P-20261006-25，可选）：访客面二级验证的
	// bcrypt 哈希（落库勿明文，与 lock 域哈希惯例同源）。零值/缺失 = 无口令
	// （「知道链接即能看」的既有语义，存量记录零迁移）——口令是叠加的出域
	// 闸门而非替换。访客面凭它做 bcrypt 比对 + 派生门会话 cookie（cookie 值
	// 绑定本哈希：改口令/移除口令即让全部已发访客会话失效，无需额外会话表）
	PassphraseHash string `json:"passphraseHash,omitempty"`
	// Watermark 访客页溯源水印（P-20261005-193）：true = 访客页叠加对角双标
	// 低透明水印（分享名 + token 尾号 + 日期，见 share.WatermarkLabel）——
	// 截图/拍照外传后可归因到具体链接（归因非防泄密，定位如实）。旧文档无
	// 此字段 → 零值 false = 不出水印（存量链接访客面渲染零变化，增量扩展
	// 零迁移）；新创建由管理面缺省置 true（缺省开），幂等重建以请求值为准
	Watermark bool `json:"watermark,omitempty"`
	// MessageCount 访客留言计数（P-20261006-13 留言附表的冗余投影）：管理
	// 列表「留言 N」角标的 O(1) 数据源（列表响应不再逐分享扫附表——分享
	// 量级 × 附表扫描是 N+1 反模式）。由 shareMsgRepo 在 Add/Delete/Clear
	// 时 RMW 维护，真实存量以附表为准（RMW 间隙内可能短暂偏离，角标展示
	// 容忍；管理面板打开时以附表 List 为准）。旧文档无此字段 → 零值兼容
	// 零迁移。轮换迁键时计数随记录走（留言迁键同批次，见 Rotate）
	MessageCount int `json:"messageCount,omitempty"`
	// ViewOnce 阅后即焚一次性分享（P-20261006-27，分享时限的次数维）：true =
	// 访客在确认页显式确认（POST /s/{token}/view，P-20261020-3）即武装
	// ViewOnceGrace 倒计时，窗后失效——访客面 410 share_consumed 专页文案
	//（区别于 TTL 的「已过期」，告知「已被查看」而非「有效期到了」）。未确认
	// GET 只出确认页：预览抓取不武装、不计数。与口令门正交可叠（口令页打开
	// 不计访问，武装只发生在解锁且确认后——一次性+口令=最严形态）；
	// frozen/直播形态不支持（定格副本与持续流语义均与「看一眼即焚」相斥，
	// 创建面拒绝）。旧文档无此字段 → 零值 false = 常规分享（存量记录零迁移）
	ViewOnce bool `json:"viewOnce,omitempty"`
	// ViewedAt 一次性分享的确认时点（ViewOnce 专有，倒计时锚；零值 = 尚未
	// 被确认，窗未启动）。创建请求不携带、只由访客面显式确认经 MarkFirstView
	// 落库（first-writer-wins：并发两访客同开，先到者锚定起点，后到者 no-op
	// ——重复分享/轮换均不得重置已启动的倒计时）。旧文档无此字段 → 零值兼容
	ViewedAt time.Time `json:"viewedAt,omitempty"`
	// Collab 协作通道开关（P-20261024-1，分享级动作化开关——分享无编辑面，
	// 生命=创建→revoke/rotate/freeze，开关是管理面行内动作）：true = 访客面
	// 暴露上传/受限输入端点（POST /s/{token}/drop 上传素材、GET /s/{token}/drops
	// 收件清单、留言板上限 500→2000 rune）。缺省 false = 关（存量记录零迁移），
	// 端点对访客恒 404（与「端点不存在」不可区分，retired 短链同款语义）；
	// 关闭即回收（上传位即刻消失）但存量已收素材保留可读（主人侧清单/取件
	// 不受开关影响——素材已入档，回收的是「新上行」而非「已收到的东西」）
	Collab bool `json:"collab,omitempty"`
	// DirectInput 直通输入档开关（P-20261024-1 第二档独立开关，缺省关，与
	// Collab 互不联动）：true = 访客可经申请-批准握手（单持有者）向本分享
	// 锚定的 agent 会话直接输入补充信息（文字批次，≤4KB/批）。v1 限定 agent
	// 会话——普通终端直通 = 匿名远程 shell 等价，明确不开放（批准面判定
	// session kind，非 agent 会话 400）；开启不等于持权（还要 owner 批准
	// 握手），关闭即回收持权并级联摘除会话侧只读闸
	DirectInput bool `json:"directInput,omitempty"`
	// RetiredTokens 退役短链台账（P-20261008-2，Rotate 专有）：历次轮换被
	// 替换的旧 token 及其退役后的命中观测（条目内含计数与最近命中时点）。
	// 泄露应对的观测面——旧链对访客面已死（404 与不存在同观感，存在性不可
	// 探测），「死链仍被踩」是零误报的外泄确认信号：管理面据此挂「退役访问
	// N 次」徽标、通知中心据此发外泄告警。随 Rotate 追加（上限
	// RetiredTokensMax 逐出最旧），命中计数由访客面攒批落盘（RecordRetiredHit
	// 两段式同 Hits）。记录撤销/过期清理时随记录消亡（退役观测的生命周期
	// 与宿主一致，无独立清理面）。旧文档无此字段 → 零值 nil = 无退役史，
	// 零迁移
	RetiredTokens []RetiredToken `json:"retiredTokens,omitempty"`
}

// RetiredToken 一条退役短链的台账条目（P-20261008-2）：Rotate 换链时把被
// 替换的旧 token 追加进记录——旧链对访客面已死（404，与不存在同观感），
// 但「死链仍被踩」是零误报的外泄确认信号，值得留观测。命中侧经
// RecordRetiredHit 更新本条目的计数与时点（访客面攒批落盘，与 Hits 同款
// 两段式），管理面「退役访问 N 次」徽标与通知告警都从本字段读。
// 旧记录无此字段 → 零值 nil = 无退役史，零迁移
type RetiredToken struct {
	// Token 退役的旧短链标识（完整值：与 share.view 同理，审计/对账是本地
	// 持久化凭证而非外发工件，完整 token 保指认能力）
	Token string `json:"token"`
	// RetiredAt 退役时点（Rotate 执行时刻；换链即失效，先于任何命中）
	RetiredAt time.Time `json:"retiredAt"`
	// Hits 退役后被访问的累计次数（零值 = 从未被踩）
	Hits int64 `json:"hits,omitempty"`
	// LastHitAt 最近一次被访问时点（零值 = 从未被踩）
	LastHitAt time.Time `json:"lastHitAt,omitempty"`
}

// RetiredTokensMax 单条记录的退役 token 台账上限：每次 Rotate 追加一条，
// 正常使用远达不到；封顶防「自动化高频轮换」把记录撑成无界文档。逐出最旧
// （保留最近代际——泄露应对后旧链被踩的价值随代际更替快速衰减，最新退役链
// 才是与当前外发副本对应的观测面）
const RetiredTokensMax = 32

// Consumed 一次性分享是否已失效（P-20261006-27）：开了 viewOnce 且已武装
// （ViewedAt 非零）且宽限窗走完。与 Expired 互相独立——一次性失效不走
// ExpiresAt（SetExpiry 不得延长已武装的焚毁倒计时，TTL 调整也救不回已
// 消费的一次性），也不触发惰性删除（管理器要能呈现「失效态」，记录留在
// 列表直到分享者撤销）
func (s Share) Consumed(now time.Time) bool {
	if !s.ViewOnce || s.ViewedAt.IsZero() {
		return false
	}
	return !s.ViewedAt.Add(ViewOnceGrace).After(now)
}

// Expired 分享是否已过保留窗口（ExpiresAt 零值 = 永不过期）
func (s Share) Expired(now time.Time) bool {
	return !s.ExpiresAt.IsZero() && !s.ExpiresAt.After(now)
}

// ShareStore 分享记录存储。
// 语义约定：同一 (ProjectID, Path) 反复创建得到同一 Token（幂等 get-or-create，
// 仅刷新名称/大小快照）；snippet 形态同理——同一段内容反复分享得到同一
// Token（幂等重建保留原 CreatedAt/ExpiresAt，倒计时不续期）；撤销即删除记录，
// 撤销后再次创建因派生确定性会恢复同一 Token——这是"同一内容短链恒定"
// 语义的直接推论。轮换（Rotate）是该语义唯一的显式例外：代际 +1 重派生新
// 短链、旧短链立即失效（泄露应对），且轮换后的幂等创建固定返回当前代际链
// （绝不在用户无操作时把已作废的旧链复活）
//
// 保留策略决策（持久化纪律 A2 评审结论）：文件/目录分享默认不做自动过期
// 清理——分享是用户主动创建且对外分发的活链接，自动删除等于悄悄弄断别人的
// 短链（功能性回归）。snippet 形态自带过期语义（SnippetTTL）：文本片段临时
// 性强、暴露面应短，到期清理随特性一并引入（CleanupExpired，由分享模块的
// 保留策略 ticker 周期执行；访客面在清理间隙也拒绝已过期记录，双保险）。
// P-20261003-29 按该邀请补齐 opt-in TTL：文件/目录分享可由用户显式设定
// 有效期（SetExpiry/创建对话框），默认路径仍永久——A2 决策对默认语义不变，
// 清理管线（ticker + 访客面把守）对两种 ExpiresAt 来源一视同仁
type ShareStore interface {
	Create(s Share) (*Share, error)
	List() ([]Share, error)
	Get(token string) (*Share, error)
	// Rotate 轮换短链（泄露应对）：为该分享派生新 token（代际 +1 参与派生）
	// 并迁键，旧 token 立即失效；返回携带新 token 的记录。未知/已撤销/已
	// 过期 → ErrNotFound
	Rotate(token string) (*Share, error)
	Delete(token string) error
	// CleanupExpired 删除已过保留窗口的记录（snippet 的固定 24h 与文件分享
	// 的 opt-in TTL 同管线），返回删除条数
	CleanupExpired(now time.Time) (int, error)
	// SetExpiry 显式调整分享有效期（opt-in TTL，P-20261003-29）：expiresAt
	// 零值 = 恢复永久。snippet 的 24h 倒计时是固定安全边界，不开放调整
	// （ErrInvalidArg）；未知/已撤销/已过期 → ErrNotFound（与 Rotate 同口径
	// ——过期记录对访客面已死亡，不接受借尸还魂）
	SetExpiry(token string, expiresAt time.Time) (*Share, error)
	// SetPassphrase 设置/更换/移除访问口令门（P-20261006-25 管理面入口）：
	// hash 为调用方已算好的 bcrypt 哈希（store 不持有明文）；空串 = 移除口令
	//（回到「知道链接即能看」）。全形态（file 的 live/frozen 两模式、snippet、
	// terminal）统一开放——访客守卫层按记录字段把门，与形态无关。未知/已撤销
	// /已过期 → ErrNotFound（与 SetExpiry 同口径）。只覆写 PassphraseHash 一个
	// 字段，其余原样（短链不变——改口令不动链接，要连链接一起换走显式
	// Rotate，管理面「改口令建议联动 rotate」是两个动作的组合而非本方法的语义）
	SetPassphrase(token string, hash string) (*Share, error)
	// SetCollab 协作通道开关（P-20261024-1 管理面行内动作）：collab=true 开启
	// 访客上传/受限输入端点（缺省关），false 关闭即回收（端点恢复 404，存量
	// 素材保留可读）。与 SetPassphrase 同款 RMW：Get→覆写单字段→Update，
	// 其余字段原样（短链不变）。未知/已撤销/已过期 → ErrNotFound（与 Rotate
	// 同口径——过期记录对访客面已死亡，开关无从谈起）
	SetCollab(token string, collab bool) (*Share, error)
	// SetDirectInput 直通输入档开关（P-20261024-1 第二档独立开关，与 Collab
	// 互不联动）：on=true 开启申请-批准握手面，false 关闭即回收（持权立刻
	// 失效，由装配层级联摘除会话侧只读闸——store 只管记录字段）。RMW 同款
	SetDirectInput(token string, on bool) (*Share, error)
	// RecordHits 访问计数累加（P-20261002-14）：Hits += n 并刷新
	// LastAccessAt = at。供访客面内存聚合的批量落盘回调（见 share.HitCounter
	// ——计数先攒内存、定时冲刷，访客响应路径零磁盘 I/O）；记录已撤销/
	// 已过期 → ErrNotFound，调用方静默丢弃该批（计数是尽力而为的旁路
	// 指标，绝不影响访客响应，也不给已死短链复活）
	RecordHits(token string, n int64, at time.Time) error
	// MarkFirstView 一次性分享显式确认落库（P-20261006-27；P-20261020-3 起
	// 调用点是访客确认 POST /s/{token}/view，GET 预览抓取不再触达）：
	// ViewedAt 仅在零值时写入（first-writer-wins——并发两访客同开，先到者
	// 锚定宽限窗起点，后到者 no-op），非一次性/已武装记录原样返回 nil。
	// 同步写而非攒批：武装时点是失效判定的安全锚，崩在攒批窗口 = 倒计时
	// 凭空重置（分享多活一个窗），不属「尽力而为」范畴；且每条分享至多写
	// 一次，访客热路径零常态开销。与 RecordHits 同款 Get→Update RMW 取舍
	//（filestore per-kind 锁只串行化单次写）；记录已撤销/已过期 → ErrNotFound
	MarkFirstView(token string, at time.Time) error
	// RecordRetiredHit 退役短链命中计数累加（P-20261008-2 的落盘侧）：
	// retiredToken 必须是某条存活记录 RetiredTokens 台账中的条目——定位宿主
	// 记录后该条目 Hits += n、LastHitAt = at，返回更新后的宿主记录（调用方
	// 据此锚定审计/通知的展示元数据）。供访客面内存聚合的批量落盘回调（与
	// RecordHits 同款两段式——计数先攒内存、定时冲刷，访客响应路径零磁盘
	// I/O）；retiredToken 不在任何存活台账中（记录已撤销/过期随台账消亡）
	// → ErrNotFound，调用方静默丢弃该批（观测是尽力而为的旁路指标，绝不
	// 影响访客响应，也不给已死短链复活）
	RecordRetiredHit(retiredToken string, n int64, at time.Time) (*Share, error)
	// FindRetired 退役短链反查宿主（P-20261008-2 访客面命中钩子的只读查询）：
	// retiredToken 在某条存活记录的 RetiredTokens 台账中 → 返回宿主记录与
	// true；否则 (nil, false)。实现侧维护内存反向索引（retired token → 宿主
	// token，rotate 写入、记录消亡摘除、重启惰性重建），访客 404 热路径的
	// 未命中分支一次 map 读即出，绝不逐请求扫全表——扫描探测不存在 token 的
	// 请求不能被放大成 O(N) 磁盘读
	FindRetired(retiredToken string) (*Share, bool)
}

type shareRepo struct {
	doc DocumentStore
	// msgs 留言附表（同包装配：级联删除/轮换迁键/计数 RMW 的协作对象，
	// 构造期接线见 New——repo 间不经全局 Store 互相摸底）
	msgs *shareMsgRepo
	// 退役短链反向索引（P-20261008-2）：retired token → 宿主记录当前 token。
	// 访客面 FindRetired 的 O(1) 查询面——retiredTokens 挂在记录上而访客 404
	// 路径只有 token 一个键，逐请求 List 扫描会把「探测不存在 token」的请求
	// 放大成 O(N) 磁盘读（404 是访客面最常被打的路径），内存索引是热路径的
	// 前提。维护点：Rotate 写入、Delete/CleanupExpired 摘除（宿主亡则退役
	// 台账随之消亡）、进程重启后首次查询惰性重建（store 是单进程唯一写方，
	// 索引与落盘一致；构建失败不置位，下次查询重试——宁慢勿错）
	retiredMu   sync.Mutex
	retiredIdx  map[string]string
	retiredInit bool
}

func newShareRepo(doc DocumentStore) *shareRepo { return &shareRepo{doc: doc} }

const shareKind = "shares"

// shareTokenLen 短链标识长度（base36 字符）。80 bit 熵 × HMAC 派生，
// 枚举不可行；同空间下 10 万条分享碰撞概率 < 10^-14
const shareTokenLen = 16

// DeriveShareToken 稳定短链标识：HMAC-SHA256(pepper, projectID\x00path)
// 取前 10 字节转 base36 截 16 位。
//   - 确定性 → 同一文件/目录重复分享得到同一短链（需求：短链不变）；
//   - 路径全量入参 → 不同项目/不同层级的同名文件互不相同（需求：同名隔离）；
//   - pepper 为部署级 master-key → token 对知道项目结构的局外人不可预测；
//   - gen 为轮换代际（share.Rotate）：0 = 原生派生（与历史版本逐字节一致，
//     存量记录零迁移），≥1 把代际计数混入 HMAC 入参——轮换一次派生一条新
//     短链，泄露应对（Rotate）无需更换部署密钥。share_test 有 gen=0 金标
//     向量锚定跨版本稳定，改动派生 = 全部存量短链失效，禁止
func DeriveShareToken(pepper []byte, projectID, path string, gen int) string {
	mac := hmac.New(sha256.New, pepper)
	mac.Write([]byte(projectID))
	mac.Write([]byte{0})
	mac.Write([]byte(path))
	if gen > 0 {
		mac.Write([]byte{0})
		mac.Write([]byte(fmt.Sprintf("rotate#%d", gen)))
	}
	n := new(big.Int).SetBytes(mac.Sum(nil)[:10])
	s := n.Text(36)
	if len(s) < shareTokenLen {
		s = strings.Repeat("0", shareTokenLen-len(s)) + s
	}
	return s[:shareTokenLen]
}

// FrozenNativeToken 冻结分享的零代际派生 token。除参与短链派生外还是快照
// 目录名的稳定键：轮换代际（Rotate）改变的是 gen 参与的派生值，零代际值
// 恒定——rotate 换 token 后管理面/访客面/清账三方仍能从记录字段重算出同一
// 目录名，副本不随轮换迁移（「rotate 换链、副本不变」的组合语义）
func FrozenNativeToken(pepper []byte, projectID, path string) string {
	return DeriveShareToken(pepper, frozenTokenNamespace, projectID+"\x00"+path, 0)
}

// FrozenBatchNativeToken 多路径冻结分享（P-20261008-1）的零代际派生 token：
// 除参与短链派生外还是批量快照目录名的稳定键（rotate 换链副本原地不动，
// 与 FrozenNativeToken 同构）。paths 必须是 CanonicalSharePaths 的产物
// （排序去重），否则同集合不同顺序会派生出不同短链，幂等语义破裂
func FrozenBatchNativeToken(pepper []byte, projectID string, paths []string) string {
	return DeriveShareToken(pepper, frozenBatchTokenNamespace, frozenBatchShareKey(projectID, paths), 0)
}

// frozenBatchShareKey 批量派生键：projectID 与各路径以 NUL 拼接（路径不能
// 含 NUL，拼接无歧义；排序由 CanonicalSharePaths 保证）
func frozenBatchShareKey(projectID string, paths []string) string {
	return projectID + "\x00" + strings.Join(paths, "\x00")
}

// CanonicalSharePaths 批量路径集合规范化（创建面与 store 侧共用的唯一实现）：
// 反斜杠 → 斜杠、丢弃空段与 "." 段、拒绝上跳段/NUL/超长路径、排序去重——
// 归一语义与 share.NormalizeRelPath 同口径（后者属访客/管理面，store 不能
// 反向依赖），但"任何 .. 段一律拒绝"更严：选择集必须逐项是用户真正选中的
// 具体路径，靠上跳拼出的路径即使落在项目内也不接受。**不裁剪空白**——文件名
// 里的首尾空格是合法字符，TrimSpace 会悄悄改写用户选中的路径。返回的切片
// 可直接用于 token 派生与快照复制。
// 注意：只做词法层归一，不判存在性/嵌套（存在性由调用方 StatTarget 校验，
// 嵌套选择由 API 层按目录前缀去重）
func CanonicalSharePaths(paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("%w: paths is empty", ErrInvalidArg)
	}
	seen := make(map[string]bool, len(paths))
	out := make([]string, 0, len(paths))
	for _, raw := range paths {
		// 与 NormalizeRelPath 同量级上限：挡住畸形超长输入，真实路径远不及此
		if len(raw) > 1024 {
			return nil, fmt.Errorf("%w: share path is too long", ErrInvalidArg)
		}
		segs := strings.Split(strings.ReplaceAll(raw, "\\", "/"), "/")
		if len(segs) > 64 {
			return nil, fmt.Errorf("%w: share path is too deep", ErrInvalidArg)
		}
		parts := make([]string, 0, len(segs))
		for _, seg := range segs {
			switch seg {
			case "", ".":
				continue
			case "..":
				return nil, fmt.Errorf("%w: share path must not traverse up", ErrInvalidArg)
			}
			if strings.ContainsRune(seg, '\x00') {
				return nil, fmt.Errorf("%w: share path contains NUL", ErrInvalidArg)
			}
			parts = append(parts, seg)
		}
		norm := strings.Join(parts, "/")
		if norm == "" {
			return nil, fmt.Errorf("%w: share path must not be empty", ErrInvalidArg)
		}
		if seen[norm] {
			continue
		}
		seen[norm] = true
		out = append(out, norm)
	}
	sort.Strings(out)
	return out, nil
}

// TermFrozenNativeToken 终端输出冻结分享（P-20261005-205）的零代际派生
// token：键 = terminalID\x00contentHash。语义与 FrozenNativeToken 同构——
// 除参与短链派生外还是单文件快照目录名的稳定键，rotate 换链快照原地不动，
// 清账对账/访客面解析都从记录字段重算同一目录名
func TermFrozenNativeToken(pepper []byte, terminalID, contentHash string) string {
	return DeriveShareToken(pepper, termFrozenTokenNamespace, terminalID+"\x00"+contentHash, 0)
}

// CastNativeToken 会话回放分享（P-20261004-103）的零代际派生 token：键 =
// recordingID。语义与 FrozenNativeToken/TermFrozenNativeToken 同构——除参与
// 短链派生外还是 cast 快照目录名的稳定键，rotate 换链后管理面/访客面/清账
// 仍从记录字段重算出同一目录名，快照副本原地不动
func CastNativeToken(pepper []byte, recordingID string) string {
	return DeriveShareToken(pepper, castTokenNamespace, recordingID, 0)
}

// SessionNativeToken 会话回放只读分享（P-20261003-77）的零代际派生 token：
// 键 = sessionID。语义与 FrozenNativeToken/TermFrozenNativeToken/CastNativeToken
// 同构——除参与短链派生外还是会话快照目录名的稳定键，rotate 换链后管理面/
// 访客面/清账仍从记录字段重算出同一目录名，快照副本原地不动
func SessionNativeToken(pepper []byte, sessionID string) string {
	return DeriveShareToken(pepper, sessionTokenNamespace, sessionID, 0)
}

// Create 幂等创建/刷新分享记录。file 形态 Token 由 (ProjectID, Path) 派生，
// 已存在时保留原 CreatedAt 只刷新名称/大小快照；snippet 形态 Token 由内容
// 派生（createSnippet）。落库侧防御纵深：路径含 ".." 段直接拒绝（正常调用方
// 已经过 share.NormalizeRelPath；这里兜底防未来调用方绕过归一）
func (r *shareRepo) Create(s Share) (*Share, error) {
	if s.Kind == "" {
		s.Kind = ShareKindFile
	}
	switch s.Kind {
	case ShareKindSnippet:
		return r.createSnippet(s)
	case ShareKindTerminal:
		return r.createTerminal(s)
	case ShareKindTermFrozen:
		return r.createTermFrozen(s)
	case ShareKindCast:
		return r.createCast(s)
	case ShareKindSession:
		return r.createSession(s)
	}
	return r.createFile(s)
}

// createTerminal 终端只读直播分享（P-20261003-306）。与 snippet 同构的三点：
// 不绑项目文件系统（ProjectID/Path 清空，锚点是 TerminalID）、token 从会话
// ID 确定性派生（同一会话重复开直播得到同一短链，幂等重建不续期——倒计时
// 是安全边界）、默认 TTL 创建即定（TerminalLiveTTL 30 分钟，可显式覆盖，
// 上限 TerminalLiveTTLMax）。既有记录按 (kind, terminalId) 定位（轮换感知，
// createFile 的目标扫描同款）。Name 展示名由调用方给（缺省会话 ID 兜底）
func (r *shareRepo) createTerminal(s Share) (*Share, error) {
	if s.TerminalID == "" {
		return nil, fmt.Errorf("%w: terminal share requires terminalId", ErrInvalidArg)
	}
	s.ProjectID, s.Path, s.IsDir = "", "", false
	s.Paths = nil
	// 直播是持续流语义，与「看一眼即焚」相斥（P-20261006-27：创建面已拒绝，
	// 这里兜底清防未来调用方绕过 API 直入 store——一次性字段对直播无意义）
	s.ViewOnce, s.ViewedAt = false, time.Time{}
	if s.Name == "" {
		s.Name = s.TerminalID
	}
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(TerminalLiveTTL)
	}
	if d := time.Until(s.ExpiresAt); d > TerminalLiveTTLMax {
		s.ExpiresAt = time.Now().Add(TerminalLiveTTLMax)
	}
	if old := r.findTerminalBySession(s.TerminalID); old != nil {
		if !old.Expired(time.Now()) {
			// 幂等命中：请求带新口令哈希 = 主动加/改门，覆写生效（与 snippet
			// 同款；不带 = 保持既有口令）；watermark 同为可变展示设置，请求值
			// 覆写（管理面缺省传 true——不带该字段的重建回到缺省开基线）
			changed := false
			if s.PassphraseHash != "" && s.PassphraseHash != old.PassphraseHash {
				old.PassphraseHash = s.PassphraseHash
				changed = true
			}
			if s.Watermark != old.Watermark {
				old.Watermark = s.Watermark
				changed = true
			}
			if changed {
				if data, err := json.Marshal(*old); err == nil {
					_ = r.doc.Update(shareKind, old.Token, data)
				}
			}
			return old, nil
		}
		// 命中已过期但未被清理 ticker 扫走的记录：删旧重建（新时钟周期，
		// 落回零代际 token）——snippet 同款，不给过期直播借尸还魂
		_ = r.doc.Delete(shareKind, old.Token)
	}
	s.Token = DeriveShareToken(config.MasterKey(), terminalTokenNamespace, s.TerminalID, 0)
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// findTerminalBySession 按 (kind=terminal, TerminalID) 定位存活直播记录
// （轮换感知的 get-or-create 定位；按 token 找会漏掉已轮换记录）
func (r *shareRepo) findTerminalBySession(terminalID string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		if shares[i].Kind == ShareKindTerminal && shares[i].TerminalID == terminalID {
			return &shares[i]
		}
	}
	return nil
}

// createTermFrozen 终端输出时点冻结分享（P-20261005-205）。与 snippet 同构的
// 三点：token 从内容派生（键 = terminalID\x00contentHash——遮蔽净化后的文本
// 即快照全部内容，哈希全等 = 内容全等，「同一段输出恒同一短链」，两次定格
// 内容相同自然落到同一条链）；既有记录按 (kind, terminalId, contentHash) 全等
// 定位（轮换感知，按 token 找会漏掉已轮换记录）；默认 TTL 创建即定（30 天，
// FrozenTTL 同值——快照是落盘数据，倒计时防磁盘长尾；显式调整走 SetExpiry，
// 幂等重建不续期）。与直播（createTerminal）刻意区分：不要求会话存活、
// ExpiresAt 不钳 24h——快照脱离会话生命周期，报障求援链接要在会话关闭后
// 仍可访问。Name 展示名由调用方给（缺省会话 ID 兜底）；快照本体（净化文本）
// 由调用方先行落盘（本函数不碰文件系统——store 不涉车道 2）
func (r *shareRepo) createTermFrozen(s Share) (*Share, error) {
	if s.TerminalID == "" || s.ContentHash == "" {
		return nil, fmt.Errorf("%w: terminal-frozen share requires terminalId and contentHash", ErrInvalidArg)
	}
	s.ProjectID, s.Path, s.IsDir, s.Frozen = "", "", false, false
	s.Paths = nil
	// 定格快照与一次性相斥（P-20261006-27，createTerminal 同款兜底清）
	s.ViewOnce, s.ViewedAt = false, time.Time{}
	if s.Name == "" {
		s.Name = s.TerminalID
	}
	if old := r.findTermFrozen(s.TerminalID, s.ContentHash); old != nil {
		if !old.Expired(time.Now()) {
			// 会话改名（重命名终端后重复定格同一段输出）：刷新展示名；watermark
			// 同为可变展示设置，请求值覆写（管理面缺省传 true）。其余字段原样
			//（CreatedAt/ExpiresAt/Hits 同属记录而非请求，幂等不清零）
			changed := false
			if old.Name != s.Name {
				old.Name = s.Name
				changed = true
			}
			if s.Watermark != old.Watermark {
				old.Watermark = s.Watermark
				changed = true
			}
			if changed {
				if data, err := json.Marshal(old); err == nil {
					_ = r.doc.Update(shareKind, old.Token, data)
				}
			}
			return old, nil
		}
		// 命中已过期但未被清理 ticker 扫走的记录：删旧重建（新时钟周期，
		// 落回零代际 token）——terminal/snippet 同款，不给过期快照借尸还魂
		_ = r.doc.Delete(shareKind, old.Token)
	}
	s.Token = TermFrozenNativeToken(config.MasterKey(), s.TerminalID, s.ContentHash)
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	// 默认 30 天保留窗口（FrozenTTL 同值）：创建即定倒计时；显式调整走
	// SetExpiry（与 frozen 文件快照同构）
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(FrozenTTL)
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// findTermFrozen 按 (kind=terminal-frozen, TerminalID, ContentHash) 全等定位
// 存活快照记录（轮换感知的 get-or-create 定位）。分享量级为用户手工创建的
// 个位数到十位数，List 扫描代价可忽略
func (r *shareRepo) findTermFrozen(terminalID, contentHash string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		if shares[i].Kind == ShareKindTermFrozen && shares[i].TerminalID == terminalID &&
			shares[i].ContentHash == contentHash {
			return &shares[i]
		}
	}
	return nil
}

// createCast 会话回放分享（P-20261004-103）。与 snippet/terminal-frozen 同构
// 的三点：不绑项目文件系统（ProjectID/Path 清空，锚点是 RecordingID）、token
// 从录制 ID 确定性派生（同一录制重复分享得到同一短链，幂等重建不续期——
// 倒计时是安全边界）、默认 TTL 创建即定（CastShareTTL 1 小时，可显式覆盖，
// 上限 CastShareTTLMax）。既有记录按 (kind=cast, recordingID) 定位（轮换感知，
// 按 token 找会漏掉已轮换记录）。cast 快照本体由调用方先行落盘（本函数不碰
// 文件系统——store 不涉车道 2）；重复分享时调用方可重写快照跟进录制内容，
// 记录侧只刷新名称/大小快照，CreatedAt/ExpiresAt 保持（倒计时不续期）
func (r *shareRepo) createCast(s Share) (*Share, error) {
	if s.RecordingID == "" {
		return nil, fmt.Errorf("%w: cast share requires recordingId", ErrInvalidArg)
	}
	s.ProjectID, s.Path, s.IsDir, s.Frozen = "", "", false, false
	s.Paths = nil
	// 回放是异步观看语义，与「看一眼即焚」相斥（P-20261006-27：创建面已拒绝，
	// 这里兜底清防未来调用方绕过 API 直入 store——一次性字段对回放无意义）
	s.ViewOnce, s.ViewedAt = false, time.Time{}
	if old := r.findCastByRecording(s.RecordingID); old != nil {
		if !old.Expired(time.Now()) {
			// 幂等命中：名称/大小随录制内容刷新（重分享可能已重写快照）；
			// 口令门与 watermark 为可变设置，请求值覆写（与 term-frozen 同款）；
			// CreatedAt/ExpiresAt/Hits 同属记录而非请求，幂等不清零/不续期
			changed := false
			if s.Name != "" && old.Name != s.Name {
				old.Name = s.Name
				changed = true
			}
			if s.Size > 0 && old.Size != s.Size {
				old.Size = s.Size
				changed = true
			}
			if s.PassphraseHash != "" && s.PassphraseHash != old.PassphraseHash {
				old.PassphraseHash = s.PassphraseHash
				changed = true
			}
			if s.Watermark != old.Watermark {
				old.Watermark = s.Watermark
				changed = true
			}
			if s.TerminalID != "" && old.TerminalID != s.TerminalID {
				old.TerminalID = s.TerminalID
				changed = true
			}
			if changed {
				if data, err := json.Marshal(*old); err == nil {
					_ = r.doc.Update(shareKind, old.Token, data)
				}
			}
			return old, nil
		}
		// 命中已过期但未被清理 ticker 扫走的记录：删旧重建（新时钟周期，
		// 落回零代际 token）——snippet/terminal-frozen 同款，不给过期回放借尸还魂
		_ = r.doc.Delete(shareKind, old.Token)
	}
	s.Token = CastNativeToken(config.MasterKey(), s.RecordingID)
	if s.Name == "" {
		s.Name = s.RecordingID
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	// 默认 1 小时保留窗口：回放含全量输出回显，暴露面应短；显式覆盖上限
	// CastShareTTLMax（回放不是持久分享形态，长期留档走 cast 文件导出）
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(CastShareTTL)
	}
	if d := time.Until(s.ExpiresAt); d > CastShareTTLMax {
		s.ExpiresAt = time.Now().Add(CastShareTTLMax)
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// findCastByRecording 按 (kind=cast, RecordingID) 定位存活回放记录（轮换感知
// 的 get-or-create 定位）。分享量级为用户手工创建的个位数到十位数，List 扫描
// 代价可忽略
func (r *shareRepo) findCastByRecording(recordingID string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		if shares[i].Kind == ShareKindCast && shares[i].RecordingID == recordingID {
			return &shares[i]
		}
	}
	return nil
}

// createSession 会话回放只读分享（P-20261003-77）。与 snippet/cast 同构：
// 不绑项目文件系统（ProjectID/Path 清空，锚点是 SessionID）、token 从会话
// ID 确定性派生（同一会话重复分享得到同一短链，幂等重建不续期——倒计时是
// 安全边界）、默认 TTL 创建即定（SessionShareTTL 24 小时，可显式调短，上限
// 同值 SessionShareTTLMax）。既有记录按 (kind=session, sessionID) 定位
// （轮换感知，按 token 找会漏掉已轮换记录）。会话条目快照本体由调用方先行
// 落盘（本函数不碰文件系统——store 不涉车道 2）；重复分享时调用方重写快照
// 跟进会话新增回合，记录侧只刷新名称/大小快照，CreatedAt/ExpiresAt 保持
func (r *shareRepo) createSession(s Share) (*Share, error) {
	if s.SessionID == "" {
		return nil, fmt.Errorf("%w: session share requires sessionId", ErrInvalidArg)
	}
	s.ProjectID, s.Path, s.IsDir, s.Frozen = "", "", false, false
	s.Paths = nil
	// 回放是异步观看语义，与「看一眼即焚」相斥（createCast 同款兜底清）
	s.ViewOnce, s.ViewedAt = false, time.Time{}
	if old := r.findSessionBySession(s.SessionID); old != nil {
		if !old.Expired(time.Now()) {
			// 幂等命中：名称/大小随会话内容刷新（重分享可能已重写快照）；
			// 口令门与 watermark 为可变设置，请求值覆写（与 cast 同款）；
			// CreatedAt/ExpiresAt/Hits 同属记录而非请求，幂等不清零/不续期
			changed := false
			if s.Name != "" && old.Name != s.Name {
				old.Name = s.Name
				changed = true
			}
			if s.Size > 0 && old.Size != s.Size {
				old.Size = s.Size
				changed = true
			}
			if s.PassphraseHash != "" && s.PassphraseHash != old.PassphraseHash {
				old.PassphraseHash = s.PassphraseHash
				changed = true
			}
			if s.Watermark != old.Watermark {
				old.Watermark = s.Watermark
				changed = true
			}
			if changed {
				if data, err := json.Marshal(*old); err == nil {
					_ = r.doc.Update(shareKind, old.Token, data)
				}
			}
			return old, nil
		}
		// 命中已过期但未被清理 ticker 扫走的记录：删旧重建（新时钟周期，
		// 落回零代际 token）——cast/snippet 同款，不给过期回放借尸还魂
		_ = r.doc.Delete(shareKind, old.Token)
	}
	s.Token = SessionNativeToken(config.MasterKey(), s.SessionID)
	if s.Name == "" {
		s.Name = s.SessionID
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	// 默认 24 小时保留窗口：会话回放含思考块与工具详情，暴露面应短；
	// 显式调短有效，上限钳到 SessionShareTTLMax（不提供长留存档）
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(SessionShareTTL)
	}
	if d := time.Until(s.ExpiresAt); d > SessionShareTTLMax {
		s.ExpiresAt = time.Now().Add(SessionShareTTLMax)
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// findSessionBySession 按 (kind=session, SessionID) 定位存活会话回放记录
// （轮换感知的 get-or-create 定位）。分享量级为用户手工创建的个位数到
// 十位数，List 扫描代价可忽略
func (r *shareRepo) findSessionBySession(sessionID string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		if shares[i].Kind == ShareKindSession && shares[i].SessionID == sessionID {
			return &shares[i]
		}
	}
	return nil
}

// createFile 文件/目录分享（既有路径，语义不变）。get-or-create 按
// (ProjectID, Path, Frozen) 定位既有记录而非按派生 token：记录可能已轮换迁键
// （Rotate>0 的 token 不再等于零代际派生值），按 token 找会漏掉已轮换记录、
// 把已作废的旧代际短链复活。Frozen 参与定位：同一目标的 live 与 frozen 是
// 两条独立记录（独立命名空间派生，互不复用短链）
func (r *shareRepo) createFile(s Share) (*Share, error) {
	if s.ProjectID == "" {
		return nil, fmt.Errorf("%w: share requires projectId", ErrInvalidArg)
	}
	// 批量冻结分享（P-20261008-1）：paths 非空即集合语义，与单路径分支完全
	// 分立（独立命名空间派生，单路径 batch 也不会与单文件分享撞链）。MVP 仅
	// frozen：live 的实时多根锚定语义未定义，store 兜底拒绝防调用方绕过 API
	if len(s.Paths) > 0 {
		if !s.Frozen {
			return nil, fmt.Errorf("%w: batch share requires frozen mode", ErrInvalidArg)
		}
		paths, err := CanonicalSharePaths(s.Paths)
		if err != nil {
			return nil, err
		}
		s.Paths = paths
		s.Path = ""
		// 集合不是单一根：IsDir 在访客/管理面只描述单路径目标，批量形态恒 false
		s.IsDir = false
		// 定格留证语义与一次性相斥（P-20261006-27，单路径 frozen 同款兜底清）
		s.ViewOnce, s.ViewedAt = false, time.Time{}
		if old := r.findByBatchTarget(s.ProjectID, paths); old != nil {
			s.Token = old.Token
			s.Rotate = old.Rotate
			s.CreatedAt = old.CreatedAt
			s.ExpiresAt = old.ExpiresAt
			s.Hits = old.Hits
			s.LastAccessAt = old.LastAccessAt
			s.MessageCount = old.MessageCount
			// 退役台账同属记录（P-20261008-2）：幂等重建不清零——外泄观测
			// 面不得因分享者再点一次分享而丢失
			s.RetiredTokens = old.RetiredTokens
			if s.PassphraseHash == "" {
				s.PassphraseHash = old.PassphraseHash
			}
			if data, err := json.Marshal(s); err == nil {
				_ = r.doc.Update(shareKind, s.Token, data)
			}
			return &s, nil
		}
		s.Token = FrozenBatchNativeToken(config.MasterKey(), s.ProjectID, paths)
		if s.CreatedAt.IsZero() {
			s.CreatedAt = time.Now()
			// 冻结分享默认 30 天保留窗口（FrozenTTL），与单路径 frozen 同款
			if s.ExpiresAt.IsZero() {
				s.ExpiresAt = time.Now().Add(FrozenTTL)
			}
		}
		data, err := json.Marshal(s)
		if err != nil {
			return nil, fmt.Errorf("marshal share: %w", err)
		}
		if err := r.doc.Create(shareKind, s.Token, data); err != nil {
			return nil, err
		}
		return &s, nil
	}
	if s.Frozen {
		// 冻结快照是「定格留证」语义，与「看一眼即焚」相斥（P-20261006-27：
		// 创建面已拒绝组合，store 兜底清——frozen 记录永不携带一次性标志）
		s.ViewOnce, s.ViewedAt = false, time.Time{}
	}
	s.Path = strings.Trim(strings.ReplaceAll(s.Path, "\\", "/"), "/")
	for _, seg := range strings.Split(s.Path, "/") {
		if seg == ".." {
			return nil, fmt.Errorf("%w: share path must not traverse up", ErrInvalidArg)
		}
	}
	if old := r.findByFileTarget(s.ProjectID, s.Path, s.Frozen); old != nil {
		s.Token = old.Token
		s.Rotate = old.Rotate
		s.CreatedAt = old.CreatedAt
		// ExpiresAt 同 CreatedAt 口径：幂等重建不刷新（opt-in TTL 的倒计时
		// 是安全边界，重复分享不得暗中清零续成永久——调整有效期走显式的
		// SetExpiry，与 snippet 倒计时不续期同构）
		s.ExpiresAt = old.ExpiresAt
		// 访问指标同属记录而非请求：幂等重建返回同一条短链，历史暴露量
		// 不因分享者再点一次分享而清零（语义对齐 CreatedAt 不刷新）
		s.Hits = old.Hits
		s.LastAccessAt = old.LastAccessAt
		// 留言计数同属记录（P-20261006-13）：幂等重建不清零——附表文档仍在，
		// 计数清零会让「留言 N」角标与真实存量脱节
		s.MessageCount = old.MessageCount
		// 退役台账同属记录（P-20261008-2）：幂等重建不清零——「退役访问 N 次」
		// 徽标与外泄告警的观测面不得因分享者再点一次分享而丢失
		s.RetiredTokens = old.RetiredTokens
		// 口令门同属记录：幂等重建不带 passphrase 时保持既有口令（重复分享
		// 不得暗中拆掉已设的门）；请求显式带了新哈希 = 分享者主动改口令，
		// 覆写生效（访客门会话 cookie 绑定哈希，改口令即全体重验）
		if s.PassphraseHash == "" {
			s.PassphraseHash = old.PassphraseHash
		}
		// 一次性开关（P-20261006-27）与 watermark 同为「请求值覆写」的可变
		// 设置，但失效时钟（ViewedAt）同属记录而非请求：保持一次性时沿用
		// 既有 ViewedAt（重复分享不得重置已启动的焚毁倒计时）；显式关闭
		// 一次性则连时钟一并清（再次开启 = 重新武装，从零起算）
		if s.ViewOnce {
			s.ViewedAt = old.ViewedAt
		} else {
			s.ViewedAt = time.Time{}
		}
		if data, err := json.Marshal(s); err == nil {
			_ = r.doc.Update(shareKind, s.Token, data)
		}
		return &s, nil
	}
	// 派生命名空间与创建路径同构：file 按 (ProjectID, Path)、frozen 按保留
	// 命名空间 + (ProjectID, Path)、snippet 按 保留命名空间 + 内容、terminal
	// 按保留命名空间 + 会话 ID、terminal-frozen 按 保留命名空间 + 会话 ID +
	// 内容哈希、cast 按 保留命名空间 + 录制 ID、session 按 保留命名空间 +
	// 会话 ID；Kind 缺省按 file（存量记录零迁移）
	ns, key := s.ProjectID, s.Path
	if s.Kind == ShareKindSnippet {
		ns, key = snippetTokenNamespace, s.Content
	} else if s.Kind == ShareKindTerminal {
		ns, key = terminalTokenNamespace, s.TerminalID
	} else if s.Kind == ShareKindTermFrozen {
		ns, key = termFrozenTokenNamespace, s.TerminalID+"\x00"+s.ContentHash
	} else if s.Kind == ShareKindCast {
		ns, key = castTokenNamespace, s.RecordingID
	} else if s.Kind == ShareKindSession {
		ns, key = sessionTokenNamespace, s.SessionID
	} else if s.Frozen {
		ns, key = frozenTokenNamespace, s.ProjectID+"\x00"+s.Path
	}
	s.Token = DeriveShareToken(config.MasterKey(), ns, key, 0)

	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
		// 冻结分享默认 30 天保留窗口（FrozenTTL）：副本是落盘数据，创建即定
		// 倒计时防磁盘长尾；显式调整走 SetExpiry（与 snippet 创建即定 TTL 同构）
		if s.Frozen && s.ExpiresAt.IsZero() {
			s.ExpiresAt = time.Now().Add(FrozenTTL)
		}
		if data, err = json.Marshal(s); err != nil {
			return nil, err
		}
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// findByFileTarget 按 (ProjectID, Path, Frozen) 定位文件/目录分享记录
// （轮换感知的 get-or-create 定位）。分享量级为用户手工创建的个位数到十位数，
// List 扫描代价可忽略；Kind 缺省按 file 解读（存量记录零迁移）。Frozen 参与
// 匹配：live 与 frozen 是独立记录空间，互不命中
func (r *shareRepo) findByFileTarget(projectID, path string, frozen bool) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		kind := shares[i].Kind
		if kind == "" {
			kind = ShareKindFile
		}
		if kind == ShareKindFile && shares[i].Frozen == frozen &&
			shares[i].ProjectID == projectID && shares[i].Path == path {
			return &shares[i]
		}
	}
	return nil
}

// findByBatchTarget 按 (ProjectID, 规范化路径集合) 定位多路径冻结分享记录
// （轮换感知的 get-or-create 定位，findByFileTarget 同口径）。集合全等比较
// 依赖 CanonicalSharePaths 的排序去重——同集合不同选择顺序命中同一条链
func (r *shareRepo) findByBatchTarget(projectID string, paths []string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		s := &shares[i]
		kind := s.Kind
		if kind == "" {
			kind = ShareKindFile
		}
		if kind != ShareKindFile || !s.Frozen || s.ProjectID != projectID || len(s.Paths) == 0 {
			continue
		}
		if equalPathSets(s.Paths, paths) {
			return s
		}
	}
	return nil
}

// equalPathSets 两个规范化路径集合的全等比较（长度 + 逐项，顺序已排序）
func equalPathSets(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// createSnippet 文本片段分享。不绑项目（ProjectID/Path 清空）；Token 从内容
// 确定性派生（"同一段文本恒同一短链"，与文件派生同构、经保留命名空间隔离）。
// 已存在时整体返回既有记录（CreatedAt/ExpiresAt 均不刷新——倒计时是安全边界，
// 幂等重建不得续期）。既有记录按 (kind, content) 全等定位而非按派生 token：
// 轮换会迁键，按 token 找会漏掉已轮换记录、把旧代际短链复活（createFile 的
// 目标扫描同款）。内容上限 MaxSnippetBytes，空内容拒绝
func (r *shareRepo) createSnippet(s Share) (*Share, error) {
	if s.Content == "" {
		return nil, fmt.Errorf("%w: snippet content is empty", ErrInvalidArg)
	}
	if len(s.Content) > MaxSnippetBytes {
		return nil, fmt.Errorf("%w: snippet exceeds %d bytes", ErrInvalidArg, MaxSnippetBytes)
	}
	s.ProjectID, s.Path, s.IsDir = "", "", false
	s.Paths = nil
	s.Size = int64(len(s.Content))
	s.Token = DeriveShareToken(config.MasterKey(), snippetTokenNamespace, s.Content, 0)
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(SnippetTTL)
	}
	if old := r.findSnippetByContent(s.Content); old != nil {
		if !old.Expired(time.Now()) {
			// 幂等命中：请求带新口令哈希 = 分享者主动加/改门，覆写生效；
			// 不带 = 保持既有（含「已设门不得被重复分享拆掉」）。watermark 同为
			// 可变展示设置，请求值覆写（管理面缺省传 true）。其余字段原样
			//（CreatedAt/ExpiresAt 不刷新，倒计时是安全边界）
			changed := false
			if s.PassphraseHash != "" && s.PassphraseHash != old.PassphraseHash {
				old.PassphraseHash = s.PassphraseHash
				changed = true
			}
			if s.Watermark != old.Watermark {
				old.Watermark = s.Watermark
				changed = true
			}
			// 一次性开关请求值覆写（P-20261006-27）：关闭清时钟；开启保持
			// 既有 ViewedAt 原样（旧记录已是零值自然为零，已武装不重置——
			// createFile 同款语义；old 即落库态，无需从请求回填）
			if s.ViewOnce != old.ViewOnce {
				old.ViewOnce = s.ViewOnce
				changed = true
			}
			if !s.ViewOnce && !old.ViewedAt.IsZero() {
				old.ViewedAt = time.Time{}
				changed = true
			}
			if changed {
				if data, err := json.Marshal(*old); err == nil {
					_ = r.doc.Update(shareKind, old.Token, data)
				}
			}
			return old, nil
		}
		// 命中已过期但尚未被清理 ticker 扫走的记录：删旧重建（新时钟周期，
		// 落回零代际 token）——幂等语义只对存活短链延续，不给过期内容借尸还魂
		_ = r.doc.Delete(shareKind, old.Token)
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// findSnippetByContent 按内容全等定位存活 snippet 记录（轮换感知的
// get-or-create 定位；snippet Kind 自 P-71 起恒显式落库，无缺省形态问题）。
// 内容以明文随记录落库（≤32KiB），比对代价与 List 扫描同量级
func (r *shareRepo) findSnippetByContent(content string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		if shares[i].Kind == ShareKindSnippet && shares[i].Content == content {
			return &shares[i]
		}
	}
	return nil
}

// CleanupExpired 删除已过保留窗口的记录（片段过期即删；opt-in TTL 到期的
// 文件分享同样命中 Expired），留言附表随记录级联删除（P-20261006-13——
// 生命周期与分享一体）。单条删除失败不阻断整轮（下一周期重试同批余量）。
// 退役反向索引随宿主摘除（P-20261008-2：台账与记录同生命周期）
func (r *shareRepo) CleanupExpired(now time.Time) (int, error) {
	shares, err := r.List()
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, s := range shares {
		if !s.Expired(now) {
			continue
		}
		if err := r.doc.Delete(shareKind, s.Token); err != nil {
			continue
		}
		removed++
		// 退役索引跟进（清单取自删除前的 List 快照；残留由 FindRetired
		// 自愈分支兜底）
		r.retiredForgetHost(s.Token, s.RetiredTokens)
		// 留言级联（尽力而为：失败残留由孤儿对账 GCOrphans 兜底清账）
		if r.msgs != nil {
			_, _ = r.msgs.deleteAll(s.Token)
		}
	}
	return removed, nil
}

// SetExpiry 显式调整文件/目录分享的有效期（opt-in TTL，P-20261003-29 的
// 用户入口）：expiresAt 零值 = 恢复永久。仅整记录覆写 ExpiresAt 一个字段，
// 其余原样（含 CreatedAt/Rotate）——调整有效期不是重建，短链保持不变。
// snippet 拒绝调整：24h 倒计时是创建即定的固定安全边界（SnippetTTL），
// 开放调整等于给短期暴露开口子；未知/已撤销/已过期 → ErrNotFound（与
// Rotate 同口径——已过期记录对访客面已死亡，不接受借尸还魂，等清理扫走）
func (r *shareRepo) SetExpiry(token string, expiresAt time.Time) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Kind == ShareKindSnippet {
		return nil, fmt.Errorf("%w: snippet expiry is fixed", ErrInvalidArg)
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound
	}
	s.ExpiresAt = expiresAt
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Update(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return s, nil
}

// SetPassphrase 设置/更换/移除访问口令门（P-20261006-25）。与 SetExpiry 同款
// RMW：Get→覆写 PassphraseHash→Update，其余字段原样（短链不变）。调用方
// （管理面 handler）负责 bcrypt 哈希，store 只认哈希不接触明文。空 hash =
// 移除口令（json omitempty 落库即字段消失，回到无门语义）。已过期记录拒绝
// （ErrNotFound，与 SetExpiry/Rotate 同口径——过期记录对访客面已死亡）
func (r *shareRepo) SetPassphrase(token string, hash string) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound
	}
	s.PassphraseHash = hash
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Update(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return s, nil
}

// SetCollab 协作通道开关（P-20261024-1）：与 SetPassphrase 同款 RMW，
// 只覆写 Collab 单字段。开关是动作化语义（分享无编辑面），关闭不清理
// 已收素材（那是落盘数据，回收的是「新上行」面；素材随记录撤销/过期
// 级联清，见 shareapi 清账管线）
func (r *shareRepo) SetCollab(token string, collab bool) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound
	}
	s.Collab = collab
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Update(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return s, nil
}

// SetDirectInput 直通输入档开关（P-20261024-1 第二档）：RMW 同款，只覆写
// DirectInput 单字段。持权状态与会话侧只读闸是进程内状态，由装配层在
// 调用前后级联摘除——store 只管记录字段（重启即清的短时效状态不落盘）
func (r *shareRepo) SetDirectInput(token string, on bool) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound
	}
	s.DirectInput = on
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Update(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return s, nil
}

func (r *shareRepo) List() ([]Share, error) {
	keys, _, err := r.doc.List(shareKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]Share, 0, len(keys))
	for _, k := range keys {
		data, err := r.doc.Get(shareKind, k)
		if err != nil {
			continue
		}
		var s Share
		if json.Unmarshal(data, &s) == nil {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (r *shareRepo) Get(token string) (*Share, error) {
	data, err := r.doc.Get(shareKind, token)
	if err != nil {
		return nil, ErrNotFound
	}
	var s Share
	if json.Unmarshal(data, &s) != nil {
		return nil, ErrNotFound
	}
	return &s, nil
}

// getLive 存活记录读取（留言附表的写入前置）：不存在/已过期统一 ErrNotFound
// ——过期未及清账的记录对访客面已死亡（share.lookup 惰性删除同口径），
// 不接受借尸还魂
func (r *shareRepo) getLive(token string) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound
	}
	return s, nil
}

// Delete 撤销分享 + 留言附表级联删除（P-20261006-13：生命周期与分享一体
// ——短链死亡后附表不留尸）。先删记录（链接即刻失效是主语义）再级联，
// 级联尽力而为：失败残留由孤儿对账 GCOrphans 兜底清账。退役反向索引随
// 宿主摘除（P-20261008-2：撤销后该记录台账内的退役 token 命中退化为
// 普通 404，与「从未存在」同观感——观测随宿主消亡；台账在删除前读出，
// 读不到不阻断删除主流程，索引残留由 FindRetired 自愈分支兜底）
func (r *shareRepo) Delete(token string) error {
	cur, gerr := r.Get(token)
	if err := r.doc.Delete(shareKind, token); err != nil {
		return err
	}
	if gerr == nil {
		r.retiredForgetHost(token, cur.RetiredTokens)
	}
	if r.msgs != nil {
		_, _ = r.msgs.deleteAll(token)
	}
	return nil
}

// RecordHits 访问计数累加（P-20261002-14 的落盘侧）：读改写整文档只动
// Hits/LastAccessAt 两个字段，其余原样（含 ExpiresAt/Rotate）。与 SetExpiry
// 等 RMW 写共享「Get→Update 间隙」的既有取舍（filestore per-kind 锁只串行化
// 单次写、不覆盖跨调用 RMW）——管理面写是用户手工低频、命中冲刷是定时低频，
// 双低频相撞的丢失窗口可忽略，为此引入乐观锁不值当（与 snippets/terminal_history
// 同款债务，不新增面）。n ≤ 0 直接返回 nil（访客面聚合器不会产生，防御未来调用方）
func (r *shareRepo) RecordHits(token string, n int64, at time.Time) error {
	if n <= 0 {
		return nil
	}
	s, err := r.Get(token)
	if err != nil {
		return err
	}
	s.Hits += n
	s.LastAccessAt = at
	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("marshal share: %w", err)
	}
	return r.doc.Update(shareKind, s.Token, data)
}

// MarkFirstView 一次性分享显式确认落库（P-20261006-27；P-20261020-3 起由
// 访客确认 POST /s/{token}/view 调用，GET 预览抓取不再触达）。first-writer-wins：
// 只在 ViewedAt 为零值时写入——并发两访客同开时 filestore per-kind 锁把两
// 次 RMW 串行化，后到的读到的已是非零 ViewedAt，no-op 返回；即便 Get 与
// Update 间隙交叠（RecordHits 同款已知取舍），最坏也只是「较晚的时点覆盖
// 较早的」，宽限窗只延后不缩短，无安全面损失。已武装/非一次性直接放行
// （访客热路径的常态分支，一次 map 读即出）
func (r *shareRepo) MarkFirstView(token string, at time.Time) error {
	s, err := r.Get(token)
	if err != nil {
		return err
	}
	if !s.ViewOnce || !s.ViewedAt.IsZero() {
		return nil
	}
	s.ViewedAt = at
	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("marshal share: %w", err)
	}
	return r.doc.Update(shareKind, s.Token, data)
}

// Rotate 轮换短链（P-20261002-72 泄露应对）：代际 +1 重新派生 token 并迁键
// ——旧 token 立即失效（访客面按 token 查记录，迁键即 404），新 token 即刻
// 可用。元数据全部保留（名称/大小/CreatedAt；snippet 的 ExpiresAt 不续期
// ——倒计时是安全边界，轮换不得成为续期通道）。写序先建新后删旧：建新失败
// 时旧链原样存活（轮换可重试，绝不把分享弄死）；删旧失败至多留下一条待手动
// 撤销的旧链，不丢数据。未知/已撤销/已过期 → ErrNotFound
func (r *shareRepo) Rotate(token string) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound // 已过期未及清理的残留：对访客面已不可达，同拒
	}
	// 派生命名空间与创建路径同构：file 按 (ProjectID, Path)、frozen 按保留
	// 命名空间 + (ProjectID, Path)、snippet 按 保留命名空间 + 内容、terminal
	// 按保留命名空间 + 会话 ID、terminal-frozen 按 保留命名空间 + 会话 ID +
	// 内容哈希、session 按 保留命名空间 + 会话 ID；Kind 缺省按 file（存量
	// 记录零迁移）。frozen/terminal-frozen 轮换只换短链代际——快照目录名
	// 锚定零代际值（FrozenNativeToken / TermFrozenNativeToken），副本原地
	// 不动；cast/session 同构（CastNativeToken / SessionNativeToken，录制 ID /
	// 会话 ID 是零代际稳定键）
	ns, key := s.ProjectID, s.Path
	if s.Kind == ShareKindSnippet {
		ns, key = snippetTokenNamespace, s.Content
	} else if s.Kind == ShareKindTerminal {
		ns, key = terminalTokenNamespace, s.TerminalID
	} else if s.Kind == ShareKindTermFrozen {
		ns, key = termFrozenTokenNamespace, s.TerminalID+"\x00"+s.ContentHash
	} else if s.Kind == ShareKindCast {
		ns, key = castTokenNamespace, s.RecordingID
	} else if s.Kind == ShareKindSession {
		ns, key = sessionTokenNamespace, s.SessionID
	} else if s.Frozen {
		if len(s.Paths) > 0 {
			// 批量冻结（P-20261008-1）：集合键参与派生；rotate 只换代际，
			// 快照目录名锚零代际值（FrozenBatchNativeToken），副本原地不动
			ns, key = frozenBatchTokenNamespace, frozenBatchShareKey(s.ProjectID, s.Paths)
		} else {
			ns, key = frozenTokenNamespace, s.ProjectID+"\x00"+s.Path
		}
	}
	s.Rotate++
	s.Token = DeriveShareToken(config.MasterKey(), ns, key, s.Rotate)
	// 退役台账记账（P-20261008-2）：被替换的旧 token 追加进记录随新键落盘
	// ——旧链对访客面已死，但「死链仍被踩」是零误报的外泄确认信号（告警/
	// 徽标的数据源）。上限护栏逐出最旧（自动化高频轮换的文档无界防线）；
	// 台账写在新记录的 Create 里（先建新后删旧的既有写序，台账与迁键同批，
	// 崩溃窗口不留半态——台账缺失至多丢观测，不丢语义）
	s.RetiredTokens = appendRetiredToken(s.RetiredTokens, RetiredToken{
		Token:     token,
		RetiredAt: time.Now(),
	})
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	if err := r.doc.Delete(shareKind, token); err != nil {
		return nil, err
	}
	// 留言迁键（P-20261006-13）：轮换换的是短链不是分享——访客附言跟记录
	// 走（角标计数随记录字段天然连续）。尽力而为：失败残留由孤儿对账兜底
	if r.msgs != nil {
		r.msgs.migrateToken(token, s.Token)
	}
	// 退役反向索引跟进（FindRetired 的 O(1) 查询面）：旧 token → 新记录键。
	// 放在迁键成功之后——迁键失败时索引不得指向不存在的宿主
	r.retiredRemember(token, s.Token)
	return s, nil
}

// appendRetiredToken 退役台账追加（上限护栏 + 去重防御）：同 token 重复追加
// 是调用方 bug（一次 Rotate 只产生一个退役 token），静默合并不扩表；超上限
// 逐出最旧——保留最近代际（最新退役链才是与当前外发副本对应的观测面，见
// RetiredTokensMax）
func appendRetiredToken(list []RetiredToken, e RetiredToken) []RetiredToken {
	for i := range list {
		if list[i].Token == e.Token {
			return list
		}
	}
	list = append(list, e)
	if len(list) > RetiredTokensMax {
		return list[len(list)-RetiredTokensMax:]
	}
	return list
}

// RecordRetiredHit 退役短链命中计数累加（P-20261008-2 落盘侧）。定位宿主
// 依赖反向索引（FindRetired 同一数据面）：索引 miss = 该 token 不在任何存活
// 记录的台账中（记录已撤销/过期/从未存在）→ ErrNotFound，调用方丢弃该批。
// RMW 只动命中条目的 Hits/LastHitAt 两个字段（RecordHits 同款「Get→Update
// 间隙」取舍，不新增面）；n ≤ 0 直接返回 nil（防御未来调用方）
func (r *shareRepo) RecordRetiredHit(retiredToken string, n int64, at time.Time) (*Share, error) {
	if n <= 0 {
		return nil, nil
	}
	host, ok := r.retiredHostOf(retiredToken)
	if !ok {
		return nil, ErrNotFound
	}
	s, err := r.Get(host)
	if err != nil {
		return nil, err
	}
	// 索引与落盘的偏差兜底：索引指向的宿主记录里找不到该条目（理论不可达
	// ——rotate 记账先于索引写入且两者同源）按无宿主处理，不给调用方幻觉
	for i := range s.RetiredTokens {
		if s.RetiredTokens[i].Token != retiredToken {
			continue
		}
		s.RetiredTokens[i].Hits += n
		s.RetiredTokens[i].LastHitAt = at
		data, err := json.Marshal(s)
		if err != nil {
			return nil, fmt.Errorf("marshal share: %w", err)
		}
		if err := r.doc.Update(shareKind, s.Token, data); err != nil {
			return nil, err
		}
		return s, nil
	}
	return nil, ErrNotFound
}

// FindRetired 退役短链反查宿主（P-20261008-2 访客面命中钩子的只读查询）。
// 只读不写盘、未命中一次 map 读——访客 404 热路径的常态分支
func (r *shareRepo) FindRetired(retiredToken string) (*Share, bool) {
	host, ok := r.retiredHostOf(retiredToken)
	if !ok {
		return nil, false
	}
	s, err := r.Get(host)
	if err != nil {
		// 索引指向的宿主已不可读（惰性清理竞态窗口）：按无宿主处理并摘除
		// 失效索引项（下次查询不再空转）
		r.retiredForget(retiredToken)
		return nil, false
	}
	return s, true
}

// retiredHostOf 反查宿主 token（索引惰性重建的收口点）。首次查询时 List
// 扫描全量记录构建（启动后的第一发 404 付一次全表读，此后纯内存）；构建
// 失败不置位——下次查询重试，绝不带着残缺索引回答「不在」
func (r *shareRepo) retiredHostOf(retiredToken string) (string, bool) {
	r.retiredMu.Lock()
	defer r.retiredMu.Unlock()
	if !r.retiredInit {
		idx := make(map[string]string)
		if shares, err := r.List(); err == nil {
			for i := range shares {
				for _, rt := range shares[i].RetiredTokens {
					idx[rt.Token] = shares[i].Token
				}
			}
			r.retiredIdx = idx
			r.retiredInit = true
		}
	}
	host, ok := r.retiredIdx[retiredToken]
	return host, ok
}

// retiredRemember 登记一条退役映射（Rotate 迁键成功后调用；并发安全）
func (r *shareRepo) retiredRemember(retired, host string) {
	r.retiredMu.Lock()
	defer r.retiredMu.Unlock()
	if !r.retiredInit {
		return // 索引未构建：下次查询的全量扫描天然包含本条，无需增量
	}
	if r.retiredIdx == nil {
		r.retiredIdx = make(map[string]string)
	}
	r.retiredIdx[retired] = host
}

// retiredForget 摘除一条退役映射（宿主不可读时的自愈；并发安全）
func (r *shareRepo) retiredForget(retired string) {
	r.retiredMu.Lock()
	defer r.retiredMu.Unlock()
	delete(r.retiredIdx, retired)
}

// retiredForgetHost 宿主记录消亡时摘除其全部退役映射（Delete/
// CleanupExpired 的索引跟进）：退役台账与记录同生命周期，宿主亡后台账
// 无从更新，命中退化为普通 404（与「从未存在」同观感）。hostRetired 为
// 调用方在记录消亡前读出的台账（删除后 Get 不到，清单须先行备好）——
// 只摘仍指向本宿主的项，防误摘已被新宿主接管的键（理论不可达，防御）
func (r *shareRepo) retiredForgetHost(hostToken string, hostRetired []RetiredToken) {
	r.retiredMu.Lock()
	defer r.retiredMu.Unlock()
	for _, rt := range hostRetired {
		if r.retiredIdx[rt.Token] == hostToken {
			delete(r.retiredIdx, rt.Token)
		}
	}
}
