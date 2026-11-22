package shareapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 终端只读直播分享（P-20261003-306；P-20261118-9 起 store 侧同族在
// server/store/share_terminal.go）的 handler 面：创建请求/馈线接线口/审计
// 文本件。P-20261119-5 从 handlers.go 整段迁出（体量守卫：handlers.go 存量
// 超阈，新增永久挡不得加深欠账——纯搬移零改写，行为语义的权威注释随代码走）。
// 冻结快照（terminal-frozen）面仍在 handlers.go，勿并入本文件：两者生命周期
// 不同（直播随会话、快照脱离会话）。

// liveWire 终端直播馈线接线口（liveterm.Hub 结构性满足；Module Start 注入、
// Stop 摘除。nil = 未装配——创建仍成功，馈线在访客订阅时由 hub 惰性接通，
// 语义不变只是首访多一次播种）。unfiltered 是 live 源参数（P-20261106-9）：
// 取生效记录（幂等命中时是既有记录，非请求值）的 Unfiltered，模式不符的
// 陈旧馈线由 hub 整条替换；Prune 供过期清理巡检按存活 token 集收口馈线
type liveWiring interface {
	Wire(token, sessionID string, unfiltered bool)
	Unwire(token string)
	Prune(keep map[string]bool) int
}

var liveWire liveWiring

// setLiveWire 注入/摘除接线口（Module Start/Stop 调用；测试可直接置 nil）
func setLiveWire(h liveWiring) { liveWire = h }

// unfilteredEgressNote 未过滤分享（P-20261106-9）的审计/日志 Detail 后缀：
// 敏感值遮蔽被显式关闭是出域安全事件的关键维度，审计台账必须一眼可辨
func unfilteredEgressNote(unfiltered bool) string {
	if unfiltered {
		return ", UNFILTERED"
	}
	return ""
}

// writableEgressNote 开放直入出生（P-20261121-1 创建面快捷选择）的审计/
// 日志 Detail 后缀：键入授权随创建直接落地的分享必须一眼可辨（泄露半径
// 抬升到「打 shell」，与 UNFILTERED 同族出域标注）
func writableEgressNote(writable bool) string {
	if writable {
		return ", WRITABLE"
	}
	return ""
}

// expiryTTLText 记录剩余有效期的可读文本（P-20261119-5）：永久记录的零值
// ExpiresAt 经 time.Until 会输出 ≈-2562047h 的不可读值，统一输出 permanent
// 字样（SetShareExpiry 的 target 口径同款）。round = 显示粒度（日志秒级、
// 审计分钟级）
func expiryTTLText(at time.Time, round time.Duration) string {
	if at.IsZero() {
		return "permanent"
	}
	return time.Until(at).Round(round).String()
}

// createTerminalReq 终端直播分享请求
type createTerminalReq struct {
	// SessionID 终端会话 ID（必填；不限 shell/agent——直播的是输出不是控制权）
	SessionID string `json:"sessionId" binding:"required"`
	// TTLMinutes 可选有效期覆盖（分钟）；缺省/0 = store.TerminalLiveTTL 30 分钟，
	// 上限钳到 store.TerminalLiveTTLMax。显式永久不走本字段（见 Permanent）——
	// 限时档与永久挡互斥
	TTLMinutes int `json:"ttlMinutes"`
	// Permanent 显式永久挡（P-20261119-5，用户定向推翻「直播无永久档」旧决策）：
	// true = 分享记录与 token 不再过期（链接恒有效、管理面板恒可见），直播态
	// 本身仍随会话（会话关闭 → 访客页「已结束」；tmux 跨重启恢复即复活）。
	// 与 TTLMinutes 同时给出 → 400（两来源矛盾静默择一会让调用方拿到非预期
	// 窗口，文件分享 expiresAt/ttl 互斥同口径）；与 Unfiltered 同时为 true
	// 合法（【用户定向修订】2026-11-19：不再硬禁——显式选择=用户意志+撤销
	// 兜底，警示面在创建对话框/审计标注，行动自由交给用户）
	Permanent bool `json:"permanent"`
	// Override 敏感会话出域警示的确认标记（P-20261003-155）：true = 用户已在
	// 警示框确认仍要开直播（首次请求恒为 false；命中警示时响应不带 data，
	// 创建被拦下）——与文件分享扫描的 override 同一契约
	Override bool `json:"override"`
	// Passphrase 可选访问口令（P-20261006-25，四形态统一守卫）：非空 = 直播
	// 加口令门（访客页同门，stream 端点同守卫）；幂等命中既有直播时带新
	// 口令=改门、不带=保持既有
	Passphrase string `json:"passphrase"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开，
	// 显式 false = 关
	Watermark *bool `json:"watermark"`
	// ViewOnce 显式拒绝位（P-20261006-27）：直播是持续流语义，「看一眼即焚」
	// 不成立——传 true 一律 400（可编程感知，不静默吞）
	ViewOnce bool `json:"viewOnce"`
	// Unfiltered 敏感值遮蔽关闭开关（P-20261106-9）：缺省 false = 遮蔽开（安全
	// 默认不可让步，旧客户端/agent 不带字段即遮蔽）；true = 直播 feeder 原样
	// 转发（内网协作原样输出场景，访客页标注「未过滤」）。创建时定死：幂等
	// 命中既有直播时以既有记录为准（改配置须结束直播后重开）
	Unfiltered bool `json:"unfiltered"`
	// Writable 开放直入快捷选择（P-20261121-1 统一收编：创建弹层的访客输入
	// 快捷选择——显式 opt-in 即合法出生，与行内开关同闸）：缺省 false = 键入
	// 关（安全默认，旧客户端零变化）；true = 持链接（+口令）访客可经 WS 上
	// 行桥直接键入锚定终端。**强制口令门与行内开关同款**：无门记录必携
	// Passphrase 补设，缺门 400（writable requires a passphrase——泄露半径
	// 抬升到「打 shell」的成比例补偿）。幂等命中既有直播时以既有记录为准
	//（改输入授权须结束直播后重开，Unfiltered 同款创建时定死语义）
	Writable bool `json:"writable"`
}

// CreateTerminalLive POST /api/share/terminal —— 终端只读直播分享（远程结对/
// 教学/汇报场景）：token→会话锚点，访客经短链看遮蔽化只读输出流。
// 幂等：同一会话重复开直播得到同一短链（倒计时不续期）；会话已关闭 → 404
// （无可直播的源，不做「空直播」记录）。创建即接通馈线（tap 从此刻累积
// 遮蔽尾流，先于任何访客订阅）。
// 永久挡（P-20261119-5）：permanent=true = 记录与 token 永不过期，但直播态
// 仍随会话——会话关闭访客页「已结束」，tmux 跨重启恢复（RecoverSessions 同 ID
// 重建 + hub 惰性 Wire）即复活；mid-run 不复活（该场景现势不存在）。
// permanent×unfiltered 合法（【用户定向修订】2026-11-19：撤销兜底即可）——
// 对冲面=创建对话框警示文案+审计 permanent/UNFILTERED 双标，组合不再是硬禁。
// 敏感出域闸门（P-20261003-155）：会话被人工标记敏感且未带 override 时不创建，
// 响应仅带 warnings（shared.SensitiveSessionWarning）——创建被拦下，前端弹
// 「确认出域」后带 override 二次请求才落库（文件分享扫描同流）
func CreateTerminalLive(c *gin.Context) {
	var req createTerminalReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	// 一次性不适用于直播（P-20261006-27⑤）：持续流无「看一眼」语义
	if req.ViewOnce {
		shared.Error(c, http.StatusBadRequest, "viewOnce is not supported for terminal live", nil)
		return
	}
	if req.TTLMinutes < 0 {
		shared.Error(c, http.StatusBadRequest, "ttlMinutes must be >= 0", nil)
		return
	}
	// 永久挡校验（P-20261119-5）：permanent×ttlMinutes 两来源矛盾落在创建面
	// 400——静默择一会让请求值≠生效值（文件分享 expiresAt/ttl 互斥先例；
	// viewOnce 400 同款「可编程感知、不静默吞标志」纪律）。permanent×unfiltered
	// 【用户定向修订】2026-11-19 起合法：不再 400 硬禁（撤销兜底即可），警示面
	// 在创建对话框与审计标注（UNFILTERED+permanent 双标）
	if req.Permanent && req.TTLMinutes > 0 {
		shared.Error(c, http.StatusBadRequest, "permanent and ttlMinutes are mutually exclusive", nil)
		return
	}
	sess := terminal.DefaultManager.GetSession(req.SessionID)
	if sess == nil {
		shared.Error(c, http.StatusNotFound, "terminal session not found", nil)
		return
	}
	if shared.IsSessionSensitive(req.SessionID) && !req.Override {
		slog.Info("terminal live share blocked by sensitive mark", "session", req.SessionID)
		c.JSON(http.StatusOK, gin.H{"warnings": []string{shared.SensitiveSessionWarning}})
		return
	}
	expiresAt := time.Time{}
	if req.TTLMinutes > 0 {
		expiresAt = time.Now().Add(time.Duration(req.TTLMinutes) * time.Minute)
	}
	// 开放直入口令门强制（P-20261121-1：与行内开关修订点5同款——无门记录
	// 必携 passphrase 补设，400 稳定错误码是前端弹「先设口令」的契约）
	if req.Writable && req.Passphrase == "" {
		shared.Error(c, http.StatusBadRequest, "writable requires a passphrase", nil)
		return
	}
	// 口令门（P-20261006-25）：哈希先行，明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	created, err := store.Get().Share.Create(store.Share{
		Kind:           store.ShareKindTerminal,
		TerminalID:     req.SessionID,
		Name:           sess.Name,
		ExpiresAt:      expiresAt,
		Permanent:      req.Permanent,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
		Unfiltered:     req.Unfiltered,
		Writable:       req.Writable,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create terminal live share failed", err)
		return
	}
	// 幂等命中语义（P-20261119-5）：store 幂等分支保留既有倒计时是安全边界
	//（重复分享不得暗中续期/清窗）；显式永久命中既有记录时这里经 SetExpiry
	// 清窗（文件分享 applyExplicitExpiry 同边界），未显式选择保持既有倒计时。
	// 既有记录若为未过滤（模式不匹配、前端 modeMismatch 回告）同样清窗——
	// 显式永久对未过滤记录合法（【用户定向修订】），SetExpiry 对 terminal
	// 零值豁免钳制不再静默降级 24h
	if req.Permanent && !created.ExpiresAt.IsZero() {
		cleared, cerr := store.Get().Share.SetExpiry(created.Token, time.Time{})
		if cerr != nil {
			shared.Error(c, http.StatusInternalServerError, "create terminal live share failed", cerr)
			return
		}
		created = cleared
	}
	// 馈线即刻接通：分享创建到访客首连之间的输出也要进遮蔽尾流（否则那段
	// 输出在访客页只以播种形式晚到，时序错乱）。幂等命中同链时 Wire no-op。
	// 遮蔽模式取生效记录（P-20261106-9：幂等命中 = 既有记录的定死配置）
	if liveWire != nil {
		liveWire.Wire(created.Token, created.TerminalID, created.Unfiltered)
	}
	slog.Info("terminal live share created", "token", share.TokenSummary(created.Token),
		"session", created.TerminalID, "ttl", expiryTTLText(created.ExpiresAt, time.Second),
		"unfiltered", created.Unfiltered, "writable", created.Writable)
	// 审计入账：终端输出暴露到匿名短链，创建即安全事件（与文件分享同族）；
	// 永久挡以 permanent 字样入账（零值 ExpiresAt 的时长不可读，见 expiryTTLText）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("terminal live: %s (%s, ttl %s%s%s)", sess.Name, created.TerminalID,
			expiryTTLText(created.ExpiresAt, time.Minute), unfilteredEgressNote(created.Unfiltered),
			writableEgressNote(created.Writable)),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created)})
}
