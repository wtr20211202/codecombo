package report

// activity.go 实例活动序列查询口（P-20261003-37）：值班大屏热力图消费的
// 只读端点。写面在 server/report 发报链（随存档落库顺带 upsert），本文件
// 只做参数钳制透传；包级说明见 daily.go

import (
	"net/http"
	"strconv"

	"codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ListActivity GET /api/reports/activity?days=91
// 最近 days 天实例活动序列（date 升序，旧→新——热力图列即周次，升序直铺）；
// days 缺省 = 全保留窗口（钳制 ≤365，季度视图由前端传 91 自取）。无数据返回
// 空列表非错误（新装实例/长期闲置是常态）
func ListActivity(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "0"))
	items, err := store.Get().ActivityDay.List(days)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Failed to list activity series", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": items})
}
