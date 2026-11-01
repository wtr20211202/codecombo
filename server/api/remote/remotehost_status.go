package remote

import (
	"context"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 主机在线状态探测（B3） ==============

// hostStatus 单台主机的最近探测结果
type hostStatus struct {
	State     string `json:"state"` // online / offline / unknown
	LastCheck int64  `json:"lastCheck,omitempty"`
	LatencyMs int64  `json:"latencyMs,omitempty"`
	// AuthOK 最近一次真实认证（测试连接/开终端/文件浏览）是否通过。
	// TCP 探测不验证身份，故绿点语义 = online && AuthOK；仅 TCP 可达为
	// 黄色（authOk=false）。粘性保持：TCP 探测不改变该位，直到主机被
	// 编辑（凭据可能已变，invalidateHostStatus 清除）或删除
	AuthOK bool `json:"authOk"`
}

const (
	// statusProbeInterval 探测周期；statusProbeTimeout 单次 TCP connect 上限
	statusProbeInterval = 30 * time.Second
	statusProbeTimeout  = 3 * time.Second
	// statusProbeConcurrency 全局并发池上限（大量离线主机时不至于瞬间打满 fd）
	statusProbeConcurrency = 4
)

var (
	statusMu       sync.RWMutex
	statusCache    = map[string]hostStatus{}
	statusProbing  atomic.Bool
	statusStarted  atomic.Bool
	statusNotifyCh = make(chan struct{}, 1) // 手动测试连接后乐观刷新（非阻塞）
)

// NotifyStatusProbe 非阻塞唤醒探测器立即跑一轮（手动测试连接后的乐观刷新）
func NotifyStatusProbe() {
	select {
	case statusNotifyCh <- struct{}{}:
	default: // 已有待处理的唤醒信号
	}
}

// statusProbeLoop 探测主循环（remotehost 模块 Start 拉起，stop 关闭退出）。
// 启动即首探，让徽章尽快可用
func statusProbeLoop(stop <-chan struct{}) {
	probeAllHosts()
	ticker := time.NewTicker(statusProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		case <-statusNotifyCh:
		}
		probeAllHosts()
	}
}

// probeAllHosts 跑一轮探测：上一轮未完成则跳过本轮（防大量 offline 主机导致探测重叠）
func probeAllHosts() {
	if !statusProbing.CompareAndSwap(false, true) {
		return
	}
	defer statusProbing.Store(false)

	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		return
	}
	sem := make(chan struct{}, statusProbeConcurrency)
	var wg sync.WaitGroup
	for _, h := range hosts {
		wg.Add(1)
		go func(id, host string, port int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			applyProbeResult(id, probeHost(host, port))
		}(h.ID, h.Host, h.Port)
	}
	wg.Wait()
}

// applyProbeResult 合并一轮 TCP 探测结果：AuthOK 粘性——TCP 探测无凭据
// 语义，不改动既有认证结论
func applyProbeResult(id string, st hostStatus) {
	statusMu.Lock()
	if prev, existed := statusCache[id]; existed {
		st.AuthOK = prev.AuthOK
	}
	statusCache[id] = st
	statusMu.Unlock()
}

// probeHost TCP connect 端口级探测，返回带时间戳的状态
func probeHost(host string, port int) hostStatus {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), statusProbeTimeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return hostStatus{State: "offline", LastCheck: time.Now().UnixMilli()}
	}
	_ = conn.Close()
	return hostStatus{State: "online", LastCheck: time.Now().UnixMilli(), LatencyMs: latency}
}

// GetRemoteHostsStatus GET /api/remotehosts/status —— 返回全部主机的最近探测结果
// 未探测过（服务刚启动、首轮未完成）的主机不出现在响应里，前端按 unknown 呈现
func GetRemoteHostsStatus(c *gin.Context) {
	statusMu.RLock()
	result := make(map[string]hostStatus, len(statusCache))
	for k, v := range statusCache {
		result[k] = v
	}
	statusMu.RUnlock()
	c.JSON(200, gin.H{"data": result})
}

// invalidateHostStatus 主机删除/更新时清缓存（随 B1 级联；下一轮探测重建。
// 更新即清除 AuthOK——凭据可能已变，黄色语义重新生效）
func invalidateHostStatus(id string) {
	statusMu.Lock()
	delete(statusCache, id)
	statusMu.Unlock()
}

// MarkAuthOK 一次真实认证成功（测试连接 / SSH 终端创建 / 文件浏览连接）
// 后调用：把该主机状态升级为"已连通（认证通过）"，粘性保持到主机被编辑。
// 不做后台周期性 SSH 认证探测——错误凭据反复敲 sshd 可能触发 fail2ban
func MarkAuthOK(id string) {
	statusMu.Lock()
	defer statusMu.Unlock()
	st := statusCache[id]
	st.State = "online"
	st.AuthOK = true
	st.LastCheck = time.Now().UnixMilli()
	statusCache[id] = st
}
