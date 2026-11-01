package api

// HandleWhoami GET /api/whoami —— 令牌自校验端点（P-20261004-15）。
//
// 动机：agent 脚本/新会话启动的第一件事是确认凭据可用——此前只能拿任意业务
// 端点试错看 401/200，失败时无从得知「令牌坏了还是端点不存在」。whoami 是
// 轻量引导原语：一次调用回答「我是谁（tokenKind）、令牌有效吗（无效 401 且
// 按令牌族区分错误）、我能干什么（capabilities 摘要）」。P-20261004-133 起
// 再答「我在哪台实例」（instance 块）——多机编排（派发 P-101/回流 P-131）
// 形态下日志归属、上报标注、回流映射都要实例标识，自检从「我是谁」补全到
// 「我在哪」。P-20261006-30 起再答「还开得下几个会话」（sessions 块）——
// agent 批量开会前查配额余量自适应分批，把超限错误（errTooManySessions）
// 从事后错变事前避。
//
// 挂 /api 组（LockMiddleware+TokenAuth+AgentGuard）内，agent 令牌（sca_）与
// 解锁令牌（scl_）均可。锁定开启时无效令牌先被 LockMiddleware 以 423 拦下
// （既有语义，同凭据拒绝）；锁定关闭时中间件全放行，由本端点自校验并返回
// 401——「无效令牌 → 401 区分」即指此路径。capabilities 沿 P-20261004-4
// /api/meta 的模块注册表复用（kernel.Manifest 声明，零额外维护面）。
// scopes 字段待 P-175（Token scope）落地后自然挂载，本版不做。

import (
	"net"
	"net/http"
	"strconv"
	"strings"

	"codecombo/server/api/system"
	"codecombo/server/claims"
	"codecombo/server/config"
	mw "codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// tokenKind 取值：与手册/SKILL 文案及 e2e 断言共用的事实词
const (
	whoamiKindAgent  = "agent"  // sca_ 智能体令牌（终端 env CC_LOCK_TOKEN）
	whoamiKindUnlock = "unlock" // scl_ 解锁令牌（密码解锁换取）
	whoamiKindAccess = "access" // sc_ 机器 API 令牌（Authorization Bearer，LockMiddleware 豁免链）
)

// WhoamiInstance 实例自定位块（P-20261004-133）：多机编排形态下 agent 的
// 「我在哪台」——日志归属/上报标注/回流映射的实例标识
type WhoamiInstance struct {
	// InstanceName 本实例展示名：实例注册库本机条目的登记名（实例面板可改，
	// 启动期 ops 装配即建档）；注册库不可达/条目缺失/名为空时缺省 host:port
	InstanceName string `json:"instanceName"`
	// InstanceID 数据目录级持久身份（claims.InstanceID，崩溃重启不换号；
	// 与实例族总览 fleet 聚合同源，注意与注册实例 id 异构——两套命名空间）
	InstanceID string `json:"instanceId"`
	// Port 本实例主端口（设置面 Server.Port，缺省 9999——与 fleet selfPort 同源）
	Port int `json:"port"`
}

// WhoamiSessions 会话配额块（P-20261006-30）：agent 批量开会前的预检原语——
// 第 MaxSessions+1 个创建必败（errTooManySessions），开批前查余量自适应分批
type WhoamiSessions struct {
	// Max 单进程终端会话上限生效值（terminal.MaxSessions()，可配
	// server.terminalMaxSessions 的读取端归一值，与创建路径准入同源）
	Max int `json:"max"`
	// Current 查询时刻本进程终端管理器的存活会话数（瞬时快照：与后续创建
	// 之间存在竞态——他处并发创建/关闭都会移动该值，agent 仍需处理创建失败
	// 兜底；口径=本进程内存态，不含代理/派发到对端实例的会话）
	Current int `json:"current"`
}

// WhoamiResponse /api/whoami 响应体（meta 同款平铺形状，无 data 包裹）
type WhoamiResponse struct {
	// TokenKind 本次请求凭据族：agent | unlock | access
	TokenKind string `json:"tokenKind"`
	// TerminalID X-Session-ID 头（操作手册约定携带 $CC_TERMINAL_ID）指向的
	// 会话仍在终端管理器时回显；会话已关/恢复失败则省略——引导期即可发现
	// 「会话没了」而不必等首个写操作报错
	TerminalID string `json:"terminalId,omitempty"`
	// Version 实例构建版本（构建信息细节见 /api/meta.version）
	Version string `json:"version"`
	// Capabilities 已注册能力项（去重稳定排序；无内核注入时空数组非 null）
	Capabilities []string `json:"capabilities"`
	// Instance 实例自定位块（恒在：instanceId 是数据目录级身份不依赖 claim
	// 文件，无 claim 形态照回——instanceName/port 走缺省回落）
	Instance WhoamiInstance `json:"instance"`
	// Sessions 会话配额块（恒在：max 恒有生效值、current 零会话也是合法答案；
	// 纯增量字段，旧消费者忽略零负担）
	Sessions WhoamiSessions `json:"sessions"`
}

// HandleWhoami 令牌自校验（引导原语，只读零副作用）
func HandleWhoami(c *gin.Context) {
	kind, failMsg := whoamiCredential(c)
	if failMsg != "" {
		// 401 与 LockMiddleware 的 423 语义分层：423=「系统锁着，先解锁」，
		// 401=「凭据本身无效，按 failMsg 指向的令牌族处理」
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": failMsg})
		return
	}
	resp := WhoamiResponse{
		TokenKind:    kind,
		Capabilities: metaCapabilities(),
		Instance:     whoamiInstance(),
		Sessions:     whoamiSessions(),
	}
	resp.Version, _, _ = system.BuildInfo()
	if sid := strings.TrimSpace(c.GetHeader("X-Session-ID")); sid != "" &&
		terminal.DefaultManager.GetSession(sid) != nil {
		resp.TerminalID = sid
	}
	c.JSON(http.StatusOK, resp)
}

// whoamiInstance 组装实例自定位块。instanceId/port 沿 P-56 实例族总览同源
// 读取（claims.InstanceID + 主端口缺省 9999）；instanceName 的 claims 注册表
// 只记 instanceId/port 无名字（claims.Claim 形态），登记名的真实载体是实例
// 注册库本机条目。全只读：不走 Instance.GetLocal（条目缺失时会建档写盘，
// 破坏本端点「只读零副作用」契约），改用 List 查找
func whoamiInstance() WhoamiInstance {
	port := store.Get().Settings.Get().Server.Port
	if port == 0 {
		port = 9999
	}
	blk := WhoamiInstance{Port: port}
	if id, err := claims.InstanceID(config.DataDir()); err == nil {
		blk.InstanceID = id
	}
	blk.InstanceName = whoamiLocalName(port)
	return blk
}

// whoamiSessions 组装会话配额块。max 与创建路径准入同源（MaxSessions() 生效值，
// 可配化 P-20261006-12 后随 server.terminalMaxSessions）；current 取 manager
// 存活数的锁下快照（SessionCount 只数不排，引导原语的读路径零分配）。两值
// 非同刻事务读：max 启动期定值不漂，current 独立瞬时——块语义即「查询时刻
// 快照」，无更强一致性承诺（手册已注明 agent 仍需创建失败兜底）
func whoamiSessions() WhoamiSessions {
	return WhoamiSessions{
		Max:     terminal.MaxSessions(),
		Current: terminal.DefaultManager.SessionCount(),
	}
}

// whoamiLocalName 实例注册库本机条目的登记名（只读线性查找，实例量个位级
// 与 dispatch.findInstance 同口径，List 另有 5s 缓存）；取不到时缺省 host:port
// （提案缺省形态，host 与 GetLocal 自建条目的 URL localhost 同为设置面值）
func whoamiLocalName(port int) string {
	if list, err := store.Get().Instance.List(); err == nil {
		for _, inst := range list {
			if inst.IsLocal && inst.Name != "" {
				return inst.Name
			}
		}
	}
	return net.JoinHostPort(store.Get().Settings.Get().Server.Host, strconv.Itoa(port))
}

// whoamiCredential 判别请求凭据的族与有效性。
//
// X-Lock-Token 优先（手册约定的 agent/解锁凭据载体）：前缀决定校验哪个存储，
// 避免 sca_ 坏值被误报成解锁令牌失败；无该头时回退 Authorization Bearer
// （LockMiddleware 豁免链的机器间语义，tokenKind=access）。
// 返回 (kind, failMsg)：failMsg 空串 = 凭据有效；非空 = 面向调用方的 401 文案
// （按令牌族区分，agent 据此决定重取令牌还是重新解锁）。
func whoamiCredential(c *gin.Context) (string, string) {
	if t := strings.TrimSpace(c.GetHeader(mw.LockHeaderName)); t != "" {
		if strings.HasPrefix(t, "sca_") {
			if store.Get().AgentToken.Validate(t) {
				return whoamiKindAgent, ""
			}
			return "", "agent token invalid or revoked (re-provision: POST /api/agent-token/rotate)"
		}
		if store.Get().Lock.ValidateToken(t) {
			return whoamiKindUnlock, ""
		}
		return "", "unlock token invalid or expired (re-unlock to obtain a new one)"
	}

	ah := c.GetHeader("Authorization")
	if ah == "" {
		return "", "no credential presented (X-Lock-Token: sca_/scl_ token, or Authorization: Bearer sc_ token)"
	}
	parts := strings.SplitN(ah, " ", 2)
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		if _, err := store.Get().Token.Validate(strings.TrimSpace(parts[1])); err == nil {
			return whoamiKindAccess, ""
		}
	}
	return "", "access token invalid"
}
