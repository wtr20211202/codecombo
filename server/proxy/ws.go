package proxy

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/middleware"
	"codecombo/server/peercert"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// WebSocket 代理模块

const (
	// 心跳间隔
	wsPingInterval = 30 * time.Second

	// 每实例最大 WebSocket 连接数。
	// 兜底防泄漏而非业务限额：单个浏览器多终端 tab（split pane 各占一个 WS）
	// + 通知 + 项目监听 + 重连期新旧并存即可达 20——过小会误杀正常使用
	maxWSConnsPerInstance = 100
)

// wsConnCount 每实例的 WebSocket 连接计数（使用 atomic 操作）
var wsConnCount sync.Map // instanceId -> *atomic.Int32

// wsUpgrader WebSocket 升级器：统一工厂默认档（shared.SameOrigin 同源校验
// 防 CSWSH、不启用压缩）。浏览器连接 /ws/proxy/:id 时 Origin 即中心实例自身
// 页面来源，同源判定恒真——多实例代理链路不受影响；无 Origin 头的非浏览器
// 客户端放行。不启用压缩：透传两跳各有自身协商面（远端业务 WS 已协商），
// 本端再协商徒增编解码开销
var wsUpgrader = shared.WSUpgrade()

// getWSConnCount 获取实例的当前连接计数器
func getWSConnCount(instanceId string) *atomic.Int32 {
	val, ok := wsConnCount.Load(instanceId)
	if ok {
		return val.(*atomic.Int32)
	}
	counter := &atomic.Int32{}
	actual, _ := wsConnCount.LoadOrStore(instanceId, counter)
	return actual.(*atomic.Int32)
}

// buildWSURL 将 HTTP 目标地址转换为 WebSocket URL
// http://host:port/path -> ws://host:port/ws/path
// https://host:port/path -> wss://host:port/ws/path
func buildWSURL(targetURL, remainingPath string) string {
	base := strings.TrimRight(targetURL, "/")
	var wsBase string
	if strings.HasPrefix(base, "https://") {
		wsBase = "wss://" + strings.TrimPrefix(base, "https://")
	} else {
		wsBase = "ws://" + strings.TrimPrefix(base, "http://")
	}
	return wsBase + "/ws/" + remainingPath
}

// ProxyWSHandler WebSocket 双向代理 Handler
// 路由格式：/ws/proxy/:instanceId/*path
func ProxyWSHandler(c *gin.Context) {
	instanceId := c.Param("instanceId")
	remainingPath := c.Param("path")

	// 去除前导斜杠
	remainingPath = strings.TrimPrefix(remainingPath, "/")

	// 获取实例配置
	instances, err := store.Get().Instance.List()
	if err != nil {
		slog.Error("ws-proxy: failed to load instances", "err", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to load instance config"})
		return
	}
	var inst *config.InstanceConfig
	for i := range instances {
		if instances[i].ID == instanceId {
			inst = &instances[i]
			break
		}
	}
	if inst == nil {
		slog.Error("ws-proxy: instance not found", "instanceId", instanceId)
		c.JSON(http.StatusBadGateway, gin.H{"error": "instance not found"})
		return
	}

	// 并发控制：检查连接数上限（原子操作）
	connCounter := getWSConnCount(instanceId)
	if n := connCounter.Load(); n >= maxWSConnsPerInstance {
		slog.Warn("ws-proxy: max connections reached", "instanceId", instanceId, "count", n, "path", remainingPath)
		// 稳定原文收口 errmarkers 注册表（P-20261004-29）
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": errmarkers.MaxWsConnections})
		return
	}
	connCounter.Add(1)

	defer func() {
		connCounter.Add(-1)
	}()

	// Upgrade 前端 WebSocket 连接。
	// 必须回选请求的子协议（浏览器以子协议携带 unlock token）：浏览器规范要求
	// 客户端请求了 Sec-WebSocket-Protocol 而服务器未回选时判定握手失败——
	// 前端 new WebSocket(url, ['scl_xxx']) 会导致所有远程 WS 连接建立即断
	frontendConn, err := wsUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		slog.Error("ws-proxy: frontend upgrade failed", "err", err)
		return
	}
	defer frontendConn.Close()
	// 读帧上限防线（P-20261003-313）：只限前端侧（外部客户端输入方向）。
	// remoteConn 不设限——远端→前端方向是本方基础设施产出（scrollback 重放/
	// 广播），帧大小不受本服务控制，设限反可能在病态重放场景误杀合法中继；
	// 帧的输入语义由远端实例的业务 WS 按 shared.WSReadLimitInput 终审
	frontendConn.SetReadLimit(shared.WSReadLimitProxy)

	// 构建远程 WebSocket URL
	remoteURL := buildWSURL(inst.URL, remainingPath)

	// 附加原始 Query 参数
	if c.Request.URL.RawQuery != "" {
		remoteURL += "?" + c.Request.URL.RawQuery
	}

	// 构建请求 Header（包含 Token 认证 + 透传 lock token）
	// 远程实例若启用了 lock，WS 握手期会校验 X-Lock-Token / Sec-WebSocket-Protocol
	// / sc_lock_token cookie（ExtractLockToken 三载体），不透传会导致远程
	// 终端/项目变更/通知等 WS 握手被中间件 423 拒绝。任一载体提取到的 token
	// 都以头形态转发远端（浏览器 cookie-only 会话 P-20261019-2 也被覆盖）
	requestHeader := http.Header{}
	if inst.Token != "" {
		requestHeader.Set("Authorization", "Bearer "+inst.Token)
	}
	if lockToken := middleware.ExtractLockToken(c.Request); lockToken != "" {
		requestHeader.Set(middleware.LockHeaderName, lockToken)
	}

	// 建立到远程的 WebSocket 连接（含连接超时）
	dialer := websocket.Dialer{
		HandshakeTimeout: 45 * time.Second,
		// 实例间 TLS：默认 TOFU 指纹校验，开启 tlsVerifyPeer 后走系统信任库
		//（策略在握手回调内实时读取）
		TLSClientConfig: peercert.TLSConfig(),
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			d := &net.Dialer{Timeout: 10 * time.Second}
			return d.DialContext(ctx, network, addr)
		},
	}
	remoteConn, _, err := dialer.Dial(remoteURL, requestHeader)
	if err != nil {
		slog.Error("ws-proxy: failed to connect remote", "url", remoteURL, "err", err)
		return
	}
	defer remoteConn.Close()

	slog.Info("ws-proxy: established", "instanceId", instanceId, "path", remainingPath)

	// 双向透传
	done := make(chan struct{}, 2)

	// 前端 -> 远程
	go func() {
		defer func() { done <- struct{}{} }()
		relayWS(frontendConn, remoteConn, "frontend->remote")
	}()

	// 远程 -> 前端
	go func() {
		defer func() { done <- struct{}{} }()
		relayWS(remoteConn, frontendConn, "remote->frontend")
	}()

	// 心跳：定期向前端和远程发送 ping
	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				// 向前端发送 ping
				if err := frontendConn.WriteControl(
					websocket.PingMessage,
					[]byte{},
					time.Now().Add(5*time.Second),
				); err != nil {
					frontendConn.Close()
					remoteConn.Close()
					return
				}
				// 向远程发送 ping
				if err := remoteConn.WriteControl(
					websocket.PingMessage,
					[]byte{},
					time.Now().Add(5*time.Second),
				); err != nil {
					frontendConn.Close()
					remoteConn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()

	// 等待任一端断开或前端取消
	// 注：Upgrade 劫持连接后 c.Request.Context() 不再跟踪前端断连（net.http 已放弃该连接），
	// 该分支实际不会触发——前端断开由 relay 读错误路径感知，此处保留仅作语义兜底
	select {
	case <-done:
		// 一端断开
	case <-c.Request.Context().Done():
		// 前端 HTTP 请求取消
	}

	// 关闭连接，触发另一端 goroutine 退出
	frontendConn.Close()
	remoteConn.Close()

	// 等待第二个 goroutine 退出：relay 写超时后最长 30s 返回；
	// 再兜底一层超时等待，确保 handler（及连接计数）不会因极端场景永久滞留
	select {
	case <-done:
	case <-time.After(35 * time.Second):
		// 实测（全量 e2e 115 连接 115 次告警，pprof goroutine dump 0 条
		// relay 堆栈）：relay 最终经 30s 写 deadline 自行退出，非泄漏——
		// 属慢退出（第二 relay 的退出晚于 handler 的 35s 兜底）。保留
		// Warn 级以便观测频次，文案按实测修正避免误导排查方向
		slog.Warn("ws-proxy: relay slow exit (>35s, self-resolves via write deadline)", "instanceId", instanceId)
	}

	slog.Info("ws-proxy: closed", "instanceId", instanceId)
}

// relayWS 单向转发 WebSocket 消息
func relayWS(dst, src *websocket.Conn, direction string) {
	for {
		msgType, data, err := src.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				slog.Warn("ws-proxy: read error", "direction", direction, "err", err)
			}
			return
		}

		// 写超时：对端半死（TCP 在但不读）时 WriteMessage 默认无 deadline 会永久阻塞，
		// relay goroutine 卡死 → handler 等不到 done → 连接计数只增不减（此前 163 established / 0 closed 的泄漏根因）
		_ = dst.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if err := dst.WriteMessage(msgType, data); err != nil {
			slog.Warn("ws-proxy: write error", "direction", direction, "err", err)
			return
		}
	}
}
