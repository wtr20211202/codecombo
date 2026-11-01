package remote

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

var (
	errEmptyCmd   = errors.New("command is empty")
	errCmdTooLong = errors.New("command too long (max 8KB)")
)

// 远程命令执行限制
const (
	remoteExecTimeout = 60 * time.Second // 单条命令超时
	remoteExecMaxCmd  = 8 * 1024         // 命令长度上限
)

// remoteExecResp 执行响应
type remoteExecResp struct {
	OK       bool   `json:"ok"`
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Error    string `json:"error,omitempty"`
}

// RemoteHostExec 在远程主机上执行单条命令（Web 化运维入口，免 SSH 客户端）
// 安全边界：与 Web 终端同级——受 LockMiddleware + unlock token 保护；
// 命令由用户显式提交（或经 AI 建议、用户审阅后触发），不做任何自动执行
func RemoteHostExec(c *gin.Context) {
	id := c.Param("id")
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	if rh.IsFTP() {
		c.JSON(http.StatusOK, remoteExecResp{Error: "FTP host does not support SSH exec (files only)"})
		return
	}
	var req struct {
		Cmd string `json:"cmd" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "remote exec failed", err)
		return
	}
	cmd := strings.TrimSpace(req.Cmd)
	if cmd == "" {
		shared.Error(c, http.StatusBadRequest, "remote exec failed", errEmptyCmd)
		return
	}
	if len(cmd) > remoteExecMaxCmd {
		shared.Error(c, http.StatusBadRequest, "remote exec failed", errCmdTooLong)
		return
	}

	if err := ResolveRemoteHostAuth(rh); err != nil {
		c.JSON(http.StatusOK, remoteExecResp{Error: err.Error()})
		return
	}
	// 连接从 per-host 池借出（P-20261005-159：免每请求握手）；连接级首错由
	// 池弃置重建重试一次——连接死亡时远端命令多半未启动，重放面有界。
	// ctx 超时不属连接级错误（IsConnLevelError 排除），不触发重试
	ctx, cancel := context.WithTimeout(c.Request.Context(), remoteExecTimeout)
	defer cancel()
	var out *sshclient.ExecOutput
	err = conns.WithLease(id, dialOptions(rh), func(client *sshclient.Client) error {
		var e error
		out, e = client.Exec(ctx, sshclient.ExecOptions{Cmd: cmd}, nil)
		return e
	})
	if err != nil && out == nil {
		// 连接/会话层错误（含超时取消）
		c.JSON(http.StatusOK, remoteExecResp{Error: err.Error()})
		return
	}
	resp := remoteExecResp{OK: out != nil && out.ExitCode == 0}
	if out != nil {
		resp.ExitCode = out.ExitCode
		resp.Stdout = strings.Join(out.Stdout, "\n")
		resp.Stderr = strings.Join(out.Stderr, "\n")
	}
	if err != nil && resp.Error == "" {
		resp.Error = err.Error()
	}
	c.JSON(http.StatusOK, resp)
}
