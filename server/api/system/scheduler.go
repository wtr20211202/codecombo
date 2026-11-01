package system

import (
	"net/http"
	"sync/atomic"
	"time"

	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// Scheduler 后台任务清单（P-20261003-276）：内核调度器托管的后台任务
//（日报/cron 巡检/清理/审计裁剪…）此前无运维可见面——「后台都在跑什么」
// 不可知（排查/审计需求）。本端点输出任务注册清单快照（任务名/间隔/
// 上次运行时刻），与 /api/system/health 同族只读聚合、同门控面。
//
// 刻意不提供启停（提案注记）：启停是高危面——漏关清理任务 = 数据无界增长、
// 误停巡检 = 水位失明，且任务归属各模块生命周期（Stop 序即模块 Stop），
// 界面级启停会撕裂该纪律。清单只回答「在跑什么、多久一轮、上次何时跑」。

// schedulerJobView 单任务清单行。字段全部语言中立原样直出（任务名/毫秒间隔/
// RFC3339 时刻），本地化措辞由展示层承担——lastRun 空串 = 注册后尚未到点
// （零值哨兵，与 auditLastWriteFail 同序列化惯例，前端直接喂既有日期格式化）
type schedulerJobView struct {
	Name     string `json:"name"`
	Interval int64  `json:"intervalMs"`
	LastRun  string `json:"lastRun"`
}

// schedulerRef 内核调度器引用：system.Module.Init 注入（SetBuildInfo 同款
// 包级注入惯例——handler 是包级函数）。原子指针：Init 只写一次，请求路径
// 只读；引用就绪前（极端：路由注册先于模块 Init 的窗口）返回空清单不报错
var schedulerRef atomic.Pointer[kernel.Scheduler]

// SetSchedulerSource 注入内核调度器引用（system.Module.Init 调用，单测同用）
func SetSchedulerSource(s *kernel.Scheduler) { schedulerRef.Store(s) }

// SchedulerJobs GET /api/system/scheduler —— 后台任务注册清单（只读）。
// 任务名升序（注册表快照已排序）；服务端不注记任务用途——任务名与各模块
// AddTicker 调用点一一对应，用途描述属各模块文档职责，集中翻译会随任务
// 增删漂移（清单是注册表投影不是 curated 目录）。
func SchedulerJobs(c *gin.Context) {
	jobs := []schedulerJobView{} // 非nil初值：空清单序列化为 [] 而非 null
	if s := schedulerRef.Load(); s != nil {
		for _, j := range s.Jobs() {
			lastRun := ""
			if !j.LastRun.IsZero() {
				lastRun = j.LastRun.Format(time.RFC3339)
			}
			jobs = append(jobs, schedulerJobView{
				Name:     j.Name,
				Interval: j.Interval.Milliseconds(),
				LastRun:  lastRun,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": jobs})
}
