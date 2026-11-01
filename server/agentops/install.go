package agentops

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// InstallSkillDocs 把本系统操作手册安装到各运行时的指令读取位置（启动时调用，
// 用户无感知）。幂等：内容一致不重写；清理已下线的参考文件。
//
//   - claude: ~/.claude/skills/codecombo-ops/（SKILL.md + references/ 渐进式披露）
//     + ~/.claude/CLAUDE.md 常驻标记块——技能加载靠 description 语义匹配，用户未
//     提及本系统的普通任务可能不触发；会话自命名这类「任何任务都适用」的约定
//     必须走常驻通道，不依赖触发
//   - codex:  ~/.codex/AGENTS.md 全局指令（标记块包裹，保留用户自有内容；AGENTS.md
//     每次会话必载，天然常驻）
//   - dsh:    无文档化的全局指令注入入口，跳过（CC_BASE_URL/CC_LOCK_TOKEN
//     环境变量已注入，功能可用性不受影响）
//
// 任一运行时安装失败不影响其他运行时；返回聚合错误仅供调用方留痕降级
//（受限部署如 SELinux 沙箱下家目录可能不可写）
func InstallSkillDocs() error {
	var errs []string
	if err := installClaudeSkill(); err != nil {
		errs = append(errs, "claude: "+err.Error())
	}
	if err := installClaudeMemory(); err != nil {
		errs = append(errs, "claude memory: "+err.Error())
	}
	if err := installCodexDoc(); err != nil {
		errs = append(errs, "codex: "+err.Error())
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// installClaudeSkill 安装 claude 技能目录（渐进式披露：SKILL.md 索引 +
// references/ 分域细节，Agent 按需读取——入口精简、上下文友好）。
// 内容来自分节注册表——新能力域注册 Section 后此处自动跟随。
// P-20261025-1 技能更名 simple-coding-ops → codecombo-ops：旧目录是本系统
// 管理的生成物（用户不改造），检测到旧目录时整体移除再装新名——双目录并存
// 会让技能触发语义匹配撞出两份同名能力
func installClaudeSkill() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".claude", "skills", "codecombo-ops")
	legacyDir := filepath.Join(home, ".claude", "skills", "simple-coding-ops")
	if _, err := os.Stat(legacyDir); err == nil {
		_ = os.RemoveAll(legacyDir)
	}
	if err := os.MkdirAll(filepath.Join(dir, "references"), 0o755); err != nil {
		return err
	}
	skill := SkillMarkdown("")
	path := filepath.Join(dir, "SKILL.md")
	if existing, err := os.ReadFile(path); err != nil || string(existing) != skill {
		if err := os.WriteFile(path, []byte(skill), 0o644); err != nil {
			return err
		}
	}

	// 写入/更新参考文件，并记录有效文件名用于清理
	valid := map[string]bool{}
	for _, ref := range SkillReferences("") {
		refPath := filepath.Join(dir, filepath.FromSlash(ref.Path))
		valid[filepath.Base(ref.Path)] = true
		if existing, err := os.ReadFile(refPath); err == nil && string(existing) == ref.Content {
			continue
		}
		if err := os.WriteFile(refPath, []byte(ref.Content), 0o644); err != nil {
			return err
		}
	}

	// 清理陈旧参考文件（注册表移除能力域后残留）
	entries, err := os.ReadDir(filepath.Join(dir, "references"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		if !valid[e.Name()] {
			_ = os.Remove(filepath.Join(dir, "references", e.Name()))
		}
	}
	return nil
}

// docBlockMarkers 标记块边界（幂等更新依赖；claude CLAUDE.md 与 codex AGENTS.md 共用）。
// legacyBlockStart/End 为 P-20261025-1 技能更名前的旧标记——writeMarkedBlock 对
// 新旧两套标记都能识别替换（否则存量用户文件里旧块不消失、新块再追加成重复）
const (
	docBlockStart    = "<!-- codecombo-ops:start -->"
	docBlockEnd      = "<!-- codecombo-ops:end -->"
	legacyBlockStart = "<!-- simple-coding-ops:start -->"
	legacyBlockEnd   = "<!-- simple-coding-ops:end -->"
)

// writeMarkedBlock 把 content 包进标记块写入 path：无块则追加，已有则原位替换——
// 用户自有内容始终保留；内容一致不重写（幂等）。旧标记块（更名前）同样识别并
// 原位替换为新标记块，兼容期一次写入即完成迁移
func writeMarkedBlock(path, content string) error {
	block := docBlockStart + "\n\n" + content + "\n" + docBlockEnd + "\n"

	existing, err := os.ReadFile(path)
	if err != nil {
		// 文件不存在：直接创建（仅含本系统块）
		return os.WriteFile(path, []byte(block), 0o644)
	}
	c := string(existing)
	start, end := strings.Index(c, docBlockStart), strings.Index(c, docBlockEnd)
	if start < 0 || end <= start {
		// 新标记缺失：尝试旧标记（技能更名前的存量块）
		start, end = strings.Index(c, legacyBlockStart), strings.Index(c, legacyBlockEnd)
	}
	if start >= 0 && end > start {
		// 原位替换标记块（保留 end 标记之后的用户内容）
		updated := c[:start] + block + c[end+len(docBlockEnd):]
		if strings.TrimRight(updated, "\n") == strings.TrimRight(c, "\n") {
			return nil
		}
		return os.WriteFile(path, []byte(updated), 0o644)
	}
	// 无标记块：追加（既有内容与块之间空一行）
	updated := strings.TrimRight(c, "\n") + "\n\n" + block
	return os.WriteFile(path, []byte(updated), 0o644)
}

// installCodexDoc 把操作手册写入 ~/.codex/AGENTS.md 的标记块内
func installCodexDoc() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return writeMarkedBlock(filepath.Join(dir, "AGENTS.md"), SkillMarkdown(""))
}

// claudeMemoryMarkdown ~/.claude/CLAUDE.md 常驻标记块——只放「任何任务都适用」
// 的最小约定（CLAUDE.md 常驻上下文，追求极简）；完整能力走技能目录渐进式披露。
// claude 技能触发依赖 description 语义匹配：用户说「帮我改个 bug」而非「操作
// 工作台」时技能可能不加载，会话自命名因此必须常驻
const claudeMemoryMarkdown = `## Codecombo 宿主机约定

- 会话自命名：环境变量 CC_TERMINAL_ID 存在（即运行在 Codecombo 终端内）时，
  接手任何任务后尽早执行
  curl -s -X PUT "$CC_BASE_URL/api/terminals/$CC_TERMINAL_ID/rename" -H "X-Lock-Token: $CC_LOCK_TOKEN" -H "Content-Type: application/json" -d '{"name":"任务简称"}'
  把所在终端会话重命名为任务简称（≤20 字）——用户靠会话名区分并行任务；
  CC_TERMINAL_ID 不存在则跳过本条。
- 操作本系统（项目/文件/Git/终端/远程主机/部署等）前先读技能 codecombo-ops
  （~/.claude/skills/codecombo-ops/SKILL.md），内有完整 API 手册与工作流约定。`

// installClaudeMemory 把常驻约定写入 ~/.claude/CLAUDE.md 标记块
//（claude 用户级记忆每次会话必载——技能触发不可靠时的兜底通道）
func installClaudeMemory() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return writeMarkedBlock(filepath.Join(dir, "CLAUDE.md"), claudeMemoryMarkdown)
}
