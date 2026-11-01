package agentops

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// 主机环境事实分节：终端里运行的智能体（claude/codex/dsh 或用户手敲命令）对
// 「这台机器的 SSH/Git 配置在哪」没有任何先验知识——git clone git@... 时不知道
// 已配置的密钥与主机别名，还要用户人工提示。本节把这些事实写进操作手册/Skill，
// 随 InstallSkillDocs 安装、/ops-manual 全文输出。
//
// 安全边界：只收集路径、文件名、Host 别名、配置存在性等事实，
// 不读取私钥内容，不输出 known_hosts 主机清单细节。

func init() { RegisterSection(hostEnvSection()) }

// hostEnvSection 启动期采集主机事实构造分节（重启后重新采集）
func hostEnvSection() Section {
	var sb strings.Builder
	sb.WriteString(" - 本机运行环境（终端命令与 git 操作都在这台机器上执行）：\n")
	sb.WriteString("  - 系统: " + runtime.GOOS + "/" + runtime.GOARCH)
	if h, err := os.Hostname(); err == nil && h != "" {
		sb.WriteString("  主机名: " + h)
	}
	if home, err := os.UserHomeDir(); err == nil {
		sb.WriteString("  HOME: " + home)
		writeGitIdentityFact(&sb, home)
		writeSSHFacts(&sb, home)
	} else {
		sb.WriteString("  HOME: 不可知（UserHomeDir 失败）")
	}
	sb.WriteString("\n  - git clone 的远程地址：配置了 SSH 密钥的仓库直接用 git@host:... 形式，")
	sb.WriteString("密钥由 ssh 自动选取（默认密钥或 ~/.ssh/config 中该 Host 对应的 IdentityFile），无需 ssh-agent，也无需新建密钥\n")
	sb.WriteString("  - 禁止在未询问用户的情况下生成新 SSH 密钥或修改 ~/.ssh/config")

	return Section{
		ID:      "host-env",
		Title:   "主机环境（SSH/Git 事实）",
		Order:   8, // 内置能力域（projects=10 起）之前的先导上下文；预留 <8 给测试节
		Summary: "本机系统/SSH 密钥/ssh config 主机别名/git 全局配置——git clone 前先读本节",
		Body:    sb.String(),
	}
}

// writeGitIdentityFact 追加 Git 全局身份配置事实（user.name/email 是否已设置；
// 只报存在性，值让智能体 `git config --global --get` 自查）
func writeGitIdentityFact(sb *strings.Builder, home string) {
	path := filepath.Join(home, ".gitconfig")
	data, err := os.ReadFile(path) //nolint:gosec // 路径由 UserHomeDir 拼接，非用户输入
	if err != nil {
		sb.WriteString("\n  - Git 全局配置: 不存在——首次 commit 前需设置 user.name/email（先询问用户）")
		return
	}
	inUser := false
	hasName, hasEmail := false, false
	for _, line := range strings.Split(string(data), "\n") {
		t := strings.TrimSpace(line)
		if i := strings.Index(t, "#"); i == 0 {
			continue
		}
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			inUser = strings.EqualFold(strings.TrimSpace(t[1:len(t)-1]), "user")
			continue
		}
		if !inUser {
			continue
		}
		lower := strings.ToLower(t)
		if strings.HasPrefix(lower, "name") {
			hasName = true
		} else if strings.HasPrefix(lower, "email") {
			hasEmail = true
		}
	}
	status := func(ok bool) string {
		if ok {
			return "已设置"
		}
		return "未设置"
	}
	sb.WriteString("\n  - Git 全局配置: " + path +
		"（user.name " + status(hasName) + "，user.email " + status(hasEmail) + "）")
}

// writeSSHFacts 追加 ~/.ssh 事实：密钥文件名、config Host 别名、agent 可用性
func writeSSHFacts(sb *strings.Builder, home string) {
	sshDir := filepath.Join(home, ".ssh")
	entries, err := os.ReadDir(sshDir)
	if err != nil {
		sb.WriteString("\n  - SSH: " + sshDir + " 不存在或不可读——本机未配置 SSH 密钥，clone 私有仓库需先用 HTTPS")
		return
	}

	var privKeys, configNames []string
	knownHosts := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		switch {
		case strings.HasSuffix(lower, ".pub"):
			// 公钥与同名私钥成对，私钥名单已覆盖，不重复输出
		case lower == "config" || strings.HasPrefix(lower, "config."):
			configNames = parseSSHConfigHosts(filepath.Join(sshDir, name))
		case strings.HasPrefix(lower, "known_hosts"):
			knownHosts = true // known_hosts 及 .old/.bak 等衍生
		case strings.HasPrefix(lower, "authorized_keys"):
			// 授权公钥清单，非密钥对，跳过
		case strings.HasPrefix(lower, "id_") ||
			strings.HasSuffix(lower, ".pem") || strings.HasSuffix(lower, ".key"):
			// 私钥候选（约定命名）：只记文件名，不读取内容；
			// 其余无名文件（known_hosts.old 等）不算私钥，避免误导
			privKeys = append(privKeys, name)
		}
	}

	sb.WriteString("\n  - SSH 密钥目录: " + sshDir + "（git@ 形式的 clone/push 直接可用）")
	if len(privKeys) > 0 {
		sb.WriteString("\n    - 私钥文件: " + strings.Join(privKeys, "、"))
	} else {
		sb.WriteString("\n    - 未发现私钥文件（clone 私有仓库需 HTTPS 或询问用户）")
	}
	if knownHosts {
		sb.WriteString("\n    - known_hosts 已有主机记录（常见主机此前连接过）")
	}
	if len(configNames) > 0 {
		sb.WriteString("\n    - ~/.ssh/config 已配置 Host 别名: " + strings.Join(configNames, "、") +
			"（clone 别名仓库用别名作 host；`ssh -G <别名>` 可查实际参数）")
	}
	if os.Getenv("SSH_AUTH_SOCK") != "" || os.Getenv("SSH_AGENT_PID") != "" {
		sb.WriteString("\n    - ssh-agent 可用（SSH_AUTH_SOCK 已设置）")
	}
}

// parseSSHConfigHosts 提取 ~/.ssh/config 的 Host 别名（仅别名，剔除通配符模式；
// 解析失败返回空——config 存在本身已在调用侧体现）
func parseSSHConfigHosts(path string) []string {
	data, err := os.ReadFile(path) //nolint:gosec // 路径由 UserHomeDir 拼接，非用户输入
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var names []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if i := strings.Index(line, "#"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		lower := strings.ToLower(line)
		if !strings.HasPrefix(lower, "host ") {
			continue
		}
		for _, f := range strings.Fields(line[5:]) {
			if f == "*" || strings.ContainsAny(f, "*?!") || seen[f] {
				continue
			}
			seen[f] = true
			names = append(names, f)
		}
		if len(names) >= 20 {
			break // 别名极多的环境截断，手册保持精简
		}
	}
	return names
}

// HostEnvSummary 诊断用的一句话环境摘要（预留外部调用）
func HostEnvSummary() string {
	home, _ := os.UserHomeDir()
	return fmt.Sprintf("%s/%s home=%s", runtime.GOOS, runtime.GOARCH, home)
}
