// Package report 日报存档查询端口（P-20261003-4）：14 天日报存档（server/report
// 发报时同步落档）的两只读口——列表 + 单日详情——与一个手动触发口。本包只
// 做参数解析与响应整形，聚合与落档语义全在 server/report（RunDaily）
package report

import (
	"net/http"
	"strconv"
	"time"

	"codecombo/server/api/shared"
	serverreport "codecombo/server/report"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ListDailyReports GET /api/reports/daily?limit=100
// 最近存档倒序（date 降序、同日按项目 ID 升序）；limit 钳制由仓储负责
func ListDailyReports(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "0"))
	items, err := store.Get().DailyReport.List(limit)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Failed to list daily reports", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": items})
}

// DailyReportDetail GET /api/reports/daily/:date
// 单日全部项目存档（含与通知同源的实例级事实）；该日无存档返回空列表（回看
// 空日是常态而非错误，前端按空态渲染）
func DailyReportDetail(c *gin.Context) {
	date := c.Param("date")
	if _, err := time.ParseInLocation("2006-01-02", date, time.Local); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid date, want YYYY-MM-DD", err)
		return
	}
	items, err := store.Get().DailyReport.ListByDate(date)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Failed to list daily reports", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": items})
}

// RunDailyReport POST /api/reports/daily/run
// 手动触发一轮日报生成：body {"date":"YYYY-MM-DD"} 缺省 = 今天（立即投递通知
// 并落档）；历史日 = 只补档不投递。e2e 与「到点前想先看一眼」共用此口
func RunDailyReport(c *gin.Context) {
	var req struct {
		Date string `json:"date"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", err)
		return
	}
	var day time.Time
	if req.Date != "" {
		parsed, err := time.ParseInLocation("2006-01-02", req.Date, time.Local)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid date, want YYYY-MM-DD", err)
			return
		}
		day = parsed
	}
	sent := serverreport.RunDaily(day)
	c.JSON(http.StatusOK, gin.H{"sent": sent, "date": time.Now().Format("2006-01-02")})
}
