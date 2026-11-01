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

// snippetIDRe 片段 ID 白名单（sc_snip_ + uuid，防路径穿越形态）
var snippetIDRe = regexp.MustCompile(`^sc_snip_[A-Za-z0-9-]{1,64}$`)

// 命令片段 CRUD（C2）。模型与约束见 server/store/snippets.go：
// ID 服务端生成（sc_snip_）、系统片段不可删除、body 字段级长度校验。

const (
	// snippetTitleMax / snippetCommandMax / snippetDescMax / snippetLanguageMax 字段级 rune 上限
	snippetTitleMax    = 120
	snippetCommandMax  = 8192
	snippetDescMax     = 500
	snippetLanguageMax = 40
)

// validateSnippetPayload 校验并归一化必填字段；返回首个错误的用户可读信息
func validateSnippetPayload(title, command string) string {
	title = strings.TrimSpace(title)
	command = strings.TrimSpace(command)
	if title == "" {
		return "title is required"
	}
	if utf8.RuneCountInString(title) > snippetTitleMax {
		return "title too long"
	}
	if command == "" {
		return "command is required"
	}
	if utf8.RuneCountInString(command) > snippetCommandMax {
		return "command too long"
	}
	return ""
}

// validateSnippetMeta 校验种类与语言元数据（P-20261002-44 编辑器代码片段）：
// Kind 白名单（缺省 command 由 store 层归一）、Language 短自由文本（monaco language id）
func validateSnippetMeta(kind, language string) string {
	switch kind {
	case "", store.SnippetKindCommand, store.SnippetKindCode:
	default:
		return "invalid snippet kind"
	}
	if utf8.RuneCountInString(language) > snippetLanguageMax {
		return "language too long"
	}
	return ""
}

// ListSnippets GET /api/snippets
func ListSnippets(c *gin.Context) {
	snippets, err := store.Get().Snippet.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "snippet operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": snippets})
}

// CreateSnippet POST /api/snippets
func CreateSnippet(c *gin.Context) {
	var req store.Snippet
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "snippet operation failed", err)
		return
	}
	if msg := validateSnippetPayload(req.Title, req.Command); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	if utf8.RuneCountInString(req.Description) > snippetDescMax {
		shared.Error(c, http.StatusBadRequest, "description too long", nil)
		return
	}
	if msg := validateSnippetMeta(req.Kind, req.Language); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	s, err := store.Get().Snippet.Create(req)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "snippet operation failed", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": s})
}

// UpdateSnippet PUT /api/snippets/:id
func UpdateSnippet(c *gin.Context) {
	id := c.Param("id")
	if !snippetIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "snippet not found", nil)
		return
	}
	var req store.Snippet
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "snippet operation failed", err)
		return
	}
	if utf8.RuneCountInString(req.Title) > snippetTitleMax ||
		utf8.RuneCountInString(req.Command) > snippetCommandMax ||
		utf8.RuneCountInString(req.Description) > snippetDescMax {
		shared.Error(c, http.StatusBadRequest, "field too long", nil)
		return
	}
	if msg := validateSnippetMeta(req.Kind, req.Language); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	s, err := store.Get().Snippet.Update(id, req)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "snippet not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "snippet operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": s})
}

// DeleteSnippet DELETE /api/snippets/:id（系统片段 403）
func DeleteSnippet(c *gin.Context) {
	id := c.Param("id")
	if !snippetIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "snippet not found", nil)
		return
	}
	err := store.Get().Snippet.Delete(id)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			shared.Error(c, http.StatusNotFound, "snippet not found", nil)
		case errors.Is(err, store.ErrSystemSnippet):
			shared.Error(c, http.StatusForbidden, "system snippet cannot be deleted", nil)
		default:
			shared.Error(c, http.StatusInternalServerError, "snippet operation failed", err)
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "snippet deleted"})
}
