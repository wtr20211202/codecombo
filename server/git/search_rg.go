package git

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"

	"codecombo/server/filepolicy"
	"codecombo/server/userbin"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// ── ripgrep 可选搜索后端（roadmap M5.1）──
//
// 背景：git grep 在 20k 文件仓库冷缓存 1-3.4s（git 本体启动与对象扫描成本），
// rg 同查询约 50-100ms。rg 可用时自动改用 rg（--vimgrep 输出格式与
// git grep 的 path:line:col:content 逐字段一致，复用同一解析器）；
// 无 rg 或 rg 执行失败（非"无匹配"）时自动回退 git grep——行为永不劣化。
// 可用 SC_SEARCH_BACKEND=git-grep 强制走旧后端（排障用）。
// 探测走 userbin（PATH → 用户级常见位置 → 登录 shell 兜底 + TTL 缓存）：
// 守护进程/systemd 的进程 PATH 不含用户级工具链（.cargo/bin、scoop shims、
// npm 全局等），裸 exec.LookPath 会把「已安装」误报为「未安装」而静默降速。
//
// 安全说明：查询词经 argv 列表以 "-e <query>" 传给 rg 子进程（与 git grep
// 传参方式一致），全程无 shell 参与，不存在命令拼接面。

var (
	rgResolveFn = userbin.Resolve // 可注入（测试）
	rgSearchFn  = searchWithRg    // 可注入（测试：假 rg 输出）

	// 探测结果缓存（指针便于测试复位）。rgPath 为解析出的可执行文件全路径：
	// 探测与执行必须用同一来源——userbin 可能在进程 PATH 之外找到 rg
	// （守护进程/systemd 场景），执行若仍拉起裸 "rg" 必然失败而静默回退
	rgOnce = new(sync.Once)
	rgPath string
)

// rgSearchTimeout rg 单次搜索兜底超时：异常路径（网络盘/巨型仓库）不再挂住请求 worker
const rgSearchTimeout = 30 * time.Second

// rgResolved 进程内探测一次 rg 可用性（userbin 自带 TTL 缓存，此处再省掉
// 每次调用的重复探测开销）
func rgResolved() bool {
	rgOnce.Do(func() {
		backend := os.Getenv("CC_SEARCH_BACKEND")
		if backend == "" {
			backend = os.Getenv("SC_SEARCH_BACKEND") // 旧名兼容双读（P-20261025-1）
		}
		if strings.EqualFold(backend, "git-grep") {
			return
		}
		if p, ok := rgResolveFn("rg"); ok {
			rgPath = p
		}
	})
	return rgPath != ""
}

// rgExecutable 拉起 rg 子进程用的可执行路径（探测失败时不会走到搜索，
// 兜底裸名仅为防御）
func rgExecutable() string {
	if rgPath != "" {
		return rgPath
	}
	return "rg"
}

// rgSearchArgs 翻译 SearchOptions 为 rg 参数。
// 正则模式映射：git grep -E（POSIX ERE）→ rg 默认引擎（Rust regex，
// 常用 ERE 语法超集）；字面量 -F、忽略大小写 -i、整词 -w 两边语义一致。
// --hidden 对齐 git grep --untracked 的"未跟踪文件也搜"语义
// （仍遵守 .gitignore，与 git grep 不搜 ignored 一致）
func rgSearchArgs(query string, opts SearchOptions) []string {
	args := []string{
		"--vimgrep", // path:line:column:text，与解析器约定一致
		"--no-messages",
		"--color", "never",
		"--path-separator", "/", // 对齐 git grep 的正斜杠路径输出
		"--hidden",
		// --hidden 会把 .git 内部一并纳入搜索——git grep 永不搜 .git；
		// 显式排除保持「工作区文件」语义对齐，替换类操作也不会改写仓库元数据
		"--glob", "!.git/**",
	}
	if !opts.CaseSensitive {
		args = append(args, "-i")
	}
	if opts.WholeWord {
		args = append(args, "-w")
	}
	if !opts.UseRegex {
		args = append(args, "-F")
	}
	args = append(args, "-e", query)
	if opts.FilePattern != "" {
		args = append(args, "-g", opts.FilePattern)
	}
	// 不传根路径参数：rg 默认搜当前目录且输出相对路径不带 "./" 前缀，
	// 与 git grep 的路径输出形态一致
	return args
}

// runRg 执行 rg 子进程并返回原始 stdout（30s 兜底超时：异常路径/网络盘/
// 巨型仓库不挂住请求 worker；exit 1 = 无匹配归空输出，exit 2+ = 真错误由
// 调用方回退）。固定字面量 "rg" 探测缓存路径 + 纯 argv 列表传参，无 shell、
// 无字符串拼接命令行
func runRg(repoPath string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), rgSearchTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, rgExecutable(), args...)
	cmd.Dir = repoPath
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("rg timed out after %v", rgSearchTimeout)
		}
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return "", nil
		}
		return "", err
	}
	return stdout.String(), nil
}

// searchWithRg 执行 rg 并解析（解析器与 git grep 后端共用；无匹配保持
// 既有契约返回空切片而非 nil——JSON 序列化为 [] 而非 null）
func searchWithRg(repoPath string, query string, opts SearchOptions, maxResults int) ([]SearchMatch, error) {
	out, err := runRg(repoPath, rgSearchArgs(query, opts))
	if err != nil {
		return nil, err
	}
	matches := parseGrepOutputLimit(filepolicy.DecodeDisplay(out), query, opts.CaseSensitive, maxResults)
	if matches == nil {
		matches = []SearchMatch{}
	}
	return matches, nil
}

// searchBackend 选择搜索后端并执行（rg 优先，失败回退 git grep）。
// 返回值附带实际使用的后端名（日志/测试观测用）
func searchBackend(repoPath, query string, opts SearchOptions, maxResults int) ([]SearchMatch, error, string) {
	if rgResolved() {
		matches, err := rgSearchFn(repoPath, query, opts, maxResults)
		if err == nil {
			return matches, nil, "rg"
		}
		slog.Debug("search: rg failed, falling back to git grep", "err", err)
	}
	matches, err := searchWithGitGrep(repoPath, query, opts, maxResults)
	return matches, err, "git-grep"
}
