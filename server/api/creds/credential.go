package creds

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git/auth"
	"codecombo/server/git/auth/platforms"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ListGitCredentials 返回所有 Git 凭据（不含 Secret 内容）
func ListGitCredentials(c *gin.Context) {
	creds, err := store.Get().Credential.ListPublic()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Credential operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": creds})
}

// credentialRequest 凭据新增/更新请求体
type credentialRequest struct {
	Host     string `json:"host" binding:"required"`
	Username string `json:"username" binding:"required"`
	Secret   string `json:"secret"`
	Platform string `json:"platform"` // 可选：手动指定平台（本地自建 Gitea/GitLab 等 host 命中不了静态注册表），空则按 host 自动识别
}

// SaveGitCredential 新增或更新凭据（同 host+username+authType=basic 视为更新）
// 注：当前 handler 仍以基础认证（PAT/密码）语义接收前端表单，
// 后续 OAuth flow 走独立端点写入 oauth-device/oauth-web 类型凭据。
func SaveGitCredential(c *gin.Context) {
	var req credentialRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Credential operation failed", err)
		return
	}
	host := store.HostFromURL(req.Host)
	if host == "" || req.Username == "" {
		shared.Error(c, http.StatusBadRequest, "Credential operation failed", store.ErrInvalidArg)
		return
	}
	// 平台识别：用户显式指定且合法时优先（本地自建 Gitea/GitLab 等 host 命中不了静态注册表），
	// 否则按 host 走静态注册表自动识别（仅遍历静态表，避免 5s probe）
	// 用途：CredentialList 平台 tag 渲染 + /credentials/:id/test 端点选 API URL
	platform := req.Platform
	if platform == "" {
		platform = platforms.MatchStatic(host).ID()
	} else if !isValidPlatform(platform) {
		shared.Error(c, http.StatusBadRequest, "Credential operation failed", store.ErrInvalidArg)
		return
	}
	cred := &store.Credential{
		Host:     host,
		Platform: platform,
		Username: req.Username,
		AuthType: store.AuthTypeBasic,
		Status:   store.StatusActive,
		Secret:   req.Secret,
	}
	// 沿用 V1 语义：同 host+username 的 basic 凭据视为更新（覆盖 Secret）
	isUpdate := false
	if existing := findBasicCredential(host, req.Username); existing != nil {
		cred.ID = existing.ID
		isUpdate = true
		if cred.Secret == "" {
			cred.Secret = existing.Secret
		}
	}
	if err := store.Get().Credential.Save(cred); err != nil {
		shared.Error(c, http.StatusBadRequest, "Credential operation failed", err)
		return
	}
	// 审计入账：只记 host/用户名/动作形态，Secret 绝不入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditCredSave,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s@%s (%s)", req.Username, host, map[bool]string{true: "update", false: "create"}[isUpdate]),
	})
	c.JSON(http.StatusOK, gin.H{"data": cred.ToPublic()})
}

// findBasicCredential 在已存储凭据里按 host+username+authType=basic 查找
// 用 FindByHost 而非 List：避免随凭据总量线性读盘
func findBasicCredential(host, username string) *store.Credential {
	creds, err := store.Get().Credential.FindByHost(host)
	if err != nil {
		return nil
	}
	for _, c := range creds {
		if c.Username == username && c.AuthType == store.AuthTypeBasic {
			return c
		}
	}
	return nil
}

// isValidPlatform 校验 platform 是否为合法平台标识
// 用户手动指定 platform 时用，防止任意字符串写入 cred.Platform
func isValidPlatform(p string) bool {
	switch p {
	case auth.PlatformGitHub, auth.PlatformGitLab, auth.PlatformGitea, auth.PlatformGitee, auth.PlatformGeneric:
		return true
	}
	return false
}

// DeleteGitCredential 按 ID 删除凭据
func DeleteGitCredential(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		shared.Error(c, http.StatusBadRequest, "id is required", nil)
		return
	}
	// 先取记录再删（P-20261003-133 审计对象名自明化）：凭据的「名」即
	// username@host（与 save 点同口径），拼「名 (id)」翻台账不再只对裸 id。
	// FindByID 未命中/损坏返回 (nil, nil)，须 nil 守卫——回退裸 id 不阻断删除
	detail := id
	if cred, _ := store.Get().Credential.FindByID(id); cred != nil {
		detail = fmt.Sprintf("%s@%s (%s)", cred.Username, cred.Host, id)
	}
	if err := store.Get().Credential.Delete(id); err != nil {
		shared.Error(c, http.StatusNotFound, "Credential operation failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditCredDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
