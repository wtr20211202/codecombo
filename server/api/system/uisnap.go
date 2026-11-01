package system

// 用户 UI 现场（P-20261004-52）HTTP 面。路由（router.go 注册，组中间件
// LockMiddleware + TokenAuthMiddleware——浏览器解锁令牌上报、agent sca_ 令牌
// 读取同组可达；读取是纯观测面不进 AgentGuard 高危清单，ops-ask 同级先例）：
//
//	POST /api/ui/snapshot   前端聚合上报（显著变化去抖 2s + 60s 心跳；多标签页
//	                        竞争 MVP 最后写入优先，不区分 tab）
//	GET  /api/ui/snapshot   agent 读取（结构化返回；开关关/TTL 过期/从未上报
//	                        三类同收敛 404 ui.snapshot_unavailable——陈旧现场
//	                        宁缺勿错）
//
// 低频 POST 取向注记：opschannel 上行通道未开，60s 心跳量级 POST 无负担；
// 不挂 RateLimit——单文档覆写幂等有界（clip 同位置先例是为广播风暴而设，
// 本端点无广播无放大面），前端去抖已保证自限。

import (
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 载荷字段长度上界（防畸形长串入库；值是展示性投影非安全边界，设上界即够）
const (
	uiSnapPathMax      = 1024
	uiSnapIDMax        = 128
	uiSnapPanelNameMax = 64
)

// uisnapEnabled 现场开关读取（变量化供单测换桩——settings 面 handler 级测试
// 走真实 store，但纯 404 收敛用例不想搭整条 settings 链）
var uisnapEnabled = func() bool {
	return store.Get().Settings.Get().Server.UISnapshotEnabledOrDefault()
}

// uisnapNow 服务端时钟（变量化供 TTL 用例时间旅行）
var uisnapNow = time.Now

// PostUISnapshot POST /api/ui/snapshot —— 整体覆写最近快照（last-write-wins）。
// 校验从宽（长度上界 + UTF-8 合法性），值本身是展示性投影不参与任何执行路径
func PostUISnapshot(c *gin.Context) {
	var req store.UISnapshot
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeUIPayloadInvalid, "ui snapshot rejected", err)
		return
	}
	req.ActiveProjectID = strings.TrimSpace(req.ActiveProjectID)
	if len(req.ActiveProjectID) > uiSnapIDMax {
		shared.ErrorWithCode(c, shared.CodeUIPayloadInvalid, "activeProjectId too long", nil)
		return
	}
	if req.ActiveFile != nil {
		req.ActiveFile.Path = strings.TrimSpace(req.ActiveFile.Path)
		// 空 path 的文件引用归一为「无文件」：存一条 {path:"",line:N} 是半真
		// 现场（agent 读到空路径无从定位），诚实降级比留残影好
		if req.ActiveFile.Path == "" {
			req.ActiveFile = nil
		} else if !utf8.ValidString(req.ActiveFile.Path) || len(req.ActiveFile.Path) > uiSnapPathMax {
			shared.ErrorWithCode(c, shared.CodeUIPayloadInvalid, "activeFile.path invalid or too long", nil)
			return
		}
		if req.ActiveFile != nil {
			if req.ActiveFile.Line < 0 {
				req.ActiveFile.Line = 0
			}
			if req.ActiveFile.Column < 0 {
				req.ActiveFile.Column = 0
			}
		}
	}
	req.VisiblePanels.Side = strings.TrimSpace(req.VisiblePanels.Side)
	req.VisiblePanels.Bottom = strings.TrimSpace(req.VisiblePanels.Bottom)
	if len(req.VisiblePanels.Side) > uiSnapPanelNameMax || len(req.VisiblePanels.Bottom) > uiSnapPanelNameMax {
		shared.ErrorWithCode(c, shared.CodeUIPayloadInvalid, "visiblePanels name too long", nil)
		return
	}
	req.ActiveTerminalSessionID = strings.TrimSpace(req.ActiveTerminalSessionID)
	if len(req.ActiveTerminalSessionID) > uiSnapIDMax {
		shared.ErrorWithCode(c, shared.CodeUIPayloadInvalid, "activeTerminalSessionId too long", nil)
		return
	}
	// UpdatedAt 服务端盖戳：心跳续期的时钟以服务端为唯一事实源（多标签页
	// 客户端时钟漂移不影响 TTL 判定），调用方传入值一律覆写
	if err := store.Get().UISnap.Put(req); err != nil {
		shared.Error(c, http.StatusInternalServerError, "ui snapshot rejected", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "accepted"})
}

// GetUISnapshot GET /api/ui/snapshot —— agent「看着问」原语。
// 404 = 无在报现场（开关关/TTL 过期/从未上报三类同语义，不区分原因——区分
// 原因对「宁缺勿错」的读取语义没有增量价值，agent 只需知道「没有现场」）
func GetUISnapshot(c *gin.Context) {
	if !uisnapEnabled() {
		shared.ErrorWithCode(c, shared.CodeUINoLiveSnapshot, "no live ui snapshot", nil)
		return
	}
	snap, err := store.Get().UISnap.GetAlive(uisnapNow())
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeUINoLiveSnapshot, "no live ui snapshot", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"activeProjectId":         snap.ActiveProjectID,
			"activeFile":              snap.ActiveFile,
			"visiblePanels":           snap.VisiblePanels,
			"activeTerminalSessionId": snap.ActiveTerminalSessionID,
			"updatedAt":               snap.UpdatedAt.UTC().Format(time.RFC3339),
			// ageSeconds 现场年龄（0~600）：agent 据此措辞「用户刚在看/几分钟前
			// 在看」，陈旧度自明，无需再猜心跳节拍
			"ageSeconds": int(uisnapNow().Sub(snap.UpdatedAt).Seconds()),
		},
	})
}
