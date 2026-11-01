package terminal

import (
	"regexp"
	"strings"
)

// 高危命令影响面预检（P-20261005-191）——命令串 → 结构化判定。
// 本文件只做纯模式匹配（零 IO，可独立单测）：动态影响面计数（rm 路径 glob
// 展开的文件数/总大小、reset/clean 对 git status 的脏文件/untracked 数）由
// API 层注入（server/api/terminal/command_preview.go），命中判定与计数解耦。
//
// 服务对象有二：前端粘贴链 / palette 命令直达插入链的「影响面确认卡」数据源，
// 以及 agent 执行前自检原语（POST /api/terminals/command-preview，运行书/
// broadcast-write 执行前可先取影响面证据）。
//
// 诚实边界（提案原文注明）：手敲命令不拦——全屏 PTY 的 shell 渲染域无法可靠
// 提取当前输入行，本判定只服务「命令串整体可知」的结构化入口（粘贴块/直达
// 插入），不是通用命令审计。

// RiskLevel 命中档位：danger=不可逆破坏（删除/覆盖历史/强推），warning=
// 覆盖写等需知情但常见的操作。前端据档位选确认卡强度；动态计数全为 0 时
// （如干净树上的 git reset --hard）前端降级为灰提示不弹确认。
type RiskLevel string

const (
	RiskDanger  RiskLevel = "danger"
	RiskWarning RiskLevel = "warning"
)

// RiskMatch 单条模式命中。ID 是模式稳定标识：前端 i18n 文案键尾 + 「确认过
// 的同型命令本会话不再拦」白名单键（同型 = 同 ID，粒度到模式族而非具体命令）。
type RiskMatch struct {
	ID      string    `json:"id"`
	Level   RiskLevel `json:"level"`
	Kind    string    `json:"kind"` // 大类：rm / git / prune / truncate / shred / overwrite
	Segment string    `json:"segment"`
	// Targets 参与动态计数的目标参数（路径/文件通配/重定向目标）。仅可计数的
	// 模式抽取（rm 族/overwrite）；git 族计数走 git status 不需要目标参数
	Targets []string `json:"targets,omitempty"`
}

// maxSegmentLen 展示用片段截断：超长复合命令保留头部供辨认即可
const maxSegmentLen = 200

// maxMatches 单条命令串的命中上限：防病态超长输入撑爆载荷（正常粘贴命中
// 1~3 条；截断即已表达「不止一处高危」）
const maxMatches = 8

// riskPattern 单行模式表条目。matcher 在 trim 过的单条命令段上判定，fields 为
// strings.Fields 分词；返回参与计数的目标参数。新增高危形态 = 表内加一行。
var riskPatterns = []struct {
	id      string
	level   RiskLevel
	kind    string
	matcher func(seg string, fields []string) (targets []string, ok bool)
}{
	{
		id:    "rm-recursive",
		level: RiskDanger,
		kind:  "rm",
		// rm 带递归位（-r/-R/-rf/-fr/-rvf/--recursive…）且确有目标：
		// 目录树整体消失无回头路，即便目标当前是空目录也值得知情
		matcher: func(seg string, fields []string) ([]string, bool) {
			if fields[0] != "rm" {
				return nil, false
			}
			recursive := false
			for _, f := range fields[1:] {
				if f == "--" {
					break
				}
				if strings.HasPrefix(f, "--") {
					if f == "--recursive" {
						recursive = true
					}
					continue
				}
				if strings.HasPrefix(f, "-") && strings.ContainsAny(f[1:], "rR") {
					recursive = true
				}
			}
			targets := nonFlagArgs(fields[1:])
			return targets, recursive && len(targets) > 0
		},
	},
	{
		id:    "rm-force",
		level: RiskDanger,
		kind:  "rm",
		// rm -f（非递归）：单文件即刻消失且抑制确认提示——比普通 rm 更无挽回。
		// 递归形态由 rm-recursive 承接（-rf 同捕两表会双计同一片段）
		matcher: func(seg string, fields []string) ([]string, bool) {
			if fields[0] != "rm" {
				return nil, false
			}
			force, recursive := false, false
			for _, f := range fields[1:] {
				if f == "--" {
					break
				}
				if strings.HasPrefix(f, "--") {
					continue
				}
				if strings.HasPrefix(f, "-") {
					if strings.Contains(f[1:], "f") {
						force = true
					}
					if strings.ContainsAny(f[1:], "rR") {
						recursive = true
					}
				}
			}
			targets := nonFlagArgs(fields[1:])
			return targets, force && !recursive && len(targets) > 0
		},
	},
	{
		id:    "git-reset-hard",
		level: RiskDanger,
		kind:  "git",
		// git reset --hard：tracked 工作区改动整体回滚（untracked 不动）
		matcher: func(seg string, fields []string) ([]string, bool) {
			return nil, isGitSub(fields, "reset") && contains(fields[2:], "--hard")
		},
	},
	{
		id:    "git-checkout-discard",
		level: RiskDanger,
		kind:  "git",
		// git checkout -- <paths> / git checkout .：工作区改动丢弃形态
		//（切分支形态 checkout <branch> 不命中）
		matcher: func(seg string, fields []string) ([]string, bool) {
			if !isGitSub(fields, "checkout") {
				return nil, false
			}
			rest := fields[2:]
			return nil, contains(rest, "--") || contains(rest, ".")
		},
	},
	{
		id:    "git-restore",
		level: RiskDanger,
		kind:  "git",
		// git restore <paths>：checkout -- 的现代等价。--staged 独占只动索引
		//（可重新 add 找回）不算，--staged --worktree 双写仍丢工作区改动
		matcher: func(seg string, fields []string) ([]string, bool) {
			if !isGitSub(fields, "restore") {
				return nil, false
			}
			rest := fields[2:]
			stagedOnly := contains(rest, "--staged") && !contains(rest, "--worktree")
			targets := nonFlagArgs(rest)
			return nil, !stagedOnly && len(targets) > 0
		},
	},
	{
		id:    "git-clean",
		level: RiskDanger,
		kind:  "git",
		// git clean：无 -f 是空操作（git 自身拒绝），带 -f 才真正删除 untracked
		matcher: func(seg string, fields []string) ([]string, bool) {
			if !isGitSub(fields, "clean") {
				return nil, false
			}
			force := false
			for _, f := range fields[2:] {
				if f == "--" {
					break
				}
				if strings.HasPrefix(f, "--") {
					continue
				}
				if strings.HasPrefix(f, "-") && strings.Contains(f[1:], "f") {
					force = true
				}
			}
			targets := nonFlagArgs(fields[2:])
			return targets, force
		},
	},
	{
		id:    "git-push-force",
		level: RiskDanger,
		kind:  "git",
		// git push --force / -f / --force-with-lease：覆盖远端引用。lease 版
		// 有并发防护但同样改写远端历史，同档知情
		matcher: func(seg string, fields []string) ([]string, bool) {
			if !isGitSub(fields, "push") {
				return nil, false
			}
			for _, f := range fields[2:] {
				if f == "--force" || f == "--force-with-lease" || f == "-f" {
					return nil, true
				}
			}
			return nil, false
		},
	},
	{
		id:    "truncate",
		level: RiskDanger,
		kind:  "truncate",
		// truncate -s 0 <files>：文件内容清零（大小截到 0），元数据还在内容没了
		matcher: func(seg string, fields []string) ([]string, bool) {
			if fields[0] != "truncate" {
				return nil, false
			}
			zero := false
			for i, f := range fields[1:] {
				if f == "--" {
					break
				}
				if (f == "-s" || f == "--size") && i+2 < len(fields) && isZeroSize(fields[i+2]) {
					zero = true
				}
				if strings.HasPrefix(f, "--size=") && isZeroSize(strings.TrimPrefix(f, "--size=")) {
					zero = true
				}
			}
			targets := nonFlagArgs(fields[1:])
			return targets, zero && len(targets) > 0
		},
	},
	{
		id:    "shred",
		level: RiskDanger,
		kind:  "shred",
		// shred <files>：原位覆写销毁内容——文件名尚在，数据已不可恢复
		matcher: func(seg string, fields []string) ([]string, bool) {
			if fields[0] != "shred" {
				return nil, false
			}
			targets := nonFlagArgs(fields[1:])
			return targets, len(targets) > 0
		},
	},
	{
		id:    "docker-prune",
		level: RiskDanger,
		kind:  "prune",
		// docker <x> prune：批量清理容器/镜像/卷/构建缓存（volume prune 连
		// 数据卷一起没）。无 -f 时 docker 交互确认，但粘贴进非交互 shell
		//（CI/脚本）会直接通过，仍按知情面处理
		matcher: func(seg string, fields []string) ([]string, bool) {
			if fields[0] != "docker" || len(fields) < 3 {
				return nil, false
			}
			// prune 是末位子命令（flag 可缀尾：system prune -af）——自尾跳过
			// flag 找首个非 flag token 判定
			for i := len(fields) - 1; i > 0; i-- {
				if strings.HasPrefix(fields[i], "-") {
					continue
				}
				return nil, fields[i] == "prune"
			}
			return nil, false
		},
	},
	{
		id:    "overwrite-redirect",
		level: RiskWarning,
		kind:  "overwrite",
		// > file 覆盖重定向：目标文件被静默截断（>> 追加、2>/dev/null 类 fd
		// 重定向不命中）。warning 档——脚本落日志是常见用法，知情即可
		matcher: func(seg string, fields []string) ([]string, bool) {
			m := overwriteRedirectRe.FindStringSubmatch(seg)
			if m == nil {
				return nil, false
			}
			target := m[1]
			if target == "/dev/null" || target == "/dev/stdout" || target == "/dev/stderr" {
				return nil, false
			}
			return []string{target}, true
		},
	},
}

// overwriteRedirectRe 覆盖重定向匹配：`>` 不带 fd 前缀（2>/&> 排除）、
// 不吞 `>>` 追加，目标取紧随 token。段级正则属启发式（引号内 `>` 会误报，
// 误报代价只是一张知情卡，从宽可接受）
var overwriteRedirectRe = regexp.MustCompile(`(?:^|[\s;(])>\s*([^\s|;&>][^\s|;&]*)`)

// isZeroSize truncate 大小参数是否为零值（0 / 0K / 0M / 0G 等后缀形态）
func isZeroSize(v string) bool {
	v = strings.ToUpper(strings.TrimSpace(v))
	if v == "0" {
		return true
	}
	return len(v) == 2 && v[0] == '0' && strings.ContainsRune("BKMGTPE", rune(v[1]))
}

// isGitSub fields 是否 `git <sub>` 形态（容忍 `git -C dir <sub>` 载体参数）
func isGitSub(fields []string, sub string) bool {
	if len(fields) < 2 || fields[0] != "git" {
		return false
	}
	// git 的全局载体参数（-C <dir> / -c k=v）夹在子命令前：跳过后再认子命令
	for i := 1; i < len(fields); i++ {
		f := fields[i]
		switch {
		case f == "-C" || f == "-c":
			i++ // 跳过其参数
		case strings.HasPrefix(f, "-"):
			// git 其他全局 flag（--no-pager 等）：跳过
		default:
			return f == sub
		}
	}
	return false
}

// contains 子串全等查找（fields 规模线性扫即可，不值得为此引入 import 面）
func contains(fields []string, want string) bool {
	for _, f := range fields {
		if f == want {
			return true
		}
	}
	return false
}

// nonFlagArgs 抽取非 flag 位置参数（跳过 - 开头 token 与其相邻值以外的部分；
// 「flag 带值」形态如 -s 0 的值会误入 targets——调用方只把 targets 用于计数
// 预演，多计一个不存在的路径无副作用，从严剔除需完整 flag 语义表不值当）
func nonFlagArgs(fields []string) []string {
	var out []string
	for _, f := range fields {
		if f == "--" {
			continue
		}
		if strings.HasPrefix(f, "-") {
			continue
		}
		out = append(out, f)
	}
	return out
}

// MatchCommandRisk 命令串 → 全部模式命中。命令串按引号感知的 shell 分隔符
// （换行 / ; & && | ||）切段逐段匹配——引号内不切（echo "a|b" 不误分段；
// 反引号/$( ) 内不追求完备，启发式定位）。
func MatchCommandRisk(command string) []RiskMatch {
	var matches []RiskMatch
	for _, seg := range splitCommandSegments(command) {
		fields := strings.Fields(seg)
		if len(fields) == 0 {
			continue
		}
		for _, p := range riskPatterns {
			if len(matches) >= maxMatches {
				return matches
			}
			targets, ok := p.matcher(seg, fields)
			if !ok {
				continue
			}
			matches = append(matches, RiskMatch{
				ID:      p.id,
				Level:   p.level,
				Kind:    p.kind,
				Segment: truncateSegment(seg),
				Targets: targets,
			})
		}
	}
	return matches
}

// truncateSegment 片段展示截断
func truncateSegment(seg string) string {
	seg = strings.TrimSpace(seg)
	if len(seg) <= maxSegmentLen {
		return seg
	}
	return seg[:maxSegmentLen]
}

// maxSummaryLen 审批卡证据摘要的长度上限（多命中复合命令截断，宁短不假）
const maxSummaryLen = 300

// RiskSummary 命中集的一行稳定摘要（审批卡证据增强/日志用，稳定英文短语）：
// 形如 `risk patterns: rm-recursive(rm -rf build); git-reset-hard(git reset --hard)`。
// 空命中返回空串。注意：动态计数不在摘要内（需要 fs/git 面，审批中间件无 cwd
// 上下文）——agent 需要规模数字时自行调 /api/terminals/command-preview
func RiskSummary(matches []RiskMatch) string {
	if len(matches) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("risk patterns: ")
	for i, m := range matches {
		if i > 0 {
			b.WriteString("; ")
		}
		b.WriteString(m.ID)
		b.WriteString("(")
		b.WriteString(m.Segment)
		b.WriteString(")")
	}
	s := b.String()
	if len(s) > maxSummaryLen {
		s = s[:maxSummaryLen]
	}
	return s
}

// splitCommandSegments 引号感知的分段：扫描整串，处于 ' " 引号外时才在
// 分隔符处切开。&&/|| 是双字符分隔符，扫描时先探后一位
func splitCommandSegments(command string) []string {
	var segs []string
	var cur strings.Builder
	inSingle, inDouble := false, false
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			segs = append(segs, s)
		}
		cur.Reset()
	}
	for i := 0; i < len(command); i++ {
		ch := command[i]
		switch {
		case ch == '\'' && !inDouble:
			inSingle = !inSingle
			cur.WriteByte(ch)
		case ch == '"' && !inSingle:
			inDouble = !inDouble
			cur.WriteByte(ch)
		case !inSingle && !inDouble && (ch == '\n' || ch == ';' || ch == '&' || ch == '|'):
			flush()
			// 双字符分隔符（&&/||）把后一位一并吃掉
			if i+1 < len(command) && command[i+1] == ch {
				i++
			}
		default:
			cur.WriteByte(ch)
		}
	}
	flush()
	return segs
}
