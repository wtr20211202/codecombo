package remote

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	"codecombo/server/remoteterminal"
	"codecombo/server/sshclient"
	"codecombo/server/store"
	"codecombo/server/terminal"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

// remoteResIDRe 远程终端相关资源 ID 白名单
// hostID（sc_rh_ 前缀）与 sessionId（32 hex）均落在该字符集内；
// 拒绝路径穿越 / 盘符 / scheme 分隔符等危险形态
var remoteResIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// 远程终端尺寸约束（创建与 resize 共用）
const (
	defaultRemoteRows = 24
	defaultRemoteCols = 80
	maxRemoteRows     = 512
	maxRemoteCols     = 1024
)

// normalizeRemoteSize 尺寸归一化：0 取默认值，超上限防御性钳制
func normalizeRemoteSize(rows, cols uint16) (uint16, uint16) {
	if rows == 0 {
		rows = defaultRemoteRows
	}
	if cols == 0 {
		cols = defaultRemoteCols
	}
	if rows > maxRemoteRows {
		rows = maxRemoteRows
	}
	if cols > maxRemoteCols {
		cols = maxRemoteCols
	}
	return rows, cols
}

// ============== 远程 tmux 持久化 ==============

// sessionTmuxNames sessionID → tmux 会话名（tmux 开启时用于：响应回显 + 关 tab 时 kill 远端会话）。
// 服务重启后丢失属可接受：重启本身意味着所有服务端会话已 GC，条目自然失效
var sessionTmuxNames sync.Map

// tmuxNameRe 与 remoteResIDRe 同字符集：保证名字可安全内嵌 shell 命令（无引号/分号/分隔符）
var tmuxNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// resolveTmuxName 依据设置与请求解析本次创建使用的 tmux 会话名。
// 开关关闭 → 返回空串（原生 shell）；请求携带名字（重开场景）且合法 → 原样复用（重连既有 tmux）；
// 否则按主机生成稳定前缀 + 随机后缀的唯一名
func resolveTmuxName(hostID, requested string) (string, error) {
	if !store.Get().Settings.Get().Server.TerminalRemoteTmuxOrDefault() {
		return "", nil
	}
	if requested != "" {
		if !tmuxNameRe.MatchString(requested) {
			return "", fmt.Errorf("invalid tmuxName")
		}
		return requested, nil
	}
	suffix, err := remotePasteRandHex()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(hostID))
	return fmt.Sprintf("sc_rtm_%s-%s", hex.EncodeToString(sum[:])[:8], suffix[:6]), nil
}

// ============== 远程 tmux 版本地板探测（P-20261109-7 A2） ==============

// tmuxFloorProbeTimeout 单次远端 tmux -V 探测上限。探测是教育性提示的数据源，
// 失败/超时一律静默降级（不阻塞会话创建、横幅缺省），上限收紧到 5s 防挂起
// 主机拖慢创建链
const tmuxFloorProbeTimeout = 5 * time.Second

// tmuxFloorProbeCmd 探测命令：tmux 缺席时整条失败（exit 非 0、stdout 空），
// 解析端按空串静默处理。无状态查询，幂等可重复
const tmuxFloorProbeCmd = "command -v tmux >/dev/null 2>&1 && tmux -V"

// probeHostTmuxFloor 在远端主机执行 tmux -V 并按版本地板归类。
// 返回 (原始版本串如 "tmux 3.2a", 地板分类 ok/drag-copy/passthrough)；主机不可达/
// tmux 缺席/超时返回 ("", "")——调用方静默降级（不提示），绝不作为错误上抛
func probeHostTmuxFloor(hostID string) (string, string) {
	rh, err := store.Get().RemoteHost.Get(hostID)
	if err != nil {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), tmuxFloorProbeTimeout)
	defer cancel()
	var out *sshclient.ExecOutput
	err = conns.WithLease(hostID, dialOptions(rh), func(client *sshclient.Client) error {
		var e error
		out, e = client.Exec(ctx, sshclient.ExecOptions{Cmd: tmuxFloorProbeCmd}, nil)
		return e
	})
	if err != nil || out == nil || out.ExitCode != 0 || len(out.Stdout) == 0 {
		return "", ""
	}
	version := strings.TrimSpace(strings.Join(out.Stdout, " "))
	floor := terminal.TmuxClipboardFloorKind(version)
	return version, floor
}

// ============== 生产 Dialer ==============

// buildTmuxWrapper 远端 tmux 模式的启动命令链（纯函数，单测断言步骤序与关键步骤）。
// 附带解绑远端 tmux 自带右键菜单（MouseDown3*）：否则右键按下被 tmux 接管、它
// 画出自带英文菜单，与本系统右键菜单双层同现。
// 附带 set-option -s set-clipboard on（P-20261109-7）：远端 tmux 是用户自有默认
// socket server，托管 conf 不到远端——不显式置 on 时 <3.2 默认 off = 拖选
// copy-pipe 源头即不发 OSC 52（拖选复制死源主因）。影响面比 unbind 更重：该
// server 上全部会话（含用户自建）的 copy-pipe/OSC 52 行为被对齐到「写入系统
// 剪贴板」——语义是功能对齐而非限制，评审裁量取 on；幂等可重复执行。
// 2>/dev/null + `;`：旧 tmux（<3.2 无此键）报 unknown option 静默跳过不阻断
// 后续步骤。步骤必须分开执行：`new -A -d` 先确保 server+session 存在（已存在
// 则 no-op），set-option/unbind-key 是 server 级选项/键表操作（幂等），最后才
// attach 进会话——不带 -d 的 new 会阻塞命令链，排在后面的命令永远执行不到。
// command -v 守卫：远端缺 tmux 时整链短路回退原生 shell
func buildTmuxWrapper(tmuxName string) string {
	return fmt.Sprintf(
		`command -v tmux >/dev/null 2>&1 && { tmux new -A -d -s %s 2>/dev/null; tmux set-option -s set-clipboard on 2>/dev/null; tmux unbind-key -n MouseDown3Pane 2>/dev/null; tmux unbind-key -n MouseDown3Status 2>/dev/null; tmux unbind-key -n MouseDown3StatusLeft 2>/dev/null; tmux unbind-key -n MouseDown3StatusRight 2>/dev/null; exec tmux attach -t %s; }; exec "${SHELL:-/bin/sh}"`,
		tmuxName, tmuxName)
}

// sshDialer 生产 Dialer：解析凭据并建立远程主机的 SSH PTY 连接
type sshDialer struct{}

// NewRemoteTerminalDialer 返回生产 Dialer（main.go 装配期注入 remoteterminal.Manager）
func NewRemoteTerminalDialer() remoteterminal.Dialer { return sshDialer{} }

func (sshDialer) DialPTY(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error) {
	rh, err := store.Get().RemoteHost.Get(spec.HostID)
	if err != nil {
		return nil, fmt.Errorf("remote host not found: %w", err)
	}
	if rh.IsFTP() {
		return nil, fmt.Errorf("FTP host does not support SSH terminal (files only)")
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
	conn, err := newSSHPTYConn(client, spec.Rows, spec.Cols, spec.TmuxName)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	return conn, nil
}

// sshPTYConn 包装 SSH 会话为 remoteterminal.PTYConn
// 请求 xterm-256color PTY + Shell：PTY 模式下远端 stderr 并入 stdout（fd 2 指向 pty slave），
// 因此仅读 StdoutPipe 即可拿到完整输出
type sshPTYConn struct {
	client  *sshclient.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
}

func newSSHPTYConn(client *sshclient.Client, rows, cols uint16, tmuxName string) (*sshPTYConn, error) {
	rows, cols = normalizeRemoteSize(rows, cols)
	sess, err := client.UnderlyingClient().NewSession()
	if err != nil {
		return nil, fmt.Errorf("new ssh session: %w", err)
	}
	// 管道必须在 Shell 启动前建立
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", int(rows), int(cols), modes); err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}
	// tmux 模式：attach-or-create，远端缺 tmux 时回退原生 shell——
	// 整条命令经 sh -c 执行，tmuxName 字符集已校验（[A-Za-z0-9_-]）可安全内嵌
	//（wrapper 构造与步骤序说明见 buildTmuxWrapper）
	if tmuxName != "" {
		wrapper := buildTmuxWrapper(tmuxName)
		if err := sess.Start(wrapper); err != nil {
			_ = sess.Close()
			return nil, fmt.Errorf("start tmux shell: %w", err)
		}
		return &sshPTYConn{client: client, session: sess, stdin: stdin, stdout: stdout}, nil
	}
	if err := sess.Shell(); err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}
	return &sshPTYConn{client: client, session: sess, stdin: stdin, stdout: stdout}, nil
}

func (p *sshPTYConn) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *sshPTYConn) Write(b []byte) (int, error) { return p.stdin.Write(b) }
func (p *sshPTYConn) Resize(rows, cols uint16) error {
	return p.session.WindowChange(int(rows), int(cols))
}
func (p *sshPTYConn) Close() error {
	err := p.session.Close()
	if cerr := p.client.Close(); err == nil {
		err = cerr
	}
	return err
}

// SetReadDeadline SSH channel 无 deadline 能力，no-op；
// Kill 靠 Close 兜底唤醒阻塞在 Read 上的 readLoop（PTYConn 接口已声明此语义）
func (p *sshPTYConn) SetReadDeadline(time.Time) error { return nil }

// ============== REST 端点 ==============

// CreateRemoteTerminal 创建远程终端会话（SSH 拨号，1-5s）
func CreateRemoteTerminal(c *gin.Context) {
	hostID := c.Param("id")
	if !remoteResIDRe.MatchString(hostID) {
		shared.Error(c, http.StatusNotFound, "remote host not found", nil)
		return
	}
	if _, err := store.Get().RemoteHost.Get(hostID); err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	// FTP 主机守卫：无 SSH 通道，明确报错而非让用户面对莫名的 SSH 拨号失败
	if rh, gerr := store.Get().RemoteHost.Get(hostID); gerr == nil && rh.IsFTP() {
		shared.Error(c, http.StatusBadRequest, "FTP host does not support SSH terminal (files only)", nil)
		return
	}
	var req struct {
		Rows     uint16 `json:"rows"`
		Cols     uint16 `json:"cols"`
		TmuxName string `json:"tmuxName"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "remote terminal create failed", err)
		return
	}
	rows, cols := normalizeRemoteSize(req.Rows, req.Cols)

	// 远程 tmux 持久化：开关关闭返回空名（原生 shell），重开场景复用请求携带的既有名
	tmuxName, err := resolveTmuxName(hostID, req.TmuxName)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "remote terminal create failed", err)
		return
	}

	m := remoteterminal.GetManager()
	if m == nil {
		shared.Error(c, http.StatusInternalServerError, "remote terminal manager not initialized", nil)
		return
	}
	// tmux 版本地板探测（P-20261109-7 A2）：tmux 模式才探（原生 shell 无 tmux 链
	// 可言）。与 PTY 拨号并行起跑（各自独立 SSH 连接），创建完成后限时收割——
	// 探测先到零额外延迟，慢于 4s 不等（静默降级，横幅缺省），绝不阻塞/失败创建
	var floorCh chan [2]string
	if tmuxName != "" {
		floorCh = make(chan [2]string, 1)
		go func() {
			v, f := probeHostTmuxFloor(hostID)
			floorCh <- [2]string{v, f}
		}()
	}
	s, err := m.CreateSession(hostID, rows, cols, tmuxName)
	if err != nil {
		// 上限满是客户端可感知的状态（提示关 tab），拨号/凭据失败是上游故障——分开状态码
		if errors.Is(err, remoteterminal.ErrSessionLimit) {
			shared.Error(c, http.StatusConflict, "remote terminal create failed", err)
			return
		}
		respondRemoteDialError(c, "remote terminal create failed", err)
		return
	}
	if tmuxName != "" {
		sessionTmuxNames.Store(s.ID, tmuxName)
		// 任意终结路径（GC 超期回收 / SSH 断开 / 主机删除级联）都清理远端 tmux
		// 孤儿会话与注册表条目；用户主动关 tab 走 DeleteRemoteTerminal 显式
		// 清理（彼时条目已删，钩子自然 no-op）。清理是异步 SSH 拨号，go 出去
		sid, hostID := s.ID, s.HostID
		_ = s.OnExit(func() {
			if name, ok := sessionTmuxNames.LoadAndDelete(sid); ok {
				go killRemoteTmux(hostID, name.(string))
			}
		})
		// 钩子注册可能晚于终结（CreateSession 返回时 readLoop 已在跑，
		// SSH 瞬断则 Kill 先于注册完成）：补查一次防条目与远端 tmux 残留
		if s.IsClosed() {
			if name, ok := sessionTmuxNames.LoadAndDelete(sid); ok {
				go killRemoteTmux(hostID, name.(string))
			}
		}
	}
	// 会话建立 = SSH 认证通过：主机状态点升级为绿（已连通）
	MarkAuthOK(hostID)
	// 收割并行探测（4s 上限）：先到零延迟、慢到不等——教育性提示不值得拖住
	// 会话创建（「探测失败静默降级不阻塞」）。收割的值只进本响应（tab 持有，
	// 宿主不落盘）；响应缺字段 = 前端无横幅（诚实降级）
	tmuxVersion, tmuxFloor := "", ""
	if floorCh != nil {
		select {
		case r := <-floorCh:
			tmuxVersion, tmuxFloor = r[0], r[1]
		case <-time.After(4 * time.Second):
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"sessionId":   s.ID,
			"hostId":      s.HostID,
			"rows":        s.Rows,
			"cols":        s.Cols,
			"createdAt":   s.CreatedAt,
			"tmuxName":    tmuxName,
			"tmuxVersion": tmuxVersion,
			// tmuxClipboardFloor：ok / drag-copy(<3.2 拖选复制受限) / passthrough
			// (≥3.2<3.3 应用内复制透传受限)；空串 = 探测失败或 tmux 缺席（无横幅）
			"tmuxClipboardFloor": tmuxFloor,
		},
	})
}

// GetRemoteTmuxFloor GET /remotehosts/:id/terminals/tmux-floor —— 远端 tmux
// 版本地板探测（P-20261109-7 A2）。Create 响应携带探测结果，但页面刷新后
// 恢复的存量 tab 不经 Create（WS 直连重连），pane 挂载时经本端点补拉一次。
// 同步探测（连接池借出，通常一 RTT），失败/超时静默返回空字段（前端不显示
// 横幅），200 恒成功——探测是教育性提示数据源，不值得错误码
func GetRemoteTmuxFloor(c *gin.Context) {
	hostID := c.Param("id")
	if !remoteResIDRe.MatchString(hostID) {
		shared.Error(c, http.StatusNotFound, "remote host not found", nil)
		return
	}
	version, floor := probeHostTmuxFloor(hostID)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"tmuxVersion":        version,
		"tmuxClipboardFloor": floor,
	}})
}

// ListRemoteTerminals 列出某远程主机的终端会话
// 注意：CreateSession 持管理器锁拨号（1-5s），并发创建期间此处会短暂阻塞——低频创建可接受
func ListRemoteTerminals(c *gin.Context) {
	hostID := c.Param("id")
	if !remoteResIDRe.MatchString(hostID) {
		shared.Error(c, http.StatusNotFound, "remote host not found", nil)
		return
	}
	m := remoteterminal.GetManager()
	if m == nil {
		shared.Error(c, http.StatusInternalServerError, "remote terminal manager not initialized", nil)
		return
	}
	all := m.ListSessions()
	result := make([]gin.H, 0, len(all))
	for _, s := range all {
		if s.HostID != hostID {
			continue
		}
		result = append(result, gin.H{
			"id":        s.ID,
			"hostId":    s.HostID,
			"rows":      s.Rows,
			"cols":      s.Cols,
			"createdAt": s.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": result})
}

// ListAllRemoteTerminals GET /api/remotehosts/terminals —— 跨主机聚合列出全部
// 远程终端会话（P-20261005-11）：广播多选 popover「远程主机」分组与 agent 舰队
// 巡检「列远程会话→广播→回读 scrollback」链的取数原语——一次请求替代逐主机
// N 次查询（会话上限 20，主机名经一次 List 建 map 解析，无 N+1）。
// host 为别名（未命名/记录已删回落 hostId）。静态段与 /:id 同级先例（/status）
func ListAllRemoteTerminals(c *gin.Context) {
	m := remoteterminal.GetManager()
	if m == nil {
		shared.Error(c, http.StatusInternalServerError, "remote terminal manager not initialized", nil)
		return
	}
	hostNames := map[string]string{}
	if st := store.Get(); st != nil {
		if hosts, err := st.RemoteHost.List(); err == nil {
			for _, h := range hosts {
				if h.Name != "" {
					hostNames[h.ID] = h.Name
				}
			}
		}
	}
	all := m.ListSessions()
	result := make([]gin.H, 0, len(all))
	for _, s := range all {
		host := s.HostID
		if name, ok := hostNames[s.HostID]; ok {
			host = name
		}
		result = append(result, gin.H{
			"id":        s.ID,
			"hostId":    s.HostID,
			"host":      host,
			"createdAt": s.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": result})
}

// getRemoteTerminalSession 校验 :id/:sid 并定位会话（不属于该主机的会话一律 404）
func getRemoteTerminalSession(c *gin.Context) *remoteterminal.Session {
	hostID := c.Param("id")
	sid := c.Param("sid")
	if !remoteResIDRe.MatchString(hostID) || !remoteResIDRe.MatchString(sid) {
		return nil
	}
	m := remoteterminal.GetManager()
	if m == nil {
		return nil
	}
	s := m.GetSession(sid)
	if s == nil || s.HostID != hostID {
		return nil
	}
	return s
}

// DeleteRemoteTerminal 关闭远程终端会话（用户主动关闭 tab / DELETE API）
func DeleteRemoteTerminal(c *gin.Context) {
	s := getRemoteTerminalSession(c)
	if s == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	// tmux 模式：主动关 tab = 结束远端 tmux 会话（与本地 tmux 后端 Kill=kill-session 语义一致），
	// 防止远端残留孤儿会话；异步执行避免 SSH 拨号阻塞响应。
	// LoadAndDelete 原子取出：与 OnExit 钩子的清理路径互斥，避免双触发重复拨号
	if name, ok := sessionTmuxNames.LoadAndDelete(s.ID); ok {
		hostID := s.HostID
		go killRemoteTmux(hostID, name.(string))
	}
	remoteterminal.GetManager().KillSession(s.ID)
	c.JSON(http.StatusOK, gin.H{"message": "remote terminal closed"})
}

// killRemoteTmux 远端清理 tmux 会话（best-effort：主机不可达/无 tmux 时静默失败）
func killRemoteTmux(hostID, tmuxName string) {
	defer func() { _ = recover() }()
	rh, err := store.Get().RemoteHost.Get(hostID)
	if err != nil {
		return
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		return
	}
	client, err := sshclient.Dial(sshclient.ConnectOptions{
		Host: rh.Host, Port: rh.Port, User: rh.User,
		Auth:            sshclient.AuthMethodFor(rh.AuthType, rh.Password, rh.PemContent),
		SkipHostKeyTOFU: rh.HostKeyVerifyDisabled,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		return
	}
	defer func() { _ = client.Close() }()
	sess, err := client.UnderlyingClient().NewSession()
	if err != nil {
		return
	}
	defer func() { _ = sess.Close() }()
	// tmuxName 字符集已校验（[A-Za-z0-9_-]），可安全内嵌
	_ = sess.Run(fmt.Sprintf("tmux kill-session -t %s 2>/dev/null", tmuxName))
}

// ResizeRemoteTerminal 调整远程终端尺寸（走 WindowChange，不经 stdin）
func ResizeRemoteTerminal(c *gin.Context) {
	var req struct {
		Rows uint16 `json:"rows"`
		Cols uint16 `json:"cols"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "remote terminal resize failed", err)
		return
	}
	if req.Rows == 0 || req.Cols == 0 {
		shared.Error(c, http.StatusBadRequest, "rows and cols must be positive", nil)
		return
	}
	rows, cols := normalizeRemoteSize(req.Rows, req.Cols)
	s := getRemoteTerminalSession(c)
	if s == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	if err := s.Resize(rows, cols); err != nil {
		shared.Error(c, http.StatusInternalServerError, "remote terminal resize failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "resized"})
}

// RedrawRemoteTerminal PUT /api/remotehosts/:id/terminals/:sid/redraw
// 远程终端权威重绘：SSH 到远端对 attach 在该 tmux 会话上的客户端逐个
// refresh-client（内容 + 光标 + 备屏完整重发），与本地 tmux 后端的
// RedrawClient 同语义——远程终端 pane 重新可见/宿主 fit 后由前端回调，
// 治愈切换/最大化后的显示失步。原生 shell 会话（无 tmux 名）为 no-op；
// 失败始终 200 + ok:false（重绘是自愈增强，不作为错误打断前端自愈路径）
func RedrawRemoteTerminal(c *gin.Context) {
	sessionID := c.Param("sid")
	v, ok := sessionTmuxNames.Load(sessionID)
	if !ok {
		// 原生 shell 会话：无 tmux 重绘概念，no-op
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "noop": true}})
		return
	}
	tmuxName, _ := v.(string)
	if tmuxName == "" || !tmuxNameRe.MatchString(tmuxName) {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "noop": true}})
		return
	}
	hostID := c.Param("id")
	if err := redrawRemoteTmux(hostID, tmuxName); err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": false, "error": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// redrawRemoteTmux SSH 到远端对 attach 在该 tmux 会话上的客户端逐个 refresh-client
// （与本地 tmuxBackend.RedrawClient 同语义）。best-effort：主机不可达/凭据失效/无
// tmux 时返回错误，由调用方决定如何呈现（当前前端静默）
func redrawRemoteTmux(hostID, tmuxName string) error {
	defer func() { _ = recover() }()
	rh, err := store.Get().RemoteHost.Get(hostID)
	if err != nil {
		return err
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		return err
	}
	client, err := sshclient.Dial(sshclient.ConnectOptions{
		Host: rh.Host, Port: rh.Port, User: rh.User,
		Auth:            sshclient.AuthMethodFor(rh.AuthType, rh.Password, rh.PemContent),
		SkipHostKeyTOFU: rh.HostKeyVerifyDisabled,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	sess, err := client.UnderlyingClient().NewSession()
	if err != nil {
		return err
	}
	defer func() { _ = sess.Close() }()
	// tmuxName 字符集已校验（[A-Za-z0-9_-]），可安全内嵌；list-clients 枚举 attach
	// 在本会话的客户端（client_name 为 tty 路径），逐个 refresh，无客户端时静默完成
	cmd := fmt.Sprintf(`tmux list-clients -t %s -F '#{client_name}' 2>/dev/null | while IFS= read -r c; do [ -n "$c" ] && tmux refresh-client -t "$c" 2>/dev/null; done`, tmuxName)
	if _, err := sess.CombinedOutput(cmd); err != nil {
		return err
	}
	return nil
}

// GetRemoteScrollback 返回远程终端输出历史（格式对齐项目终端 scrollback 端点：裸 octet-stream）
func GetRemoteScrollback(c *gin.Context) {
	s := getRemoteTerminalSession(c)
	if s == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	// 断档探测原语（P-20261005-233）：与本地 scrollback 端点同语义响应头，
	// agent 巡检远程会话时同法验完整性（缓冲在本机中转落环形缓冲，时间戳即
	// 本机时钟，无跨机时钟差）
	if earliest, ok := s.EarliestTime(); ok {
		c.Header("X-Earliest-Available-At", strconv.FormatInt(earliest.UnixMilli(), 10))
	}
	c.Data(http.StatusOK, "application/octet-stream", s.ScrollbackBytes())
}

// ============== WebSocket ==============

// RemoteTerminalWS 远程终端 WebSocket：裸字节双向 relay（与 /ws/terminal 同构）
// GET /ws/remote-terminal/:id —— :id 为 sessionId（hostID 已在创建时绑定）
func RemoteTerminalWS(c *gin.Context) {
	sid := c.Param("id")
	if !remoteResIDRe.MatchString(sid) {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	m := remoteterminal.GetManager()
	if m == nil {
		shared.Error(c, http.StatusServiceUnavailable, "remote terminal not initialized", nil)
		return
	}
	s := m.GetSession(sid)
	if s == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}

	// Upgrade 前抢占唯一连接位：同一会话同一时刻仅允许一个 WS 挂载（防双标签页双写）
	if !s.TryAcquireConn() {
		// 稳定原文收口 errmarkers 注册表（P-20261004-29）
		shared.Error(c, http.StatusConflict, errmarkers.SessionBusy, nil)
		c.Abort()
		return
	}
	// 断开后进入 60s 重连窗口，窗口内重连（TryAcquireConn）会话复活，超期由 Manager GC 回收
	defer s.ReleaseConn()

	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		return
	}
	// 输入帧上限防线（P-20261003-313）：超限帧对端收到 1009，读侧得 ErrReadLimit
	rawConn.SetReadLimit(shared.WSReadLimitInput)
	// 并发写串行化（与 /ws/terminal 同款修复）：ping 心跳与输出转发分属两个
	// goroutine，裸 conn 并发写会触发 gorilla panic 且 gin Recovery 捕获不到
	conn := wssafe.New(rawConn)
	defer conn.Close()

	// 与 /ws/terminal 同语义：故意不注册 lock closer——锁定/解锁仅是 UI 状态，
	// 远程长任务（编译/部署观察）不因锁屏被打断；
	// 安全侧靠 HTTP LockMiddleware 保证：锁定时新 API 请求仍被 423 拒绝

	const readDeadline = 60 * time.Second
	_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
	rawConn.SetPongHandler(func(string) error {
		_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	// 定期发送 ping（wssafe 内部串行化 + 写超时兜底）
	defer conn.StartPing()()

	// 断档元信息（P-20261005-233）：与 /ws/terminal 同语义——重放字节之前先发
	// G 帧（OSC 133;G，现存缓冲最早行时间 + 本机当前时刻），前端判得淘汰缺口
	// 即在重放内容之前插入标记行（缺口处=重放起点）
	if earliest, ok := s.EarliestTime(); ok {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		gapFrame := fmt.Sprintf("\x1b]133;G;%d;%d\x07", earliest.UnixMilli(), time.Now().UnixMilli())
		if err := conn.WriteMessage(websocket.BinaryMessage, []byte(gapFrame)); err != nil {
			return
		}
	}

	// 重连窗口内重放 scrollback 历史（maxLines=0 返回全部缓冲，前端 xterm.scrollback 接管显示截断）
	if data := s.ScrollbackBytes(); len(data) > 0 {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			return
		}
	}

	// 注册输出回调（OnOutput 返回 unregister，WS 断开时必须调用以避免回调泄漏）
	// 同步阻塞写 channel：WS 慢时 handler 阻塞 → readLoop 阻塞 → SSH channel 缓冲满
	// → 远端 shell stdout 自然反压，避免大流量下丢字节导致 xterm 显示错乱
	outputChan := make(chan []byte, 256)
	// streamDone：主循环退出即 close，解除 handler 的反背压等待——
	// hijack 后 ctx 永不触发 Done，若客户端断开时远端持续输出且 outputChan 满，
	// handler 会永久阻塞在发送上 → readLoop 卡在 handler 调用 → Kill 的 Close
	// 也无法唤醒（readLoop 不在 Read 上）→ goroutine 泄漏，故必须有本地退出信号
	streamDone := make(chan struct{})
	defer close(streamDone)
	handler := func(data []byte) {
		select {
		case outputChan <- data:
		case <-streamDone:
			// 主循环已退出：丢弃本块数据立即返回，让 readLoop 恢复（后续 Kill 生效）
		}
	}
	unregister := s.OnOutput(handler)
	defer unregister()

	// 读取 WebSocket 输入 -> 远端 PTY
	// clientGone：读 goroutine 退出（客户端断开/读错）即 close，唤醒主循环 return——
	// WS hijack 后 request ctx 不再随连接关闭触发 Done，若仅靠 outputChan 驱动，
	// 远端无输出时主循环永久阻塞 → connHeld 永久占用（重连 409 + GC 不启动 + 泄漏）
	clientGone := make(chan struct{})
	go func() {
		defer close(clientGone)
		for {
			_, msg, err := rawConn.ReadMessage()
			if err != nil {
				shared.WarnIfReadLimitExceeded(err, "remote-terminal")
				return
			}
			if err := s.WriteInput(msg); err != nil {
				return
			}
		}
	}()

	// 远端 PTY 输出 -> WebSocket
	// 合帧（P-20261004-26）：与 /ws/terminal 同款写侧聚合——远程访问逐块成帧
	// 还叠加 TCP 帧头（每帧一个 WS 帧头 + 一次 TCP 写），收益比本地更直接；
	// 反压语义不变（chan 满 → handler 阻塞 → readLoop 阻塞 → SSH channel 缓冲）
	agg := shared.NewWSOutputAggregator()
	for {
		select {
		case data := <-outputChan:
			frame, ok := agg.Collect(data, outputChan, clientGone)
			if !ok {
				// 窗口期内客户端断开：与 clientGone 分支同语义退出
				return
			}
			// 每次写都显式刷新 write deadline（deadline 是连接级持久状态）
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
		case <-clientGone:
			// 客户端已断开：释放连接位（defer ReleaseConn），进入 60s 重连窗口
			return
		}
	}
}

// ============== 粘贴上传（SFTP 上传远程 /tmp） ==============

const (
	// remotePasteMaxBytes image 形态（截图 blob）大小上限（截图通常 < 2MB，留余量）
	remotePasteMaxBytes = 10 << 20
	// remotePasteFileMaxBytes file 形态（P-20261024-2 通用文件粘贴）大小上限，
	// 与本地端点 pasteFileMaxBytes 同口径
	remotePasteFileMaxBytes = 20 << 20
	// remotePasteDir 远程落盘目录
	remotePasteDir = "/tmp"
)

// remotePasteImageExt Content-Type → 扩展名精确白名单
// 不用 contains：畸形类型（如 "image/png; x=..."）必须拒绝而非误判（前端 blob.type 是精确值）
func remotePasteImageExt(contentType string) (string, bool) {
	switch contentType {
	case "image/png":
		return ".png", true
	case "image/jpeg":
		return ".jpg", true
	case "image/gif":
		return ".gif", true
	case "image/webp":
		return ".webp", true
	}
	return "", false
}

// remotePasteFileExt file 形态扩展名白名单（P-20261024-2）：与本地端点
// server/api/terminal/terminal_paste_image.go pasteFileAllowedExts 及前端
// web/src/utils/pasteFiles.ts PASTE_FILE_ALLOWED_EXTS 三处对账。本地包内 map
// 不跨包导出（remote 与 terminal 两域无依赖关系），重复一份与 remotePasteImageExt
// 既有重复同理由：两域独立演进、各自测试守门
var remotePasteFileExt = map[string]bool{
	// 图片（OS 里复制的图片文件走 file 形态；截图 blob 才走 image 形态）
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".svg": true,
	// 纯文本 / 结构化文本
	".txt": true, ".md": true, ".markdown": true, ".log": true, ".csv": true, ".tsv": true,
	".json": true, ".jsonl": true, ".xml": true, ".yml": true, ".yaml": true, ".toml": true,
	".ini": true, ".cfg": true, ".conf": true, ".sql": true, ".html": true, ".htm": true, ".css": true,
	// 常见源码
	".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true, ".jsx": true,
	".py": true, ".go": true, ".rs": true, ".java": true, ".kt": true, ".swift": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cc": true,
	".sh": true, ".bash": true, ".zsh": true, ".bat": true, ".cmd": true, ".ps1": true,
	".rb": true, ".php": true, ".lua": true, ".pl": true, ".r": true,
	".dart": true, ".vue": true, ".svelte": true,
	// office / 文档
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true,
	".ppt": true, ".pptx": true, ".odt": true, ".ods": true, ".odp": true, ".rtf": true, ".epub": true,
	// 压缩包
	".zip": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true, ".7z": true, ".rar": true,
}

// validateRemotePaste 校验 image 形态上传大小 + Content-Type，返回扩展名
func validateRemotePaste(header *multipart.FileHeader) (string, error) {
	if header.Size > remotePasteMaxBytes {
		return "", fmt.Errorf("image too large: %d bytes (max %d)", header.Size, remotePasteMaxBytes)
	}
	ct := header.Header.Get("Content-Type")
	ext, ok := remotePasteImageExt(ct)
	if !ok {
		return "", fmt.Errorf("unsupported content type: %q", ct)
	}
	return ext, nil
}

// validateRemotePasteFile 校验 file 形态（P-20261024-2）上传大小 + 扩展名白名单。
// 扩展名取自原始文件名（File.name 只有 basename，无目录成分）：paste 事件 File 的
// MIME 常为空或通用 octet-stream，与本地端点同口径按扩展名判定
func validateRemotePasteFile(header *multipart.FileHeader) (string, error) {
	if header.Size > remotePasteFileMaxBytes {
		return "", fmt.Errorf("file too large: %d bytes (max %d)", header.Size, remotePasteFileMaxBytes)
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !remotePasteFileExt[ext] {
		return "", fmt.Errorf("unsupported paste file type: %q", ext)
	}
	return ext, nil
}

// remotePasteRandHex 8 字节 crypto/rand hex 后缀（16 字符）
func remotePasteRandHex() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random suffix: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// remotePasteName 远程文件名：sc-paste-<unixms>-<8字节hex随机后缀><ext>
// 随机后缀防多用户主机的 /tmp symlink 抢占（不可预测路径不可提前埋链）
func remotePasteName(ms int64, randHex, ext string) string {
	return fmt.Sprintf("sc-paste-%d-%s%s", ms, randHex, ext)
}

// UploadRemotePasteImage 接收前端粘贴链捕获的上传载荷，经 SFTP 上传到远程主机 /tmp，
// 返回远程绝对路径。前端把该路径作为 text paste 到远程终端，让 claude code 等 CLI 读取。
//
// 两种形态按 multipart 字段分派（P-20261024-2 通用化，同端点增量扩展，与本地
// 端点 UploadPasteImage 同构）："image" = 截图 blob（Content-Type 白名单，10MB），
// "file" = OS 复制的白名单文件（扩展名白名单，20MB）。旧前端只发 image，兼容不破坏。
//
// 安全约束：独立 Dial 专用连接（不与终端会话复用 Client，避免其 SFTP
// 子通道与会话流量互相干扰）；文件名带随机后缀；两形态各自精确白名单
func UploadRemotePasteImage(c *gin.Context) {
	hostID := c.Param("id")
	if !remoteResIDRe.MatchString(hostID) {
		shared.Error(c, http.StatusNotFound, "remote host not found", nil)
		return
	}
	rh, err := store.Get().RemoteHost.Get(hostID)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	if rh.IsFTP() {
		shared.Error(c, http.StatusBadRequest, "FTP host does not support paste upload (SFTP only)", nil)
		return
	}
	// 优先 file 形态（P-20261024-2）；缺省回落既有 image 形态（旧前端兼容）。
	// ErrMissingFile 才回落：file 字段在但解析失败必须如实回告（同本地端点口径）
	file, header, err := c.Request.FormFile("file")
	isFileForm := err == nil
	errMsg := "remote paste file failed"
	if err != nil {
		if !errors.Is(err, http.ErrMissingFile) {
			shared.Error(c, http.StatusBadRequest, errMsg, err)
			return
		}
		file, header, err = c.Request.FormFile("image")
		errMsg = "remote paste image failed"
		if err != nil {
			shared.Error(c, http.StatusBadRequest, errMsg, err)
			return
		}
	}
	defer file.Close()

	var ext string
	if isFileForm {
		ext, err = validateRemotePasteFile(header)
	} else {
		ext, err = validateRemotePaste(header)
	}
	if err != nil {
		shared.Error(c, http.StatusBadRequest, errMsg, err)
		return
	}
	// header.Size 已过上限校验，ReadAll 有界
	data, err := io.ReadAll(file)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, errMsg, err)
		return
	}

	suffix, err := remotePasteRandHex()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, errMsg, err)
		return
	}
	remotePath := remotePasteDir + "/" + remotePasteName(time.Now().UnixMilli(), suffix, ext)

	if err := ResolveRemoteHostAuth(rh); err != nil {
		respondRemoteDialError(c, errMsg, err)
		return
	}
	client, err := sshclient.Dial(sshclient.ConnectOptions{
		Host: rh.Host, Port: rh.Port, User: rh.User,
		Auth:            sshclient.AuthMethodFor(rh.AuthType, rh.Password, rh.PemContent),
		SkipHostKeyTOFU: rh.HostKeyVerifyDisabled,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		respondRemoteDialError(c, errMsg, err)
		return
	}
	defer client.Close()

	if err := client.UploadBytes(data, sshclient.UploadOptions{RemotePath: remotePath, Mode: 0644}); err != nil {
		shared.Error(c, http.StatusBadGateway, errMsg, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"path": remotePath,
			"size": len(data),
		},
	})
}
