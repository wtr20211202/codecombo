package system

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 数据出域面总览（P-20261003-20）：自托管安全的关键问题「这台实例的数据会流到
// 哪里去」的只读聚合答案。出域口分散在通知（webhook）/分享/安全（agent token）/
// 远程（主机凭据）四个分区，本端点一次取齐供安全分区总览卡展示，另附安全事件
// 审计计数。零新增敏感暴露纪律（与 P-95 日志脱敏同源）：webhook URL 只出脱敏
// 展示态（host+路径，query/凭据形状的路径段一律不回显）；分享只出目标与时间窗
// （token 是访问凭据，绝不回显）；agent token 只出 Meta（本就不含秘密值）；远程
// 主机只出数量。全部复用各存储既有读取口，不新增任何明文通道。

// egressTokenShapeMinLen 路径段按凭据形状打码的长度下限：Bark/Pushover 类推送
// key 走路径而非 query（https://api.day.app/<key>/），短于该值的段几乎不可能是
// 随机凭据（ntfy topic 等普通路径不受影响）
const egressTokenShapeMinLen = 16

// maskWebhookEndpoint 把 webhook 端点 URL 脱敏为可展示态（scheme://host+路径）：
//   - query/fragment 整体剥除（GET 模板的插值参数是最常见的密钥藏身处），仅留 ？… 占位
//   - 路径中凭据形状的段（剥 ≤5 字符尾缀后 ≥egressTokenShapeMinLen 位纯字母数字
//     与 -/_）整段打码为 ***——Bark 式裸 key 与 sctapi 式 key.send 两种挂法都不回显；
//     普通路径段（ntfy topic、文件名等）保留。宁可多打码：误伤一个长路径段的
//     可读性代价远小于漏显一枚推送 key
//   - 解析失败不回显原文，返回不可解析占位符；空串（未配置）返回空串
func maskWebhookEndpoint(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "<unparsable>"
	}
	masked := u.Scheme + "://" + u.Host
	if u.Path != "" {
		segs := strings.Split(u.Path, "/")
		for i, seg := range segs {
			if isTokenShaped(seg) {
				segs[i] = "***"
			}
		}
		masked += strings.Join(segs, "/")
	}
	if u.RawQuery != "" {
		masked += "?…"
	}
	return masked
}

// isTokenShaped 路径段是否呈随机凭据形状：剥掉 ≤5 字符的已知端点尾缀（.send/.json
// 等）后足够长、仅字母数字与连字符/下划线、不含其他标点（含点的语义段如文件名
// 在尾缀剥除后仍留点/变短，自然落到保留侧）
func isTokenShaped(seg string) bool {
	if i := strings.LastIndex(seg, "."); i > 0 && len(seg)-i-1 <= 5 {
		seg = seg[:i]
	}
	if len(seg) < egressTokenShapeMinLen {
		return false
	}
	for _, r := range seg {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// egressWebhook 单个 webhook 端点的总览形态（endpoint 恒为脱敏展示态）
func egressWebhook(w notification.WebhookPrefs) gin.H {
	n := w.Normalized()
	return gin.H{
		"enabled":  n.Enabled,
		"mode":     n.Mode,
		"scope":    n.Scope,
		"endpoint": maskWebhookEndpoint(n.URL),
	}
}

// shareKindNorm 分享形态归一：存量记录零值按 file 解读（shareResponse 同口径）
func shareKindNorm(k store.ShareKind) store.ShareKind {
	if k == "" {
		return store.ShareKindFile
	}
	return k
}

// egressShareEntries 分享记录 → 总览条目：只盘活跃出域口（过期 snippet 已 404，
// 不算敞口），token 是访问凭据绝不回显
func egressShareEntries(shares []store.Share, now time.Time) []gin.H {
	active := make([]gin.H, 0, len(shares))
	for _, s := range shares {
		if s.Expired(now) {
			continue
		}
		entry := gin.H{
			"kind":        shareKindNorm(s.Kind),
			"name":        s.Name,
			"projectName": s.ProjectName,
			"path":        s.Path,
			"createdAt":   s.CreatedAt,
		}
		if !s.ExpiresAt.IsZero() {
			entry["expiresAt"] = s.ExpiresAt
		}
		active = append(active, entry)
	}
	return active
}

// EgressOverview GET /api/system/egress-overview —— 数据出域面总览（纯只读聚合）。
// 管理面鉴权：挂在全局 api 组（LockMiddleware + TokenAuthMiddleware）之下
func EgressOverview(c *gin.Context) {
	shares, err := store.Get().Share.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		return
	}
	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		return
	}
	_, auditTotal, err := store.Get().Audit.List(1, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		return
	}

	activeShares := egressShareEntries(shares, time.Now())
	c.JSON(http.StatusOK, gin.H{
		"webhook":    egressWebhook(store.Get().Notification.GetPrefs().Webhook),
		"shares":     gin.H{"count": len(activeShares), "items": activeShares},
		"agentToken": store.Get().AgentToken.Meta(),
		"remoteHosts": gin.H{
			"count": len(hosts), // 只出数量：主机清单走远程分区列表接口（响应剥敏感字段）
		},
		"audit": gin.H{"total": auditTotal},
	})
}
