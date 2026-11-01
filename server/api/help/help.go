// Package help 帮助中心：常见问题的单一事实源。
//
// 同一份数据服务两端：
//   - 前端帮助中心 UI（GET /api/help，顶栏 ? / 命令面板入口）
//   - 智能体（GET /api/help 经 agentops 手册分节对 AI 开放——用户在智能体里
//     问使用类问题时，Agent 查本接口作答，与界面帮助中心天然一致）
//
// 内容为非敏感静态文档，跟随 /ops-manual 先例公开只读（浏览器/Agent 免 token）。
// 新增问答：往 categories/entries 追加即可，UI 与 AI 手册自动跟随。
package help

import (
	"net/http"
	"strings"

	"codecombo/server/agentops"
	"codecombo/server/api/whatsnew"

	"github.com/gin-gonic/gin"
)

// Category 帮助分类（Title 中文 / TitleEn 英文；前端按语言取用）
type Category struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	TitleEn string `json:"titleEn,omitempty"`
}

// Entry 单条问答（q/a 中文为主，qEn/aEn 英文可选；a 支持 markdown 子集——
// 前端经 marked 渲染。Tags 供 Agent 检索与前端搜索加权）
type Entry struct {
	ID       string   `json:"id"`
	Category string   `json:"category"`
	Q        string   `json:"q"`
	A        string   `json:"a"`
	QEn      string   `json:"qEn,omitempty"`
	AEn      string   `json:"aEn,omitempty"`
	Tags     []string `json:"tags,omitempty"`
}

var categories = []Category{
	{ID: "terminal", Title: "终端操作", TitleEn: "Terminal"},
	{ID: "sessions", Title: "会话管理", TitleEn: "Sessions"},
	{ID: "dsh", Title: "dsh 控制台", TitleEn: "dsh Console"},
	{ID: "agent", Title: "智能体协作", TitleEn: "Agent"},
	{ID: "general", Title: "通用", TitleEn: "General"},
}

var entries = []Entry{
	{
		ID: "mouse-captured", Category: "terminal", Tags: []string{"鼠标", "选中", "复制", "shift", "tmux", "vim", "鼠标接管"},
		Q:   "终端提示「鼠标已交给应用」时，怎么选中复制？",
		A:   "当 tmux / vim 等程序开启鼠标上报后，鼠标事件会交给应用本身（用于点击窗格、滚动列表等）。\n\n- **按住 Shift 拖动**即可本地选中，松开自动复制（选中即复制默认开启，可在设置中关闭）\n- tmux 会话也可以用 tmux 原生复制：进入翻页模式后选择，经 `copy-pipe` 直达系统剪贴板\n- 复制粘贴均可走右键菜单",
		QEn: "The terminal says \"mouse captured by app\" — how do I select & copy?",
		AEn: "When tmux / vim enable mouse reporting, mouse events go to the application itself (pane clicks, list scrolling, etc.).\n\n- **Hold Shift and drag** to select locally; release auto-copies (copy-on-select is on by default, configurable in Settings)\n- tmux sessions also support native tmux copy: select in copy-mode, delivered via `copy-pipe` to the system clipboard\n- Right-click menu also offers copy/paste actions",
	},
	{
		ID: "scroll-stuck", Category: "terminal", Tags: []string{"上翻", "滚动", "滚轮", "历史", "刷新", "卡住", "失灵"},
		Q:   "终端无法上翻历史（滚轮没反应）怎么办？",
		A:   "点终端**右上角重绘按钮**或**右键菜单 → 刷新**，会强制重新同步滚动区并让 tmux 重发整屏；切走再切回面板通常也会自动恢复。\n\n若 tmux 开启了鼠标模式，滚轮默认交给 tmux 自己（进入翻页模式上翻），这是正常行为而非故障。",
		QEn: "The terminal cannot scroll up (mouse wheel does nothing). What now?",
		AEn: "Click the **redraw button at the pane's top-right corner** or **right-click menu → Refresh**: it force-resyncs the scroll area and makes tmux resend the whole screen. Switching away and back also heals it automatically.\n\nIf tmux mouse mode is on, the wheel is handled by tmux itself (scrollback paging) — that is expected behavior, not a bug.",
	},
	{
		ID: "paste-image", Category: "terminal", Tags: []string{"粘贴", "图片", "剪贴板"},
		Q:   "可以直接往终端粘贴图片吗？",
		A:   "可以。复制的图片直接 Ctrl+V 粘贴到终端，会自动上传到目标机器的临时目录并把路径贴入命令行（远程主机会传到远端 /tmp）。",
		QEn: "Can I paste an image directly into the terminal?",
		AEn: "Yes. Copy an image and press Ctrl+V in the terminal: it uploads to the target machine's temp directory and inserts the path into the command line (remote hosts upload to the remote /tmp).",
	},
	{
		ID: "session-manage", Category: "sessions", Tags: []string{"会话", "管理", "新建", "分组", "tmux"},
		Q:   "终端会话管理页能做什么？",
		A:   "集中查看与新建终端会话（含 tmux 持久会话与 Claude 等智能体会话），支持搜索、分组、重命名，重启应用后 tmux 会话可恢复。",
		QEn: "What can the terminal session management page do?",
		AEn: "It centralizes viewing and creating terminal sessions (tmux persistent sessions and agent sessions like Claude), with search, grouping and renaming. tmux sessions survive app restarts.",
	},
	{
		ID: "dsh-launch", Category: "dsh", Tags: []string{"dsh", "一键启动", "启动失败", "令牌", "3080"},
		Q:   "dsh 控制台提示未检测到 / 一键启动失败，怎么排查？",
		A:   "一键启动会自动拉起本机 dsh web 并捕获访问令牌；失败时界面直接显示日志尾部原因。\n\n- 未安装：`npm install -g` 安装 dsh 后重试\n- 自定义环境：在「设置 → 终端 → dsh Web UI」调整启动命令与上游地址\n- 仍不行：把界面显示的完整日志路径发给维护者",
		QEn: "The dsh console says \"not detected\" or one-click launch failed. How to troubleshoot?",
		AEn: "One-click launch starts the local dsh web and captures the access token; on failure the UI shows the log tail with the reason.\n\n- Not installed: install dsh via `npm install -g`, then retry\n- Custom environment: adjust the launch command and upstream URL in \"Settings → Terminal → dsh Web UI\"\n- Still failing: share the full log path shown in the UI",
	},
	{
		// ID 是前端锚点契约：NewSessionDialog 安装指引链接（HELP_RUNTIME_ENTRY）
		// 经 sc-open-help 直达本条——迁移/改名须两处同步（help_test.go 守门）
		ID: "agent-runtime-install", Category: "agent", Tags: []string{"运行时", "安装", "claude", "codex", "dsh", "不可用", "未安装", "自定义命令", "npm", "启动命令"},
		Q:   "如何安装/配置智能体运行时（claude/codex/dsh 与自定义命令）？",
		A:   "新建智能体会话时下拉里的运行时来自本机检测：口径是**该运行时的启动命令可在服务进程里执行**（PATH → 用户级常见位置 → 登录 shell 逐级解析——服务以守护进程运行时进程 PATH 常缺用户级工具链，交互终端里能跑而报「未安装」的历史问题已按此收敛）。\n\n**安装（npm 全局包）：**\n\n- claude：`npm install -g @anthropic-ai/claude-code`\n- codex：`npm install -g @openai/codex`\n- dsh：`npm install -g @deepseek-ai/dsh`\n\n也可以在「设置 → 通用 → AI 智能体」的运行时状态区直接点**「在终端安装」**（新开 shell 会话执行安装命令，全程可见）或**「复制安装命令」**。\n\n**装好后**：设置 → 通用 → 「运行时检测」立即重新探测（探测结果带缓存）；新建会话对话框重新打开即选到新运行时，无需重启应用。\n\n**自定义命令**：某运行时由非默认名命令启动（如包装脚本）时，在同一设置区为该运行时保存自定义启动命令（新建会话对话框勾选「存为该运行时的默认启动命令」等效）；任意 CLI 智能体工具可在「自定义智能体」登记注册名与展示名，登记后与内置运行时同等参与选型。",
		QEn: "How do I install/configure agent runtimes (claude/codex/dsh and custom commands)?",
		AEn: "The runtimes offered in the new-session dialog come from local detection: a runtime counts as available when **its launch command is executable in the service process** (resolved via PATH → common user-level locations → login shell; daemons often miss user toolchains in PATH — the \"works in my terminal but reported missing\" issue is fixed by this).\n\n**Install (npm global packages):**\n\n- claude: `npm install -g @anthropic-ai/claude-code`\n- codex: `npm install -g @openai/codex`\n- dsh: `npm install -g @deepseek-ai/dsh`\n\nOr use **Install in terminal** / **Copy install command** in the runtime status area of \"Settings → General → AI agent\".\n\n**After installing**: click \"Runtime detection\" in Settings → General to re-probe immediately (results are cached); reopen the new-session dialog to pick the new runtime — no app restart needed.\n\n**Custom commands**: if a runtime is launched by a non-default command (e.g. a wrapper script), save a custom launch command for it in the same settings area (the dialog's \"save as default launch command\" checkbox does the same); any CLI agent tool can also be registered under \"Custom agents\" and then participates in selection like a built-in runtime.",
	},
	{
		ID: "ask-agent", Category: "agent", Tags: []string{"智能体", "提问", "AI", "帮助", "claude", "dsh"},
		Q:   "帮助中心没有的问题，可以在哪里问？",
		A:   "直接问智能体（Claude Code / dsh 会话）即可。智能体与本系统已打通：使用类问题它能查到与这里一致的答案；也可以直接让它替你操作——改设置、管理项目与终端、Git 操作、远程主机等，用自然语言说需求就行。",
		QEn: "Where can I ask questions not covered by this help center?",
		AEn: "Just ask the agent (Claude Code / dsh sessions). The agent is deeply integrated with the system: it answers usage questions consistently with this help center, and can act for you — changing settings, managing projects & terminals, Git operations, remote hosts. Just describe what you need.",
	},
	{
		ID: "palette", Category: "general", Tags: []string{"命令面板", "快捷键", "搜索", "ctrl+k"},
		Q:   "命令面板怎么打开？",
		A:   "`Ctrl+K`（macOS 为 `Cmd+K`）或点顶栏搜索框；`Ctrl+Shift+P` 直达命令模式。可搜索文件、项目切换、新建终端、设置等全部命令。",
		QEn: "How do I open the command palette?",
		AEn: "`Ctrl+K` (`Cmd+K` on macOS) or click the search box in the top bar; `Ctrl+Shift+P` jumps straight to commands mode. It searches files, project switching, new terminals, settings — every command.",
	},
	{
		ID: "shortcuts", Category: "general", Tags: []string{"快捷键", "键位", "速查"},
		Q:   "全部快捷键在哪看？",
		A:   "按 `?`（Shift+/）呼出完整速查表；命令面板里搜「快捷键」同样可达。常用：\n\n- `Ctrl+K` 命令面板（搜索文件、切换项目、新建终端、设置等）；`Ctrl+Shift+P` 直达命令模式\n- `Ctrl+P` 快速打开文件；`Ctrl+B` 侧栏开关；``Ctrl+` `` 终端开关\n- `Ctrl+1-9` 直达活动栏面板（按视觉顺序）；`Ctrl+,` 打开设置\n- `Ctrl+W` 关闭当前标签；`Alt+1-9` 切换终端\n- 编辑器内：`Ctrl+S` 保存、`Ctrl+F` 查找、`Ctrl+D` 多光标",
		QEn: "Where can I find all keyboard shortcuts?",
		AEn: "Press `?` (Shift+/) for the full cheat-sheet; searching \"shortcuts\" in the command palette works too. Most used:\n\n- `Ctrl+K` command palette (search files, switch project, new terminals, settings); `Ctrl+Shift+P` commands mode\n- `Ctrl+P` quick open; `Ctrl+B` toggle sidebar; ``Ctrl+` `` toggle terminal\n- `Ctrl+1-9` jump to activity bar panels (visual order); `Ctrl+,` open settings\n- `Ctrl+W` close tab; `Alt+1-9` switch terminal\n- Editor: `Ctrl+S` save, `Ctrl+F` find, `Ctrl+D` multi-cursor",
	},
	{
		ID: "notify-prefs", Category: "general", Tags: []string{"通知", "偏好", "桌面提醒", "过滤", "齿轮"},
		Q:   "通知提醒规则 / 桌面提醒在哪调？",
		A:   "通知中心右上角**齿轮**直达「通知偏好」：可按分类（任务/克隆/Git/系统/错误）开关通知、调长任务阈值、开关桌面提醒（页面切走时仅错误/警告弹系统通知）。桌面通知权限被浏览器拒绝时，偏好页有警示与「重新检测」按钮——在浏览器站点设置里允许通知后点它即可恢复。权限授予后可点「发送测试通知」当场验证链路。",
		QEn: "Open the notification center and click the **gear** at its top-right to reach \"Notification preferences\": toggle notifications per category (task/clone/Git/system/error), adjust the long-task threshold, and turn desktop notifications on/off (when the tab is hidden, only errors/warnings raise system notifications). If desktop permission was denied, the preferences pane shows a warning plus a \"Re-check\" button — allow notifications in the browser site settings and click it to recover. Once granted, use \"Send test notification\" to verify the pipeline on the spot.",
	},
	{
		ID: "update", Category: "general", Tags: []string{"更新", "升级", "版本", "检查更新", "分发源", "新版本"},
		Q:   "怎么检查 / 安装新版本？",
		A:   "设置 → 关于 → **检查更新**：有新版本会显示最新版本号、体积与变更说明，点「立即更新」在线升级（失败自动回滚旧版本并通知）。自建分发源：在同一处「更新分发源」填入自建仓库地址即可让子实例从该地址缓存转发二进制。",
		QEn: "Settings → About → **Check for updates**: when a new version exists you'll see the latest version, size and changelog — click \"Update now\" for an in-place upgrade (failures auto-rollback to the old version and notify). Self-hosted mirror: fill in \"Update source\" to let sub-instances cache and forward binaries from your own repository.",
	},
	{
		ID: "mobile-access", Category: "general", Tags: []string{"手机", "移动端", "二维码", "扫码", "局域网", "外网", "tailscale", "cloudflare", "外部访问", "QR"},
		Q:   "手机怎样访问本工作台（局域网 / 外网 / Tailscale）？",
		A:   "顶栏二维码按钮或命令面板「在手机上打开」会按当前访问方式自动选择扫码地址，弹窗内的徽标说明可达性：\n\n- **局域网**：手机需与服务器连同一 Wi-Fi。服务器要监听局域网地址——默认仅绑定 `127.0.0.1`，需把配置里的 `host` 改为 `0.0.0.0`（或具体网卡 IP）并重启应用\n- **外网（Tailscale / Cloudflare Tunnel / 公网反代）**：在「设置 → 通用 → 外部访问地址」填入手机可达的 origin（如 `https://nas.tailnet.ts.net`），二维码优先使用该地址，任意网络可访问\n- **本机回环（localhost）**：手机无法访问回环地址；弹窗会自动改用局域网 IP，没有可用候选时显示红色不可达提示\n\n自签证书场景手机首次打开需接受证书；明文 HTTP 链路未加密，请避免在公共网络扫码。",
		QEn: "How can my phone access this workbench (LAN / internet / Tailscale)?",
		AEn: "The top-bar QR button or the command-palette \"Open on Phone\" picks a scan address from the current access mode; the badge in the dialog explains reachability:\n\n- **LAN**: the phone must be on the same Wi-Fi as the server. The server must listen on a LAN address — it binds `127.0.0.1` by default; set `host` to `0.0.0.0` (or a specific NIC IP) in the config and restart\n- **Internet (Tailscale / Cloudflare Tunnel / public reverse proxy)**: enter the origin your phone can reach (e.g. `https://nas.tailnet.ts.net`) under Settings → General → External access URL; the QR code prefers it and works from any network\n- **Local loopback (localhost)**: phones cannot reach loopback; the dialog automatically switches to a LAN IP and shows a red unreachable hint when no candidate exists\n\nWith self-signed certificates the phone must accept the certificate on first open; plain HTTP is unencrypted — avoid scanning on public networks.",
	},
	{
		ID: "theme", Category: "general", Tags: []string{"主题", "字体", "语言", "设置", "外观"},
		Q:   "如何更换主题 / 字体 / 语言？",
		A:   "顶栏齿轮、`Ctrl+,` 或命令面板搜「设置」打开设置：外观（主题色/字体/语言）、终端（主题/滚动行为/dsh）、远程主机等都在其中，变更实时生效。",
		QEn: "How do I change theme / font / language?",
		AEn: "Open Settings from the gear icon / `Ctrl+,` in the top bar (or search \"settings\" in the command palette): appearance (theme/font/language), terminal, remote hosts — changes apply live.",
	},
}

// Get 返回帮助中心全文。
// 路由：GET /api/help（公开只读，跟随 /ops-manual 先例——前端与智能体共用）
func Get(c *gin.Context) {
	cats, ents := withWhatsNew(categories, entries)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"categories": cats,
		"entries":    ents,
	}})
}

// withWhatsNew 静态 FAQ 之外并入「更新内容」动态节（P-20261007-17）：内容来自
// whatsnew 包的嵌入文档段落（docs/whatsnew.md），缺文档=缺节（诚实降级，不报
// 空壳分类）。A 为全部段落拼装的 markdown——历史版本可回看；前端帮助中心与
// 智能体查询同一份数据源（本函数在请求路径上、whatsnew 内容装配期注入后只读，
// 无并发写）。条目 id `whats-new` 是前端深链契约（WhatsNewPopup「查看历史」
// 经 openHelpEntry 锚定直达），改名须两处同步。
func withWhatsNew(cats []Category, ents []Entry) ([]Category, []Entry) {
	secs := whatsnew.Sections()
	if len(secs) == 0 {
		return cats, ents
	}
	var b strings.Builder
	for _, s := range secs {
		b.WriteString("## ")
		if s.Version != "" {
			b.WriteString("v")
			b.WriteString(s.Version)
			if s.Title != "" {
				b.WriteString(" ")
			}
		}
		b.WriteString(s.Title)
		b.WriteString("\n")
		b.WriteString(s.Body)
		b.WriteString("\n")
	}
	cat := Category{ID: "whatsnew", Title: "更新内容", TitleEn: "What's New"}
	entry := Entry{
		ID: "whats-new", Category: "whatsnew",
		Tags: []string{"更新", "新功能", "版本", "changelog", "whats new", "升级"},
		Q:    "这个版本（以及历史版本）更新了什么？",
		A:    b.String(),
		QEn:  "What's new in this (and previous) versions?",
	}
	return append(append([]Category{}, cats...), cat), append(append([]Entry{}, ents...), entry)
}

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "help", Title: "帮助中心（常见问题查询）", Order: 95,
		Summary: "使用/配置/排障类常见问题全文：用户问「怎么用/怎么配/为什么不行」类问题时，先查本接口再作答",
		Body: `- GET /api/help   帮助中心全文（categories[]+entries[]；q/a 中文、qEn/aEn 英文、tags 关键词）
  用户提出使用类问题时优先查询本接口，按用户语言作答（答案与界面帮助中心一致）；
  接口未覆盖的使用类问题，如实告知，不要编造。`,
	})
}
