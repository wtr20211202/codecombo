package creds

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/git/auth"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// testCredentialResp 测试连接的统一响应体
// status 取值：
//   - "ok"            token 有效，验证通过
//   - "limited"       token 有效但权限受限（/user API 403：缺查询用户信息权限，不影响 git 推送/拉取）
//   - "expired"       token 失效（401 / 鉴权失败），cred.Status 已置 expired 并持久化
//   - "network_error" 网络/平台不可达（含非 200/401/403 的其他状态码）
type testCredentialResp struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// probe 候选探测目标（平台 /user API）；https 优先、http 兜底（本地自建服务常是 http）
// authKind：gitea 历史用 "token <token>" 前缀，github/gitlab 用标准 "Bearer <token>"
type probe struct {
	url      string
	accept   string
	authKind string // "bearer"（github/gitlab）| "token"（gitea 历史格式）
}

// TestGitCredential 测试 Git 凭据当前是否仍有效
//
// 实现策略：
//   - generic 平台：有 repo_url 时用 git ls-remote 真实验证（generic 无标准 /user API）；
//     无 repo_url 时兜底试 Gitea / GitLab 的 /user API（覆盖大多数自建实例）
//   - github：GET https://api.github.com/user
//   - gitea / gitlab：先 https，连接失败再试 http（本地自建常是 http）
//   - 其他未知平台：不支持测试，返 400
//
// 结果：
//   - 验证通过 → {status: "ok"}
//   - 401 / 鉴权失败 → 自动置 cred.Status="expired" + LastError，返 {status:"expired"}
//   - 其他/网络错误 → {status:"network_error"}
func TestGitCredential(c *gin.Context) {
	credID := c.Param("id")
	if credID == "" {
		shared.Error(c, http.StatusBadRequest, "id is required", nil)
		return
	}

	// FindByID 直接按 ID 取单条凭据，避免 List() 全量遍历的 N+1
	cred, err := store.Get().Credential.FindByID(credID)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Credential operation failed", err)
		return
	}
	if cred == nil {
		shared.Error(c, http.StatusNotFound, "credential not found", nil)
		return
	}

	// 可选 body：generic 平台 ls-remote 测试需要仓库 URL（前端弹窗填）
	var body struct {
		RepoURL string `json:"repo_url"`
	}
	_ = c.ShouldBindJSON(&body) // 可选，绑定失败忽略

	// 解密 token；cred 可能没有 Secret（用户填写时漏填），返 network_error 提示
	plain, err := config.DecryptToken(cred.Secret)
	if err != nil || plain == "" {
		c.JSON(http.StatusOK, testCredentialResp{
			Status:  "network_error",
			Message: "secret is empty or cannot be decrypted",
		})
		return
	}

	// 有 repo_url 时优先 ls-remote（不限平台）：最贴近实际 git 操作，不依赖 /user API 权限。
	// 适用场景：token 有 repo 权限但无 user 读权限（如部分 Gitea 细粒度 token）时，/user API 会 403，
	// 而 ls-remote 只需 repo 读权限，与 push/pull 一致。
	if body.RepoURL != "" {
		testLsRemote(c, body.RepoURL, cred)
		return
	}

	// 构造候选探测 URL（github/gitea/gitlab 走 /user API；generic 兜底试 gitea/gitlab API）
	probes := buildProbes(cred)
	if len(probes) == 0 {
		// generic 且无 host 又无 repo_url：无法测试
		shared.Error(c, http.StatusBadRequest, "platform not supported for testing", nil)
		return
	}

	// 依次探测：拿到明确结论（ok/expired）即止；network_error 时试下一个候选 URL
	var status, msg string
	for _, p := range probes {
		status, msg = probeUserAPI(p.url, p.accept, plain, p.authKind)
		if status != "network_error" {
			break
		}
	}
	switch status {
	case "ok":
		c.JSON(http.StatusOK, testCredentialResp{Status: "ok"})
	case "limited":
		c.JSON(http.StatusOK, testCredentialResp{Status: "limited"})
	case "expired":
		markCredentialExpired(c, cred, msg)
	default:
		c.JSON(http.StatusOK, testCredentialResp{Status: "network_error", Message: msg})
	}
}

// buildProbes 按 platform 构造候选 /user API 探测列表
// https 优先、http 兜底：本地自建 Gitea/GitLab 默认 http，公网服务 https
func buildProbes(cred *store.Credential) []probe {
	switch cred.Platform {
	case auth.PlatformGitHub:
		return []probe{{url: "https://api.github.com/user", accept: "application/vnd.github+json", authKind: "bearer"}}
	case auth.PlatformGitea:
		if cred.Host == "" {
			return nil
		}
		return []probe{
			{url: "https://" + cred.Host + "/api/v1/user", authKind: "token"},
			{url: "http://" + cred.Host + "/api/v1/user", authKind: "token"},
		}
	case auth.PlatformGitLab:
		if cred.Host == "" {
			return nil
		}
		return []probe{
			{url: "https://" + cred.Host + "/api/v4/user", authKind: "bearer"},
			{url: "http://" + cred.Host + "/api/v4/user", authKind: "bearer"},
		}
	case auth.PlatformGeneric:
		// generic 兜底：依次试 Gitea / GitLab 的 https + http（自建服务多为这俩）
		if cred.Host == "" {
			return nil
		}
		return []probe{
			{url: "https://" + cred.Host + "/api/v1/user", authKind: "token"},
			{url: "http://" + cred.Host + "/api/v1/user", authKind: "token"},
			{url: "https://" + cred.Host + "/api/v4/user", authKind: "bearer"},
			{url: "http://" + cred.Host + "/api/v4/user", authKind: "bearer"},
		}
	}
	return nil
}

// probeUserAPI 用 token GET url，返回 (status, message)
// status: "ok" | "expired" | "network_error"
// authKind: "bearer"（github/gitlab 标准）| "token"（gitea 历史格式 Authorization: token xxx）
func probeUserAPI(url, accept, token, authKind string) (string, string) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "network_error", err.Error()
	}
	if authKind == "token" {
		// Gitea 历史鉴权格式：Authorization: token <token>（Bearer 在部分 Gitea 版本不被识别）
		req.Header.Set("Authorization", "token "+token)
	} else {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "network_error", err.Error()
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return "ok", ""
	case http.StatusUnauthorized:
		return "expired", "revoked by platform"
	case http.StatusForbidden:
		// 403：token 被服务端识别为有效，但缺少该端点权限（如 Gitea 细粒度 token 无 user 读权限）。
		// git 推送/拉取走 repo 权限不受影响，故标识为 limited（有效但权限受限）而非失败。
		return "limited", ""
	default:
		return "network_error", fmt.Sprintf("unexpected status %d", resp.StatusCode)
	}
}

// testLsRemote 用 git ls-remote 验证 generic 凭据
// exit 0 = ok；鉴权失败标志 = expired；其他错误 = network_error
func testLsRemote(c *gin.Context, repoURL string, cred *store.Credential) {
	if err := git.LsRemoteWithURL(repoURL); err != nil {
		msg := err.Error()
		if isLsRemoteAuthFailure(msg) {
			markCredentialExpired(c, cred, "authentication failed")
			return
		}
		c.JSON(http.StatusOK, testCredentialResp{Status: "network_error", Message: msg})
		return
	}
	c.JSON(http.StatusOK, testCredentialResp{Status: "ok"})
}

// isLsRemoteAuthFailure 判断 git ls-remote stderr 是否为鉴权失败
// 匹配 git 在凭据无效 / 无权限时的典型错误文案
func isLsRemoteAuthFailure(msg string) bool {
	low := strings.ToLower(msg)
	if strings.Contains(low, "authentication failed") {
		return true
	}
	if strings.Contains(low, "could not read username") {
		return true
	}
	if strings.Contains(low, "access denied") {
		return true
	}
	if strings.Contains(low, "401") || strings.Contains(low, "403") {
		return true
	}
	return false
}

// markCredentialExpired 置 cred.Status=expired + LastError 并持久化，返回 expired 响应
func markCredentialExpired(c *gin.Context, cred *store.Credential, reason string) {
	cred.Status = store.StatusExpired
	cred.LastError = reason
	if err := store.Get().Credential.Save(cred); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Credential operation failed", err)
		return
	}
	c.JSON(http.StatusOK, testCredentialResp{Status: "expired"})
}
