package pluginsdk

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"sync"
)

// Host 宿主侧插件连接：一个子进程插件对应一个 Host。
// 典型用法（Phase D 插件运行时装配层）：
//
//	cmd := exec.Command(manifest.Backend.Entry)
//	h, _ := Spawn(cmd)
//	mf, err := h.Initialize() // 握手 + apiVersion 协商，失败即拒绝装载
//	h.Call("greet", params, &result)
//	h.Close()
type Host struct {
	stdin  io.WriteCloser
	stdout *bufio.Reader
	wait   func() error

	mu      sync.Mutex // 保护 nextID / pending
	nextID  int64
	pending map[string]chan Response
	notify  func(Notification)

	wmu   sync.Mutex // 串行化对 stdin 的写（并发 Call 不交错帧）
	closed chan struct{}
}

// Spawn 启动插件子进程并接管其 stdio（stderr 直通宿主日志面）。
// 调用方负责命令构造（argv 列表传参，无 shell）与工作目录设置
func Spawn(cmd *exec.Cmd) (*Host, error) {
	return SpawnWithStderr(cmd, nil)
}

// SpawnWithStderr 同 Spawn，另接 stderr 落点（nil = 丢弃）
func SpawnWithStderr(cmd *exec.Cmd, stderr io.Writer) (*Host, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return newHost(stdin, stdout, cmd.Wait), nil
}

// newHost 组装宿主连接（wait 为子进程回收动作；内存管道测试传 nil 动作）
func newHost(stdin io.WriteCloser, stdout io.Reader, wait func() error) *Host {
	h := &Host{
		stdin:   stdin,
		stdout:  bufio.NewReader(stdout),
		pending: make(map[string]chan Response),
		closed:  make(chan struct{}),
		wait:    wait,
	}
	go h.readLoop()
	return h
}

// OnNotification 注册插件 → 宿主单向事件处理器（必须在 Initialize 前调用）
func (h *Host) OnNotification(fn func(Notification)) { h.notify = fn }

// Initialize 握手：请求插件的 initialize，校验 apiVersion 兼容性。
// major 不一致即返回错误（Phase D 装配层据此拒绝装载该插件）
func (h *Host) Initialize() (PluginManifest, error) {
	var mf PluginManifest
	if err := h.Call(MethodInitialize, nil, &mf); err != nil {
		return mf, fmt.Errorf("pluginsdk: initialize: %w", err)
	}
	if mf.Name == "" {
		return mf, fmt.Errorf("pluginsdk: plugin manifest missing name")
	}
	if !APICompatible(mf.APIVersion, ProtocolVersion) {
		return mf, fmt.Errorf("pluginsdk: plugin %q apiVersion %q incompatible with host %q",
			mf.Name, mf.APIVersion, ProtocolVersion)
	}
	return mf, nil
}

// Call 同步请求-应答。pending 必须先于请求发出注册：stdio 写是同步消费的，
// 插件应答可能在 write 返回前就抵达 readLoop——先发后注册会丢应答
//（spike 调试实证的竞态）
func (h *Host) Call(method string, params, result any) error {
	req := Request{JSONRPC: jsonrpcVersion, Method: method}
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		req.Params = b
	}

	h.mu.Lock()
	h.nextID++
	req.ID = json.RawMessage(strconv.FormatInt(h.nextID, 10))
	ch := make(chan Response, 1)
	h.pending[string(req.ID)] = ch
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, string(req.ID))
		h.mu.Unlock()
	}()

	if err := h.write(req); err != nil {
		return err
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return resp.Error
		}
		if result != nil && len(resp.Result) > 0 {
			return json.Unmarshal(resp.Result, result)
		}
		return nil
	case <-h.closed:
		return fmt.Errorf("pluginsdk: plugin closed during call %q", method)
	}
}

// Notify 宿主 → 插件单向通知（JSON-RPC 语义：无 ID、无应答）
func (h *Host) Notify(method string, params any) error {
	req := Request{JSONRPC: jsonrpcVersion, Method: method}
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		req.Params = b
	}
	return h.write(req)
}

// write 编码单条消息写入插件 stdin（加锁防并发 Call 帧交错）
func (h *Host) write(req Request) error {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	return json.NewEncoder(h.stdin).Encode(req)
}

// Close 关闭 stdin（插件侧读到 EOF 优雅退出）并回收子进程
func (h *Host) Close() error {
	_ = h.stdin.Close()
	select {
	case <-h.closed:
	default:
		close(h.closed)
	}
	if h.wait != nil {
		return h.wait()
	}
	return nil
}

// readLoop 读插件输出并分发：应答按 ID 投递给等待中的 Call，其余按 Notification 处理
func (h *Host) readLoop() {
	dec := json.NewDecoder(h.stdout)
	for {
		var msg struct {
			*Response
			*Notification
		}
		if err := dec.Decode(&msg); err != nil {
			_ = h.Close()
			return
		}
		switch {
		case msg.Response != nil && len(msg.Response.ID) > 0:
			h.mu.Lock()
			ch, ok := h.pending[string(msg.Response.ID)]
			h.mu.Unlock()
			if ok {
				ch <- *msg.Response
			}
		case msg.Notification != nil:
			if h.notify != nil {
				h.notify(*msg.Notification)
			}
		}
	}
}
