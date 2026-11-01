package terminal

import (
	"runtime"
	"strings"
)

// 驻留识别（P-20261006-36）：kind=agent 会话免项目绑定（ProjectID 恒空，
// createAgentWithShell 传空），但常被用户在某个项目目录里启动（创建参数
// dir 即项目根或其子目录，Path 字段在位）。项目删除此前只级联 ProjectID
// 绑定的会话，驻留 agent 会话成为孤儿——cwd 指向已删目录继续运行、恢复
// tab 指向已删项目，正是 project.go 级联注释要防的「泄漏会话 404」问题的
// agent 变体。本文件提供 Path 前缀匹配的驻留判定，供项目删除的知情计数
// 与可选级联关闭（DELETE /projects/:id?closeAgentSessions=1）消费。
//
// 保守边界（提案定案）：纯词法前缀匹配，不 EvalSymlinks、不探测文件系统
// 大小写策略——前缀失配只意味着「不计入、不级联」，与既有行为一致不恶化；
// 消费侧代价至多是知情计数 +1 / 用户显式勾选时多关一个驻留会话，故匹配
// 从严不从宽。

// pathResidesIn 生产入口：按运行平台选比较语义（windows = 大小写折叠 +
// 反斜杠视作分隔符；POSIX = 仅 '/' 分隔、大小写敏感）。
func pathResidesIn(dir, root string) bool {
	return lexPathResidesIn(dir, root, runtime.GOOS == "windows")
}

// lexPathResidesIn 判定 dir 是否驻留在 root 内（含 root 本身）。纯词法，
// 三平台同一份代码可编译可运行，GOOS 只在选择语义旗标处出现——无构建
// 标签分支差；windowsSemantics 旗标同时是测试注入口，Windows 路径形态
// （盘符大小写/混用分隔符）在任何平台上都可用 caseFold=true 表驱动验证。
func lexPathResidesIn(dir, root string, windowsSemantics bool) bool {
	d := normalizeComparePath(dir, windowsSemantics)
	r := normalizeComparePath(root, windowsSemantics)
	if d == "" || r == "" {
		return false
	}
	if windowsSemantics {
		// NTFS/Windows API 缺省大小写不敏感：整路径折叠（盘符大小写混写
		// 是最常见的失配源）。POSIX 平台不折叠——两个仅大小写不同的目录
		// 可真实并存，误折叠会把兄弟目录并成同一个（误匹配后果见文件头）
		d = strings.ToLower(d)
		r = strings.ToLower(r)
	}
	if d == r {
		return true
	}
	if r == "/" {
		// POSIX 根目录：任何绝对路径都驻留其内（HasPrefix(d, "//") 恒假，
		// 需单列）。dir 已在上面确认为绝对形态
		return true
	}
	return strings.HasPrefix(d, r+"/")
}

// normalizeComparePath 路径 → 比较形态：'/' 分隔、无尾分隔符；非绝对形态
// 返回空串（相对路径与项目根的包含关系无法可靠判定，从严不计）。
// windowsSemantics 下反斜杠先行折算为 '/'——会话创建参数与 OSC 7 file URL
// 折算可能带来两种分隔符形态，指向同一目录必须归一；非 Windows 语义下
// 反斜杠是合法文件名字符（Linux 目录名可含 \），原样保留不做折算。
// 归一不依赖 host filepath 语义（host filepath.Clean 在 Windows 上会把 '\'
// 当分隔符、并保留卷根尾分隔符，令「posix 语义」模式跨平台结果不定）——
// 比较域自持 slashClean，任意平台上同一输入得到同一形态，测试可移植。
func normalizeComparePath(p string, windowsSemantics bool) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if windowsSemantics {
		p = strings.ReplaceAll(p, "\\", "/")
	}
	cleaned := slashClean(p)
	if !isAbsoluteSlashPath(cleaned) {
		return ""
	}
	return cleaned
}

// slashClean 以 '/' 为唯一分隔符的词法清理：解析 . / .. 段、收敛重复与尾部
// 分隔符（保持输入的相对/绝对形态——盘符根 D:/ 收敛为 D:、POSIX 根 / 保持
// /）。仅服务于路径比较域，不触碰文件系统。
func slashClean(p string) string {
	abs := strings.HasPrefix(p, "/")
	segs := strings.Split(p, "/")
	out := make([]string, 0, len(segs))
	for _, seg := range segs {
		switch {
		case seg == "" || seg == ".":
			// 重复/首尾分隔符与当前目录段：跳过
		case seg == "..":
			if len(out) > 0 {
				out = out[:len(out)-1] // 绝对形态越根的 .. 收敛回根；相对形态随后被绝对性检查拒绝，收敛结果无消费方
			}
		default:
			out = append(out, seg)
		}
	}
	cleaned := strings.Join(out, "/")
	if abs {
		return "/" + cleaned
	}
	return cleaned
}

// isAbsoluteSlashPath 判定 '/' 形态路径是否绝对：POSIX 根开头，或 Windows
// 盘符前缀（形如 C:/，含 //server/share 的 UNC 形态——首字符即 '/'）。
func isAbsoluteSlashPath(p string) bool {
	if strings.HasPrefix(p, "/") {
		return true
	}
	return len(p) >= 2 && p[1] == ':'
}

// ResidentAgentSessions 列出驻留在 root 内的自建智能体会话（P-20261006-36）：
// kind=agent、免项目绑定（ProjectID 空——绑定会话由删除级联的 ProjectID 分支
// 覆盖，双重过滤防重叠计数）、创建目录（Path）位于项目根内。external 接管
// 会话不参与：其归属是用户自管的 tmux 会话，本系统「关闭」对它只是解除接管
// （closeSession 分流），项目删除不该碰；且接管会话不自动重启恢复，无孤儿
// tab 问题。Kind/Origin/Path 均为创建期写入的不可变字段，注册进 Manager 后
// 只读，无需持锁（与删除级联裸读 ProjectID 同口径）。
func (m *Manager) ResidentAgentSessions(root string) []*Session {
	var out []*Session
	for _, s := range m.ListSessions() {
		if s.Kind != KindAgent || s.Origin == OriginExternal || s.ProjectID != "" {
			continue
		}
		if pathResidesIn(s.Path, root) {
			out = append(out, s)
		}
	}
	return out
}
