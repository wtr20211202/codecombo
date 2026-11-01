// Package watchapi 文件监听域 API 面（P-20261003-140）：inotify 配额耗尽的
// 轮询降级兜底状态读取与手动开关。watch 模块自身不做 HTTP（分层惯例），
// 控制面经组合根注入的 Control 接口触达（api 层不 import watch 包——
// watch.Default 包级桥已消除的路线，与 api.SetKernel 同一注入模式）
package watchapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// Status 降级轮询兜底状态（GET/POST /api/watch/fallback 响应体 data）
type Status struct {
	Enabled bool   `json:"enabled"`
	Source  string `json:"source,omitempty"` // auto（配额耗尽自动启用）/ manual（用户手动开启）
	Since   string `json:"since,omitempty"`  // RFC3339，本段降级开始时刻
}

// Control 降级兜底控制面：由组合根以 watch 模块实例装配（隐式接口，
// watchapi 不反向依赖 watch 包实现）
type Control interface {
	// FallbackStatus 当前状态（enabled, source, since）
	FallbackStatus() (bool, string, time.Time)
	// SetFallback 开关降级；nil = 翻转，返回开关后的状态
	SetFallback(enable *bool) (bool, string, time.Time)
}

// control 组合根注入点（启动期一次写、请求期只读，mutex 只为测试可复位）；
// 未装配（模块未注册/单测直调 handler）时 GET 回零状态、POST 报 503——
// 读宽容写明确
var (
	controlMu sync.RWMutex
	control   Control
)

// SetFallbackControl 组合根装配（server/app 在模块清单构造时调用）
func SetFallbackControl(c Control) {
	controlMu.Lock()
	control = c
	controlMu.Unlock()
}

func loadControl() Control {
	controlMu.RLock()
	defer controlMu.RUnlock()
	return control
}

func statusOf(enabled bool, source string, since time.Time) Status {
	st := Status{Enabled: enabled, Source: source}
	if enabled && !since.IsZero() {
		st.Since = since.Format(time.RFC3339)
	}
	return st
}

// GetFallback GET /api/watch/fallback——当前降级状态（前端设置面/诊断与
// e2e 断言用；多实例代理下旧后端未注册路由即 404，能力项 watch-fallback
// 先探测可避）
func GetFallback(c *gin.Context) {
	if ctl := loadControl(); ctl != nil {
		enabled, source, since := ctl.FallbackStatus()
		c.JSON(http.StatusOK, gin.H{"data": statusOf(enabled, source, since)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": Status{}})
}

// SetFallback POST /api/watch/fallback {"enabled"?: bool}——手动开关轮询
// 兜底；enabled 缺省（含空 body）= 翻转当前态。响应 data 为开关后的状态，
// 前端据此反馈「已切换到轮询 / 已切回实时监听」
func SetFallback(c *gin.Context) {
	ctl := loadControl()
	if ctl == nil {
		shared.Error(c, http.StatusServiceUnavailable, "watch module not ready", nil)
		return
	}
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	// 空/body 仅空白（通知动作翻转链、curl 直 POST）= 翻转；非空 body 严格
	// 解析（截断 JSON 与空流在 binding 层同为 ErrUnexpectedEOF，无法按错误
	// 类型区分——先分长度再解析，语义无歧义）
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "failed to read request body", err)
		return
	}
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid request body", err)
			return
		}
	}
	enabled, source, since := ctl.SetFallback(req.Enabled)
	c.JSON(http.StatusOK, gin.H{"data": statusOf(enabled, source, since)})
}
