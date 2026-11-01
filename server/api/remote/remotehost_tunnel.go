package remote

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/preview"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/ssh"
)

// SSH 本地转发隧道 REST（P-20261004-5）：远端主机回环端口 → 实例本机临时口。
// 预览面板联动（preview.port 带 hostId，前端据此开隧道拿映射口）与 agent
// 自助开隧道（手册 remote 节：远程起服务 → 开隧道 → 上报预览）共用这三个端点。
// 安全边界：远端目标恒为远端回环、本机监听恒为 127.0.0.1（见 sshclient.TunnelManager）；
// 端口校验与预览面板同口径（1024~65535，特权段不开放）。

// tunnels 隧道管理器单例：上限与 TTL 取 sshclient 默认（5 条 / 15min 空闲回收）；
// 生命周期挂远程模块（module.go Stop 时 CloseAll）
var tunnels = sshclient.NewTunnelManager(sshclient.DefaultTunnelLimit, sshclient.DefaultTunnelTTL)

// OpenTunnel POST /api/remotehosts/:id/tunnels {"remotePort"} → {"data": TunnelInfo}
// 同 (host, remotePort) 幂等：既有隧道直接返回既有映射（前端重试/agent 重复
// 上报不重复占口）。上限命中 409、凭据/拨号失败 502——隧道开不成没有半开资源
func OpenTunnel(c *gin.Context) {
	id := c.Param("id")
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	if rh.IsFTP() {
		shared.Error(c, http.StatusBadRequest, "FTP host does not support SSH tunnels (files only)", nil)
		return
	}
	var req struct {
		RemotePort int `json:"remotePort" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid tunnel payload", err)
		return
	}
	if req.RemotePort < preview.MinPort || req.RemotePort > preview.MaxPort {
		shared.Error(c, http.StatusBadRequest,
			fmt.Sprintf("invalid remotePort %d: must be in [%d, %d]", req.RemotePort, preview.MinPort, preview.MaxPort), nil)
		return
	}

	info, err := tunnels.Open(id, req.RemotePort, tunnelDialer(id))
	if err != nil {
		if errors.Is(err, sshclient.ErrTunnelLimit) {
			shared.Error(c, http.StatusConflict, "tunnel limit reached", err)
			return
		}
		respondRemoteDialError(c, "remote host dial failed", err)
		return
	}
	// 审计入账：开隧道=把远端回环服务暴露到 Web 面（预览同级），与主机 CRUD 同族入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostTunnel,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s 127.0.0.1:%d -> 127.0.0.1:%d", rh.Name, req.RemotePort, info.LocalPort),
	})
	c.JSON(http.StatusOK, gin.H{"data": info})
}

// ListTunnels GET /api/remotehosts/:id/tunnels → {"data": []TunnelInfo}
func ListTunnels(c *gin.Context) {
	id := c.Param("id")
	if _, err := store.Get().RemoteHost.Get(id); err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": tunnels.List(id)})
}

// CloseTunnel DELETE /api/remotehosts/:id/tunnels/:localPort → {"ok": true}
func CloseTunnel(c *gin.Context) {
	id := c.Param("id")
	localPort, err := strconv.Atoi(c.Param("localPort"))
	if err != nil || localPort < 1 {
		shared.Error(c, http.StatusBadRequest, "invalid local port", nil)
		return
	}
	if !tunnels.Close(id, localPort) {
		shared.Error(c, http.StatusNotFound, "tunnel not found", nil)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostTunnel,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("close 127.0.0.1:%d", localPort),
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// tunnelDialer 隧道拨号闭包：每次调用（开隧道 / 断线重连）时重新解析主机记录
// 与凭据再拨号——主机改地址/改密后重连自动跟随最新配置，无需重建隧道
func tunnelDialer(hostID string) sshclient.TunnelDialer {
	return func() (*ssh.Client, error) {
		rh, err := store.Get().RemoteHost.Get(hostID)
		if err != nil {
			return nil, fmt.Errorf("host record gone: %w", err)
		}
		if err := ResolveRemoteHostAuth(rh); err != nil {
			return nil, err
		}
		client, err := sshclient.Dial(sshclient.ConnectOptions{
			Host: rh.Host, Port: rh.Port, User: rh.User,
			Auth:            sshclient.AuthMethodFor(rh.AuthType, rh.Password, rh.PemContent),
			SkipHostKeyTOFU: rh.HostKeyVerifyDisabled,
			Timeout:         15 * time.Second,
		})
		if err != nil {
			return nil, err
		}
		return client.UnderlyingClient(), nil
	}
}
