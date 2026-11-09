package archguard_test

// 手册路由覆盖率门禁（P-20261003-286）：/ops-manual 是 agent 学会调用本系统的
// 唯一教材——端点合入漏登手册，agent 永远不知道，能力面对 AI 静默缩水（提案
// 动机：PUT /api/projects/:id 等已合入未登记，靠人工记忆不可持续）。本测试把
// 「路由注册面 ↔ 手册文本」双向对账固化为 CI 门禁，与 payload 字段快照
//（P-20261003-120）/ 能力项对账（app/meta_conformance_test.go）/ 事件目录
// 快照（P-20261006-46）同族，构成 API 契约防线的「手册文档」层：
//
//  1. 路由→手册：RegisterRoutes 收口的真实路由（方法+路径）逐条在手册全文
//     （manualHeader + 全部分节 Body，即 agentops.Manual("") 的最终输出）中
//     找「方法词 + 路径词」登记证据；manualWhitelist（管理 UI 面/传输通道/
//     内部端点，逐条注明缘由）豁免——新能力端点不登记手册测试即红；
//  2. 手册→路由：手册里以 gin 形态（:param 占位、/api 或 /ws 前缀）登记的
//     (方法,路径) 必须存在于真实路由表——端点删除/改名后手册悬空条目即红
//     （对向漂移，防手册腐化成第二本死账）；
//  3. 白名单不悬空：豁免前缀必须命中至少一条真实路由——端点删光后豁免条目
//     显式修剪（与 app/discovery_conformance_test.go 白名单同纪律）。
//
// 解析口径：手册是给人/agent 读的散文，登记形态多样（`GET/POST /x` 合写、
// `GET /x 列表 / POST 创建` 行内散写、{{BASE}} 前缀、<id> / $CC_TERMINAL_ID /
// :id 三种占位）。按「行内方法词 × 行内路径词」取积登记，占位段归一 <p> 后
// 比对——误覆盖只会放宽门禁且登记行经评审可见，漏判会冤枉合规登记，故正则
// 从宽。对向核对限定 /api、/ws、/ops-manual 三族的 gin 形态词元：访客短链
// （P-20261020-2 起 /s/* 也在主路由表，但手册以 <分享基址>/s/<token> 散文形态
// 书写，非 gin 形态词元）与 <id>/$VAR 行文变体天然不参与。
//
// 更新纪律：新增 agent 能力端点 = 路由注册 → 所属能力域分节登记一行（既有
// 分节在其 Body 追加；全新能力域在能力包 manual.go RegisterSection，agentops
// 头注释有完整指引）；确属非 agent 面（管理 UI/传输通道）在 manualWhitelist
// 登记**具体前缀** + 缘由（越具体的白名单门禁越强，禁整族豁免）。
// 本测试落在包外测试包 archguard_test（与 ops_events_test.go 同包）：import
// server/api 触发全路由注册与各能力包 init（手册分节注册），零副作用（app
// 包对账测试同款装配，只 Register 不 Init/Start）。

import (
	"regexp"
	"sort"
	"strings"
	"testing"

	"codecombo/server/agentops"
	"codecombo/server/api"

	"github.com/gin-gonic/gin"
)

// manualMethods 覆盖检查的方法全集。WS 是手册对 GET 路由的书写惯例（双向流），
// 归一为 GET；HEAD/OPTIONS/CONNECT/TRACE 是 gin Any 注册的传输变体，手册不载。
var manualMethods = map[string]string{
	"GET": "GET", "POST": "POST", "PUT": "PUT", "DELETE": "DELETE", "PATCH": "PATCH",
	"WS": "GET",
}

// manualPathRe 手册路径词：/ 起步、保守字符类（含 / 与路径常见符号，* 为
// 「/ws/*」类通配散文记法、由对向核对的 gin 形态判定排除）——中文标点/引号/
// 反引号/空白天然截断 token，避免「/api/x——`curl」类粘连；? 供剥离查询串
// （?path= 等参数示例不是路由形态的一部分）。
var manualPathRe = regexp.MustCompile(`/[A-Za-z0-9_:.$<>{}\[\]*?&=/-]+`)

// manualMethodRe 手册方法词（含 WS 书写惯例）。词边界防误伤普通英文单词。
var manualMethodRe = regexp.MustCompile(`\b(GET|POST|PUT|DELETE|PATCH|WS)\b`)

// manualWhitelist 路由前缀 → 豁免缘由：不要求手册登记的路径族。口径=非 agent
// 能力面（管理 UI 数据面 / 传输通道 / 内部端点）；每条注明缘由，端点删光后由
// 「白名单不悬空」子检查强制修剪。键按前缀匹配真实路由路径（gin 形态），
// 前缀登记得越具体门禁越强。
var manualWhitelist = map[string]string{
	// —— 内部/基础设施端点（agent 不消费）——
	"/api/health":   "健康探针（无中间件保护）——进程探活面非能力面",
	"/api/metrics":  "Prometheus 指标出口——监控系统消费",
	"/api/shutdown": "本机优雅停机通道（回环+自定义头双约束）——进程管理面",
	"/api/restart":  "本机优雅重启通道（回环+X-SC-Restart 头双约束，P-20261106 页面重启链）——进程管理面，同 shutdown 族",
	"/preview/":     "端口预览回环反代——传输通道非能力端点（浏览器 iframe 消费）",
	"/proxy/":       "实例代理传输通道——机器间转发管道（发现面 routeWhitelist 同款豁免）",
	"/ws/proxy/":    "实例代理 WS 传输通道——同 /proxy 的 WebSocket 形态",
	// 分享访客面同源入口（P-20261020-2）：/s/* 与访客页依赖的 vendored
	// 资产挂在主引擎上是匿名访客面——token（+ 可选口令门）即门禁、锁定态
	// 不挡；创建/撤销等管理面已在 share 节登记，访客页不是 agent 能力端点。
	"/s/":                  "分享访客面同源入口（匿名访客页/子资源/SSE；token+口令门即门禁，非 agent 能力面）",
	"/assets/xterm.js":     "分享访客页 vendored 资产（终端直播/回放页 xterm 运行时）",
	"/assets/addon-fit.js": "分享访客页 vendored 资产（xterm addon-fit）",
	"/assets/xterm.css":    "分享访客页 vendored 资产（xterm 样式）",
	// P-20261107-4 渲染保真：宽字符宽度表 + 产品同款终端字体（同为访客渲染资源）
	"/assets/addon-unicode11.js":          "分享访客页 vendored 资产（xterm addon-unicode11 宽度表）",
	"/assets/JetBrainsMono-Regular.woff2": "分享访客页 vendored 资产（终端字体 JetBrains Mono，OFL）",
	"/assets/JetBrainsMono-Bold.woff2":    "分享访客页 vendored 资产（终端字体 JetBrains Mono 粗体，OFL）",
	// —— 管理/设置 UI 数据面（agent 能力域之外；agent 自持 CC_LOCK_TOKEN，不管理凭据令牌）——
	"/api/ui-state":    "前端 UI 状态持久化面（浏览器工作台专用，GET/PUT/PATCH/export 同族）",
	"/api/updates":     "应用自更新链路（更新器/设置 UI 消费，agent 不触碰升级）",
	"/api/tools":       "dsh 工具集成管理面（设置 UI 专用；发现面同款豁免先例）",
	"/api/lock":        "锁定管理面（setup/config/password 锁屏与设置专用；unlock 引导已在手册头部登记）",
	"/api/tokens":      "访问令牌管理面（设置·安全 UI 专用）",
	"/api/agent-token": "agent 令牌管理面（reveal/rotate/revoke 属管理员动作，agent 用注入的 CC_LOCK_TOKEN 即可）",
	// /api/hooks（入站原语）已升格 agent 能力面登记手册（P-20261003-23，
	// inbound-hooks 节「入站事件 Hook」）；仅凭据生命周期管理面留白
	"/api/hook-token": "入站 Hook 凭据管理面（设置·安全 UI；签发/轮换/销毁属管理员动作，投递方持 sch_ token 即可）",
	// /api/quickdrop（收件箱清单/摘除 + 投递原语）已升格 agent 能力面登记手册
	//（P-20261006-51，share 节「快投递」配方）；仅凭据生命周期管理留白
	"/api/quickdrop/token": "快投递凭据管理面（设置·分享区 UI；生成即轮换/撤销属管理员动作，投递方持 scd_ token 即可）",
	// /api/audit 与 /api/audit/export 已升格 agent 能力面登记手册（P-20261007-2，
	// audit 节「审计日志」），从本白名单迁出；仅归档手动触发留白
	"/api/audit/archive":           "审计归档手动触发（运维缩短窗口/升级前落档的运维动作，设置·审计 UI 专用）",
	"/api/license":                 "许可授权管理面（设置 UI 专用）",
	"/api/oauth":                   "OAuth Device Flow 凭据面（凭据设置 UI 专用）",
	"/api/oauth-clients":           "OAuth Client 配置面（凭据设置 UI 专用）",
	"/api/credentials":             "Git HTTPS 凭据管理面（凭据设置 UI 专用）",
	"/api/sshkeys":                 "SSH Key 管理面（凭据设置 UI 专用）",
	"/api/settings/custom-agents":  "自定义智能体运行时注册（设置 UI；agent 经 GET /api/agent-runtimes 只读消费）",
	"/api/settings/approval-rules": "审批规则命中测试（设置·审批规则编辑器调试口）",
	"/api/system/":                 "系统元数据管理面（egress/ingress 总览+健康摘要，值班大屏/设置 UI）",
	"/api/browse":                  "目录浏览器（添加项目弹窗选目录 UI 面）",
	"/api/instances/fleet":         "实例 claim 聚合/残留清理（值班大屏管理面）",
	"/api/instances/probe":         "实例探测（添加/编辑实例弹窗「测试连接」，check-batch 同族）",
	// —— 项目域管理 UI 面（用户在面板操作；agent 的写路径走文件/Git 写端点，硬锁语义见 projects 节）——
	"/api/projects/:id/frozen": "项目冻结开关（项目卡右键 UI；403 project.locked 自纠指引在 projects 节）",
	"/api/projects/:id/locked": "项目硬锁开关——唯一解锁路径刻意只留给用户（projects 节明确 agent 不得自行解锁）",
	"/api/commit-templates":    "提交模板管理（提交框模板设置 UI）",
	// /api/changelists 与 /api/projects/:id/shelve 已升格 agent 能力面登记手册
	//（P-20261007-19，git 节「变更列表与搁置」），从本白名单迁出
	"/api/projects/:id/gitignore":       ".gitignore 结构化编辑（编辑器 UI；agent 用文件写端点原样编辑）",
	"/api/projects/:id/gitattributes":   ".gitattributes 结构化编辑（同上 UI 面）",
	"/api/projects/:id/git-exclude":     "git exclude 本地排除（同上 UI 面）",
	"/api/projects/:id/commit-template": "commit.template 预填读取（提交框初始化 UI 面）",
	"/api/projects/:id/numstat":         "工作区逐文件行数统计（变更树「复制变更摘要」数据面）",
	"/api/projects/:id/todos":           "TODO/FIXME 标记聚合（TODO 面板数据面）",
	"/api/projects/:id/file/hunks":      "文件 hunk 切分（差异视图 hunk 级 UI 数据面）",
	"/api/projects/:id/hunk":            "hunk 级暂存/取消/丢弃（差异视图 hunk 操作 UI 面）",
	"/api/projects/:id/submodules":      "Submodule 管理（submodule 面板 UI）",
	"/api/projects/:id/gpg":             "GPG 签名状态/开关（设置 UI 面）",
	"/api/projects/:id/hooks":           "git hooks 查看/编辑（hooks 编辑器 UI；.git/hooks 写入另有敏感路径闸覆盖）",
	// /api/projects/:id/worktrees 已升格 agent 能力面登记手册（P-20261005-179，
	// git 节「Worktree」——ref 通道透传裸 hash 的定点检视是 agent bisect 排查基元），从本白名单迁出
	"/api/projects/:id/tasks":            "任务运行器 manifest 扫描（任务面板数据面）",
	"/api/projects/:id/terminal-history": "项目命令历史查询/清理（命令历史面板 UI；跨项目检索 GET /api/terminal-history/search 已在手册）",
	// —— 终端/远程/通知/部署的视图与偏好面（人操作；agent 对应能力端点已在手册）——
	"/api/terminals/:id/redraw":        "权威重绘（终端视图渲染恢复，浏览器消费）",
	"/api/terminals/tmux-info":         "服务端 tmux 环境信息（终端视图诊断面）",
	"/api/terminals/tmux-install":      "tmux 安装向导（设置 UI 引导）",
	"/api/terminals/paste-image":       "终端粘贴图片上传（终端视图剪贴板面）",
	"/api/terminals/:id/sensitive":     "会话敏感标记（会话中心右键策展 UI；导出/分享警示自动消费）",
	"/api/remotehosts/status":          "主机在线状态批量查询（主机列表徽标轮询面）",
	"/api/remotehosts/diaghist":        "主机诊断趋势摘要（列表悬停展示面）",
	"/api/remotehosts/test":            "未保存表单参数直测连通性（新增/编辑弹窗「测试连接」；已存主机 POST /:id/test 已在手册）",
	"/api/remotehosts/export":          "主机配置导出（设置 UI 迁移面，口令在请求体）",
	"/api/remotehosts/import":          "主机配置导入（同上）",
	"/api/remotehosts/:id/duplicate":   "主机复制（列表右键 UI）",
	"/api/remotehosts/:id/hostkey":     "SSH 主机密钥 TOFU 指纹查看/重置（安全 UI；重置是合法迁移的人工裁决）",
	"/api/remotehosts/:id/terminals":   "远程主机终端 REST 面（远程终端视图消费，WS 通道已在手册 remote 节）",
	"/api/remotehosts/:id/paste-image": "远程终端粘贴图片（远程终端视图剪贴板面）",
	"/api/notifications/prefs":         "通知偏好读写（设置 UI）",
	"/api/notifications/webhook-test":  "外发推送测试（设置 UI）",
	"/api/notifications/dismiss-batch": "批量移除（通知中心批量 UI；单条 dismiss 已在手册）",
	"/api/notifications/clear":         "清空通知（通知中心 UI）",
	"/api/notifications/snooze":        "稍后提醒打标（通知中心 UI）",
	"/api/recordings":                  "审批窗口过程实况录制回放（值班大屏消费，录制默认关）",
	"/api/watch/":                      "文件监听降级开关与跨项目变更活动流（前端数据面；能力项 watch-fallback 同源）",
	"/api/deploy-config":               "部署配置读写（部署面板编辑 UI；执行面 POST /api/deploy 已在手册）",
	"/api/deploy/binaries":             "部署器二进制扫描（部署面板 UI）",
}

// liveKey 真实路由的（归一方法, 归一路径）键。
type liveKey struct{ method, path string }

// manualEntry 手册解析出的一个登记证据：rawPath 供对向核对的 gin 形态判定。
type manualEntry struct {
	method  string
	rawPath string
}

// TestManualRouteCoverage 手册↔路由双向对账主测试（三面对账见文件头注）。
func TestManualRouteCoverage(t *testing.T) {
	// —— 真实路由表：RegisterRoutes 收口（只注册不启动，app 对账测试同款装配）——
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)

	live := map[liveKey]bool{}
	livePaths := map[string]bool{}
	for _, ri := range r.Routes() {
		if _, ok := manualMethods[ri.Method]; !ok {
			continue // HEAD/OPTIONS 等传输变体不进对账
		}
		live[liveKey{ri.Method, normalizeRoutePath(ri.Path)}] = true
		livePaths[ri.Path] = true
	}
	if len(live) == 0 {
		t.Fatal("真实路由表为空——RegisterRoutes 装配失败？")
	}

	// —— 手册全文：/ops-manual 最终输出（头部 + 全部分节 Body）——
	covered, rawCovered := parseManualEndpoints(t, agentops.Manual(""))

	// —— 1. 路由→手册：漏登即红 ——
	var missing []string
	for _, ri := range r.Routes() {
		if _, ok := manualMethods[ri.Method]; !ok {
			continue
		}
		if _, wl := whitelistReason(manualWhitelist, ri.Path); wl {
			continue
		}
		if !covered[liveKey{manualMethods[ri.Method], normalizeRoutePath(ri.Path)}] {
			missing = append(missing, ri.Method+" "+ri.Path)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("路由已注册、手册未登记：%d 条——agent 能力面静默缩水。登记路径：agent 能力端点在所属能力域分节登记一行（server/agentops/sections_builtin.go 既有节追加，或能力包 manual.go 新节）；确属管理 UI/传输通道在 manualWhitelist 登记**具体前缀**+缘由：\n%s",
			len(missing), strings.Join(missing, "\n"))
	}

	// —— 2. 手册→路由：悬空登记即红（gin 形态、/api|/ws|/ops-manual 族才核对）——
	var stale []string
	for _, e := range rawCovered {
		if !isGinShapedPath(e.rawPath) || !manualDocFamily(e.rawPath) {
			continue
		}
		if !live[liveKey{e.method, normalizeRoutePath(e.rawPath)}] {
			stale = append(stale, e.method+" "+e.rawPath)
		}
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		t.Errorf("手册登记、路由已不存在（悬空条目）：%d 条——端点删除/改名后手册同步修剪或更名（文档对向漂移）：\n%s",
			len(stale), strings.Join(stale, "\n"))
	}

	// —— 3. 白名单不悬空：豁免前缀必须命中至少一条真实路由 ——
	var deadWL []string
	for prefix := range manualWhitelist {
		hit := false
		for p := range livePaths {
			if strings.HasPrefix(p, prefix) {
				hit = true
				break
			}
		}
		if !hit {
			deadWL = append(deadWL, prefix)
		}
	}
	if len(deadWL) > 0 {
		sort.Strings(deadWL)
		t.Errorf("白名单悬空（前缀未命中任何真实路由，端点删光后须显式修剪豁免条目——防腐化成第二本死账）：%v", deadWL)
	}
}

// parseManualEndpoints 把手册全文解析成登记证据：返回 归一键→存在 与
// 原始词元清单（对向核对用）。行内方法词 × 行内路径词取积（合写/散写/示例
// 块统一覆盖）；无方法词的行（纯路径提及）不产生证据——登记必须带方法。
func parseManualEndpoints(t *testing.T, manual string) (map[liveKey]bool, []manualEntry) {
	t.Helper()
	// {{BASE}} 占位符剥除：curl 示例里的 {{BASE}}/api/x 归一为 /api/x
	text := strings.ReplaceAll(manual, "{{BASE}}", "")
	covered := map[liveKey]bool{}
	var raw []manualEntry
	for _, line := range strings.Split(text, "\n") {
		methods := map[string]bool{}
		for _, m := range manualMethodRe.FindAllString(line, -1) {
			if norm, ok := manualMethods[m]; ok {
				methods[norm] = true
			}
		}
		if len(methods) == 0 {
			continue
		}
		for _, tok := range manualPathRe.FindAllString(line, -1) {
			p := sanitizeManualPath(tok)
			if p == "" {
				continue
			}
			np := normalizeRoutePath(p)
			for m := range methods {
				covered[liveKey{m, np}] = true
				raw = append(raw, manualEntry{method: m, rawPath: p})
			}
		}
	}
	if len(covered) == 0 {
		t.Fatal("手册全文未解析到任何「方法+路径」登记证据——手册结构变化时同步本解析器")
	}
	return covered, raw
}

// sanitizeManualPath 清洗路径词元：剥查询串、去尾部标点粘连（含 [?] 可选参数
// 记法的残留括号）、丢弃单段孤词（如「所有 /api 请求」的 /api——不是端点登记）。
func sanitizeManualPath(tok string) string {
	if i := strings.IndexByte(tok, '?'); i >= 0 {
		tok = tok[:i]
	}
	tok = strings.TrimRight(tok, ".,;:[]")
	if tok == "/ops-manual" {
		return tok
	}
	if !strings.Contains(strings.TrimPrefix(tok, "/"), "/") {
		return ""
	}
	return tok
}

// normalizeRoutePath 占位段归一：gin 的 :param / *wildcard 与手册的 <id> /
// $CC_TERMINAL_ID 等占位段统一折算 <p>，两侧同构可比。
func normalizeRoutePath(p string) string {
	segs := strings.Split(p, "/")
	for i, seg := range segs {
		if seg == "" {
			continue
		}
		if strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") ||
			strings.HasPrefix(seg, "<") || strings.HasPrefix(seg, "$") {
			segs[i] = "<p>"
		}
	}
	return strings.Join(segs, "/")
}

// isGinShapedPath 手册路径词是否 gin 注册形态（占位只用 :name）——只有 gin
// 形态才参与「手册→路由」对向核对；<id>/$VAR 是行文变体、* 是通配散文记法
// （如「/ws/* 用子协议」），均不核对。
func isGinShapedPath(p string) bool {
	return !strings.ContainsAny(p, "<>$*")
}

// manualDocFamily 对向核对的路径族：主引擎注册面（分享子服务 /s/<token> 等
// 独立端口面不在主路由表，天然排除）。
func manualDocFamily(p string) bool {
	return strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/ws/") || p == "/ops-manual"
}

// whitelistReason 前缀匹配白名单；命中即豁免（缘由供评审，测试输出不展示）。
func whitelistReason(wl map[string]string, path string) (string, bool) {
	for prefix, reason := range wl {
		if strings.HasPrefix(path, prefix) {
			return reason, true
		}
	}
	return "", false
}
