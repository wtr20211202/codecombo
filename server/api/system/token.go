package system

import (
	"codecombo/server/api/shared"
	"fmt"
	"log/slog"
	"net/http"

	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ListTokens 获取所有 Token 列表（不包含 Hash）
func ListTokens(c *gin.Context) {
	tokens, err := store.Get().Token.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Token operation failed", err)
		return
	}

	type tokenResponse struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Prefix     string `json:"prefix"`
		ExpiresAt  string `json:"expiresAt"`
		CreatedAt  string `json:"createdAt"`
		LastUsedAt string `json:"lastUsedAt"`
	}

	result := make([]tokenResponse, 0, len(tokens))
	for _, t := range tokens {
		result = append(result, tokenResponse{
			ID:         t.ID,
			Name:       t.Name,
			Prefix:     t.Prefix,
			ExpiresAt:  t.ExpiresAt,
			CreatedAt:  t.CreatedAt,
			LastUsedAt: t.LastUsedAt,
		})
	}

	c.JSON(http.StatusOK, gin.H{"data": result})
}

// CreateToken 创建新的 API Token
func CreateToken(c *gin.Context) {
	var req struct {
		Name          string `json:"name"`
		ExpiresInDays int    `json:"expiresInDays"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Token operation failed", err)
		return
	}

	if req.Name == "" {
		shared.Error(c, http.StatusBadRequest, "name is required", nil)
		return
	}

	plainText, tokenCfg, err := store.Get().Token.Generate(req.Name, req.ExpiresInDays)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Token operation failed", err)
		return
	}

	slog.Info("token created", "name", req.Name, "id", tokenCfg.ID)
	// 审计入账：只记名称与时效，明文令牌绝不入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTokenCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (expiresInDays=%d)", req.Name, req.ExpiresInDays),
	})
	c.JSON(http.StatusCreated, gin.H{
		"data": gin.H{
			"token": plainText,
			"id":    tokenCfg.ID,
		},
	})
}

// DeleteToken 删除指定 Token
func DeleteToken(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		shared.Error(c, http.StatusBadRequest, "token id is required", nil)
		return
	}

	// 先查名再删（P-20261003-133 审计对象名自明化）：拼「name (id)」翻台账自明。
	// TokenStore 无按 id 单查口（存量面只有 List）——API token 量级个位数且撤销
	// 是人操作低频，List 线性扫描成本可忽略；查不到（竞态已删）回退裸 id
	detail := id
	if tokens, err := store.Get().Token.List(); err == nil {
		for i := range tokens {
			if tokens[i].ID == id {
				detail = fmt.Sprintf("%s (%s)", tokens[i].Name, id)
				break
			}
		}
	}

	if err := store.Get().Token.Delete(id); err != nil {
		shared.Error(c, http.StatusNotFound, "Token operation failed", err)
		return
	}

	slog.Info("token deleted", "id", id)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTokenRevoke,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
	c.JSON(http.StatusOK, gin.H{"message": "token deleted"})
}
