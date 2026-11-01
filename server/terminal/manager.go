package terminal

import (
	"fmt"
	"log/slog"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
	"codecombo/server/terminal/shellint"
)

// 会话形态（Session.Kind）
const (
	KindShell = "shell"
	KindAgent = "agent"
)

// 会话来源（Session.Origin，P-20261005-189）
const (
	// OriginSelf 本系统自建（new-session + 环境注入，close=彻底释放的既有语义）
	OriginSelf = "self"
	// OriginExternal 外部接管（attach 用户默认 socket 上的既有 tmux 会话，
	// close=仅解除接管；kill 需显式二次确认走 KillSession）
	OriginExternal = "external"
)

// ptyConn 终端连接接口
type ptyConn interface {
	Read(p []byte) (n int, err error)
	Write(p []byte) (n int, err error)
	Close() error
	// Wait 等待子进程退出，返回进程状态（含退出码）
	Wait() (*os.ProcessState, error)
}

// Session 终端会话
type Session struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	ProjectID string    `json:"projectId"`
	Path      string    `json:"path"`
	CreatedAt time.Time `json:"createdAt"`
	Backend   string    `json:"backend"`
	// Kind 会话形态："shell" 普通终端 / "agent" 智能体终端（tmux 名以哨兵项目
	// 哈希命名，重启恢复时据此归类，不参与项目孤儿清理）
	Kind string `json:"kind"`
	// Origin 会话来源（P-20261005-189）：self=自建（缺省值，close=彻底释放的
	// 既有语义）/ external=外部接管（close=仅解除接管，kill 需显式确认）。
	// 全量携带不加 omitempty：外部判据是前端关闭分流与 UI 文案的唯一依据，
	// 字段缺席=自建与显式 self 同义，旧前端忽略无影响
	Origin string `json:"origin"`

	spec    SessionSpec
	backend PtyBackend
	ptmx    ptyConn
	// mgr 注册所属 Manager（create/RegisterRecoveredSession 注入），
	// native shell 退出时自移除，避免死会话永驻 map 占配额与 scrollback 内存
	mgr *Manager
	// scrollback 仅 native backend 初始化（tmux 用 capture-pane）；为 nil 表示不缓存
	scrollback *ScrollbackBuffer
	// devPort dev 端口被动探测状态（P-20261002-83，portdetect.go）：输出滑窗 +
	// 同端口防抖，命中经 OnDevPortDetected 上报；创建/重启恢复两路构造点初始化
	devPort *devPortDetector
	// sentinel 输出哨兵（P-20261004-8，sentinel.go）：用户自定义正则规则的输出
	// 订阅，与 devPort 同挂点同护栏（滑窗 + 编译缓存 + 防抖），命中经
	// OnSentinelHit 上报；创建/重启恢复两路构造点初始化
	sentinel *sentinelDetector
	// osc OSC 133 运行态旁挂（P-20261004-63，oscstate.go）：C/D 帧识别 →
	// 服务端权威的会话运行态（跨设备可查，running-count 端点消费位），
	// 与 devPort/sentinel 同挂点第三旁挂；创建/重启恢复两路构造点初始化
	osc *oscStateDetector
	// cwd OSC 7 cwd 实时追踪（P-20261004-59，cwdtrack.go）：与 devPort/sentinel
	// 同挂输出 tap（无 WS 客户端也生效），最近一帧 file URL 归一化为本机路径。
	// 纯内存运行态不落盘——无帧（旧 shell/新会话尚无 prompt/重启恢复历史不可考）
	// 时 CurrentDir known=false
	cwd *cwdTracker
	// gitActivity TUI git 写活动嗅探（P-20261004-81，gitactivity.go）：commit/
	// push/switch 完成特征旁路匹配，命中经 OnGitActivity 发布定向广播——
	// TUI 内部子进程 git 不发 OSC 133，服务端嗅探是面板秒级感知的唯一链
	gitActivity *gitActivityDetector
	// lastCols/lastRows 上次成功同步给 PTY 的尺寸，用于 Resize 去重
	lastCols uint16
	lastRows uint16
	// serverReadOnly 服务端只读闸（P-20261008-17）：接管会话（origin=external）
	// 默认置 true——前端 pane 只读锁是 UI 语义，绕过前端（agent 令牌直调 WS
	// 写链）仍可写用户的 tmux 会话；本标记是同一锁语义的服务端强制面，WS 写链
	// 入口（api/terminal HandleTerminalWS）按 Origin==external && 本标记拒绝。
	// 刻意不放进 WriteInput：广播写/排队指令/运行书等批量运维面走各自端点的
	// AgentGuard 高危审批（P-189 批注③语义保留），不经本闸（api 层判拦截）。
	// atomic：WS 输入热路径每帧一次 Load，锁竞争不可接受（lastActivity 同款
	// 取向）；翻转只发生在接管时刻与解锁端点，频率可忽略
	serverReadOnly atomic.Bool
	// directInputHold 直通输入持权闸（P-20261024-1）：访客经分享直通输入档
	// 持有会话输入权期间置位——owner 侧 WS 输入被拒（「谁在输入」单持有者
	// 语义的服务端强制面，与 serverReadOnly 同一闸口同一拒绝帧形态；收回/
	// 超时/关闭分享级联即解除）。atomic 同款热路径取向
	directInputHold atomic.Bool

	mu sync.Mutex
	// onOutput / onExit 使用 map + 自增 id 注册，避免 slice index 在多次注册/注销时漂移
	// 历史实现用 %p 比对函数指针，闭包每次实例化都是新地址，导致 WS 重连后回调永不删除（内存泄漏）
	onOutput      map[int64]func(data []byte)
	onExit        map[int64]func(exitCode int)
	nextHandlerID int64
	closed        bool // 用户主动 Kill、native shell 退出或空闲分离终结（P-192）
	attachExited  bool // attach 子进程已退出（tmux 模式下底层 session 仍存活）
	// terminated 我方主动终结 PTY（Close/Kill/Detach 先于关闭置位）：waitLoop
	// 据此区分「进程收割」（我方动作的结果，不触发退出回调）与「真实退出事件」
	//（P-20261004-60 验尸链依赖后者；缺此标志空闲分离会与分离通知双发）
	terminated bool
	// 前台活动探测缓存（ProbeRunning 写 / RunningState 读），供 snapshot
	// 免重复探测；known=false 表示后端无法判定（如 Windows ConPTY）
	running      bool
	runningKnown bool
	// clients 交互 WS 客户端附着计数（HandleTerminalWS 生命周期增减）：
	// >0 表示有人/有端正持有本会话的终端连接——空闲超时分离（P-192）以此
	// 为「被遗忘」判据之一，在用会话绝不动。recording/liveterm 等旁路输出
	// tap 不经此计数（它们不代表人在线）
	clients int
	// lastActivity 最近一次 PTY 活动（unix nano，atomic）：WriteInput（输入）
	// 与 readLoop 输出双面刷新。空闲超时判定（P-192）的事实源——服务端自有
	// 口径，不依赖前端 activityMap（浏览器内存态，浏览器一关即失效，而「被
	// 遗忘」的会话恰恰没有浏览器看着）。atomic 而非 s.mu：输出热路径每 4KB
	// 块一次 store，锁竞争不可接受；单 atomic store 开销 ns 级，读侧
	// LastActivity() 无锁读
	lastActivity atomic.Int64
}

// Manager 终端会话管理器
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	// ports 端口注册表（P-20261003-293，portregistry.go）：dev 端口探测/上报
	// 两路信号沉淀的「端口 → 会话」登记，会话关闭即摘除。与 sessions 同锁；
	// 测试裸构造的 Manager 零值可用（RegisterDevPort 惰性建表）
	ports map[int]PortEntry
}

// MaxSessions（生效值经 MaxSessions() 取，可配化 P-20261006-12）与超限错误
// 声明归 module.go（roadmap M1.4：会话上限归模块所有；此处仅保留错误构造）。
// errTooManySessions 按调用时刻构造：上限可配后不再有常量可预拼文案，
// 实时取值让用户从错误信息感知当前配在哪
func errTooManySessions() error {
	return fmt.Errorf("terminal: too many sessions (limit %d), close unused terminals first", MaxSessions())
}

var DefaultManager = &Manager{
	sessions: make(map[string]*Session),
}

// getShell 获取当前平台的默认 shell：设置（terminal.defaultShell）优先，
// 未配置/失效回落平台硬编码序（platformDefaultShell，P-20261004-57，见 shell.go）
func getShell() string {
	if v := configuredShell(); v != "" {
		return v
	}
	return platformDefaultShell()
}

// agentCallbackEnv 本机终端会话统一注入的智能体回调环境变量。
// 目标：任何本机终端里运行的智能体（claude/codex/dsh 或用户手敲的 curl）
// 都能开箱即用调本系统 API——CC_BASE_URL 跟随实际监听端口（TLS 启用时指
// 明文回环辅助端口，规避自签证书握手失败），CC_LOCK_TOKEN 为 sca_ 智能体
// 令牌（长效，不随解锁 TTL 过期）。
// 仅本机会话有意义：远程主机终端注入 localhost 会指向远程机器自身。
// P-20261025-1 标识切换：CC_ 正名 + SC_ 旧名双写一个版本期——消费方是终端里的
// 外部进程（用户脚本/智能体），旧名脚本兼容期内不断链；移除时点见
// server/config/datamigrate.go 头注
func agentCallbackEnv() []string {
	st := store.Get()
	if st == nil {
		return nil
	}
	port := 0
	if cfg := st.Settings.Get(); cfg != nil {
		port = cfg.Server.Port
	}
	if port <= 0 {
		return nil
	}
	if lp := config.LoopbackPort(); lp > 0 {
		port = lp
	}
	env := []string{
		fmt.Sprintf("CC_BASE_URL=http://localhost:%d", port),
		fmt.Sprintf("CC_BASE_URL=http://localhost:%d", port),
	}
	if tok := st.AgentToken.Plain(); tok != "" {
		env = append(env, "CC_LOCK_TOKEN="+tok, "CC_LOCK_TOKEN="+tok)
	}
	return env
}

// terminalIDEnv 会话自标识环境变量：agent 经 ops-notify 上报 task.progress 时
// 携带该 id，前端进度归属到具体会话（悬浮球/条点击直达）。CC_ 正名 + SC_ 旧名
// 双写一个版本期（消费方是终端里的外部进程，兼容期语义同 agentCallbackEnv）
func terminalIDEnv(id string) []string {
	return []string{"CC_TERMINAL_ID=" + id, "CC_TERMINAL_ID=" + id}
}

// projectEnv 项目绑定会话注入的项目标识环境变量（P-20261003-307）：
// CC_PROJECT_ID 即 /api/projects/:id 的 :id——agent 免「GET /api/projects 按路径
// 反查」一步（符号链接/大小写/相对绝对形态不一致时反查会匹配出错），notes/本地
// 历史/回收站等项目级端点开箱可调；CC_PROJECT_PATH 为注册根路径，供 agent 对照
// pwd 判断 cwd 相对关系。免项目会话（agent 会话等 projectID 为空）不注入，反查
// 语义保留。注意：存量会话升级后 env 不刷新，新建会话生效。CC_ 正名 + SC_ 旧名
// 双写一个版本期（消费方是终端里的外部进程，兼容期语义同 agentCallbackEnv）
func projectEnv(projectID, projectPath string) []string {
	if projectID == "" {
		return nil
	}
	env := []string{"CC_PROJECT_ID=" + projectID, "SC_PROJECT_ID=" + projectID}
	if projectPath != "" {
		env = append(env, "CC_PROJECT_PATH="+projectPath, "SC_PROJECT_PATH="+projectPath)
	}
	return env
}

// ============== 会话集合变更回调 ==============
// API 层注册（注入 opschannel 广播 terminals.changed）：native shell 自行退出
// 不经 API，管理页/底部终端/悬浮窗的统一会话列表需据此实时对账，否则死会话
// 在未持有其 WS 的端上一直显示。回调在锁外触发；nil 安全
var (
	onChangeMu sync.Mutex
	// observerEntry 身份 id 退订：SetOnChange 截断复用底层数组，按下标清理会
	// 让旧退订闭包误删同位置的新回调（与 opschannel 观察者同款设计）
	onChangeEntries []observerEntry
	nextOnChangeID  int
)

// observerEntry 回调条目（id 供退订匹配）
type observerEntry struct {
	id int
	fn func()
}

// SetOnChange 覆盖式注册会话集合变更回调（nil = 清空）——历史单回调语义，
// API 层 init 与测试仍走此口；追加式消费者一律用 AddOnChange
func SetOnChange(fn func()) {
	onChangeMu.Lock()
	onChangeEntries = onChangeEntries[:0]
	if fn != nil {
		nextOnChangeID++
		onChangeEntries = append(onChangeEntries, observerEntry{id: nextOnChangeID, fn: fn})
	}
	onChangeMu.Unlock()
}

// AddOnChange 追加注册会话集合变更回调，返回退订函数（幂等）。
// 跨模块旁路消费会话生命周期事件的装配口（P-20261001-15 审批窗口录制自愈）
func AddOnChange(fn func()) (unsubscribe func()) {
	onChangeMu.Lock()
	nextOnChangeID++
	e := observerEntry{id: nextOnChangeID, fn: fn}
	onChangeEntries = append(onChangeEntries, e)
	onChangeMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			onChangeMu.Lock()
			for i, o := range onChangeEntries {
				if o.id == e.id {
					onChangeEntries = append(onChangeEntries[:i], onChangeEntries[i+1:]...)
					break
				}
			}
			onChangeMu.Unlock()
		})
	}
}

func notifyChange() {
	onChangeMu.Lock()
	snapshot := make([]func(), 0, len(onChangeEntries))
	for _, o := range onChangeEntries {
		snapshot = append(snapshot, o.fn)
	}
	onChangeMu.Unlock()
	for _, fn := range snapshot {
		fn()
	}
}

// CreateSession 创建新终端会话
// shellIntegration=true 时注入 OSC 133 钩子（bash/zsh/PowerShell 支持）
// 后端类型由 config.Server.TerminalBackend 决定（auto/tmux/native）
func (m *Manager) CreateSession(id, name, projectPath, projectID string, shellIntegration bool) (*Session, error) {
	return m.create(id, name, projectPath, projectID, shellIntegration, KindShell, "", "", "")
}

// CreateSessionWithShell 创建新终端会话并指定 shell（P-20261004-57 会话级覆盖）：
// shell 为空跟随设置/平台默认；显式传入时优先于设置（ResolveSessionShell 解析，
// 失效回落不阻塞创建）
func (m *Manager) CreateSessionWithShell(id, name, projectPath, projectID string, shellIntegration bool, shell string) (*Session, error) {
	return m.CreateSessionInDir(id, name, projectPath, projectID, shellIntegration, shell, "")
}

// CreateSessionInDir 创建指定工作目录的项目终端会话（P-20261005-192 目录级终端
// 直达）：dir 为空 = 项目根（既有行为零变化）；非空 = 项目根内子目录，透传至
// SessionSpec.Dir 供后端作 shell 起始 cwd（tmux -c / native cmd.Dir）。目录存在
// 性与项目根包含校验在 API 层（files.SafeJoinProject 守卫，越界/缺失 400）——
// 与 shell 覆盖同款「边界校验前置 HTTP 层」分工。projectPath 仍承担项目身份：
// CC_PROJECT_PATH 环境注入（spec.Env 与 tmux 侧 spec.ProjectPath 两路）恒为
// 注册根路径，会话元数据（产出基线/重启恢复）也以根为准
func (m *Manager) CreateSessionInDir(id, name, projectPath, projectID string, shellIntegration bool, shell, dir string) (*Session, error) {
	return m.create(id, name, projectPath, projectID, shellIntegration, KindShell, "", shell, dir)
}

// CreateAgentSession 创建智能体终端会话：免项目绑定（工作目录默认用户主目录）、
// tmux 名走哨兵项目哈希（重启恢复归类为 agent，不被孤儿清理）、launch 非空时
// 启动后注入启动命令（如 claude/codex，经 PTY 写入由 shell 缓冲执行）
func (m *Manager) CreateAgentSession(id, name, dir, launch string) (*Session, error) {
	return m.createAgentWithShell(id, name, dir, launch, "")
}

// CreateAgentSessionWithShell 创建智能体终端会话并指定 shell（P-20261004-57）：
// 供纯终端形态（launch 为空）的会话级覆盖；agent 运行时会话（claude 等）调用
// 方不传——运行时自管其启动 shell，与用户默认 shell 设置解耦
func (m *Manager) CreateAgentSessionWithShell(id, name, dir, launch, shell string) (*Session, error) {
	return m.createAgentWithShell(id, name, dir, launch, shell)
}

func (m *Manager) createAgentWithShell(id, name, dir, launch, shell string) (*Session, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve home dir: %w", err)
		}
		dir = home
	}
	return m.create(id, name, dir, "", true, KindAgent, launch, shell, "")
}

// AttachExternalSession 接管外部 tmux 会话（P-20261005-189）：跳过 new-session/
// 环境注入/引导占位（会话与其中进程已在运行，注入既无效也无意义），直接 attach
// 用户默认 socket 上的既有会话——TmuxName 即外部会话名，Session.ID 与之相等
// （与自建 tmux 会话 ID 约定一致：WS/关闭/改名全链按 id 寻址零特判）。
// 仅 tmux 后端可用（native 无从接管）；display 名缺省按 meta 还原用户历史命名，
// 再退会话名。持 m.mu 全程与 create 同锁序（内联注册而非复用
// RegisterRecoveredSession——后者自行取锁，复用须中途放锁引入重复接管竞态）
func (m *Manager) AttachExternalSession(name, tmuxName string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 会话数准入：接管会话同样占配额（attach 子进程 + 探测旁挂同为资源）
	if len(m.sessions) >= MaxSessions() {
		return nil, errTooManySessions()
	}
	if _, dup := m.sessions[tmuxName]; dup {
		return nil, fmt.Errorf("external session already attached: %s", tmuxName)
	}

	backendCfg := ""
	if cfg := store.Get().Settings.Get(); cfg != nil {
		backendCfg = cfg.Server.TerminalBackend
	}
	if ResolveBackend(backendCfg) != BackendTmux {
		return nil, fmt.Errorf("external tmux takeover requires tmux backend")
	}
	backend := NewBackend(BackendTmux)

	if name == "" {
		// 显示名还原：接管是可重复动作（解除后可再接管），历史命名随 meta 存续
		name = tmuxName
		if meta, err := store.Get().AgentSession.Get(tmuxName); err == nil && meta != nil && meta.Name != "" {
			name = meta.Name
		}
	}

	spec := SessionSpec{
		ID:           tmuxName,
		Name:         name,
		Shell:        getShell(),
		TmuxName:     tmuxName,
		TmuxExternal: true,
	}
	if !backend.Alive(spec) {
		return nil, fmt.Errorf("tmux session not found: %s", tmuxName)
	}
	conn, err := backend.Reattach(spec)
	if err != nil {
		return nil, fmt.Errorf("attach external tmux session: %v", err)
	}

	session := &Session{
		ID:        tmuxName,
		Name:      name,
		Path:      externalTmuxPanePath(tmuxName),
		CreatedAt: time.Now(),
		Backend:   string(BackendTmux),
		Kind:      KindAgent,
		Origin:    OriginExternal,

		spec:    spec,
		backend: backend,
		ptmx:    conn,
		mgr:     m,

		onOutput: make(map[int64]func(data []byte)),
		onExit:   make(map[int64]func(exitCode int)),

		// 探测旁挂与自建/恢复会话同构初始化（外部 shell 无 OSC 133 集成时
		// 各探测器无帧即静默，运行态如实呈现不可考——不补偿不虚构）
		devPort:     newDevPortDetector(tmuxName),
		sentinel:    newSentinelDetector(tmuxName, ""),
		osc:         newOscStateDetector(),
		cwd:         newCWDDetector(),
		gitActivity: newGitActivityDetector(tmuxName, ""),
	}
	// 空闲时钟起点 = 接管时刻（恢复会话同口径：真实末次活动不可考，
	// 保守侧多给一个完整空闲窗口）
	session.touchActivity()
	// 服务端只读闸默认开（P-20261008-17）：与前端接管 pane 默认只读锁同初值
	// 同语义——解锁由 input-lock 端点翻转（前端解锁动作同步调用），不是这里的
	// 职责。重启不恢复接管会话（CLAUDE.md 终端节），无恢复路径需带值
	session.serverReadOnly.Store(true)

	m.sessions[tmuxName] = session
	go session.readLoop()
	go session.waitLoop()

	slog.Info("terminal: external tmux session attached",
		"name", tmuxName, "display", name)
	return session, nil
}

// create 会话创建共同实现（项目/agent 两族漏斗）。
// projectPath 对项目会话是项目注册根（项目身份与环境注入的事实源），对 agent
// 会话即工作目录；workDir 非空时（目录级终端，P-20261005-192）覆盖 shell 起始
// cwd 与 Session.Path，项目身份语义（env/元数据/恢复）仍走 projectPath。
// 存在性校验：projectPath 必须存在；workDir 的存在与包含校验在 API 层（这里
// 只对与 projectPath 不同值时补一道防误用 stat，失败信息同既有原文）
func (m *Manager) create(id, name, projectPath, projectID string, shellIntegration bool, kind, launch, shellOverride, workDir string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 会话数准入：含重启恢复的 tmux 会话在内，总量不得越过上限
	if len(m.sessions) >= MaxSessions() {
		return nil, errTooManySessions()
	}

	// 确保目录存在
	if _, err := os.Stat(projectPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("directory does not exist: %s", projectPath)
	}
	if workDir == "" {
		workDir = projectPath
	} else if workDir != projectPath {
		if fi, err := os.Stat(workDir); err != nil || !fi.IsDir() {
			return nil, fmt.Errorf("directory does not exist: %s", workDir)
		}
	}

	// 解析后端类型
	// 必须用 store.Get().Settings.Get()（doc store 主存储）
	// 而非 config.Load()（仅 legacy config.json fallback，settings 写入不会同步到这里）
	backendCfg := ""
	if cfg := store.Get().Settings.Get(); cfg != nil {
		backendCfg = cfg.Server.TerminalBackend
	}
	backendKind := ResolveBackend(backendCfg)
	backend := NewBackend(backendKind)

	// 会话 shell（P-20261004-57）：会话级覆盖 > 设置（terminal.defaultShell）>
	// 平台缺省序；覆盖值失效降级不阻塞创建（ResolveSessionShell 内注记）
	shell := ResolveSessionShell(shellOverride)
	env := append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	// 智能体回调环境变量统一注入（本机所有终端会话，含项目终端）
	env = append(env, agentCallbackEnv()...)
	// 会话自标识：task.progress 上报的归属锚点（P7 进度归属）
	env = append(env, terminalIDEnv(id)...)
	// 项目标识（P-20261003-307）：项目绑定会话注入 CC_PROJECT_ID/CC_PROJECT_PATH，
	// agent 免路径反查直调 /api/projects/:id/*；免项目会话自然缺省
	env = append(env, projectEnv(projectID, projectPath)...)

	// 准备 shell integration（仅对支持的 shell 生效）
	var setup *shellint.SetupResult
	if shellIntegration {
		if s, err := shellint.Setup(shell); err != nil {
			slog.Warn("terminal: shell integration setup failed", "err", err)
		} else {
			setup = s
			slog.Debug("terminal: shell integration enabled", "shell", shell)
		}
	}

	// tmux backend 需要预先生成 session 名（重启恢复反查项目依赖此前缀）
	// native 下返回空字符串，不影响行为
	// agent 会话用哨兵项目 ID 参与命名：恢复逻辑据此归类，不按孤儿清理
	tmuxKey := projectID
	if kind == KindAgent {
		tmuxKey = store.AgentProjectID
	}
	tmuxName := computeTmuxSessionName(tmuxKey)

	// tmux backend 下 session.ID 与 spec.TmuxName 保持一致：
	// 这样服务重启后 RecoverSessions 能用同一 ID 重建 Session，
	// 通知中心等引用 session.ID 的功能不会因重启失效
	// native backend 无持久化能力，沿用调用方传入的 term-<unixnano> 形式
	finalID := id
	if backend.IsPersistent() && tmuxName != "" {
		finalID = tmuxName
	}

	spec := SessionSpec{
		ID:        finalID,
		Name:      name,
		ProjectID: projectID,
		Shell:     shell,
		Env:       env,
		Dir:       workDir,
		// 项目身份环境（CC_PROJECT_PATH）恒为注册根：目录级会话的 Dir 是子目录
		// （tmux 后端会话环境注入读本字段，P-20261005-192）；agent 会话 projectPath
		// 即工作目录，两值天然相等
		ProjectPath: projectPath,
		Setup:       setup,
		TmuxName:    tmuxName,
	}

	ptmx, err := backend.Create(spec)
	if err != nil {
		slog.Error("terminal: failed to start backend", "backend", backendKind,
			"shell", shell, "dir", workDir, "err", err)
		return nil, fmt.Errorf("failed to start backend (%s): %v", backendKind, err)
	}
	slog.Info("terminal: session created", "id", finalID, "backend", backendKind,
		"shell", shell, "dir", workDir, "tmuxName", tmuxName, "kind", kind)

	session := &Session{
		ID:        finalID,
		Name:      name,
		ProjectID: projectID,
		// Path = 实际起始 cwd（目录级会话为子目录）：CurrentDir 回落、前端
		// tab 目录徽标/「在文件树中定位」按此解析；项目注册根另见 spec.ProjectPath
		Path:      workDir,
		CreatedAt: time.Now(),
		Backend:   string(backendKind),
		Kind:      kind,
		Origin:    OriginSelf,

		spec:    spec,
		backend: backend,
		ptmx:    ptmx,
		mgr:     m,

		onOutput: make(map[int64]func(data []byte)),
		onExit:   make(map[int64]func(exitCode int)),

		devPort:     newDevPortDetector(finalID),
		sentinel:    newSentinelDetector(finalID, projectID),
		osc:         newOscStateDetector(),
		cwd:         newCWDDetector(),
		gitActivity: newGitActivityDetector(finalID, projectID),
	}
	// 空闲时钟起点 = 创建时刻（P-192）：重启恢复的 tmux 会话真实末次活动
	// 不可考，一律按「恢复当下」重新起算——保守侧多给一个完整空闲窗口，
	// 不恢复即分离刚恢复的会话
	session.touchActivity()

	// 仅 native backend 启用 scrollback 缓存：tmux 用 capture-pane 拿到的状态更完整
	// native 没有持久化能力，靠缓存支持 WS 重连重放历史输出
	// 容量来自用户配置（settings.terminalScrollbackLines），换算为字节
	if !backend.IsPersistent() {
		lines := DefaultScrollbackLines
		if cfg := store.Get().Settings.Get(); cfg != nil {
			lines = GetScrollbackLines(cfg.Server.TerminalScrollbackLines)
		}
		session.scrollback = NewScrollbackWithCapacity(scrollbackBytesFromLines(lines))
	}

	// map key 必须与 session.ID（finalID）一致：API 返回 data.id = session.ID，
	// 前端用它在 GetSession/CloseSession 中反查。tmux 后端下 finalID != 传入 id
	//（改写为 tmuxName），若用原始 id 做 key 会导致 WS 连接永远 404
	m.sessions[finalID] = session

	// 启动读取 goroutine
	go session.readLoop()
	// 启动退出监听 goroutine（捕获 shell 进程退出码）
	go session.waitLoop()

	// 智能体启动命令注入：经 PTY 写入，由行规程缓冲、shell 就绪后执行
	//（与 tmux send-keys 同语义；命令为服务端 Provider 常量，不经客户端）
	if launch != "" {
		if err := session.WriteInput([]byte(launch + "\r")); err != nil {
			slog.Warn("terminal: agent launch command write failed", "id", finalID, "err", err)
		}
	}

	return session, nil
}

// RegisterRecoveredSession 将已恢复的底层会话（如重启后从 tmux 列表中找到的）注册到 Manager
// 不调用 backend.Create（底层会话已存在），仅启动 attach + readLoop/waitLoop
// Phase 3 重启恢复逻辑会用到
func (m *Manager) RegisterRecoveredSession(s *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 恢复场景：底层 session 已存在，需要 Reattach 拿到一个新的 attach 进程
	if s.backend == nil {
		return fmt.Errorf("recovered session missing backend")
	}
	conn, err := s.backend.Reattach(s.spec)
	if err != nil {
		return fmt.Errorf("reattach: %v", err)
	}
	s.ptmx = conn
	s.mgr = m
	// 恢复会话的空闲时钟重置（P-192，同 create 注记：真实末次活动不可考，
	// 按恢复当下起算）
	s.touchActivity()
	m.sessions[s.ID] = s
	go s.readLoop()
	go s.waitLoop()
	return nil
}

// waitLoop 等待子进程退出，触发 onExit 回调
// 注意：tmux 模式下这里 wait 的是 attach 子进程，attach 退出≠底层 session 死
func (s *Session) waitLoop() {
	// 持锁取快照：ptmx 可能被 EnsureAttached 替换，裸读是数据竞争（与 readLoop 同款）
	s.mu.Lock()
	ptmx := s.ptmx
	s.mu.Unlock()
	if ptmx == nil {
		return
	}
	state, _ := ptmx.Wait()
	// state == nil = PTY 关闭/等待失败无状态可考：维持既有「视为正常退出」
	// 语义。state != nil 且 err != nil（exec.ExitError 惯例，exec.Cmd 与
	// go-pty Cmd 两后端同形）= 进程带非零码真实退出——恰是异常退出链
	// （P-20261004-60 验尸通知/项目终端异常退出通知）要捕获的事件；此前
	// 对 err 一律早退让该链从未真正触发过（存量缺陷，随本提案修复）
	if state == nil {
		return
	}
	// 我方主动终结（用户关闭/空闲分离/接管释放，先于 PTY 关闭置位）：
	// 进程收割是我方动作的结果而非退出事件，不触发退出回调——否则空闲
	// 分离（native 分离即杀 shell）会与分离通知双发、主动关闭会误报异常
	s.mu.Lock()
	terminated := s.terminated
	s.mu.Unlock()
	if terminated {
		return
	}
	exitCode := state.ExitCode()

	handlers := snapshotHandlers(&s.mu, s.onExit)

	for _, h := range handlers {
		h(exitCode)
	}
}

// readLoop 持续读取 PTY 输出并广播
func (s *Session) readLoop() {
	// 读缓冲 32KB（P-20261004-26）：高输出场景 4KB 粒度意味着 readLoop 每秒
	// 数千次 Read 系统调用 + 旁挂扫描/handler 分发——32KB 直接砍掉 8 次频次。
	// PTY Read 就绪即返不凑满，交互回显延迟不受影响；下游消费（scrollback 环、
	// devPort/sentinel/osc/cwd/gitActivity 五旁挂）均为滑窗裁剪语义，块大小
	// 无假设。内存代价：每会话 readLoop 一个 32KB 缓冲，MaxSessions() 上限
	//（缺省 50）下最坏 1.6MB，忽略不计
	buf := make([]byte, 32768)
	for {
		// 取当前 ptmx（readLoop 期间 ptmx 可能被 EnsureAttached 替换）
		s.mu.Lock()
		ptmx := s.ptmx
		s.mu.Unlock()
		if ptmx == nil {
			return
		}

		n, err := ptmx.Read(buf)
		if err != nil {
			s.handleAttachExit()
			return
		}
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])

			// PTY 输出即活动（P-192）：原子刷空闲时钟，热路径单 store ns 级
			//（量级考量见字段注记）。附着客户端的重连重绘（RedrawClient）与
			// tmux 重放同样经此路径到达，天然算活动——重连的会话不该被判空闲
			s.touchActivity()

			// native backend 写入 scrollback 缓存（tmux backend scrollback 为 nil，跳过）
			if s.scrollback != nil {
				s.scrollback.Write(data)
			}

			// dev 端口被动探测（P-20261002-83）：输出流旁路轻量正则（4KB 滑窗 +
			// 关键词预筛），与 scrollback 同路——无 WS 客户端 attached 也生效
			if s.devPort != nil {
				s.devPort.feed(data)
			}

			// 输出哨兵（P-20261004-8）：用户自定义正则规则旁路匹配，与端口探测
			// 同挂点（规则集为空时零正则成本，护栏见 sentinel.go 头注）
			if s.sentinel != nil {
				s.sentinel.feed(data)
			}

			// OSC 133 运行态旁挂（P-20261004-63）：C/D 帧识别推进服务端运行态，
			// 与 devPort/sentinel 同挂点第三旁挂（护栏见 oscstate.go 头注）
			if s.osc != nil {
				s.osc.feed(data)
			}
			// OSC 7 cwd 实时追踪（P-20261004-59）：与端口探测/输出哨兵同挂点——
			// 无 WS 客户端 attached 也生效（后台 agent cd 后前台照样拿到新位置），
			// 跨块半帧由 tracker 内 pending 拼接（护栏见 cwdtrack.go 头注）
			if s.cwd != nil {
				s.cwd.feed(data)
			}
			// gitActivity（P-20261004-81）：TUI git 写完成特征——内容键去重+1s 防抖，
			// 命中经会话项目归属发布定向广播（面板秒级感知唯一链，护栏见 gitactivity.go）
			if s.gitActivity != nil {
				s.gitActivity.feed(data)
			}

			handlers := snapshotHandlers(&s.mu, s.onOutput)

			for _, handler := range handlers {
				handler(data)
			}
		}
	}
}

// handleAttachExit 处理 attach 进程退出
// native backend：shell 死了，关闭 session
// tmux backend：仅标记 attach 已退出，保留底层 session 以便下次 WS 连接 Reattach
func (s *Session) handleAttachExit() {
	s.mu.Lock()

	s.attachExited = true

	// 持久化 backend：保留 session，等待 Reattach
	if s.backend != nil && s.backend.IsPersistent() {
		s.mu.Unlock()
		slog.Debug("terminal: attach exited, session preserved for reattach",
			"id", s.spec.ID, "tmuxName", s.spec.TmuxName)
		return
	}

	// native backend：shell 死了，终结 session 并从 Manager 自移除——
	// 否则死会话永驻 map：占 MaxSessions 配额 + 保留最大 16MB 级 scrollback
	//（HealthCheck 只清 tmux，Windows 上更是 no-op）
	var mgr *Manager
	needRemove := false
	if !s.closed {
		s.closed = true
		if s.ptmx != nil {
			s.ptmx.Close()
		}
		if s.mgr != nil {
			mgr = s.mgr
			needRemove = true
		}
	}
	s.mu.Unlock()

	// 锁外自移除（锁序纪律）：持 s.mu 再取 m.mu 会与既有 m.mu→s.mu 路径
	//（HealthCheck 持 m.mu.RLock 调 s.IsPersistent；create 持 m.mu 调
	// session.WriteInput）构成锁序反转死锁环
	if needRemove {
		mgr.removeSession(s)
	}
}

// removeSession 会话终结自移除；指针比对防止误删同 ID 的新会话。
// 实际删除后触发变更回调（native shell 自行退出的唯一广播点）
func (m *Manager) removeSession(s *Session) {
	m.mu.Lock()
	if cur, ok := m.sessions[s.ID]; ok && cur == s {
		delete(m.sessions, s.ID)
		m.removeSessionPortsLocked(s.ID) // 端口登记随会话消亡摘除（P-20261003-293）
		m.mu.Unlock()
		notifyChange()
		return
	}
	m.mu.Unlock()
}

// EnsureAttached 确保 attach 进程处于活跃状态
// 由 HandleTerminalWS 在 WS 连接时调用：
//   - attach 仍活跃 → 直接返回
//   - attach 已退出但 backend 持久化（tmux）→ Reattach 启动新 attach
//   - attach 已退出且 backend 非持久化（native）→ 返回 error（session 已终结）
func (s *Session) EnsureAttached() error {
	s.mu.Lock()
	if !s.attachExited && s.ptmx != nil {
		s.mu.Unlock()
		return nil
	}
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("session closed")
	}
	backend := s.backend
	spec := s.spec
	if backend == nil {
		s.mu.Unlock()
		return fmt.Errorf("session has no backend")
	}
	if !backend.IsPersistent() {
		// native: session 终结后不可恢复
		s.mu.Unlock()
		return fmt.Errorf("session expired")
	}
	s.mu.Unlock()

	// tmux: reattach 是慢操作（进程拉起），锁外执行；
	// 提交时校验消除并发窗口——两个 WS 同时重连同一会话时仅第一个生效，
	// 后来者发现自己输掉竞态后必须 Close 自己新建的 conn，
	// 否则被覆盖丢弃的 attach 子进程 + PTY 永久泄漏
	conn, err := backend.Reattach(spec)
	if err != nil {
		return fmt.Errorf("reattach: %v", err)
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = conn.Close()
		return fmt.Errorf("session closed")
	}
	if !s.attachExited && s.ptmx != nil {
		s.mu.Unlock()
		_ = conn.Close()
		return nil
	}
	old := s.ptmx
	s.ptmx = conn
	s.attachExited = false
	s.mu.Unlock()
	if old != nil {
		// 已退出的旧 attach 连接：覆盖前补 Close，防 PTY fd 泄漏
		_ = old.Close()
	}

	// 重启 readLoop/waitLoop
	go s.readLoop()
	go s.waitLoop()
	return nil
}

// WriteInput 向终端写入输入
func (s *Session) WriteInput(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("session closed")
	}
	if s.ptmx == nil {
		return fmt.Errorf("session not attached")
	}
	// 输入即活动（P-192）：持本方法已有的 s.mu 顺带刷新，无额外锁开销
	if len(data) > 0 {
		s.touchActivity()
	}
	_, err := s.ptmx.Write(data)
	return err
}

// ServerReadOnly 服务端只读闸状态（P-20261008-17）：无锁读——WS 输入热路径
// 每帧一次，atomic.Load 开销 ns 级（lastActivity 同款取向）
func (s *Session) ServerReadOnly() bool {
	return s.serverReadOnly.Load()
}

// SetServerReadOnly 翻转服务端只读闸（input-lock 端点调用）。翻转是稀有动作
// （解锁/重锁），不做审计与变更事件——入账在 api 层端点侧（有请求上下文与
// 操作者 IP，这里只有标记位）
func (s *Session) SetServerReadOnly(v bool) {
	s.serverReadOnly.Store(v)
}

// directInputHold 直通输入持权闸（P-20261024-1）：访客经分享直通输入档持有
// 会话输入权期间置位——owner 侧 WS 输入被拒（「谁在输入」单持有者语义的
// 服务端强制面，与 P-20261008-17 serverReadOnly 同一闸口同一拒绝帧形态；
// 收回/超时/关闭分享级联即解除）。atomic：与 serverReadOnly 同款热路径取向
func (s *Session) DirectInputHeld() bool {
	return s.directInputHold.Load()
}

// SetDirectInputHold 翻转直通持权闸（shareapi 直通批准/收回路径调用）。
// 翻转是稀有动作（授予/收回），审计在 api 层落
func (s *Session) SetDirectInputHold(v bool) {
	s.directInputHold.Store(v)
}

// OnOutput 注册输出回调，返回 unregister 函数
// 调用方应在 WS 断开时调用 unregister，避免回调泄漏
func (s *Session) OnOutput(handler func(data []byte)) func() {
	return registerHandler(&s.mu, &s.nextHandlerID, &s.onOutput, handler)
}

// OnExit 注册进程退出回调，返回 unregister 函数
func (s *Session) OnExit(handler func(exitCode int)) func() {
	return registerHandler(&s.mu, &s.nextHandlerID, &s.onExit, handler)
}

// registerHandler 泛型注册回调到指定 map，返回 unregister 函数
// OnOutput/OnExit 共用：仅 handler 签名不同，注册/反注册逻辑一致
func registerHandler[T any](mu *sync.Mutex, nextID *int64, slot *map[int64]func(T), handler func(T)) func() {
	mu.Lock()
	defer mu.Unlock()
	if *slot == nil {
		*slot = make(map[int64]func(T))
	}
	id := *nextID
	*nextID++
	(*slot)[id] = handler
	return func() {
		mu.Lock()
		defer mu.Unlock()
		delete(*slot, id)
	}
}

// snapshotHandlers 持锁快照 map 为 slice，供 readLoop/waitLoop 锁外调用
func snapshotHandlers[T any](mu *sync.Mutex, slot map[int64]func(T)) []func(T) {
	mu.Lock()
	defer mu.Unlock()
	out := make([]func(T), 0, len(slot))
	for _, h := range slot {
		out = append(out, h)
	}
	return out
}

// Close 关闭 PTY 连接（不释放底层 backend 会话）
// native 模式：等同杀 shell 进程；tmux 模式：仅 detach attach 进程，底层 session 存活
// WS 断开/重连场景使用此方法
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	s.terminated = true // 主动终结：waitLoop 的进程收割不触发退出回调
	if s.ptmx != nil {
		s.ptmx.Close()
	}
}

// Kill 彻底释放底层会话（杀 shell 或 kill-session）
// 用户主动关闭终端（点 tab × 按钮）场景使用此方法
//
// 主动关闭前同时清空 onOutput + onExit：避免 backend.Kill 杀 attach 子进程时，
// readLoop 与 Kill 之间的 race 让残留 handler 继续触发（向已废弃的 WS channel 写数据，
// 或触发"异常退出"通知——用户主动行为不属于异常）
func (s *Session) Kill() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.terminated = true // 主动终结：waitLoop 的进程收割不触发退出回调（handlers 亦已清空，双保险）
	clear(s.onOutput)
	clear(s.onExit)
	backend := s.backend
	spec := s.spec
	ptmx := s.ptmx
	s.mu.Unlock()

	if backend != nil {
		if err := backend.Kill(ptmx, spec); err != nil {
			slog.Warn("terminal: backend kill failed", "id", spec.ID, "err", err)
		}
	} else if ptmx != nil {
		ptmx.Close()
	}
}

// ReleaseTakeover 解除对外部 tmux 会话的接管（P-20261005-189 close 分流的
// 接管侧）：终结 attach 子进程并清空输出/退出回调，底层 tmux 会话原样存活，
// 其中的进程不受影响。与 Kill 的全部差别就在不调 backend.Kill；时序纪律同
// Kill——先锁内置位 closed 再 Close，readLoop 随后的 handleAttachExit 看到
// closed 立即收尾，绝不对同一连接二次 Close（Windows ConPTY 不可重入）
func (s *Session) ReleaseTakeover() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.terminated = true // 主动终结：waitLoop 的进程收割不触发退出回调（handlers 亦已清空，双保险）
	clear(s.onOutput)
	clear(s.onExit)
	ptmx := s.ptmx
	s.mu.Unlock()

	if ptmx != nil {
		_ = ptmx.Close()
	}
	slog.Info("terminal: external tmux session released (session kept)",
		"name", s.spec.TmuxName)
}

// CaptureScrollback 获取 scrollback 历史用于 WS 重连后重放
// tmux backend：调 capture-pane（含光标位置等完整状态）
// native backend：返回 readLoop 维护的内部环形缓冲（仅字节历史，无光标信息）
func (s *Session) CaptureScrollback(maxLines int) ([]byte, error) {
	s.mu.Lock()
	backend := s.backend
	spec := s.spec
	scrollback := s.scrollback
	s.mu.Unlock()

	if backend != nil && backend.IsPersistent() {
		return backend.CaptureScrollback(spec, maxLines)
	}
	if scrollback != nil {
		return scrollback.Snapshot(maxLines), nil
	}
	return nil, nil
}

// CaptureHistory WS 重连重放的历史部分：
// tmux：只取可视区上方历史行（可视屏由 RedrawClient 重绘，保证光标/备屏状态精确）
// native：无重绘能力，退化为完整字节缓冲（含可视区，语义同 CaptureScrollback）
func (s *Session) CaptureHistory(maxLines int) ([]byte, error) {
	s.mu.Lock()
	backend := s.backend
	spec := s.spec
	scrollback := s.scrollback
	s.mu.Unlock()

	if backend != nil && backend.IsPersistent() {
		return backend.CaptureHistory(spec, maxLines)
	}
	if scrollback != nil {
		return scrollback.Snapshot(maxLines), nil
	}
	return nil, nil
}

// SnapshotReader 返回 native 环形缓冲的分段读取器（WS 重连重放专用，P-20261007-3）：
// 行裁剪语义与 CaptureScrollback 一致，但避免 Snapshot 的 ring→flat 整体复制
// 与持锁整段拷贝（大缓冲 16MB 级内存尖峰 + 重放期 Write 停摆）。
// tmux 后端无内部环形缓冲，返回 nil——调用方走 CaptureHistory 的整体快照
// 路径（capture-pane 的 exec 输出本就是一次性独立缓冲）
func (s *Session) SnapshotReader(maxLines int) *ScrollbackReader {
	s.mu.Lock()
	scrollback := s.scrollback
	s.mu.Unlock()
	if scrollback == nil {
		return nil
	}
	return scrollback.SnapshotReader(maxLines)
}

// EarliestAvailableAt 现存缓冲最早字节的写入时刻估计（P-20261005-233 断档检测）：
// 前端/agent 与「断开前最后收到的输出时刻」比对——本时刻晚于它（=断开前最后
// 输出早于现存缓冲起点）即断线窗口内环形缓冲发生过淘汰，重放起点与已见内容
// 之间存在缺口。tmux 后端 capture-pane 无逐行
// 时间语义，恒 (零值,false)——消费方按完整性未知处理（零标记，诚实缺失）。
// 估计值为「不晚于真实写入时刻」的下界（宁可漏标不误标），见 EarliestTime
func (s *Session) EarliestAvailableAt() (time.Time, bool) {
	s.mu.Lock()
	scrollback := s.scrollback
	s.mu.Unlock()
	if scrollback == nil {
		return time.Time{}, false
	}
	return scrollback.EarliestTime()
}

// RedrawClient 强制底层 backend 重绘当前可视屏（仅 tmux 有效；native no-op）。
// 必须在 WS 输出回调注册之后调用，重绘序列才能到达前端
func (s *Session) RedrawClient() {
	s.mu.Lock()
	backend := s.backend
	spec := s.spec
	s.mu.Unlock()
	if backend != nil {
		backend.RedrawClient(spec)
	}
}

// Rename 重命名终端
func (s *Session) Rename(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Name = name
}

// Resize 调整终端大小
// 相同尺寸的重复 resize 直接跳过：PowerShell/PSReadLine 收到 resize 事件会重发
// 完整 banner（含 \x1b[H 覆盖屏幕），冗余 resize 会让用户看到 banner 反复覆盖历史
func (s *Session) Resize(rows, cols uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("session closed")
	}
	if s.backend == nil || s.ptmx == nil {
		return nil
	}
	if s.lastCols == cols && s.lastRows == rows {
		return nil
	}
	s.lastCols = cols
	s.lastRows = rows
	return s.backend.Resize(s.ptmx, s.spec, rows, cols)
}

// Redraw 强制 tmux 客户端整屏重绘：tmux server 以自身 pane 网格为事实源向
// attach 客户端重发完整画面，治愈 PTY 尺寸竞态、WS 丢帧等造成的客户端显示
// 失步（切换/最大化后错乱、滚轮失灵的统一自愈点）。native 后端无可重绘通道
// （shell/前台程序随自身输出自然重绘），no-op。tmux 命令失败静默——会话可能
// 刚被外部 kill，下一轮探测/快照会正常收尾
func (s *Session) Redraw() {
	s.mu.Lock()
	spec := s.spec
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return
	}
	if b, ok := s.backend.(interface{ RedrawClient(SessionSpec) }); ok {
		b.RedrawClient(spec)
	}
}

// IsPersistent 返回底层 backend 是否支持持久化（tmux=true / native=false）
func (s *Session) IsPersistent() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.backend != nil && s.backend.IsPersistent()
}

// ShellPath 返回会话实际启动的 shell（P-20261004-57 创建响应投影用）：
// ResolveSessionShell 解析后的最终值（会话覆盖/设置/平台缺省的落点），
// 观测面字段——前端/agent 可核对「这个会话是用什么 shell 起的」
func (s *Session) ShellPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec.Shell
}

// ============== 空闲超时自动分离（P-20261003-192） ==============

// touchActivity 刷新活动时钟（atomic 本就无锁，持不持 s.mu 均可调——
// readLoop 输出路径无锁调用，WriteInput 路径顺带在 s.mu 内调用）
func (s *Session) touchActivity() {
	s.lastActivity.Store(time.Now().UnixNano())
}

// LastActivity 最近一次 PTY 活动（输入或输出）时刻；从未活动过（零值，仅
// 裸构造的测试会话会出现）返回零时刻——判定侧把零值当「创建即空闲」处理
func (s *Session) LastActivity() time.Time {
	return time.Unix(0, s.lastActivity.Load())
}

// OscRunningState OSC 133 运行态（P-20261004-63）：（命令在跑, 最近命令时刻）。
// 时刻零值 = 本进程未见任何 C/D 帧（裸构造测试会话/帧未出现过），判定侧不虚构。
// 与前台进程探测 RunningState 口径独立：本态源自 shell 集成帧（三平台一致），
// 进程探测是平台受限的互补信号
func (s *Session) OscRunningState() (bool, time.Time) {
	if s.osc == nil {
		return false, time.Time{}
	}
	return s.osc.snapshot()
}

// CommandWindows 最近命令窗快照（P-20261005-170，旧→新）：fsattribution 的
// 归因判定面——watcher 事件时刻落在哪个窗内即归因该 (会话, 命令)。无 shell
// 集成/裸构造会话返回 nil（判定侧按「无窗」走未归因，宁漏报不虚报）
func (s *Session) CommandWindows() []CmdWindow {
	if s.osc == nil {
		return nil
	}
	return s.osc.commandWindows()
}

// WaitCommandExit 阻塞等待本会话下一个 OSC 133 D 帧（P-20261004-108 运行书
// 服务端执行的退出码等待原语）：返回 (退出码, true)；超时 (0, false)。
// 调用方应在 WriteInput 命令后调用（等待者注册在等待内部，写后注册的漏帧
// 窗口只有「命令在微秒级跑完」的极端情形，被超时兜底覆盖）。无 shell 集成
// 的会话（s.osc 为 nil 或全程无帧）恒超时返回——调用方用 OscFramesSeen
// 区分「集成缺失」与「命令还在跑」两种超时
func (s *Session) WaitCommandExit(timeout time.Duration) (int, bool) {
	s.mu.Lock()
	d := s.osc
	s.mu.Unlock()
	if d == nil {
		return 0, false
	}
	return d.WaitDFrame(timeout)
}

// OscFramesSeen 会话生命周期内是否见过任何 OSC 133 C/D 帧（P-20261004-108）：
// 运行书执行链首轮等待超时后据此区分「shell 无集成」（降级连续发送）与
// 「命令仍在跑」（按 CMD_TIMEOUT 惯例视为完成继续）
func (s *Session) OscFramesSeen() bool {
	s.mu.Lock()
	d := s.osc
	s.mu.Unlock()
	return d != nil && d.FramesSeen()
}

// AttachClient 交互 WS 客户端附着计数 +1（HandleTerminalWS 建连时调用）。
// recording tap / liveterm 馈线等旁路输出消费者不计数——它们不代表人在线
func (s *Session) AttachClient() {
	s.mu.Lock()
	s.clients++
	s.mu.Unlock()
}

// DetachClient 附着计数 -1（WS 断开 defer 调用）；下溢防护：计数错账时
// 宁可多留会话（漏分）也不把负数当「无人附着」（误分）
func (s *Session) DetachClient() {
	s.mu.Lock()
	if s.clients > 0 {
		s.clients--
	}
	s.mu.Unlock()
}

// Detach 释放会话的服务端附着连接（空闲超时自动分离 P-192）。
// 只关 ptmx 这一层，语义按后端分叉：
//   - tmux：attach 子进程退出 → attachExited，底层 tmux session 存活，
//     下次 WS 连接 EnsureAttached 自动 Reattach——真分离，会话可重连；
//   - native：PTY 即 shell 的脐带，释放即会话终结（等同 shell 自行退出
//     的自移除路径）。native 无持久化层可保活，「分离不杀进程」在这侧
//     的诚实注记：分离动作本身就是会话的终点，不冒充可重连。
//
// 返回是否实际执行了分离（已关闭 / 已分离 / 无连接 / 仍有客户端附着 →
// false 幂等跳过）。
//
// 时序纪律：先在锁内置位 attachExited/closed 再 Close——readLoop 随后的
// handleAttachExit 拿到锁时看到标志位已立，绝不对同一连接二次 Close。
// Windows ConPTY 的 ClosePseudoConsole 不可重入，二次关闭实测堆破坏直接
// 杀死进程（STATUS_HEAP_CORRUPTION 0xC0000374，已复现）；既有 Kill 路径
// 天然单次关闭（closed 先行），本方法是同一纪律的显式版。Close 持 s.mu
// 调用有 handleAttachExit native 分支同款先例
func (s *Session) Detach() bool {
	s.mu.Lock()
	if s.closed || s.attachExited || s.ptmx == nil || s.clients > 0 {
		s.mu.Unlock()
		return false
	}
	// 我方主动终结（先于 Close 置位）：native 分离即杀 shell，waitLoop 的
	// 进程收割不触发退出回调——否则与本条分离通知双发（P-20261004-60）
	s.terminated = true
	_ = s.ptmx.Close()
	s.attachExited = true
	var mgr *Manager
	removeNative := false
	if s.backend != nil && !s.backend.IsPersistent() {
		// native：分离=终结，就地走「shell 自行退出」同款收尾。不等
		// handleAttachExit——它对已 closed 的会话不再负责移除（该分支的
		// 二次 Close 正是上面挡掉的堆破坏源）
		if !s.closed {
			s.closed = true
			mgr = s.mgr
			removeNative = mgr != nil
		}
	}
	s.mu.Unlock()

	if removeNative {
		// 锁外自移除（锁序纪律：持 s.mu 取 m.mu 会与既有 m.mu→s.mu 路径
		// 构成锁序反转，handleAttachExit 同款注记）
		mgr.removeSession(s)
	}
	return true
}

// Size 返回会话当前 PTY 尺寸（从未 resize 过返回 0 值，调用方自行回落默认；
// P-20261001-15 cast header 记录用）
func (s *Session) Size() (cols, rows uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastCols, s.lastRows
}

// GetSession 获取终端会话
func (m *Manager) GetSession(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

// SessionCount 当前存活会话数（P-20261006-30 whoami 配额块的 current 供给方）：
// 只数不排——ListSessions 的排序+切片分配对纯计数是纯开销，读锁下取 len 即可
func (m *Manager) SessionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// ListSessions 列出所有会话（稳定创建序：map 遍历序随机，而前端「默认 =
// 创建序」的排序承诺与 e2e 都依赖列表顺序确定）
func (m *Manager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		result = append(result, s)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	return result
}

// CloseSession 关闭并删除会话。close 语义按会话来源分流（P-20261005-189）：
//   - 自建（Origin=self）：Kill 语义（彻底释放底层 tmux / 杀 shell 进程），既有行为
//   - 外部接管（Origin=external）：仅解除接管——终结 attach 连接并摘除登记，
//     底层 tmux 会话原样存活（「关闭」的语义是本系统放手，不是杀用户的会话；
//     真杀走 KillSession，由调用方显式确认）
func (m *Manager) CloseSession(id string) {
	m.closeSession(id, false)
}

// KillSession 强制终结底层会话（外部接管会话的 kill 分支）：kill-session 落在
// 用户默认 socket，会话内的进程随之结束——不可逆，调用方（UI 二次确认/API
// 显式 ?kill=1）负责把关。自建会话与 CloseSession 等价
func (m *Manager) KillSession(id string) {
	m.closeSession(id, true)
}

func (m *Manager) closeSession(id string, forceKill bool) {
	m.mu.Lock()
	session, ok := m.sessions[id]
	external := ok && session.Origin == OriginExternal
	if ok {
		delete(m.sessions, id)
		m.removeSessionPortsLocked(id) // 端口登记随会话关闭摘除（P-20261003-293）
	}
	m.mu.Unlock()

	if ok {
		if external && !forceKill {
			session.ReleaseTakeover()
		} else {
			session.Kill()
		}
		notifyChange()
	}
}

// CloseAll 强制关闭并彻底释放所有 session 的底层资源（含 tmux kill-session）
// 用于测试 teardown 或将来需要的强制清理场景
//
// 注意：simple-coding 主进程退出时**不**调用此方法
// 原因：tmux 持久化模式下，主进程退出应保留底层 tmux session 以便下次启动 RecoverSessions 恢复；
// attach 子进程会随主进程退出被 OS 自然清理（SIGHUP），无需显式释放
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.ports = make(map[int]PortEntry) // 登记随全量清空（测试 teardown 路径）
	m.mu.Unlock()

	for _, s := range sessions {
		// 外部接管会话按 close 分流语义放手（解除接管不杀用户会话），
		// 自建会话彻底释放
		if s.Origin == OriginExternal {
			s.ReleaseTakeover()
		} else {
			s.Kill()
		}
	}
}

// CurrentDir OSC 7 实时追踪的会话工作目录（P-20261004-59）。known=false 表示
// 无帧（旧 shell 不发 OSC7 / 新会话尚无 prompt / 重启恢复历史不可考）——快照
// 不落 currentDir 键，消费方回落创建 dir（Path），与前端回落语义一致
func (s *Session) CurrentDir() (string, bool) {
	if s.cwd == nil {
		return "", false
	}
	return s.cwd.current()
}
