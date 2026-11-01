package agentops

// 原子呈现能力注册表（P-20261022-3）：agent「把结果送到用户眼前」的原语按
// 「动词.目标」正交建模，是手册（ops-manual ops-channel 节内置事件目录）、
// 人类深链表、/api/meta 能力项与双侧漂移门禁的单一事实源。
//
// 为什么要有注册表：此前呈现原语以 ~30 个扁平 ops 事件各自为政——手册手写
// 双份（OPS_EVENTS.md 与 ops-manual 各写一遍），navigate 载荷扩展（P-20261005-223
// 四形态）落地时手册没跟，「实现了没写」让 agent 只会背 {"path":"/project"}
// 首形态、编造自然但不存在的深链 URL（/project/:id/files 404 事故即源于此）。
// 注册表收编后：注册原子 = 手册自动在册（新增能力不写手册不可能发生）、深链
// 按表拼（编造 URL 从机制上杜绝）、字段漂移被双侧快照对账拦下。
//
// 与既有防线的分工：server/archguard/testdata/ops-events.json 冻结「事件级」
// 契约（常量集/广播点/载荷键/手册锚）；本注册表是「原子级」视图（动词×目标
// 切分 + 人类深链形态），原子载荷字段必须 ⊆ 所属事件的契约键（capabilities_test.go
// 交叉对账），两层互补不重复。
//
// 扩展纪律：新增呈现原语 = RegisterPresentAtom 一条（含手册文案）→
// ops-events.json（若新增事件 type）/ present-atoms.json 两快照同 PR 跟随 →
// 手册与 /api/meta（ops.present-atoms 能力项）自动跟随。不要绕过注册表往
// sections_builtin.go 手写内置事件条目——那是本提案根除的漂移形态。

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"codecombo/server/mask"
)

// PresentAtom 原子呈现能力：一个「动词.目标」组合（如 navigate.file / present.tree）。
// 同一事件承载多原子（navigate 五形态共享 "navigate" 事件）时按目标切分登记，
// agent 侧按原子探测与组合，线上协议（事件 type 与载荷）零变化
type PresentAtom struct {
	// ID 动词.目标（点分式，如 navigate.file）：注册表主键，快照与手册目录行同值
	ID string
	// Verb 动词族：navigate（注意力引导）/ present（送到眼前）/ notify（触达与留痕）
	// / frontend（替用户执行浏览器动作，P-20261023-4 首批）/ ask（向人提问）/
	// await（等待裁决与进度）——ask/await 预留给 ops-ask / ops-confirm 族的后续收编
	Verb string
	// Event 承载事件 type（POST /api/ops-notify 的 type 字段值；与
	// server/api/opschannel/events.go 常量同值——对账测试交叉核对）
	Event string
	// Summary 一句话摘要（手册目录行尾 + 双侧快照对账）
	Summary string
	// Payload 载荷形态行（单行紧凑 JSON 形态示例，手册目录行主体）
	Payload string
	// PayloadFields 载荷契约字段集（机器可读，字典序）：present-atoms.json 双侧
	// 快照对账键——web 侧镜像单测据此核对 TS 事件 detail 接口字段（注册表声明
	// 的字段前端必须能消费），Go 侧测试另行核对 ⊆ ops-events.json 事件契约键
	// （原子形态字段不越事件契约）。Payload 文案行是给人读的示例，本字段是
	// 对账用的机器形态，两者同 PR 更新
	PayloadFields []string
	// Detail 可选细节（多行；每行原样进手册，自行携带缩进）
	Detail string
	// DeepLink 可选人类深链形态 id（DeepLinkKinds 之一，如 "file"）——该原语的
	// 等价「给用户一条可点 URL」表达；空 = 无深链形态
	DeepLink string
	// Validate 载荷校验规整函数（发布口就地调用，坏载荷 400 退回）。
	// nil = 无服务端校验：navigate 族的既有语义是前端按字段首命中、未知形态
	// 宽容忽略（开放词表哲学，e2e 已钉），此处从宽不从严
	Validate func(payload interface{}) (interface{}, bool)
	// InvalidPayloadMessage Validate 失败时发布口 400 响应的 message——既有事件
	// 的原文在此冻结（e2e 断言逐字匹配，改文案 = 破坏 agent 侧分支依据）
	InvalidPayloadMessage string
}

var (
	atomMu   sync.RWMutex
	atomRegs = map[string]PresentAtom{}
)

// RegisterPresentAtom 注册/覆盖一个原子（同 ID 覆盖；启动期注册、运行期只读，
// 与 Section 注册表同一并发模型）
func RegisterPresentAtom(a PresentAtom) {
	atomMu.Lock()
	defer atomMu.Unlock()
	atomRegs[a.ID] = a
}

// PresentAtoms 返回按 ID 排序的全部原子快照
func PresentAtoms() []PresentAtom {
	atomMu.RLock()
	defer atomMu.RUnlock()
	out := make([]PresentAtom, 0, len(atomRegs))
	for _, a := range atomRegs {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// AtomForEvent 返回该事件 type 的承载校验原子（每事件至多一个带 Validate 的
// 原子——capabilities_test.go 唯一性守卫；navigate 族五原子共享事件但校验恒
// nil 宽容透传，扫不到即返回 nil）。未收编校验的事件返回 nil，如
// preview.port / task.progress：校验与服务端伴生副作用耦合在发布口特判，
// 见 ai/opsentry.go
func AtomForEvent(event string) *PresentAtom {
	atomMu.RLock()
	defer atomMu.RUnlock()
	for _, a := range atomRegs {
		if a.Event == event && a.Validate != nil {
			cp := a
			return &cp
		}
	}
	return nil
}

// ============== 人类深链原语（把某文件/视图送到用户眼前的 URL 形态） ==============

// DeepLinkKind 一类人类深链的 URL 形态声明。深链表与前端消费逻辑双向锁死：
// file 形态的参数集 == web/src/utils/presentAtoms.ts parseFileDeepLinkQuery
// 消费的参数集（镜像单测读本快照对账，增删参数不同步即红）
type DeepLinkKind struct {
	// ID 形态标识（file/view/monitor/session）
	ID string
	// Pattern URL 形态（<> 占位标注可变段；[ ] 标注可选段）
	Pattern string
	// Params 该形态的 query 参数全集（字典序；session 形态是通知动作非 URL，
	// params 为其动作域字段）。快照与前端消费面对账键
	Params []string
	// Doc 手册说明行
	Doc string
}

// deepLinkKinds 人类深链表（注册表内声明式维护；深链是纯前端路由事实，无
// 服务端校验面——参数形态的前端守卫见 parseFileDeepLinkQuery 镜像单测）
var deepLinkKinds = []DeepLinkKind{
	{
		ID:      "file",
		Pattern: "/project?file=<项目相对路径>&project=<项目id>&line=<N>&col=<M>[&diff=1]",
		Params:  []string{"col", "diff", "file", "line", "project"},
		Doc:     "文件深链：编辑器打开目标文件（必要时切项目 → 行定位）；diff=1 = vs HEAD 工作区差异视图（无行定位语义）",
	},
	{
		ID:      "view",
		Pattern: "/project?view=<remote|shares|dashboard>[&host=<主机id>]",
		Params:  []string{"host", "view"},
		Doc:     "主区视图深链：remote=远程控制台（host 可选自动开终端）/ shares=分享管理 / dashboard=项目仪表盘",
	},
	{
		ID:      "monitor",
		Pattern: "/monitor[?fleet=<batchId>]",
		Params:  []string{"fleet"},
		Doc:     "值班大屏：fleet=<batchId> 聚合卡高亮并自动展开（编队追踪）",
	},
	{
		ID:      "session",
		Pattern: "notify.persist {\"action\":\"terminal\",\"actionPayload\":\"<会话id>\"}",
		Params:  []string{"action", "actionPayload"},
		Doc:     "会话直达（通知动作形态，非 URL）：用户通知中心点「查看会话」直达该终端——深链表内唯一非 URL 形态",
	},
}

// DeepLinkKinds 返回深链表快照（声明序）
func DeepLinkKinds() []DeepLinkKind {
	out := make([]DeepLinkKind, len(deepLinkKinds))
	copy(out, deepLinkKinds)
	return out
}

// FileDeepLink 拼文件深链 URL（agent 给用户发链接按此拼，编造 URL 从机制上
// 杜绝；与前端 useFileDeepLink「复制文件链接」产出同参同形——web 侧镜像单测
// 锁死）。line/col ≤0 与 project 空串 = 不携带对应参数；diff=true 追加 diff=1
// （对比视图，line/col 语义不适用，调用方传 true 时 line/col 应为零值）
func FileDeepLink(file, project string, line, col int, diff bool) string {
	q := url.Values{}
	q.Set("file", file)
	if project != "" {
		q.Set("project", project)
	}
	if line >= 1 {
		q.Set("line", strconv.Itoa(line))
	}
	if col >= 1 {
		q.Set("col", strconv.Itoa(col))
	}
	if diff {
		q.Set("diff", "1")
	}
	return "/project?" + q.Encode()
}

// ============== 手册渲染（注册表即手册） ==============
//
// PresentAtomsDoc 渲染 ops-channel 节的内置事件目录（sections_builtin.go 的
// {{PRESENT_ATOMS}} 占位在 Manual()/SkillReferences() 渲染期展开——占位而非
// init 期拼接，规避跨包 init 顺序问题）。目录按事件分组、原子逐行列出：
// 「实现了没写」在结构上不可能——新增能力注册即自动在册。
func PresentAtomsDoc() string {
	atoms := PresentAtoms()
	var sb strings.Builder
	sb.WriteString("  内置事件（原子能力注册表渲染：动词.目标 = 可探测可组合的呈现原语，\n")
	sb.WriteString("  同一事件可承载多原子；服务端单一事实源 server/agentops/capabilities.go，\n")
	sb.WriteString("  新增能力注册即自动在册。发布端点 POST /api/ops-notify，坏载荷 400 退回。\n")
	sb.WriteString("  注意：每行原子 id 后引号内的事件名才是上报 type（线协议名，如 present.file\n")
	sb.WriteString("  发 type=\"open-file-at\"）——发原子 id 是无消费者的静默无效上报）：\n")
	for _, a := range atoms {
		sb.WriteString("  - " + a.ID + "  \"" + a.Event + "\"  payload " + a.Payload + "\n")
		if a.Summary != "" {
			sb.WriteString("          " + strings.ReplaceAll(a.Summary, "\n", " ") + "\n")
		}
		if a.Detail != "" {
			for _, line := range strings.Split(strings.TrimRight(a.Detail, "\n"), "\n") {
				sb.WriteString("          " + strings.TrimLeft(line, " ") + "\n")
			}
		}
		if a.DeepLink != "" {
			if k := deepLinkKind(a.DeepLink); k != nil {
				sb.WriteString("          人类深链等价形态：" + k.Pattern + "\n")
			}
		}
	}
	sb.WriteString("\n")
	sb.WriteString(DeepLinksDoc())
	sb.WriteString("\n")
	sb.WriteString(RecipesDoc())
	return sb.String()
}

// RecipesDoc 渲染组合配方小节（P-20261023-4 方案③）：示范「基础原子 × 组合 =
// 任意功能」的协议哲学——注册表只收单一效应原子，业务编排是 agent 的组合层，
// agent 学组合而非背功能。配方清单与原子演进同文件维护（新增原子若参与典型
// 组合在此补一行）
func RecipesDoc() string {
	var sb strings.Builder
	sb.WriteString("  组合配方（原子只做单一效应，把原子编排成功能是你的组合层——\n")
	sb.WriteString("  学组合而非背功能；示例可按需变形，注册表不收业务编排原语）：\n")
	sb.WriteString("  - 交付物到手：frontend.download（弹下载框）+ notify.persist（留痕「报告已生成并已开始下载」）\n")
	sb.WriteString("  - 交付口令/命令：frontend.clipboard（写入剪贴板）+ notify.persist（告知已写入，粘贴即用）\n")
	sb.WriteString("  - 部署完成可达：preview.port（预览端口直达）+ notify.persist action=preview（通知中心一键进面板）\n")
	sb.WriteString("  - 改完引导复核：open-file-at（打开文件定位行）+ navigate {view:\"diff\"}（工作区差异视图）\n")
	sb.WriteString("  - 佐证外链：frontend.open（新标签开 CI 日志/PR）+ notify.persist（留痕佐证入口）\n")
	return sb.String()
}

// DeepLinksDoc 渲染人类深链表（把某文件/视图送到用户眼前的 URL 形态成表入册
// ——agent 给用户发链接按表拼，编造 URL 从机制上杜绝）
func DeepLinksDoc() string {
	var sb strings.Builder
	sb.WriteString("  人类深链表（不经事件通道、直接把可点 URL 发给用户的呈现形态——\n")
	sb.WriteString("  按表拼链接，勿编造 URL 形态；相对路径直接可点，拼 {{BASE}} 即绝对地址）：\n")
	for _, k := range deepLinkKinds {
		sb.WriteString("  - " + k.ID + ": " + k.Pattern + "\n")
		sb.WriteString("          " + k.Doc + "\n")
	}
	return sb.String()
}

// deepLinkKind 按 id 查深链形态（未声明返回 nil）
func deepLinkKind(id string) *DeepLinkKind {
	for i := range deepLinkKinds {
		if deepLinkKinds[i].ID == id {
			return &deepLinkKinds[i]
		}
	}
	return nil
}

// ============== 内置事件载荷校验（自 ai/opsentry.go 收编，P-20261022-3） ==============
//
// 纯校验规整函数随原子进注册表——载荷 schema 的文档文案与校验函数同处一文件，
// 「实现了没写/写了没实现」的单点根除。二次编解码而非 map 断言的口径在此统一
// 说明：JSON 数字反序列化为 float64，类型断言会把 1.5 这类小数误当合法值，
// 结构体 unmarshal 天然拒绝非整数/形态不符。发布口（ai/opsentry.go）限流、
// 伴生副作用与 HTTP 语义仍归 handler，本文件只管载荷形态。

const (
	// openFileAtPathMax path/projectId 形态校验长度上限（防御性，同
	// remotehost_files.go filesMaxPathLen 惯例——事件载荷取更紧的项目相对路径量级）
	openFileAtPathMax = 512
	// watchInviteURLMax url 整体字节上限：/s/ 前缀 + token 段（现役派生 token 恒
	// 16 位 base36，上限留倍量余量防派生格式演进误伤，超出即畸形上报——同
	// openFileAtPathMax 的防御性口径）
	watchInviteURLMax = 80
	// presentTextMax 展示型文本字段字节上限：4KB 远超任何正常通知文案，超限即
	// 畸形上报。字节而非 rune：与 opsmessage bodyMax / ops-ask 各字段上限同口径
	presentTextMax = 4096
	// notifyPersistTitleMax title 上限（rune 而非字节）：通知中心标题是跨语言
	// 扫读面，200 rune 与前端 notify/watchInvite 文案展示截断（TEXT_SLICE=200）同口径
	notifyPersistTitleMax = 200
	// notifyPersistActionPayloadMax actionPayload 字节上限：url 形态给到 2048
	// （现实外链含 query 充裕），其余形态（会话 id/面板名/端口）远低于此
	notifyPersistActionPayloadMax = 2048
)

// OpenFileAtPath open-file-at 事件载荷（P-20261003-287）：agent 改完文件后把
// 用户注意力引导到具体位置——编辑器打开目标文件并跳到指定行。前端接收链：
// useOpsChannel 直通分发 sc-ops:open-file-at 恰与窗口事件常量 OPS_OPEN_FILE_AT
// 精确吻合，useLayoutViews 既有监听消费（必要时切项目 → 打开文件 → 行定位）
type OpenFileAtPath struct {
	Path      string `json:"path"`
	ProjectID string `json:"projectId"`
	// 缺省 = 仅打开文件不定位；指针区分「缺省」与 0（行/列契约是 1 起步的正整数）
	Line *int `json:"line,omitempty"`
	Col  *int `json:"col,omitempty"`
}

// ValidateOpenFileAtPath 校验并规整 open-file-at 载荷：
// path 必填且为项目相对路径（正斜杠、无绝对/盘符形态、无 .. 段）；projectId
// 必填非空。均只做形态校验：文件存在性与项目存在性由前端消费链自然兜底
// （打开链走文件 API 防穿越、hasProject 丢弃未知项目）——发布口不依赖项目
// store，保持事件通道解耦（同 preview.port hostId 的既有口径）。
// line/col 可选正整数
func ValidateOpenFileAtPath(payload interface{}) (interface{}, bool) {
	var p OpenFileAtPath
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	p.Path = strings.TrimSpace(p.Path)
	if p.Path == "" || len(p.Path) > openFileAtPathMax || !isOpenFilePath(p.Path) {
		return p, false
	}
	p.ProjectID = strings.TrimSpace(p.ProjectID)
	if p.ProjectID == "" || len(p.ProjectID) > openFileAtPathMax {
		return p, false
	}
	if p.Line != nil && *p.Line < 1 {
		return p, false
	}
	if p.Col != nil && *p.Col < 1 {
		return p, false
	}
	return p, true
}

// isOpenFilePath path 的「项目相对」形态守卫：仅正斜杠分隔、无 / 前缀、
// 无 win 盘符前缀、无 .. 段——防载荷把「项目相对」契约偷换成任意路径。
// 这是契约保真而非安全边界：前端消费链还有文件 API 层防穿越
func isOpenFilePath(path string) bool {
	if strings.Contains(path, "\\") || strings.HasPrefix(path, "/") {
		return false
	}
	if len(path) >= 2 && path[1] == ':' { // win 盘符（C:/... 与 C:... 同拒）
		return false
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

// LocateInTreePayload locate-in-tree 事件载荷（P-20261022-3 新增 agent 可发
// 形态）：把「文件在树里的位置」送到用户眼前——文件树逐层展开 + 滚动定位
// 高亮（不打开编辑器 tab）。与 present.file（open-file-at）的分工：树定位给
// 「项目结构上下文」（让用户看到文件在哪、自己接着翻邻座），打开文件给
// 「内容本身」。前端直通分发 sc-ops:locate-in-tree 恰与既有窗口事件常量
// OPS_LOCATE_IN_TREE 精确吻合（open-file-at 同款双栖恒等），FileTreeView 既有
// 接收链消费；侧栏不在 files 视图时由 useLayoutViews 兜底适配层先切视图再重派发
type LocateInTreePayload struct {
	// Path 项目相对路径（正斜杠）；空串 = 项目根本身（把人送到树里自己选）
	Path string `json:"path"`
	// ProjectID 定位目标归属的注册项目 id（必填；接收方与当前项目不符时忽略——
	// 与前端 LocateInTreeDetail 既有契约一致）
	ProjectID string `json:"projectId"`
	// Focus 可选：落点后把键盘焦点移到树列表（缺省 false = 定位不抢焦点）
	Focus bool `json:"focus,omitempty"`
}

// ValidateLocateInTree 校验并规整 locate-in-tree 载荷：projectId 必填非空；
// path 可空（= 项目根）但非空时须过项目相对形态守卫（同 open-file-at 口径）；
// focus 可选布尔。定位是只读呈现原语，项目存在性由前端消费链对账兜底
// （发布口不依赖项目 store，同 open-file-at 解耦口径）
func ValidateLocateInTree(payload interface{}) (interface{}, bool) {
	var p LocateInTreePayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	p.Path = strings.TrimSpace(p.Path)
	if len(p.Path) > openFileAtPathMax || (p.Path != "" && !isOpenFilePath(p.Path)) {
		return p, false
	}
	p.ProjectID = strings.TrimSpace(p.ProjectID)
	if p.ProjectID == "" || len(p.ProjectID) > openFileAtPathMax {
		return p, false
	}
	return p, true
}

// WatchInvitePayload watch.invite 事件载荷（P-20261005-165）：agent 开完终端
// 直播（POST /api/share/terminal）后把人拉到访客页的 human-pull 原语——前端
// 桥接为通知中心带动作条目（action='url'，点击新窗打开访客直播页）。
// url 是相对访客路径而非绝对 URL：agent 无需知道部署主机/分享子服务端口
type WatchInvitePayload struct {
	// URL 访客短链路径，必填且限 /s/<token> 形态（见 isShareVisitorPath）
	URL string `json:"url"`
	// Title/Body 可选展示文本：邀请标题与一句话说明，通知文案原样展示，
	// 缺省走前端 i18n 默认文案
	Title string `json:"title"`
	Body  string `json:"body"`
}

// ValidateWatchInvite 校验并规整 watch.invite 载荷：url 必填且须过
// isShareVisitorPath 形态守卫；title/body 可选展示文本，同受 presentTextMax
// 封顶（通知文案原样展示，巨型串即畸形上报）
func ValidateWatchInvite(payload interface{}) (interface{}, bool) {
	var p WatchInvitePayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	p.URL = strings.TrimSpace(p.URL)
	if !isShareVisitorPath(p.URL) {
		return p, false
	}
	p.Title = strings.TrimSpace(p.Title)
	p.Body = strings.TrimSpace(p.Body)
	if len(p.Title) > presentTextMax || len(p.Body) > presentTextMax {
		return p, false
	}
	return p, true
}

// isShareVisitorPath url 的访客短链形态守卫：恰为 /s/<token>（无子路径、无
// query/fragment）。**反钓鱼边界，安全关键**：通知中心点击经 window.open
// 打开该值，白名单保证它只能是本部署分享子服务的访客页相对路径——
//   - 前缀 /s/ 锁死路径起点：绝对 URL（https://…）、协议相对外链（//evil.com，
//     恰以 / 开头但非 /s/）、javascript: 伪协议全被前缀拒绝；
//   - token 段字符集白名单 [0-9a-zA-Z]：不含 . / ? # @ % \ 等任何可构造
//     穿越段（../）、路径拼接（//）、凭据（@）、附加 query（?）或编码绕过
//     （%）的字符——注入形态在字符层面即被拒，无需逐形态枚举；
//   - 拒尾随子路径与 query：watch.invite 的目标恒是直播访客页本身。
//
// 与 store.DeriveShareToken 的现役产出对齐：token 恒为 base36（[0-9a-z]），
// 白名单放宽到大写仅作前向余量；长度上限见 watchInviteURLMax
func isShareVisitorPath(link string) bool {
	const prefix = "/s/"
	if len(link) <= len(prefix) || len(link) > watchInviteURLMax || !strings.HasPrefix(link, prefix) {
		return false
	}
	for i := len(prefix); i < len(link); i++ {
		c := link[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// NotifyPersistPayload notify.persist 事件载荷（P-20261007-10）：agent 长任务
// 产出非模板形态的结论时留一条「可跳转的持久通知」——与旧 notify（纯 toast
// 即逝）的分工在留痕与动作。服务端入账后 agent 通知与系统通知同库同渲染：
// 分类静音/免打扰偏好过滤全生效，跨设备可见，webhook 外发链自动携带
type NotifyPersistPayload struct {
	// Title 必填 ≤200 rune（入账前过敏感遮蔽）
	Title string `json:"title"`
	// Body 可选说明文本（同受 presentTextMax 字节封顶，入账前过敏感遮蔽）
	Body string `json:"body,omitempty"`
	// Level 分级：info|success|warning|error，缺省 info——即通知 Type 既有取值域
	//（error/warning 在通知中心桌面提醒链吃 error 穿透勿扰）
	Level string `json:"level,omitempty"`
	// Action 可选一键直达动作，白名单收敛自通知 Action 既有枚举：
	// terminal|panel|url|preview。agent-fix（人裁决后修复语义）等其余动作
	// 不对 agent 开放
	Action string `json:"action,omitempty"`
	// ActionPayload 动作目标，按 Action 逐形态校验（见 isNotifyPersistAction）：
	// terminal=会话 id / panel=面板名 / url=https(s) 绝对外链 / preview=端口号
	ActionPayload string `json:"actionPayload,omitempty"`
}

// notifyPersistLevels level 白名单：与通知 Type 既有取值域逐字对齐
// （server/notification/types.go Notification.Type 注记），缺省 info 在校验时规整
var notifyPersistLevels = map[string]bool{
	"info": true, "success": true, "warning": true, "error": true,
}

// ValidateNotifyPersist 校验并规整 notify.persist 载荷：
// title 必填 ≤200 rune；body 可选 ≤presentTextMax 字节；level 可选枚举
// （缺省规整为 info）；action 可选白名单 + actionPayload 按动作形态校验。
// title/body 校验即遮蔽（mask.MaskText——入账面是持久留痕，敏感值不得入档；
// webhook 外发链二次遮蔽幂等）
func ValidateNotifyPersist(payload interface{}) (interface{}, bool) {
	var p NotifyPersistPayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	p.Title = strings.TrimSpace(p.Title)
	if p.Title == "" || utf8.RuneCountInString(p.Title) > notifyPersistTitleMax {
		return p, false
	}
	p.Body = strings.TrimSpace(p.Body)
	if len(p.Body) > presentTextMax {
		return p, false
	}
	p.Title = mask.MaskText(p.Title)
	p.Body = mask.MaskText(p.Body)
	p.Level = strings.TrimSpace(p.Level)
	if p.Level == "" {
		p.Level = "info"
	}
	if !notifyPersistLevels[p.Level] {
		return p, false
	}
	p.Action = strings.TrimSpace(p.Action)
	p.ActionPayload = strings.TrimSpace(p.ActionPayload)
	if p.Action == "" {
		if p.ActionPayload != "" { // 载荷无主：畸形（防 agent 把目标塞错字段）
			return p, false
		}
		return p, true
	}
	if !isNotifyPersistAction(p.Action, p.ActionPayload) {
		return p, false
	}
	return p, true
}

// isNotifyPersistAction action 白名单 + actionPayload 逐动作形态校验。
// 四动作收敛自服务端既有通知的 Action 枚举，payload 形态与各自动作的消费链
// 对齐（前端 pendingAction 分发面 useLayoutBootstrap.bindPendingActionWatch）：
//   - terminal：会话 id 单 token（≤128 字节、无空白/控制符）——「查看会话」
//     直达终端 tab；会话存在性由消费链对账兜底（发布口不依赖终端注册表，
//     保持事件通道解耦，同 open-file-at projectId 口径）
//   - panel：面板名 kebab 段（≤64、[a-z0-9-]，与现役 files/changes/git/
//     terminal/share-manager 同族）——面板存在性由前端 toggleablePanelIds
//     既有判定兜底，白名单只守形态不守清单（前端注册表可扩展，服务端快照
//     会成第二事实源）
//   - url：http(s) 绝对外链（scheme 白名单拒 javascript:/data: 伪协议等——
//     该值经前端 window.open noopener 直开，scheme 是唯一防线；主机不限：
//     agent 报的 CI/PR 链接本就是站外形态）
//   - preview：端口号字符串 1024~65535（与 preview.port 事件端口校验同口径）
func isNotifyPersistAction(action, target string) bool {
	if target == "" || len(target) > notifyPersistActionPayloadMax {
		return false
	}
	switch action {
	case "terminal":
		if len(target) > 128 {
			return false
		}
		for _, r := range target {
			if r <= ' ' || r == 0x7f {
				return false
			}
		}
		return true
	case "panel":
		if len(target) > 64 {
			return false
		}
		for i := 0; i < len(target); i++ {
			c := target[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
		return true
	case "url":
		return isHTTPExternalURL(target)
	case "preview":
		port, err := strconv.Atoi(target)
		return err == nil && port >= 1024 && port <= 65535
	default:
		return false
	}
}

// isHTTPExternalURL http(s) 绝对外链形态守卫：scheme 白名单拒 javascript:/data:
// 伪协议等（该值经前端 window.open noopener 直开，scheme 是唯一防线）；主机
// 必非空；禁空白与控制符（URL 内嵌空白是解析歧义面）。主机不限：agent 报的
// CI/PR 链接本就是站外形态。notify.persist action=url 与 frontend.open 两原子
// 共用同一防线（P-20261023-4 抽出复用），口径漂移不可能单侧发生
func isHTTPExternalURL(target string) bool {
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" {
		return false
	}
	for _, r := range target {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return true
}

// ============== frontend 动词族（替用户执行浏览器动作的原子，P-20261023-4） ==============
//
// 此前的呈现原语全部是「引导注意力」类（把用户带到某处/告知某事），交付链
// 最后一厘米——「替用户执行浏览器动作」——零覆盖：agent 产出报告后只能给
// 路径/发通知，下载框弹不出来、剪贴板写不进、标签页开不了。frontend 三原子
// 补上这一层：只收「单一浏览器效应」原语，「导出报告并发送」这类业务编排
// 拒绝入表（那是 agent 的组合层，见 PresentAtomsDoc 的组合配方小节），防
// 注册表腐化成功能清单。
//
// 安全边界（三原子都是用户设备上的即时效应，滥用对策四层）：①服务端发布口
// 既有 60 条/分钟/会话限流（ai/opsentry.go opsNotifyLimiter，本族零特判直接
// 受辖）；②前端效应面独立更紧预算（10 次/分钟/原子，超限可见 warning 不
// 静默）；③全部必带可见反馈 toast——下载/剪贴板/打开均无静默效应（剪贴板
// 的可见预告是投毒防线的第一层）；④设置按原子开关（默认开，前端
// opsAtomPrefs，随 userPrefs 漫游）。

// FrontendDownloadPayload frontend.download 事件载荷：agent 产出交付物（截图
// 实证/带宽分析报告等）后直接触发浏览器下载框——下载走既有文件下载端点
// （GET /api/projects/:id/file/download，SafeJoinProject 防穿越 + Content-
// Disposition 净化链既有），事件通道只承载「触发」语义，文件字节不经广播流
type FrontendDownloadPayload struct {
	Path      string `json:"path"`
	ProjectID string `json:"projectId"`
}

// ValidateFrontendDownload 校验并规整 frontend.download 载荷：path/projectId
// 必填，形态口径同 open-file-at（项目相对正斜杠、无 .. 段、长度上限同源）。
// 文件存在性/项目存在性由下载端点消费链自然兜底（404/403，浏览器下载框空手
// 而归），发布口不依赖项目 store，保持事件通道解耦（open-file-at 同口径）
func ValidateFrontendDownload(payload interface{}) (interface{}, bool) {
	var p FrontendDownloadPayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	p.Path = strings.TrimSpace(p.Path)
	if p.Path == "" || len(p.Path) > openFileAtPathMax || !isOpenFilePath(p.Path) {
		return p, false
	}
	p.ProjectID = strings.TrimSpace(p.ProjectID)
	if p.ProjectID == "" || len(p.ProjectID) > openFileAtPathMax {
		return p, false
	}
	return p, true
}

// frontendClipboardTextMax 剪贴板文本字节上限：与跨设备中继槽 clipMaxBytes
// （server/api/system/clip.go，32KB）同界——writeText 失败的回落链写该槽，
// 校验上限对齐保证「过发布口的载荷必过回落槽」，回落链零二次拒绝
const frontendClipboardTextMax = 32 * 1024

// FrontendClipboardPayload frontend.clipboard 事件载荷：agent 把文本直写用户
// 剪贴板（交付口令/命令/链接到手即粘贴）。**剪贴板投毒（诱导用户粘贴恶意
// 命令）是本原子最大滥用面**——前端消费链必带可见 toast 预告 + 敏感值遮蔽
// + 截断预览，无静默写入；载荷本身原样透传不遮蔽：遮蔽只作用于展示面
// （前端 maskSensitive），写进剪贴板的字节必须与 agent 意图逐字一致
type FrontendClipboardPayload struct {
	Text string `json:"text"`
}

// ValidateFrontendClipboard 校验 frontend.clipboard 载荷：text 必填非空且
// ≤32KB。刻意不做 TrimSpace：剪贴板载荷是「待粘贴的逐字内容」，首尾空白可能
// 是语义（多行命令缩进/结尾换行），规整即篡改——与展示型文本字段（notify
// title 等 trim 后入册）的口径刻意相反
func ValidateFrontendClipboard(payload interface{}) (interface{}, bool) {
	var p FrontendClipboardPayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	if p.Text == "" || len(p.Text) > frontendClipboardTextMax {
		return p, false
	}
	return p, true
}

// FrontendOpenPayload frontend.open 事件载荷：agent 在用户新标签打开 http(s)
// 外链（CI 日志/PR/文档）。popup blocker 是浏览器边界不硬求：被拦时前端回落
// 通知中心 action=url 条目（既有形态），用户点击开——功能不缺失只是多一次点击
type FrontendOpenPayload struct {
	URL string `json:"url"`
}

// ValidateFrontendOpen 校验并规整 frontend.open 载荷：url 必填且过
// isHTTPExternalURL 形态守卫（scheme 白名单 + 主机非空 + 禁空白控制符）——
// 与 notify.persist action=url 同一防线，前端 window.open 的直接消费值
func ValidateFrontendOpen(payload interface{}) (interface{}, bool) {
	var p FrontendOpenPayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	p.URL = strings.TrimSpace(p.URL)
	if !isHTTPExternalURL(p.URL) {
		return p, false
	}
	return p, true
}

// ============== 注册表装配（首批收编） ==============

func init() {
	RegisterPresentAtom(PresentAtom{
		ID: "frontend.clipboard", Verb: "frontend", Event: "frontend.clipboard",
		Summary:       "剪贴板直写：把文本写进用户剪贴板（口令/命令/链接到手即粘贴）",
		Payload:       `{"text":"git rebase -i HEAD~3"}`,
		PayloadFields: []string{"text"},
		Detail: `text 必填非空 ≤32KB（原样写入，不做空白规整）。**滥用面最敏感
                 的原子**：前端写入前必带可见 toast（敏感值遮蔽 + 截断预览），
                 无静默写入；用户可在设置·通用分区按原子关闭（默认开）。
                 浏览器焦点/权限边界诚实声明：writeText 失败时自动回落跨设备
                 中继链——内容进服务端单槽，toast 点击读取即焚落本地剪贴板，
                 功能不缺失只是多一次点击`,
		Validate:              ValidateFrontendClipboard,
		InvalidPayloadMessage: "invalid frontend.clipboard payload: text (required) must be non-empty and at most 32768 bytes",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "frontend.download", Verb: "frontend", Event: "frontend.download",
		Summary:       "触发浏览器下载框：交付物（报告/截图/产物）直接到手",
		Payload:       `{"path":"reports/bandwidth-analysis.md","projectId":"<项目ID>"}`,
		PayloadFields: []string{"path", "projectId"},
		Detail: `path 必填项目相对路径（正斜杠），projectId 必填非空（GET /api/projects
                 取 id）。下载走既有文件下载端点 GET /api/projects/:id/file/download
                 （路径防穿越 + 下载头净化既有），文件字节不经事件通道。组合
                 frontend.download + notify.persist =「报告已生成并已开始下载」`,
		Validate:              ValidateFrontendDownload,
		InvalidPayloadMessage: "invalid frontend.download payload: path (project-relative, forward slashes, no .. segment) and projectId are required",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "frontend.open", Verb: "frontend", Event: "frontend.open",
		Summary:       "新标签打开 http(s) 外链（CI 日志/PR/文档）",
		Payload:       `{"url":"https://github.com/acme/repo/actions/runs/123"}`,
		PayloadFields: []string{"url"},
		Detail: `url 必填 http(s) 绝对外链（scheme 白名单拒伪协议，同 notify.persist
                 action=url 防线）。popup blocker 是浏览器边界：被拦时自动回落
                 通知中心带 url 动作条目，用户点击开——功能不缺失只是多一次点击`,
		Validate:              ValidateFrontendOpen,
		InvalidPayloadMessage: "invalid frontend.open payload: url (required) must be an absolute http(s) URL with a host",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "navigate.changes", Verb: "navigate", Event: "navigate",
		Summary:       "变更面板聚焦（ensure-open：已可见保持打开，与 panel 的 toggle 区分）",
		Payload:       `{"view":"changes"}`,
		PayloadFields: []string{"view"},
		Detail: `他页/冷启动进入经 pendingSideView 打标，bootstrap 布局恢复时消费
                 且不覆盖。注意引导无「收起」半程`,
	})
	RegisterPresentAtom(PresentAtom{
		ID: "navigate.diff", Verb: "navigate", Event: "navigate",
		Summary:       "该文件 vs HEAD 工作区差异视图直达",
		Payload:       `{"view":"diff","file":"src/app.go","project":"<项目ID>"}`,
		PayloadFields: []string{"file", "project", "view"},
		Detail:        `落成 ?file=<rel>&project=<id>&diff=1 深链变体；对比视图无行定位语义（line 不消费）。project 缺省 = 当前项目`,
		DeepLink:      "file",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "navigate.file", Verb: "navigate", Event: "navigate",
		Summary:       "文件深链直达：编辑器打开目标文件并跳到指定行",
		Payload:       `{"file":"src/app.go","line":55,"project":"<项目ID>"}`,
		PayloadFields: []string{"file", "line", "project"},
		Detail: `file 必填项目相对路径（正斜杠）；line 可选 ≥1 整数（行定位）；
                 project 可选（缺省 = 当前项目，携带且不同 = 先切项目）。
                 等价表达：直接把下方深链表的 file 形态 URL 发给用户`,
		DeepLink: "file",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "navigate.path", Verb: "navigate", Event: "navigate",
		Summary:       "路由跳转（向后兼容首形态）",
		Payload:       `{"path":"/project"}`,
		PayloadFields: []string{"path"},
		Detail:        `path 须以 / 开头（站内路由）；已知目的地：/project（工作台）、/monitor（值班大屏）`,
	})
	RegisterPresentAtom(PresentAtom{
		ID: "navigate.terminal", Verb: "navigate", Event: "navigate",
		Summary:       "会话聚焦：终端 tab 直达该会话",
		Payload:       `{"terminalId":"<会话ID>"}`,
		PayloadFields: []string{"terminalId"},
		Detail:        `审批卡「查看发起会话」同一跳转链（会话对账 / 已结束 toast 降级 / 切项目 / 激活 tab）`,
	})
	RegisterPresentAtom(PresentAtom{
		ID: "notify.persist", Verb: "notify", Event: "notify.persist",
		Summary:       "通知中心持久条目（跨设备可见 + 可跳转动作，与 toast 即逝的 notify 分工在留痕）",
		Payload:       `{"title":"构建完成","body":"42 个用例全绿","level":"info","action":"terminal","actionPayload":"<会话ID>"}`,
		PayloadFields: []string{"action", "actionPayload", "body", "level", "title"},
		Detail: `title 必填 ≤200 字（敏感值自动遮蔽）；body 可选；level 可选
                 info|success|warning|error（缺省 info；error/warning 级在用户免打扰
                 时段仍穿透桌面提醒——值得叫醒人的结论用 error）。
                 action 族（actionPayload 按动作逐形态校验，坏载荷 400）：
                 terminal=<会话id>（用户点「查看会话」直达你的终端，CC_TERMINAL_ID
                 即当前会话）/ panel=<面板名 files|changes|git|terminal> /
                 url=<https:// 外链 新窗打开> / preview=<端口号 直达预览面板>。
                 agent-fix 等人裁决类动作不对你开放`,
		DeepLink:              "session",
		Validate:              ValidateNotifyPersist,
		InvalidPayloadMessage: "invalid notify.persist payload: title (required, max 200 runes) required, level optional enum info|success|warning|error, action optional one of terminal|panel|url|preview with a matching actionPayload",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "notify.toast", Verb: "notify", Event: "notify",
		Summary:       "前端 toast（即逝提醒，不留痕——要留痕/带动作用 notify.persist）",
		Payload:       `{"message":"...","level":"info|success|warning|error"}`,
		PayloadFields: []string{"level", "message"},
	})
	RegisterPresentAtom(PresentAtom{
		ID: "present.file", Verb: "present", Event: "open-file-at",
		Summary:       "编辑器打开目标文件并定位行（改完文件引导注意力的专用事件）",
		Payload:       `{"path":"src/app.ts","projectId":"<项目ID>","line":42,"col":8}`,
		PayloadFields: []string{"col", "line", "path", "projectId"},
		Detail: `path 必填项目相对路径（正斜杠），projectId 必填非空（GET /api/projects
                 取 id）；line/col 可选正整数，缺省仅打开文件。改完文件/修完报错后
                 上报一次即可，用户无需再手动导航找文件（等价深链形态见下行）`,
		DeepLink:              "file",
		Validate:              ValidateOpenFileAtPath,
		InvalidPayloadMessage: "invalid open-file-at payload: path (project-relative, forward slashes, no .. segment) and projectId are required, line/col optional positive integers",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "present.panel", Verb: "present", Event: "panel",
		Summary:       "打开指定面板（驱动界面布局；toggle 语义）",
		Payload:       `{"name":"files|changes|git|terminal"}`,
		PayloadFields: []string{"name"},
		Detail:        `白名单 = 前端面板注册表（注册即可驱动）；「聚焦但不收起」的变更面板用 navigate {view:"changes"}`,
	})
	RegisterPresentAtom(PresentAtom{
		ID: "present.port", Verb: "present", Event: "preview.port",
		Summary:       "预览端口直达：dev server 就绪后上报，通知中心/悬浮球出现「预览 :N」一键直达预览面板",
		Payload:       `{"port":3000,"label":"vite dev server"}`,
		PayloadFields: []string{"hostId", "label", "port"},
		Detail: `port 必填 1024~65535 整数，label 可选服务简称；同一端口重复上报
                 会被前端去重，勿反复刷发（每次服务起来只报一次）。服务跑在远程
                 主机终端时加 "hostId":"<主机ID>"（port 填远端回环端口，先经
                 POST /api/remotehosts/:id/tunnels 开隧道——见 remote 节）`,
		// 校验留在发布口特判：载荷规整后还要做端口注册表登记（伴生副作用耦合）
	})
	RegisterPresentAtom(PresentAtom{
		ID: "present.tree", Verb: "present", Event: "locate-in-tree",
		Summary:       "文件树定位：逐层展开 + 滚动高亮目标位置（给结构上下文，不开编辑器）",
		Payload:       `{"path":"src/server/agentops","projectId":"<项目ID>","focus":false}`,
		PayloadFields: []string{"focus", "path", "projectId"},
		Detail: `path 可空 = 项目根（把人送到树里自己选）；projectId 必填（接收方
                 与当前项目不符时忽略——agent 项目绑定会话用 CC_PROJECT_ID）；
                 focus 可选布尔（落点后焦点交给树，缺省不抢编辑器焦点）。
                 与 present.file（open-file-at）的分工：树定位让用户看到「文件在
                 哪」，打开文件让用户看到「文件内容」`,
		Validate:              ValidateLocateInTree,
		InvalidPayloadMessage: "invalid locate-in-tree payload: path (optional project-relative, forward slashes, no .. segment, empty = project root) and projectId (required) malformed, focus optional boolean",
	})
	RegisterPresentAtom(PresentAtom{
		ID: "notify.watch", Verb: "notify", Event: "watch.invite",
		Summary:       "直播邀请：把人拉到访客直播页（human-pull 原语）",
		Payload:       `{"url":"/s/<token>","title":"过来看","body":"演示关键步骤"}`,
		PayloadFields: []string{"body", "title", "url"},
		Detail: `开完终端直播（POST /api/share/terminal）后上报——用户在通知中心
                 看到「直播邀请」条目，点击即新窗口打开访客直播页。url 必填且只
                 接受 /s/<token> 访客短链路径形态（创建直播响应 data.token 拼 /s/
                 前缀；其他形态一律 400——该值会被直接打开，白名单是防钓鱼边界），
                 title/body 可选。与 share 节「直播三步」配方配合使用`,
		Validate:              ValidateWatchInvite,
		InvalidPayloadMessage: "invalid watch.invite payload: url (required) must be a visitor share path of the form /s/<token>, title/body optional short text",
	})
}
