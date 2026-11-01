package system

import (
	"net/http"
	"time"

	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 入口面总览（P-20261004-11）：自托管安全的另一半「谁在进来」——与出域面总览
// （egress.go，P-20261003-20）对称的只读聚合答案。入口面分散在锁定（unlock 面）/
// 安全（agent token）/TLS（回环辅助口）/分享（访客短链）/远程（主机清单）五个
// 分区，本端点一次取齐供安全分区总览卡展示。零新增敏感暴露纪律（与 egress 同源）：
// 解锁失败只出限流器聚合计数（IP 明细走审计分区，绝不在此回显）；agent token 只出
// Meta（本就不含秘密值，与 egress 卡同一形态）；TLS 只出开关与回环辅助端口；
// 活跃分享只出计数（token/路径是访问凭据与目标明细，走分享管理与出域卡）；远程
// 主机只出数量。全部复用各存储既有读取口，不新增任何明文通道。
// 解锁失败计数的存储口径：限流计数为进程内存态，服务重启清零——如实聚合并在
// 前端注记该语义，不伪装成持久历史。

// activeShareCount 活跃分享计数（过期 snippet 已 404，不算敞口；与 egress
// 同一 Expired 口径）。只出计数：条目明细（目标/时间窗）在出域卡与分享管理
// 已有承载，本卡不重复列示
func activeShareCount(shares []store.Share, now time.Time) int {
	active := 0
	for _, s := range shares {
		if !s.Expired(now) {
			active++
		}
	}
	return active
}

// IngressOverview GET /api/system/ingress-overview —— 入口面总览（纯只读聚合）。
// 管理面鉴权：挂在全局 api 组（LockMiddleware + TokenAuthMiddleware）之下
func IngressOverview(c *gin.Context) {
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

	lockCfg := store.Get().Lock.GetConfig()
	failIPs, failTotal, failBlocked := middleware.LockUnlockFailureSnapshot()
	c.JSON(http.StatusOK, gin.H{
		"lock": gin.H{
			"enabled":    lockCfg.Enabled,
			"needsSetup": !store.Get().Lock.HasConfig(),
			"failures": gin.H{
				"ips":     failIPs,
				"total":   failTotal,
				"blocked": failBlocked,
			},
		},
		"agentToken": store.Get().AgentToken.Meta(),
		"tls": gin.H{
			"enabled":      config.TLSEnabled(),
			"loopbackPort": config.LoopbackPort(), // 0 = TLS 未启用或明文辅助口未就绪
		},
		"shares": gin.H{"count": activeShareCount(shares, time.Now())},
		"remoteHosts": gin.H{
			"count": len(hosts), // 只出数量：主机清单走远程分区列表接口（响应剥敏感字段）
		},
	})
}
