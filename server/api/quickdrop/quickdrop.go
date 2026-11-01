// Package quickdrop 快投递（P-20261006-51）：手机/脚本 → 工作台实例的最轻
// 投递通道。三块面：
//
//   - 投递原语 POST /api/quickdrop（公开路由注册，token 即凭据——agent 脚本/
//     iOS 快捷指令 curl 直投；无效 token 恒 404，不暴露端点存在性）
//   - 访客投递页 GET/POST /drop/:token（零依赖单页，与 Share 访客页同形态——
//     见 page.go）
//   - 管理面 /api/quickdrop（token 生命周期 + 收件箱列表/摘除，组内鉴权面）
//
// 到达处理收口在本包 ingest：内容入车道 1 短 TTL 文档（store.Quickdrop，
// 24h 过期与 ask 收件箱同语义）→ 通知中心入账（带遮蔽摘要行 + 行内动作双
// 出口：交给当前会话 / 新会话处理，前端消费）→ 审计入账（只记元数据不含
// 正文，P-13 纪律同款）。
package quickdrop

import (
	"fmt"
	"net/http"
	"strings"

	"codecombo/server/api/shared"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 请求护栏：内容 ≤ store.MaxDropBytes（4KB），请求体封顶 16KB（JSON 包裹与
// 表单编码的余量；LimitBody 在解析前置位生效，broadcast 同款惯例）
const dropMaxBody = 16 << 10

// PayloadPrefix 行内动作载荷前缀（sentinel: 前缀同款先例）：
// 「quickdrop:<投递 id>」，前端按前缀解出 id 后回查收件箱取内容
const PayloadPrefix = "quickdrop:"

// dropMaxBrief 通知摘要行的 rune 上限（通知体是短摘要语义，80 rune 展示位
// 取向；summarizeInstruction 同值同款）
const dropMaxBrief = 80

// PostDrop POST /api/quickdrop {"token","content"}——投递原语（公开端点）。
// 三重护栏：token 门禁（无效 404——404 与「端点不存在」不可区分，不向无凭据
// 探测者暴露面）、限流（注册处 mw.RateLimitMiddleware 按 IP 维度）、长度上限
// （4KB）。到达经 ingest 落收件箱 + 通知 + 审计。
// 响应 {"data":{"id","expiresAt"}}；错误体刻意不带 code（访客/脚本面按
// status 分支足够，无程序化自纠分支可言）
func PostDrop(c *gin.Context) {
	shared.LimitBody(c, dropMaxBody)
	var req struct {
		Token   string `json:"token"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "request too large",
				fmt.Errorf("request body exceeds %d bytes", dropMaxBody))
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	q, ie := ingest(c, req.Token, req.Content)
	switch ie {
	case ingestOK:
	case ingestErrToken:
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	case ingestErrEmpty:
		shared.Error(c, http.StatusBadRequest, "content is required", nil)
		return
	case ingestErrTooLarge:
		shared.Error(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("content exceeds %d bytes", store.MaxDropBytes), nil)
		return
	default:
		shared.Error(c, http.StatusInternalServerError, "save quickdrop failed", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": q.ID, "expiresAt": q.ExpiresAt}})
}

// ListDrops GET /api/quickdrop——收件箱清单（管理面，组内鉴权；新→旧，只含
// 存活条目）。前端行内动作回查内容与分享区收件箱卡共用此面
func ListDrops(c *gin.Context) {
	drops, err := store.Get().Quickdrop.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "list quickdrops failed", err)
		return
	}
	type item struct {
		store.Quickdrop
		Size int `json:"size"`
	}
	out := make([]item, 0, len(drops))
	for _, d := range drops {
		out = append(out, item{Quickdrop: d, Size: len(d.Content)})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// DeleteDrop DELETE /api/quickdrop/:id——摘除单条（转发消费后手动清理；
// 未知 id 幂等成功，与 dismiss 语义一致）
func DeleteDrop(c *gin.Context) {
	if err := store.Get().Quickdrop.Delete(c.Param("id")); err != nil {
		shared.Error(c, http.StatusInternalServerError, "delete quickdrop failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// GetDropToken GET /api/quickdrop/token——投递凭据元信息（不含明文）
func GetDropToken(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": store.Get().QuickdropToken.Meta()})
}

// CreateDropToken POST /api/quickdrop/token——生成/轮换凭据（明文仅本次响应
// 返回一次，落盘只存哈希）。已存在即轮换：旧 token 立即失效（泄露应对与
// agent token rotate 同语义）
func CreateDropToken(c *gin.Context) {
	plain, err := store.Get().QuickdropToken.Generate()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "generate quickdrop token failed", err)
		return
	}
	auditTokenAction(c, "generate")
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"token": plain, "meta": store.Get().QuickdropToken.Meta()}})
}

// RevokeDropToken DELETE /api/quickdrop/token——撤销凭据（投递页与端点即刻 404）
func RevokeDropToken(c *gin.Context) {
	if err := store.Get().QuickdropToken.Revoke(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "revoke quickdrop token failed", err)
		return
	}
	auditTokenAction(c, "revoke")
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// ingestError 投递主链的分型失败（响应形态由调用方自渲染——JSON 端点与
// HTML 访客页对同一失败给出各自语境的呈现，主链只裁决不写响应）
type ingestError int

const (
	ingestOK          ingestError = iota
	ingestErrToken                // 凭据无效/未生成/已撤销（404，存在性不可探测）
	ingestErrEmpty                // 内容 trim 后为空（400）
	ingestErrTooLarge             // 内容超 4KB（413）
	ingestErrStore                // 存储不可用/写失败（500）
)

// ingest 投递到达主链（POST /api/quickdrop 与访客页表单共用）：
// token 门禁 → 内容校验 → 收件箱入账 → 通知 → 审计。
// 失败时不写响应，返回分型错误由调用方按各自形态呈现（JSON / HTML）；
// 通知与审计均为尽力而为旁路（落库失败不阻断主流程——审计 Append 自带
// 尽力而为；通知 Add 失败无声但收件箱仍有内容可查）
func ingest(c *gin.Context, token, content string) (store.Quickdrop, ingestError) {
	st := store.Get()
	if st == nil {
		return store.Quickdrop{}, ingestErrStore
	}
	// token 门禁：无效/未生成/已撤销一律 404（与路由不存在的响应同形，
	// 探测者无从区分「无此端点」与「凭据无效」）
	if !st.QuickdropToken.Validate(token) {
		return store.Quickdrop{}, ingestErrToken
	}
	// 内容校验：首尾空白是手机键盘/复制噪声，trim 后非空才算有效投递；
	// 上限对齐 store.MaxDropBytes（字节口径——4KB 对 CJK 同样收敛）
	content = strings.TrimSpace(content)
	if content == "" {
		return store.Quickdrop{}, ingestErrEmpty
	}
	if len(content) > store.MaxDropBytes {
		return store.Quickdrop{}, ingestErrTooLarge
	}
	q, err := st.Quickdrop.Add(store.Quickdrop{Content: content, From: c.ClientIP()})
	if err != nil {
		return store.Quickdrop{}, ingestErrStore
	}
	notifyArrived(st, q)
	auditIngest(c, q, len(content))
	return q, ingestOK
}

// notifyArrived 到达通知（通知中心 + WS 广播经事件总线自动跟随）：模板化
// 文案（titleKey + 参数，P-20261001-30 惯例）+ 遮蔽摘要行（投递内容可能含
// 密钥——摘要先过 mask.MaskText 再截断，遮蔽在前防截断切漏密钥片段；
// P-108 同序）。行内动作双出口挂主动作/第二动作槽（P-150 契约）：
// 主动作「交给当前会话」（broadcast-write 写入激活会话）、第二动作「新会话
// 处理」（createAgent 以投递内容为 launchArgs 种子），payload=前缀+id，
// 前端回查 GET /api/quickdrop 取内容
func notifyArrived(st *store.Store, q store.Quickdrop) {
	st.Notification.Add(notification.Notification{
		Type:     "info",
		Category: notification.CategoryDrop,
		TitleKey: "notify.quickdrop.arrived",
		MsgParams: map[string]any{
			"from": q.From,
			"size": len(q.Content),
		},
		Body:                dropBrief(q.Content),
		Action:              "quickdrop-active",
		ActionPayload:       PayloadPrefix + q.ID,
		SecondAction:        "quickdrop-new",
		SecondActionPayload: PayloadPrefix + q.ID,
	})
}

// auditIngest 投递入账审计：只记来源/字节量/条目 id 元数据，正文不入账
// （P-13 纪律同款——审计是「谁在何时投了多大」的底账，内容在收件箱有
// TTL 生命周期，不进审计长留痕）
func auditIngest(c *gin.Context, q store.Quickdrop, size int) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditQuickdropDrop,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("id=%s bytes=%d", q.ID, size),
	})
}

// auditTokenAction 凭据管理动作入账（generate/revoke；动作词进 Detail，
// 不涉任何秘密值）
func auditTokenAction(c *gin.Context, action string) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditQuickdropToken,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: action,
	})
}

// dropBrief 摘要行：首条非空行，控制字符折叠为空格单行化（防通知面板/
// webhook 注入，broadcastDataBrief 同款）→ mask 遮蔽 → rune 截断。
// 全空行内容（纯换行/纯空白已被上游拒绝，防御未来调用方）返回空串——
// Body 为空时前端只渲染标题行
func dropBrief(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		folded := strings.Map(func(r rune) rune {
			if r < 0x20 || r == 0x7f {
				return ' '
			}
			return r
		}, line)
		masked := mask.MaskText(folded)
		runes := []rune(masked)
		if len(runes) <= dropMaxBrief {
			return masked
		}
		return string(runes[:dropMaxBrief]) + "…"
	}
	return ""
}
