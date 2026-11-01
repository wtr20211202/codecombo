package system

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// runbookIDRe 运行书 ID 白名单（sc_rb_ + uuid，防路径穿越形态）
var runbookIDRe = regexp.MustCompile(`^sc_rb_[A-Za-z0-9-]{1,64}$`)

// 运行书 CRUD（P-20261003-24）。模型与约束见 server/store/runbooks.go：
// ID 服务端生成（sc_rb_）、Steps 空 = patch 未提供该字段、字段级长度校验。

const (
	// runbookTitleMax / runbookDescMax / runbookStepCmdMax / runbookStepDescMax /
	// runbookStepsMax 字段级上限（步骤数上限防误传巨型载荷）
	runbookTitleMax    = 120
	runbookDescMax     = 500
	runbookStepCmdMax  = 8192
	runbookStepDescMax = 500
	runbookStepsMax    = 50
)

// validateRunbookTitle 标题必填且限长；返回空串 = 通过
func validateRunbookTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return "title is required"
	}
	if utf8.RuneCountInString(title) > runbookTitleMax {
		return "title too long"
	}
	return ""
}

// validateRunbookOnFailure 失败语义枚举校验（P-20261004-13）：
// 空 = 默认 continue（现状），合法值 continue/stop
func validateRunbookOnFailure(v string) bool {
	switch v {
	case "", "continue", "stop":
		return true
	}
	return false
}

// validateRunbookSteps 校验步骤清单：非空、数量上限、每步命令必填且限长。
// 返回首个错误的用户可读信息
func validateRunbookSteps(steps []store.RunbookStep) string {
	if len(steps) == 0 {
		return "at least one step is required"
	}
	if len(steps) > runbookStepsMax {
		return "too many steps"
	}
	for _, s := range steps {
		if strings.TrimSpace(s.Command) == "" {
			return "step command is required"
		}
		if utf8.RuneCountInString(s.Command) > runbookStepCmdMax {
			return "step command too long"
		}
		if utf8.RuneCountInString(s.Description) > runbookStepDescMax {
			return "step description too long"
		}
	}
	return ""
}

// ListRunbooks GET /api/runbooks
func ListRunbooks(c *gin.Context) {
	books, err := store.Get().Runbook.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "runbook operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": books})
}

// CreateRunbook POST /api/runbooks
func CreateRunbook(c *gin.Context) {
	var req store.Runbook
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "runbook operation failed", err)
		return
	}
	if msg := validateRunbookTitle(req.Title); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	if utf8.RuneCountInString(req.Description) > runbookDescMax {
		shared.Error(c, http.StatusBadRequest, "description too long", nil)
		return
	}
	if !validateRunbookOnFailure(req.OnFailure) {
		shared.Error(c, http.StatusBadRequest, "invalid onFailure", nil)
		return
	}
	if msg := validateRunbookSteps(req.Steps); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	b, err := store.Get().Runbook.Create(req)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "runbook operation failed", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": b})
}

// UpdateRunbook PUT /api/runbooks/:id（Steps 空 = 不改写步骤）
func UpdateRunbook(c *gin.Context) {
	id := c.Param("id")
	if !runbookIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "runbook not found", nil)
		return
	}
	var req store.Runbook
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "runbook operation failed", err)
		return
	}
	if utf8.RuneCountInString(req.Title) > runbookTitleMax ||
		utf8.RuneCountInString(req.Description) > runbookDescMax {
		shared.Error(c, http.StatusBadRequest, "field too long", nil)
		return
	}
	if !validateRunbookOnFailure(req.OnFailure) {
		shared.Error(c, http.StatusBadRequest, "invalid onFailure", nil)
		return
	}
	if len(req.Steps) > 0 {
		if msg := validateRunbookSteps(req.Steps); msg != "" {
			shared.Error(c, http.StatusBadRequest, msg, nil)
			return
		}
	}
	b, err := store.Get().Runbook.Update(id, req)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "runbook not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "runbook operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": b})
}

// DeleteRunbook DELETE /api/runbooks/:id
func DeleteRunbook(c *gin.Context) {
	id := c.Param("id")
	if !runbookIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "runbook not found", nil)
		return
	}
	if err := store.Get().Runbook.Delete(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "runbook not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "runbook operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "runbook deleted"})
}
