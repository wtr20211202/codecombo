package system

import (
	"net/http"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 审批分类规则（P-20261003-35 per-op 自动裁决）：规则表存 settings（config.Server.
// AgentApprovalRules，有序列表前缀匹配），经 PUT /api/settings 的 agentApprovalRules
// 字段整体读写（整体替换语义，同 agentLaunchCommands 先例）——规则表是有序整体，
// 行级 CRUD 在前端本地编辑后一次性保存。本文件只承载命中测试端点。

// agentApprovalRulesJSON GET /settings 出参：规则表原文（nil 归一为空数组，
// 前端免判空；空串 pattern 清洗，读取口径与写入口一致；pathPattern 归一同
// 写入口（P-20261004-67），空串 omitempty 自然缺省不注入零值；tempUntil 指针
// 透传，无窗口规则字段自然缺省不注入零值时刻）
func agentApprovalRulesJSON(rules []config.AgentApprovalRule) []config.AgentApprovalRule {
	out := make([]config.AgentApprovalRule, 0, len(rules))
	for _, r := range rules {
		out = append(out, config.AgentApprovalRule{
			OpPattern:   strings.TrimSpace(r.OpPattern),
			PathPattern: config.NormalizeApprovalPathPattern(r.PathPattern),
			Effect:      r.Effect,
			TempUntil:   r.TempUntil,
		})
	}
	return out
}

// TestApprovalRule POST /api/settings/approval-rules/test —— 命中测试按钮：
// 输入 op 样例（+ 可选路径样例，P-20261004-67）按当前已保存规则裁决（含全局
// allow 短路语义），返回 effect 与命中规则，供用户保存前验证规则表行为是否
// 符合预期
func TestApprovalRule(c *gin.Context) {
	var req struct {
		Op     string `json:"op" binding:"required"`
		Target string `json:"target,omitempty"` // 路径样例：参与路径条件判定（缺省 = 不带 target）
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "approval rule test failed", err)
		return
	}
	cfg := store.Get().Settings.Get()
	if cfg == nil {
		shared.Error(c, http.StatusInternalServerError, "settings not loaded", nil)
		return
	}
	// 与裁决路径同口径：op 超长先按 400 拒（真实入口 ops-confirm 同界）
	if op := strings.TrimSpace(req.Op); op == "" || len(op) > config.ApprovalOpMax {
		shared.Error(c, http.StatusBadRequest, "invalid op (1-128 chars)", nil)
		return
	}
	// target 与 ops-confirm 入口同界（512 字节）；缺省空串 = 不带路径样例
	if len(req.Target) > 512 {
		shared.Error(c, http.StatusBadRequest, "invalid target (max 512 chars)", nil)
		return
	}
	// 命中测试不带会话归属（sessionID 空串）：会话级放行档位不参与规则测试——
	// 测的是规则表本身的行为（全局放行档位短路语义仍如实反映）
	dec := cfg.Server.ResolveApprovalDecision(req.Op, req.Target, "", time.Now())
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"effect":  dec.Effect,
		"ruleHit": dec.RuleHit,
	}})
}
