package system

import (
	"codecombo/server/api/shared"
	"log/slog"
	"net/http"

	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// GetUIState 获取全部 UI 状态
func GetUIState(c *gin.Context) {
	data, err := store.Get().UIState.Get()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": map[string]interface{}{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// ExportUIState GET /api/ui-state/export —— 工作区状态备份导出：载荷与
// /ui-state 完全一致，独立端点只为审计埋点（GET /ui-state 是前端引导链的
// 例行读，逐次入账会把审计表刷成启动噪声；显式导出才是安全相关动作）
func ExportUIState(c *gin.Context) {
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditWorkspaceExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
	})
	GetUIState(c)
}

// UpdateUIState 保存全部 UI 状态（既有端点，迁移期与 PATCH 共存）
// 按命名空间浅合并（实例内）：写入方未携带的命名空间原样保留。历史上 PUT 是
// 整体覆盖——beforeunload 的同步快照只 collect 得到 Layout 自己的命名空间，
// 每次刷新都会把 agentTerminal 等它不知道的命名空间整体抹掉（命令历史的
// lastViewed 恢复因此失效）。需要清空某命名空间的调用方显式传 null 即可
// （布局重置语义；浅合并下传空对象只会与旧值合并、清不掉）。
// P-20261002-8：合并下沉到 store 层 Merge 原子执行（读-合并-写整体互斥，
// 消除 handler 内 Get 与 Update 之间的并发窗口），对外语义不变
func UpdateUIState(c *gin.Context) {
	writeMergedUIState(c)
}

// PatchUIState PATCH /ui-state —— 键级补丁写（P-20261002-8）：请求体按实例 ID
// 只携带本次实际变更的顶层键（部分记录），服务端读-合并-写原子合并。配合前端
// 脏键跟踪：auto-save/beforeunload 只发本页动过的键，boot 旧值不再整包覆盖，
// 多标签页同开一项目时各改各的键互不回滚。合并语义与 PUT 一致（PUT 历史上
// 已收敛为按命名空间浅合并，两端点共用同一 Merge），既有 PUT 原样保留
func PatchUIState(c *gin.Context) {
	writeMergedUIState(c)
}

// writeMergedUIState PUT/PATCH 共用写入路径：语义见 store.UIStateStore.Merge
func writeMergedUIState(c *gin.Context) {
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		shared.Error(c, http.StatusBadRequest, "UI state operation failed", err)
		return
	}
	if err := store.Get().UIState.Merge(body); err != nil {
		shared.Error(c, http.StatusInternalServerError, "UI state operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// CleanupProjectUIState 项目删除后的级联清理：摘除各实例 UI 状态中指向已删
// 项目的悬挂引用（projectId 指针 / projectOrder / projectSessionOrder）。
// 不清理的后果：仍开着该项目的页面 auto-save 会把死 id 反复写回服务端，
// 之后的启动恢复虽会跳过（hasProject 校验），但引用本身长期驻留，且与新
// 页面的布局恢复竞态会放大成侧栏视图震荡（见 goal 打磨台账运行 38-40）
func CleanupProjectUIState(projectID string) {
	data, err := store.Get().UIState.Get()
	if err != nil || len(data) == 0 {
		return
	}
	changed := false
	for _, raw := range data {
		inst, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if v, exists := inst["projectId"]; exists {
			if s, ok := v.(string); ok && s == projectID {
				delete(inst, "projectId")
				changed = true
			}
		}
		if filterStringSlice(inst, "projectOrder", projectID) {
			changed = true
		}
		if m, exists := inst["projectSessionOrder"].(map[string]interface{}); exists {
			if _, hit := m[projectID]; hit {
				delete(m, projectID)
				changed = true
			}
		}
	}
	if !changed {
		return
	}
	if err := store.Get().UIState.Update(data); err != nil {
		slog.Debug("cleanup project ui-state references failed", "project", projectID, "err", err)
	}
}

// filterStringSlice 就地滤除字符串数组中的目标值；有删除时回写并返回 true
func filterStringSlice(inst map[string]interface{}, key, target string) bool {
	arr, ok := inst[key].([]interface{})
	if !ok {
		return false
	}
	kept := arr[:0]
	removed := false
	for _, item := range arr {
		if s, ok := item.(string); ok && s == target {
			removed = true
			continue
		}
		kept = append(kept, item)
	}
	if removed {
		inst[key] = kept
	}
	return removed
}
