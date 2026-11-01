package git

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// TaskItem 任务运行器返回的单个任务
type TaskItem struct {
	Source  string `json:"source"`  // 任务来源标识：npm/make/maven/gradle/go/cargo/python/just/taskfile/vscode/scripts
	Name    string `json:"name"`    // 任务显示名
	Command string `json:"command"` // 实际执行的命令
	Cwd     string `json:"cwd"`     // 任务所在子目录（相对项目根，""表示根目录）
}

// manifestPriority 控制同一目录内多 manifest 的展示顺序
var sourceOrder = map[string]int{
	"npm":      1,
	"maven":    2,
	"gradle":   3,
	"go":       4,
	"cargo":    5,
	"python":   6,
	"make":     7,
	"just":     8,
	"taskfile": 9,
	"vscode":   10,
	"scripts":  11,
}

// DetectTasks 扫描项目根 + 一级子目录，识别多种任务 manifest
// 设计：避免 404，统一返回结构化任务列表；前端只发一次请求
func DetectTasks(repoPath string) ([]TaskItem, error) {
	var tasks []TaskItem

	// 收集要扫描的目录：根 + 一级子目录
	dirs := []string{""}
	entries, err := os.ReadDir(repoPath)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		// 跳过隐藏目录、node_modules、vendor、build 产物
		if strings.HasPrefix(name, ".") {
			continue
		}
		if name == "node_modules" || name == "vendor" || name == "target" || name == "dist" || name == "build" || name == "out" {
			continue
		}
		dirs = append(dirs, name)
	}

	seen := make(map[string]bool) // 去重键：source|cwd|name
	for _, sub := range dirs {
		absDir := repoPath
		if sub != "" {
			absDir = filepath.Join(repoPath, sub)
		}
		dirTasks := detectTasksInDir(absDir)
		for _, t := range dirTasks {
			t.Cwd = sub // 相对项目根的子目录
			key := t.Source + "|" + t.Cwd + "|" + t.Name
			if seen[key] {
				continue
			}
			seen[key] = true
			tasks = append(tasks, t)
		}
	}

	// 按 source 优先级排序，同 source 内按目录、名称排序
	sort.SliceStable(tasks, func(i, j int) bool {
		si, sj := sourceOrder[tasks[i].Source], sourceOrder[tasks[j].Source]
		if si != sj {
			return si < sj
		}
		if tasks[i].Cwd != tasks[j].Cwd {
			return tasks[i].Cwd < tasks[j].Cwd
		}
		return tasks[i].Name < tasks[j].Name
	})

	return tasks, nil
}

// detectTasksInDir 解析单个目录内的所有 manifest
func detectTasksInDir(dir string) []TaskItem {
	var out []TaskItem

	// npm: package.json
	if t := parseNPM(dir); t != nil {
		out = append(out, t...)
	}
	// Makefile
	if t := parseMake(dir); t != nil {
		out = append(out, t...)
	}
	// Maven: pom.xml
	if t := parseMaven(dir); t != nil {
		out = append(out, t...)
	}
	// Gradle: build.gradle / build.gradle.kts
	if t := parseGradle(dir); t != nil {
		out = append(out, t...)
	}
	// Go: go.mod
	if t := parseGo(dir); t != nil {
		out = append(out, t...)
	}
	// Cargo: Cargo.toml
	if t := parseCargo(dir); t != nil {
		out = append(out, t...)
	}
	// Python: pyproject.toml / setup.py
	if t := parsePython(dir); t != nil {
		out = append(out, t...)
	}
	// Just: Justfile / justfile
	if t := parseJust(dir); t != nil {
		out = append(out, t...)
	}
	// Taskfile: Taskfile.yml / .yaml
	if t := parseTaskfile(dir); t != nil {
		out = append(out, t...)
	}
	// VS Code: .vscode/tasks.json
	if t := parseVSCode(dir); t != nil {
		out = append(out, t...)
	}
	// scripts/ 目录
	if t := parseScriptsDir(dir); t != nil {
		out = append(out, t...)
	}

	return out
}

// fileExists 判断文件是否存在
func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// readFileSmall 读取小文件（限制 1MB 防止恶意大文件）
func readFileSmall(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > 1024*1024 {
		return "", nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// parseNPM 解析 package.json 的 scripts 字段
func parseNPM(dir string) []TaskItem {
	path := filepath.Join(dir, "package.json")
	if !fileExists(path) {
		return nil
	}
	content, err := readFileSmall(path)
	if err != nil {
		return nil
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal([]byte(content), &pkg); err != nil {
		return nil
	}
	if len(pkg.Scripts) == 0 {
		return nil
	}
	// 按名称稳定排序
	keys := make([]string, 0, len(pkg.Scripts))
	for k := range pkg.Scripts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]TaskItem, 0, len(keys))
	for _, k := range keys {
		cmd := pkg.Scripts[k]
		if cmd == "" {
			continue
		}
		out = append(out, TaskItem{
			Source:  "npm",
			Name:    k,
			Command: "npm run " + k,
		})
	}
	return out
}

// makeTargetRe 匹配 Makefile target 行：name 后跟冒号
// 变量赋值（name:=value 或 name ::= value）通过后置代码排除
var makeTargetRe = regexp.MustCompile(`^([a-zA-Z0-9_.\-]+)\s*:(.*)$`)

// parseMake 解析 Makefile / makefile / GNUmakefile
func parseMake(dir string) []TaskItem {
	var path string
	for _, name := range []string{"Makefile", "makefile", "GNUmakefile"} {
		if p := filepath.Join(dir, name); fileExists(p) {
			path = p
			break
		}
	}
	if path == "" {
		return nil
	}
	content, err := readFileSmall(path)
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var out []TaskItem
	for _, raw := range strings.Split(content, "\n") {
		// 跳过 tab 开头的配方行
		if strings.HasPrefix(raw, "\t") {
			continue
		}
		m := makeTargetRe.FindStringSubmatch(raw)
		if m == nil {
			continue
		}
		target := m[1]
		rest := m[2]
		// 排除变量赋值：:= ::= += ?=（rest 以 = 开头）
		if strings.HasPrefix(rest, "=") {
			continue
		}
		// 跳过内置 target
		if strings.HasPrefix(target, ".") {
			continue
		}
		if seen[target] {
			continue
		}
		seen[target] = true
		out = append(out, TaskItem{
			Source:  "make",
			Name:    target,
			Command: "make " + target,
		})
	}
	return out
}

// parseMaven 解析 pom.xml，提供标准 lifecycle 任务
// Maven 不易静态解析所有可用 goal（依赖 plugins），故提供业界最常用的 7 个 lifecycle 命令
func parseMaven(dir string) []TaskItem {
	if !fileExists(filepath.Join(dir, "pom.xml")) {
		return nil
	}
	// 检测是否为 Spring Boot 项目（pom.xml 中包含 spring-boot-maven-plugin）
	isSpring := false
	if content, err := readFileSmall(filepath.Join(dir, "pom.xml")); err == nil {
		if strings.Contains(content, "spring-boot-maven-plugin") {
			isSpring = true
		}
	}
	cmds := []struct {
		name string
		cmd  string
	}{
		{"compile", "mvn compile"},
		{"test", "mvn test"},
		{"package", "mvn package -DskipTests"},
		{"install", "mvn install -DskipTests"},
		{"clean", "mvn clean"},
		{"verify", "mvn verify"},
	}
	if isSpring {
		cmds = append(cmds, struct {
			name string
			cmd  string
		}{"run", "mvn spring-boot:run"})
	} else {
		cmds = append(cmds, struct {
			name string
			cmd  string
		}{"exec", "mvn exec:java"})
	}
	out := make([]TaskItem, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, TaskItem{Source: "maven", Name: c.name, Command: c.cmd})
	}
	return out
}

// parseGradle 解析 build.gradle / build.gradle.kts
// Gradle 同样不易静态列出所有任务，提供业界最常用的标准任务
func parseGradle(dir string) []TaskItem {
	var found bool
	if fileExists(filepath.Join(dir, "build.gradle")) || fileExists(filepath.Join(dir, "build.gradle.kts")) {
		found = true
	}
	if !found {
		return nil
	}
	// 检测是否为 Spring Boot
	isSpring := false
	for _, name := range []string{"build.gradle", "build.gradle.kts"} {
		if content, err := readFileSmall(filepath.Join(dir, name)); err == nil {
			if strings.Contains(content, "org.springframework.boot") || strings.Contains(content, "spring-boot") {
				isSpring = true
			}
			break
		}
	}
	cmds := []struct {
		name string
		cmd  string
	}{
		{"build", "gradle build"},
		{"assemble", "gradle assemble"},
		{"compileJava", "gradle compileJava"},
		{"test", "gradle test"},
		{"check", "gradle check"},
		{"clean", "gradle clean"},
		{"tasks", "gradle tasks --all"},
	}
	if isSpring {
		cmds = append(cmds, struct {
			name string
			cmd  string
		}{"bootRun", "gradle bootRun"})
	}
	out := make([]TaskItem, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, TaskItem{Source: "gradle", Name: c.name, Command: c.cmd})
	}
	return out
}

// parseGo 解析 go.mod，提供标准 Go 任务
func parseGo(dir string) []TaskItem {
	if !fileExists(filepath.Join(dir, "go.mod")) {
		return nil
	}
	cmds := []struct {
		name string
		cmd  string
	}{
		{"run", "go run ."},
		{"build", "go build ./..."},
		{"test", "go test ./..."},
		{"vet", "go vet ./..."},
		{"fmt", "go fmt ./..."},
		{"mod tidy", "go mod tidy"},
	}
	out := make([]TaskItem, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, TaskItem{Source: "go", Name: c.name, Command: c.cmd})
	}
	return out
}

// parseCargo 解析 Cargo.toml，提供标准 Rust 任务
func parseCargo(dir string) []TaskItem {
	if !fileExists(filepath.Join(dir, "Cargo.toml")) {
		return nil
	}
	cmds := []struct {
		name string
		cmd  string
	}{
		{"run", "cargo run"},
		{"build", "cargo build"},
		{"test", "cargo test"},
		{"check", "cargo check"},
		{"fmt", "cargo fmt"},
		{"clippy", "cargo clippy"},
	}
	out := make([]TaskItem, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, TaskItem{Source: "cargo", Name: c.name, Command: c.cmd})
	}
	return out
}

// parsePython 解析 pyproject.toml / setup.py
// PEP 621 / Poetry / setup.py 都尝试解析 entry points
func parsePython(dir string) []TaskItem {
	var out []TaskItem

	// pyproject.toml
	if fileExists(filepath.Join(dir, "pyproject.toml")) {
		// 默认任务
		out = append(out,
			TaskItem{Source: "python", Name: "install", Command: "pip install -e ."},
			TaskItem{Source: "python", Name: "test", Command: "pytest"},
		)
		// 尝试解析 [tool.poetry.scripts] 和 [project.scripts]
		if content, err := readFileSmall(filepath.Join(dir, "pyproject.toml")); err == nil {
			scripts := extractTomlScripts(content)
			names := make([]string, 0, len(scripts))
			for n := range scripts {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				out = append(out, TaskItem{
					Source:  "python",
					Name:    n,
					Command: scripts[n],
				})
			}
		}
		return out
	}

	// setup.py
	if fileExists(filepath.Join(dir, "setup.py")) {
		out = append(out,
			TaskItem{Source: "python", Name: "install", Command: "pip install -e ."},
			TaskItem{Source: "python", Name: "test", Command: "python setup.py test"},
			TaskItem{Source: "python", Name: "build", Command: "python setup.py build"},
		)
		return out
	}

	// 仅有 requirements.txt 也提供 install
	if fileExists(filepath.Join(dir, "requirements.txt")) {
		return []TaskItem{
			{Source: "python", Name: "install", Command: "pip install -r requirements.txt"},
		}
	}

	return nil
}

// extractTomlScripts 从 pyproject.toml 内容中提取 [tool.poetry.scripts] 和 [project.scripts] 段
// 简单行解析：扫描 section 头，匹配目标段后逐行收集 key = "value"
func extractTomlScripts(content string) map[string]string {
	out := make(map[string]string)
	lines := strings.Split(content, "\n")
	inTarget := false
	for _, raw := range lines {
		trim := strings.TrimSpace(raw)
		// section 头
		if strings.HasPrefix(trim, "[") {
			inTarget = trim == "[tool.poetry.scripts]" || trim == "[project.scripts]"
			continue
		}
		if !inTarget {
			continue
		}
		// key = "value" 形式
		eq := strings.Index(trim, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(trim[:eq])
		val := strings.TrimSpace(trim[eq+1:])
		// 去掉两侧引号
		val = strings.Trim(val, `"'`)
		if key == "" || val == "" {
			continue
		}
		out[key] = val
	}
	return out
}

// justRecipeRe 匹配 Justfile recipe 行：name: param1 param2
var justRecipeRe = regexp.MustCompile(`^([a-zA-Z0-9_\-]+)\s*:`)

// parseJust 解析 Justfile / justfile
func parseJust(dir string) []TaskItem {
	var path string
	for _, name := range []string{"Justfile", "justfile", ".justfile"} {
		if p := filepath.Join(dir, name); fileExists(p) {
			path = p
			break
		}
	}
	if path == "" {
		return nil
	}
	content, err := readFileSmall(path)
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var out []TaskItem
	for _, raw := range strings.Split(content, "\n") {
		// 跳过赋值行（key := value）和注释
		if strings.Contains(raw, ":=") {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(raw), "#") {
			continue
		}
		m := justRecipeRe.FindStringSubmatch(raw)
		if m == nil {
			continue
		}
		name := m[1]
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, TaskItem{
			Source:  "just",
			Name:    name,
			Command: "just " + name,
		})
	}
	return out
}

// parseTaskfile 解析 Taskfile.yml / .yaml
// 仅做最简解析：提取 "  name:" 形式的任务名（YAML 缩进 2 空格）
func parseTaskfile(dir string) []TaskItem {
	var path string
	for _, name := range []string{"Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"} {
		if p := filepath.Join(dir, name); fileExists(p) {
			path = p
			break
		}
	}
	if path == "" {
		return nil
	}
	content, err := readFileSmall(path)
	if err != nil {
		return nil
	}
	var out []TaskItem
	inTasks := false
	for _, raw := range strings.Split(content, "\n") {
		trim := strings.TrimSpace(raw)
		// tasks: 段开始
		if trim == "tasks:" {
			inTasks = true
			continue
		}
		if !inTasks {
			continue
		}
		// 顶层其他段（顶格 key:）则结束 tasks 段
		if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") && strings.HasSuffix(trim, ":") {
			inTasks = false
			continue
		}
		// 形如 "  name:" 或 "  name: { ... }"
		// 缩进 2 空格、非进一步缩进
		if !strings.HasPrefix(raw, "  ") || strings.HasPrefix(raw, "    ") {
			continue
		}
		// 提取 name
		head := strings.TrimRight(trim, ":")
		// 处理 "name: { ... }" 内联
		if idx := strings.Index(head, ":"); idx >= 0 {
			head = head[:idx]
		}
		head = strings.TrimSpace(head)
		// 跳过带引号的或空的
		if head == "" || strings.HasPrefix(head, "#") {
			continue
		}
		// 去掉 YAML key 的引号
		head = strings.Trim(head, `"'`)
		if head == "" {
			continue
		}
		out = append(out, TaskItem{
			Source:  "taskfile",
			Name:    head,
			Command: "task " + head,
		})
	}
	return out
}

// parseVSCode 解析 .vscode/tasks.json
func parseVSCode(dir string) []TaskItem {
	path := filepath.Join(dir, ".vscode", "tasks.json")
	if !fileExists(path) {
		return nil
	}
	content, err := readFileSmall(path)
	if err != nil {
		return nil
	}
	// tasks.json 支持注释（JSONC），简单剥除 // 行注释
	cleaned := stripJSONCComments(content)
	// 宽松解析：只取 tasks 数组中 label + command 字段
	var doc struct {
		Tasks []struct {
			Label   string `json:"label"`
			Command string `json:"command"`
			Type    string `json:"type"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(cleaned), &doc); err != nil {
		return nil
	}
	var out []TaskItem
	for _, t := range doc.Tasks {
		label := strings.TrimSpace(t.Label)
		if label == "" {
			continue
		}
		cmd := strings.TrimSpace(t.Command)
		// shell 类型保留原命令；process 类型加引号包裹参数
		out = append(out, TaskItem{
			Source:  "vscode",
			Name:    label,
			Command: cmd,
		})
	}
	return out
}

// stripJSONCComments 移除 JSONC 中的行注释和块注释，输出可被 json.Unmarshal 解析的字符串
func stripJSONCComments(s string) string {
	var b strings.Builder
	inStr := false
	strQuote := byte(0)
	i := 0
	for i < len(s) {
		c := s[i]
		if inStr {
			b.WriteByte(c)
			if c == '\\' && i+1 < len(s) {
				b.WriteByte(s[i+1])
				i += 2
				continue
			}
			if c == strQuote {
				inStr = false
			}
			i++
			continue
		}
		// 字符串开始
		if c == '"' {
			inStr = true
			strQuote = '"'
			b.WriteByte(c)
			i++
			continue
		}
		// 行注释
		if c == '/' && i+1 < len(s) && s[i+1] == '/' {
			for i < len(s) && s[i] != '\n' {
				i++
			}
			continue
		}
		// 块注释
		if c == '/' && i+1 < len(s) && s[i+1] == '*' {
			i += 2
			for i+1 < len(s) && !(s[i] == '*' && s[i+1] == '/') {
				i++
			}
			i += 2
			if i > len(s) {
				i = len(s)
			}
			continue
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

// parseScriptsDir 列举 scripts/ 目录下的脚本文件
func parseScriptsDir(dir string) []TaskItem {
	scriptsDir := filepath.Join(dir, "scripts")
	info, err := os.Stat(scriptsDir)
	if err != nil || !info.IsDir() {
		return nil
	}
	entries, err := os.ReadDir(scriptsDir)
	if err != nil {
		return nil
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		ext := strings.ToLower(filepath.Ext(name))
		// 仅识别常见脚本扩展名
		if ext != ".sh" && ext != ".bash" && ext != ".zsh" && ext != ".bat" && ext != ".cmd" && ext != ".ps1" {
			continue
		}
		// 跳过隐藏文件
		if strings.HasPrefix(name, ".") {
			continue
		}
		files = append(files, name)
	}
	if len(files) == 0 {
		return nil
	}
	sort.Strings(files)
	out := make([]TaskItem, 0, len(files))
	for _, name := range files {
		ext := strings.ToLower(filepath.Ext(name))
		var cmd string
		base := strings.TrimSuffix(name, filepath.Ext(name))
		switch ext {
		case ".sh", ".bash":
			cmd = "bash scripts/" + name
		case ".zsh":
			cmd = "zsh scripts/" + name
		case ".bat", ".cmd":
			cmd = "scripts\\" + name
		case ".ps1":
			cmd = "pwsh -File scripts/" + name
		default:
			cmd = "./scripts/" + name
		}
		out = append(out, TaskItem{
			Source:  "scripts",
			Name:    base,
			Command: cmd,
		})
	}
	return out
}
