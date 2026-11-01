package system

import (
	"net/http"

	"codecombo/server/git"
	"codecombo/server/metrics"

	"github.com/gin-gonic/gin"
)

// InstanceHealth GET /api/system/health —— 实例健康摘要（P-20261003-28）。
//
// 动机：/api/metrics 已吐 Prometheus 全套自省（HTTP 计数/时长/in-flight、WS
// 连接数、总线吞吐、goroutine/heap/uptime），但自托管用户大多没挂抓取系统，
// 实例自身健康在产品面无处可看。本端点把值班大屏关心的四项自省值 JSON 直取
// （metrics 包注册值/进程运行时，不做文本解析），供值班大屏「实例健康」卡
// 30s 轮询消费。
//
// 与既有面分工：/api/health 是公开存活探针（「活着吗」status/checks，不设防）；
// 本端点是资源水位（「活得怎样」），同 /api/metrics 门控面——挂在全局 api 组
// （LockMiddleware+TokenAuth）之下，路由名/运行时水位属系统元数据。
//
// P-20261003-205 增审计写失败计数两字段：审计 Append 尽力而为语义下失败
// 静默丢失=审计链断裂不可知，健康面让断裂可见（内存计数，重启清零）。
// 与 audit.go 的 /api/audit 响应同形状（auditWriteFailFields 单源）
//
// P-20261004-125 增 git 子进程并发面三字段：全局并发门（server/git/
// globalgate.go）的运行时水位——当前并发进程/排队等待/排队峰值（上限标定
// 观测面），metrics 注册值直取（指标名常量在 git 包，防字符串漂移）
func InstanceHealth(c *gin.Context) {
	snap := metrics.Snapshot()
	failCount, lastFail := auditWriteFailFields()
	c.JSON(http.StatusOK, gin.H{
		"uptime":             snap.UptimeSeconds,  // 进程运行秒数
		"heapAlloc":          snap.HeapAllocBytes, // 存活堆字节数（前端按 1024 进制格式化）
		"goroutines":         snap.Goroutines,
		"wsClients":          snap.WSClients, // 各 WS 端点在线连接数之和
		"auditWriteFails":    failCount,      // 审计写失败累计条数（0=无失败）
		"auditLastWriteFail": lastFail,       // 最近失败时刻 RFC3339（空串=从未失败）
		"gitRunning":         metrics.GaugeValue(git.MetricRunning),
		"gitWaiting":         metrics.GaugeValue(git.MetricWaiting),
		"gitWaitingPeak":     metrics.GaugeValue(git.MetricWaitingPeak),
	})
}
