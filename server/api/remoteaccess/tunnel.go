package remoteaccess

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/ssh"
)

// 远程接入（SSH 反向隧道）REST（P-20261019-11）：
//
//	GET  /api/remoteaccess/tunnel           状态 + 安全门槛 + 主机指纹
//	POST /api/remoteaccess/tunnel           {action:start|stop, profileId?, confirmInsecureTls?}
//	POST /api/remoteaccess/tunnel/test      {profileId} 或 {profile:{...}} 预检
//	POST /api/remoteaccess/tunnel/hostkey/reset  清除中继主机指纹（合法迁移）
//
// 档案 CRUD 走既有 GET/PUT /api/settings（remoteAccess 字段）——设置是档案的
// 单一持久化面，此处只做运行期控制与诊断。同一时刻仅一条隧道（manager 单活）。

// manager 反向隧道管理器单例（生命周期挂 remoteaccess 模块 Stop）
var manager = sshclient.NewReverseTunnelManager(onManagerEvent)

// lastHostKeyAlert 主机密钥变更通知节流（重连风暴下每 10 分钟至多一条；
// 初始失败与自动重连共用同一闸）
var lastHostKeyAlert atomic.Int64

func currentConfig() *config.Config {
	st := store.Get()
	if st == nil {
		return config.Load()
	}
	return st.Settings.Get()
}

// lockGate 公网暴露前置门槛：锁定功能必须启用且配置了密码。
// 未启用锁定 = 所有 /api 路由免鉴权，公网隧道等于把实例控制面直接交出。
// 默认密码（admin）不在此强拒——既有部署/测试面兼容，但状态里给出
// lockDefaultPassword 让 UI 红字警示（公网暴露前应修改）。
func lockGate() (ready bool, reason string, defaultPassword bool) {
	st := store.Get()
	if st == nil {
		return false, "store not ready", false
	}
	lc := st.Lock.GetConfig()
	if !lc.Enabled {
		return false, "lock is disabled", false
	}
	if lc.PasswordHash == "" {
		return false, "lock password is not configured", false
	}
	return true, "", st.Lock.IsDefaultPassword()
}

// auditBackground 无请求上下文的审计写入（自动恢复/回调），Append 尽力而为
func auditBackground(action, result, ip, detail string) {
	st := store.Get()
	if st == nil {
		return
	}
	st.Audit.Append(store.AuditEvent{Action: action, Result: result, IP: ip, Detail: detail})
}

// onManagerEvent 状态机事件出口：广播 remoteaccess.status（前端/agent 感知），
// 重连失败入审计（首次失败/人工启停由 handler 入账，避免双写）。
func onManagerEvent(ev sshclient.ReverseEvent) {
	if ev.Type == sshclient.ReverseEventReconnectErr && ev.Err != nil {
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, ev.ClientIP,
			fmt.Sprintf("profile=%s attempt=%d bind=%s:%d err=%s", ev.Status.ProfileID, ev.Status.Attempts,
				ev.Status.RemoteHost, ev.Status.RemotePort, truncateErr(ev.Err)))
		// 断线重连撞上主机密钥变更：与首次启用的同一告警面（通知中心节流
		// 10 分钟），否则重连风暴里用户只能从 lastError 看到英文原文
		if strings.Contains(ev.Err.Error(), errmarkers.HostKeyChanged) {
			if ra := currentConfig().Server.RemoteAccess; ra != nil {
				if p := ra.FindProfile(ev.Status.ProfileID); p != nil {
					notifyHostKeyChanged(p, ev.ClientIP)
				}
			}
		}
	}
	// ops-channel 广播：状态快照 + event + at（agent 可直接据 state 分支）
	opschannel.BroadcastEvent(opschannel.EventRemoteAccessStatus, gin.H{
		"event":              ev.Type,
		"state":              ev.Status.State,
		"profileId":          ev.Status.ProfileID,
		"remoteBindHost":     ev.Status.RemoteHost,
		"remotePort":         ev.Status.RemotePort,
		"publicUrl":          ev.Status.PublicURL,
		"startedAt":          ev.Status.StartedAt,
		"onlineSince":        ev.Status.OnlineSince,
		"lastError":          ev.Status.LastError,
		"lastErrorAt":        ev.Status.LastErrorAt,
		"reconnectAttempts":  ev.Status.Attempts,
		"activeConnections":  ev.Status.ActiveConns,
		"totalConnections":   ev.Status.TotalConns,
		"droppedConnections": ev.Status.DroppedConns,
		"at":                 time.Now().UnixMilli(),
	})
}

func truncateErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

// resolveProfileAuth 解析档案认证（每次拨号现读）：sshkey 从既有密钥库取
// 私钥，密码档案解密 enc: 密文。解密失败（master-key 换过）给出可行动错误。
func resolveProfileAuth(p *config.RemoteAccessProfile) (sshclient.AuthMethod, error) {
	switch p.AuthType {
	case config.RemoteAccessAuthSSHKey:
		st := store.Get()
		if st == nil {
			return sshclient.AuthMethod{}, fmt.Errorf("store not ready")
		}
		pem, err := st.SshKey.GetPrivatePem(p.SshKeyID)
		if err != nil {
			return sshclient.AuthMethod{}, fmt.Errorf("resolve ssh key %q failed: %w (choose another key in the relay profile)", p.SshKeyID, err)
		}
		return sshclient.AuthMethod{Type: sshclient.AuthTypePem, PemContent: pem}, nil
	case config.RemoteAccessAuthPassword:
		pw := config.DecryptIfNeeded(p.Password)
		if pw == "" || config.IsEncrypted(pw) {
			return sshclient.AuthMethod{}, fmt.Errorf("credential decrypt failed: re-enter the relay password (master-key mismatch or migrated data dir)")
		}
		return sshclient.AuthMethod{Type: sshclient.AuthTypePassword, Password: pw}, nil
	}
	return sshclient.AuthMethod{}, fmt.Errorf("unsupported auth type %q", p.AuthType)
}

// reverseDialer 拨号闭包：每次首次建立/重连都重新读档案与凭据（改密/换钥后
// 重连自动跟随，不重建档案）
func reverseDialer(profileID string) func() (*ssh.Client, error) {
	return func() (*ssh.Client, error) {
		cfg := currentConfig()
		var p *config.RemoteAccessProfile
		if cfg.Server.RemoteAccess != nil {
			p = cfg.Server.RemoteAccess.FindProfile(profileID)
		}
		if p == nil {
			return nil, fmt.Errorf("relay profile %s no longer exists", profileID)
		}
		auth, err := resolveProfileAuth(p)
		if err != nil {
			return nil, err
		}
		c, err := sshclient.Dial(sshclient.ConnectOptions{
			Host: p.Host, Port: p.EffectivePort(), User: p.User,
			Auth:    auth,
			Timeout: 15 * time.Second,
		})
		if err != nil {
			return nil, err
		}
		return c.UnderlyingClient(), nil
	}
}

// localMainAddr 反向隧道落点：本机回环主服务端口（TLS/明文均由主服务自决）
func localMainAddr(cfg *config.Config) string {
	port := cfg.Server.Port
	if port <= 0 {
		port = 9999
	}
	// 主服务 listen 地址可能是 0.0.0.0（回环可达）或某个具体网卡 IP
	//（回环不可达）：跟随配置，通配/空回落 127.0.0.1
	host := strings.TrimSpace(cfg.Server.Host)
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func buildSpec(cfg *config.Config, p *config.RemoteAccessProfile, clientIP string) (sshclient.ReverseSpec, error) {
	if p == nil {
		return sshclient.ReverseSpec{}, fmt.Errorf("relay profile is not configured")
	}
	if _, err := resolveProfileAuth(p); err != nil {
		return sshclient.ReverseSpec{}, err
	}
	public := p.PublicURL(config.TLSEnabled())
	if public == "" && strings.TrimSpace(p.Domain) == "" && p.EffectiveRemoteBindHost() == config.RemoteAccessBindLoopback {
		// 回环 + 无域名 = 只能由 VPS 反代访问；保留空 publicUrl（UI 说明）
		public = ""
	}
	return sshclient.ReverseSpec{
		ProfileID:      p.ID,
		RemoteBindHost: p.EffectiveRemoteBindHost(),
		RemotePort:     p.EffectiveRemotePort(),
		LocalAddr:      localMainAddr(cfg),
		PublicURL:      public,
		ClientIP:       clientIP,
		Dial:           reverseDialer(p.ID),
	}, nil
}

// hostKeyInfo 当前激活档案的中继主机指纹（TOFU 钉扎；未连接过 pinned=false）
func hostKeyInfo(p *config.RemoteAccessProfile) gin.H {
	if p == nil {
		return gin.H{"pinned": false}
	}
	st := store.Get()
	if st == nil {
		return gin.H{"pinned": false}
	}
	fp, algo, ok, err := st.SSHHostKey.Get(p.Host, p.EffectivePort())
	if err != nil || !ok {
		return gin.H{"pinned": false}
	}
	return gin.H{"pinned": true, "fingerprint": fp, "algo": algo}
}

// Status GET /api/remoteaccess/tunnel
func Status(c *gin.Context) {
	cfg := currentConfig()
	ra := cfg.Server.RemoteAccess
	ready, reason, defaultPw := lockGate()
	active := ra.ActiveProfile()
	st := manager.Status()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"state":               st.State,
		"profileId":           st.ProfileID,
		"remoteBindHost":      st.RemoteHost,
		"remotePort":          st.RemotePort,
		"publicUrl":           st.PublicURL,
		"startedAt":           st.StartedAt,
		"onlineSince":         st.OnlineSince,
		"lastError":           st.LastError,
		"lastErrorAt":         st.LastErrorAt,
		"reconnectAttempts":   st.Attempts,
		"activeConnections":   st.ActiveConns,
		"totalConnections":    st.TotalConns,
		"droppedConnections":  st.DroppedConns,
		"enabled":             ra != nil && ra.Enabled,
		"activeId":            activeIDOf(ra),
		"lockReady":           ready,
		"lockReason":          reason,
		"lockDefaultPassword": defaultPw,
		"tlsEnabled":          config.TLSEnabled(),
		"hostKey":             hostKeyInfo(active),
		// P-20261019-10 未落地：externalAccessUrl 联动字段保留占位（空），
		// 前端仅显示复制/二维码；P-10 落地后由该端点读取设置键回填
		"externalAccessUrl": "",
	}})
}

func activeIDOf(ra *config.RemoteAccessConfig) string {
	if ra == nil {
		return ""
	}
	return ra.ActiveID
}

// Control POST /api/remoteaccess/tunnel {action, profileId?, confirmInsecureTls?}
func Control(c *gin.Context) {
	var req struct {
		Action             string `json:"action"`
		ProfileID          string `json:"profileId"`
		ConfirmInsecureTLS bool   `json:"confirmInsecureTls"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessPayloadInvalid, "invalid remote access payload", err)
		return
	}
	switch strings.ToLower(strings.TrimSpace(req.Action)) {
	case "start":
		controlStart(c, req.ProfileID, req.ConfirmInsecureTLS)
	case "stop":
		controlStop(c)
	default:
		shared.ErrorWithCode(c, shared.CodeRemoteAccessPayloadInvalid, "invalid remote access payload",
			fmt.Errorf("action must be start or stop"))
	}
}

func controlStart(c *gin.Context, requestedID string, confirmInsecure bool) {
	cfg := currentConfig()
	ra := cfg.Server.RemoteAccess
	if ra == nil || len(ra.Profiles) == 0 {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessConfigInvalid, "relay profile is not configured",
			fmt.Errorf("remoteAccess.profiles is empty"))
		return
	}
	id := strings.TrimSpace(requestedID)
	if id == "" {
		id = ra.ActiveID
	}
	p := ra.FindProfile(id)
	if p == nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessProfileNotFound, "relay profile not found",
			fmt.Errorf("relay profile %q not found", id))
		return
	}
	if ready, reason, _ := lockGate(); !ready {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessLockRequired,
			"lock password protection is required before exposing this instance: "+reason,
			fmt.Errorf("lock gate: %s", reason))
		return
	}
	tlsOn := config.TLSEnabled()
	if !tlsOn && !confirmInsecure {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessTLSConfirmRequired,
			"TLS is not enabled: the relay would expose plaintext HTTP. Confirm the risk to continue.",
			fmt.Errorf("tls disabled and confirmInsecureTls=false"))
		return
	}
	// 同档案已在线的重复 start 是幂等复用（不重拨、不重建），不重复记
	// TLS 确认/启动审计——否则 agent 轮询式调用会把台账刷成噪声
	prev := manager.Status()
	alreadyActive := (prev.State == sshclient.ReverseStateOnline || prev.State == sshclient.ReverseStateReconnecting) && prev.ProfileID == p.ID
	if !tlsOn && confirmInsecure && !alreadyActive {
		// 显式确认入审计（P-20261019-11 用户拍板：TLS 未启用强警示 + 显式确认）
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditRemoteAccessTLSInsecure,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("profile=%s host=%s:%d", p.Name, p.Host, p.EffectivePort()),
		})
	}

	spec, err := buildSpec(cfg, p, c.ClientIP())
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessConfigInvalid, "remote access configuration invalid", err)
		return
	}
	// 一键切换：旧档案的停止也是隧道生命周期的一部分，独立入账（Start 的
	// 停旧起新对审计面不可见会让「谁把 A 换成了 B」缺一段）
	if (prev.State == sshclient.ReverseStateOnline || prev.State == sshclient.ReverseStateReconnecting) && prev.ProfileID != p.ID {
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditRemoteAccessStop,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("profileId=%s reason=switch-to:%s", prev.ProfileID, p.ID),
		})
	}
	st, err := manager.Start(spec)
	if err != nil {
		// 主机密钥变更：明确告警（审计已由 hostkey 校验链写入 hostkey.mismatch；
		// 这里补通知中心可见性与节流，避免重连风暴刷屏）
		if strings.Contains(err.Error(), errmarkers.HostKeyChanged) {
			notifyHostKeyChanged(p, c.ClientIP())
		}
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, c.ClientIP(),
			fmt.Sprintf("profile=%s bind=%s:%d err=%s", p.Name, p.EffectiveRemoteBindHost(), p.EffectiveRemotePort(), truncateErr(err)))
		shared.ErrorWithCode(c, shared.CodeRemoteAccessStartFailed, "failed to start reverse tunnel", err)
		return
	}

	// 持久化启用态 + 激活档案（进程重启后自动恢复；start/stop 是唯一写点，
	// 设置页的档案编辑不擅自改变运行态）
	ra.ActiveID = p.ID
	ra.Enabled = true
	if err := store.Get().Settings.Save(); err != nil {
		ra.Enabled = false
		_, _ = manager.Stop()
		shared.Error(c, http.StatusInternalServerError, "persist remote access state failed", err)
		return
	}
	if !alreadyActive {
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditRemoteAccessStart,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("profile=%s host=%s:%d bind=%s:%d local=%s tls=%v",
				p.Name, p.Host, p.EffectivePort(), spec.RemoteBindHost, spec.RemotePort, spec.LocalAddr, tlsOn),
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": st, "publicUrl": spec.PublicURL})
}

func controlStop(c *gin.Context) {
	cfg := currentConfig()
	ra := cfg.Server.RemoteAccess
	wasActive, st := manager.Stop()
	if ra != nil && ra.Enabled {
		ra.Enabled = false
		if err := store.Get().Settings.Save(); err != nil {
			shared.Error(c, http.StatusInternalServerError, "persist remote access state failed", err)
			return
		}
	}
	profileID := ""
	if ra != nil {
		profileID = ra.ActiveID
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditRemoteAccessStop,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("profileId=%s wasActive=%v", profileID, wasActive),
	})
	c.JSON(http.StatusOK, gin.H{"data": st})
}

// Test POST /api/remoteaccess/tunnel/test —— 预检（不改变运行态）
func Test(c *gin.Context) {
	var req struct {
		ProfileID string                      `json:"profileId"`
		Profile   *config.RemoteAccessProfile `json:"profile"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessPayloadInvalid, "invalid remote access payload", err)
		return
	}
	cfg := currentConfig()
	var p *config.RemoteAccessProfile
	if req.Profile != nil {
		// 未保存表单也可测试：按现有档案合并密码（编辑不回填密码）
		norm, err := config.NormalizeRemoteAccess(&config.RemoteAccessConfig{
			Profiles: []config.RemoteAccessProfile{*req.Profile},
		}, cfg.Server.RemoteAccess)
		if err != nil {
			shared.ErrorWithCode(c, shared.CodeRemoteAccessConfigInvalid, "remote access configuration invalid", err)
			return
		}
		p = &norm.Profiles[0]
	} else {
		id := strings.TrimSpace(req.ProfileID)
		if id == "" && cfg.Server.RemoteAccess != nil {
			id = cfg.Server.RemoteAccess.ActiveID
		}
		if cfg.Server.RemoteAccess == nil {
			shared.ErrorWithCode(c, shared.CodeRemoteAccessProfileNotFound, "relay profile not found", nil)
			return
		}
		p = cfg.Server.RemoteAccess.FindProfile(id)
		if p == nil {
			shared.ErrorWithCode(c, shared.CodeRemoteAccessProfileNotFound, "relay profile not found",
				fmt.Errorf("relay profile %q not found", id))
			return
		}
	}
	auth, err := resolveProfileAuth(p)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessConfigInvalid, "remote access configuration invalid", err)
		return
	}
	result := sshclient.ProbeReverseRelay(sshclient.ReverseProbeOptions{
		Host: p.Host, Port: p.EffectivePort(), User: p.User,
		Auth:           auth,
		RemoteBindHost: p.EffectiveRemoteBindHost(),
		RemotePort:     p.EffectiveRemotePort(),
		LocalAddr:      localMainAddr(cfg),
		Timeout:        5 * time.Second,
	})
	c.JSON(http.StatusOK, gin.H{"data": result, "publicUrl": p.PublicURL(config.TLSEnabled())})
}

// ResetHostKey POST /api/remoteaccess/tunnel/hostkey/reset {profileId}
// 合法迁移（VPS 重装/换钥）后的 TOFU 重置入口；与远程主机 hostkey reset 同
// 语义（清钉扎 + 审计 + 通知中心），幂等。
func ResetHostKey(c *gin.Context) {
	var req struct {
		ProfileID string `json:"profileId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessPayloadInvalid, "invalid remote access payload", err)
		return
	}
	cfg := currentConfig()
	if cfg.Server.RemoteAccess == nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessProfileNotFound, "relay profile not found", nil)
		return
	}
	p := cfg.Server.RemoteAccess.FindProfile(strings.TrimSpace(req.ProfileID))
	if p == nil {
		shared.ErrorWithCode(c, shared.CodeRemoteAccessProfileNotFound, "relay profile not found",
			fmt.Errorf("relay profile %q not found", req.ProfileID))
		return
	}
	if err := store.Get().SSHHostKey.Delete(p.Host, p.EffectivePort()); err != nil {
		shared.Error(c, http.StatusInternalServerError, "reset host key fingerprint failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostKeyReset,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s:%d)", p.Name, p.Host, p.EffectivePort()),
	})
	store.Get().Notification.Add(notification.Notification{
		Type:      "warning",
		Category:  notification.CategorySystem,
		TitleKey:  "audit.notify.hostkeyReset.title",
		BodyKey:   "audit.notify.hostkeyReset.body",
		Title:     fmt.Sprintf("SSH 主机指纹已重置：%s", p.Name),
		Body:      fmt.Sprintf("%s (%s:%d) 的主机密钥指纹已清除，下次连接将重新记录（来源 IP %s）", p.Name, p.Host, p.EffectivePort(), c.ClientIP()),
		MsgParams: map[string]any{"name": p.Name, "host": p.Host, "port": p.EffectivePort(), "ip": c.ClientIP()},
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"pinned": false, "resetAt": time.Now().Format(time.RFC3339)}})
}

// notifyHostKeyChanged 中继主机密钥变更告警（通知中心 + 节流）
func notifyHostKeyChanged(p *config.RemoteAccessProfile, ip string) {
	now := time.Now().Unix()
	last := lastHostKeyAlert.Load()
	if last != 0 && now-last < int64((10*time.Minute)/time.Second) {
		return
	}
	if !lastHostKeyAlert.CompareAndSwap(last, now) {
		return
	}
	st := store.Get()
	if st == nil {
		return
	}
	st.Notification.Add(notification.Notification{
		Type:      "error",
		Category:  notification.CategorySystem,
		TitleKey:  "audit.notify.remoteAccessHostKeyChanged.title",
		BodyKey:   "audit.notify.remoteAccessHostKeyChanged.body",
		Title:     fmt.Sprintf("远程接入中继主机密钥变更：%s", p.Name),
		Body:      fmt.Sprintf("%s（%s:%d）的 SSH 主机密钥与钉扎指纹不符，隧道已停止。确认是合法迁移后到「设置·远程接入」重置主机指纹（来源 IP %s）", p.Name, p.Host, p.EffectivePort(), ip),
		MsgParams: map[string]any{"name": p.Name, "host": p.Host, "port": p.EffectivePort(), "ip": ip},
	})
}
