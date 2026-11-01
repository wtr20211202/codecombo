package proxy

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/middleware"
	"codecombo/server/peercert"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ---------- 连接池管理 ----------

// clientPool 每个实例对应一个连接池化 HTTP Client
var clientPool sync.Map // instanceId -> *http.Client

// GetClient 获取或创建实例对应的连接池化 HTTP Client
func GetClient(instanceId string) *http.Client {
	val, ok := clientPool.Load(instanceId)
	if ok {
		return val.(*http.Client)
	}

	pc := config.GetProxyConfig()

	transport := &http.Transport{
		MaxIdleConnsPerHost:   pc.MaxIdleConns,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          100,
		DisableKeepAlives:     false,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		// 实例间 TLS：默认 TOFU 指纹校验（自签直达），开启 tlsVerifyPeer 后
		// 走系统信任库严格校验；策略在握手回调内实时读取，池化复用无陈旧问题
		TLSClientConfig: peercert.TLSConfig(),
	}

	client := &http.Client{
		Transport: transport,
	}

	actual, loaded := clientPool.LoadOrStore(instanceId, client)
	if loaded {
		return actual.(*http.Client)
	}
	return client
}

// ---------- 并发控制 ----------

var concurrencyMaps sync.Map // instanceId -> chan struct{}

func getConcurrencyChan(instanceId string) chan struct{} {
	val, ok := concurrencyMaps.Load(instanceId)
	if ok {
		return val.(chan struct{})
	}
	pc := config.GetProxyConfig()
	ch := make(chan struct{}, pc.MaxConcurrency)
	actual, loaded := concurrencyMaps.LoadOrStore(instanceId, ch)
	if loaded {
		return actual.(chan struct{})
	}
	return ch
}

// ---------- 超时策略 ----------

var longOperationPatterns = []string{
	"/push",
	"/pull",
	"/fetch",
	"/clone",
	"/lfs/",
	"/ai", // AI 场景（含 SSE 流式生成）：LLM 逐 token 产出耗时长，走长操作超时档
}

func isLongOperation(requestPath string) bool {
	// 精确匹配路径段，避免子串误匹配（如 /push-notification 匹配 /push）
	lower := strings.ToLower(requestPath)
	// 补前导斜杠归一化：调用方传入的路径可能已剥掉前导 "/"（如 "ai/chat/stream"），
	// 不补则首段 "/ai" 永远匹配不上
	if !strings.HasPrefix(lower, "/") {
		lower = "/" + lower
	}
	for _, pattern := range longOperationPatterns {
		if strings.HasSuffix(lower, pattern) || strings.Contains(lower, pattern+"/") {
			return true
		}
	}
	return false
}

func getTimeout(requestPath string) time.Duration {
	pc := config.GetProxyConfig()
	if isLongOperation(requestPath) {
		return time.Duration(pc.LongTimeout) * time.Second
	}
	return time.Duration(pc.DefaultTimeout) * time.Second
}

func getStreamIdleTimeout() time.Duration {
	pc := config.GetProxyConfig()
	return time.Duration(pc.IdleTimeout) * time.Second
}

// ---------- HTTP 代理核心 ----------

// ProxyHandler HTTP 代理转发核心 Handler
// 路由格式：/proxy/:instanceId/*path
func ProxyHandler(c *gin.Context) {
	instanceId := c.Param("instanceId")
	remainingPath := c.Param("path")

	remainingPath = strings.TrimPrefix(remainingPath, "/")
	// 归一化前缀：前端拦截器改写后的路径形如 /proxy/<id>/api/xxx（保留了 /api 前缀），
	// 而调用方也可能直接传 /proxy/<id>/xxx（API 相对路径）。统一剥离开头的 api/ 再补 /api/，
	// 两种形式等价，避免拼出 /api/api/ 双前缀导致远程 404
	remainingPath = strings.TrimPrefix(remainingPath, "api/")

	// 从 config 包读取实例配置
	instances, err := store.Get().Instance.List()
	if err != nil {
		slog.Error("proxy: failed to load instances", "err", err)
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
		slog.Error("proxy: instance not found", "instanceId", instanceId)
		c.JSON(http.StatusBadGateway, gin.H{"error": "instance not found"})
		return
	}

	// 构建目标 URL：<targetURL>/api/<path>
	targetURL := strings.TrimRight(inst.URL, "/")
	targetPath := "/api/" + remainingPath
	targetFullURL := targetURL + targetPath

	if c.Request.URL.RawQuery != "" {
		targetFullURL += "?" + c.Request.URL.RawQuery
	}

	// 读取原始请求体
	var bodyReader io.Reader
	if c.Request.Body != nil {
		bodyReader = c.Request.Body
		defer c.Request.Body.Close()
	}

	// 创建目标请求
	targetReq, err := http.NewRequest(c.Request.Method, targetFullURL, bodyReader)
	if err != nil {
		slog.Error("proxy: failed to create request", "err", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to create request"})
		return
	}

	// 复制 Header（排除 hop-by-hop）
	copyHeaders(targetReq.Header, c.Request.Header)

	// 上游透传本面 request-id（P-20261003-216）：远端实例日志的 rid 与访端
	// errorLog 同值，跨实例排障一键对齐。远端同版本沿用该 id（RequestID 中间件
	// 对合法来头不重新生成）；旧版本远端自生成并随响应头返回——本地响应以本面
	// id 为准，不透传回写（见下方响应头剥除）
	if rid := middleware.RequestIDFromGin(c); rid != "" {
		targetReq.Header.Set(middleware.HeaderXRequestID, rid)
	}

	// Token 认证
	if inst.Token != "" {
		targetReq.Header.Set("Authorization", "Bearer "+inst.Token)
	}

	// 并发控制
	semCh := getConcurrencyChan(instanceId)
	select {
	case semCh <- struct{}{}:
	default:
		slog.Warn("proxy: concurrency limit reached", "instanceId", instanceId)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "too many concurrent requests"})
		return
	}
	defer func() { <-semCh }()

	// 取消传播 + 差异化超时
	timeout := getTimeout(remainingPath)
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()
	targetReq = targetReq.WithContext(ctx)

	// 发送请求
	client := GetClient(instanceId)
	resp, err := client.Do(targetReq)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			slog.Warn("proxy: request timed out", "url", targetFullURL)
			c.JSON(http.StatusGatewayTimeout, gin.H{"error": "request timed out"})
		} else {
			slog.Error("proxy: request failed", "url", targetFullURL, "err", err)
			// 稳定前缀收口 errmarkers 注册表（P-20261004-29），与 dispatch 同串
			c.JSON(http.StatusBadGateway, gin.H{"error": errmarkers.RemoteUnreachable})
		}
		// 标记实例离线
		store.Get().Instance.SetStatus(instanceId, "offline")
		return
	}
	defer resp.Body.Close()

	// 在线标记
	store.Get().Instance.SetStatus(instanceId, "online")

	// 转发响应 Header（过滤 hop-by-hop 头）和状态码
	// 剥上游冗余的安全基线响应头（P-20261002-42）：主引擎全局中间件已对代理
	// 响应施基线，同版本远端会带同值头，copyHeaders 按 Add 复制会产生重复头
	//（值相同无害但脏）——转发响应以本地策略为准（同 preview.ModifyResponse
	// 的剥帧头先例，方向相反：那里为可嵌而剥，这里为去重而剥）
	for _, h := range middleware.SecurityBaselineHeaders {
		resp.Header.Del(h)
	}
	// 剥上游 X-Request-Id：本面中间件已 Set 同名头，copyHeaders 按 Add 复制
	// 会产生重复头（旧版本远端自生成异值时，客户端读到逗号拼串无法对齐）
	resp.Header.Del(middleware.HeaderXRequestID)
	copyHeaders(c.Writer.Header(), resp.Header)
	c.Writer.WriteHeader(resp.StatusCode)

	// 流式转发响应体：SSE 响应逐块写 + Flush（客户端实时收帧），其余保持 io.Copy 原路径
	var lastWrite atomic.Int64
	lastWrite.Store(time.Now().UnixNano())
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer resp.Body.Close()
		// 监听请求取消以提前终止读循环
		ctx := c.Request.Context()
		go func() {
			<-ctx.Done()
			resp.Body.Close()
		}()
		if isSSEResponse(resp) {
			if flusher, ok := c.Writer.(http.Flusher); ok {
				_ = copyStreamWithFlush(c.Writer, resp.Body, flusher, &lastWrite)
				return
			}
		}
		_, _ = io.Copy(c.Writer, resp.Body)
	}()

	switch reason := waitStreamDone(done, c.Request.Context().Done(), &lastWrite, getStreamIdleTimeout()); reason {
	case streamCancelled:
		slog.Warn("proxy: request cancelled", "url", targetFullURL)
	case streamIdle:
		slog.Warn("proxy: stream idle timeout", "url", targetFullURL)
		cancel()
	}
}

// 流转发结束原因（waitStreamDone 返回值）
const (
	streamDone      = "done"      // 上游响应体转发完成
	streamCancelled = "cancelled" // 客户端断开连接
	streamIdle      = "idle"      // 距最后一次成功写超过空闲阈值
)

// waitStreamDone 等待响应体转发结束并返回结束原因。
// 真 idle 检测：只在上游持续静默（距 lastWrite 超过 idleLimit）时才判 idle；
// 旧实现 time.After 从转发起点计时，会把持续产出但总时长超阈值的流（LLM 生成）误杀
func waitStreamDone(done <-chan struct{}, cancelled <-chan struct{}, lastWrite *atomic.Int64, idleLimit time.Duration) string {
	timer := time.NewTimer(idleLimit)
	defer timer.Stop()
	for {
		select {
		case <-done:
			return streamDone
		case <-cancelled:
			return streamCancelled
		case <-timer.C:
			idle := time.Since(time.Unix(0, lastWrite.Load()))
			if idle >= idleLimit {
				return streamIdle
			}
			// 期间有过写入：只等剩余的空闲余量
			timer.Reset(idleLimit - idle)
		}
	}
}

// isSSEResponse 判断上游响应是否为 SSE 流（Content-Type 宽松包含匹配）
func isSSEResponse(resp *http.Response) bool {
	return strings.Contains(
		strings.ToLower(resp.Header.Get("Content-Type")),
		"text/event-stream",
	)
}

// copyStreamWithFlush 逐块转发 SSE 响应体：每读一块立即写 + Flush 并刷新 lastWrite——
// io.Copy 不 Flush 会把帧憋到转发结束才发出，前端逐 token 渲染失效
func copyStreamWithFlush(w io.Writer, r io.Reader, flusher http.Flusher, lastWrite *atomic.Int64) error {
	buf := make([]byte, 8*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return werr
			}
			flusher.Flush()
			lastWrite.Store(time.Now().UnixNano())
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// copyHeaders 复制 HTTP Header，排除 hop-by-hop 头
func copyHeaders(dst, src http.Header) {
	hopByHop := map[string]bool{
		"Connection":          true,
		"Keep-Alive":          true,
		"Proxy-Authenticate":  true,
		"Proxy-Authorization": true,
		"TE":                  true,
		"Trailers":            true,
		"Transfer-Encoding":   true,
		"Upgrade":             true,
	}

	for key, values := range src {
		if hopByHop[key] {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

// CleanupInstance 清理指定实例的代理资源（clientPool、并发信号量、WS 连接计数）。
// 实例删除后调用：残留的 client 若不 CloseIdleConnections，空闲连接最长滞留
// IdleConnTimeout（90s）；三个 sync.Map 条目否则按「历史创建过的实例数」缓增
func CleanupInstance(instanceId string) {
	if v, ok := clientPool.LoadAndDelete(instanceId); ok {
		if c, ok := v.(*http.Client); ok {
			c.CloseIdleConnections()
		}
	}
	concurrencyMaps.Delete(instanceId)
	wsConnCount.Delete(instanceId)
}

// ResetInstanceClients 清空全部实例连接池：实例间 TLS 校验策略切换后，
// 存量池化客户端仍持旧 TLS 配置，清空使下次请求按新策略重建
// （IdleConnections 随之关闭，业务连接不受影响）
func ResetInstanceClients() {
	clientPool.Range(func(key, value any) bool {
		clientPool.Delete(key)
		return true
	})
}
