package tools

// dsh 升级 / 回退（npm 全局安装语义）与版本 changelog——原 dsh.go「dsh 升级 /
// 回退」「版本 changelog」两节 + prepare/install/rollback 端点整体平移
// （P-20261003-314 纯搬运拆分，逻辑零改动）。semver 比较与 CLI 路径解析原语
// 在 dsh.go，进程重启（restartDshProcess/launchAndWait）在 dsh_launch.go。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

const dshPackage = "@deepseek-ai/dsh"

// dshVersionInfo 注册表版本条目（版本 + 发布时间 ISO8601）
type dshVersionInfo struct {
	Version string `json:"version"`
	Date    string `json:"date"`
}

// npmCmd 配置的 npm 命令（支持带包装前缀，如 `wsl.exe npm`——dsh 装在 WSL、
// SC 跑在 Windows 的拓扑下，注册表查询与升级安装都要进 WSL 执行）
func npmCmd() string {
	if sc := store.Get().Settings.Get(); sc != nil {
		if v := strings.TrimSpace(sc.Server.DshNpmCommand); v != "" {
			return v
		}
	}
	return "npm"
}

// runNpmCmd 执行 npm 子命令（超时强杀，返回 stdout/stderr）。
// 裸 npm 且服务进程无法直接执行时（守护进程/systemd 启动的 PATH 盲区，
// 与 resolveLaunchCommand 处理的 dsh 启动同款问题），回退解析 npm 绝对
// 路径执行，并把 npm 同目录注入子进程 PATH——npm 是 `#!/usr/bin/env node`
// 脚本，服务 PATH 无 node 时直接 exec 必报 exit 127（实测），同目录注入后
// npm→env node→nvm bin 里的 node 成链
func runNpmCmd(timeout time.Duration, args ...string) (string, string, error) {
	parts := strings.Fields(npmCmd())
	if len(parts) == 0 {
		return "", "", fmt.Errorf("npm command is empty")
	}
	var extraPathDir string
	if parts[0] == "npm" {
		if p, dir, ok := resolveNpmExecCached(); ok {
			parts[0] = p
			extraPathDir = dir
		}
	}
	cmd := exec.Command(parts[0], append(parts[1:], args...)...)
	if extraPathDir != "" {
		cmd.Env = append(os.Environ(), "PATH="+extraPathDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return stdout.String(), stderr.String(), err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return stdout.String(), stderr.String(), err
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return stdout.String(), stderr.String(), fmt.Errorf("npm timed out after %s", timeout)
	}
}

// npm 解析缓存：成功 1h（node 升级换目录后自愈），失败 30s（服务运行中补装
// node 不必重启）；解析含「验证执行 + bash -lic」秒级探测，不能每次请求都付
var (
	npmPathMu    sync.Mutex
	npmPathCache struct {
		p   string
		dir string
		at  time.Time
	}
)

func resolveNpmExecCached() (path, dir string, ok bool) {
	npmPathMu.Lock()
	defer npmPathMu.Unlock()
	ttl := time.Hour
	if npmPathCache.p == "" {
		ttl = 30 * time.Second
	}
	if time.Since(npmPathCache.at) < ttl {
		return npmPathCache.p, npmPathCache.dir, npmPathCache.p != ""
	}
	npmPathCache.p, npmPathCache.dir = resolveNpmExec()
	npmPathCache.at = time.Now()
	return npmPathCache.p, npmPathCache.dir, npmPathCache.p != ""
}

// resetNpmResolveCacheForTest 仅供测试使用：清空 npm 解析缓存（用例改
// HOME/PATH 后需重探）
func resetNpmResolveCacheForTest() {
	npmPathMu.Lock()
	defer npmPathMu.Unlock()
	npmPathCache.p = ""
	npmPathCache.dir = ""
	npmPathCache.at = time.Time{}
}

// resolveNpmExec 解析**验证可执行**的 npm（与 resolveUnixDshPath 同源策略；
// 通用版本在 server/userbin——本函数含 nvm-windows/Program Files 特化候选）：
//  1. 候选序列：PATH 裸名 + 用户级常见位置（nvm 多版本取最新、volta、系统级
//     /usr/local/bin、/usr/bin；Windows 另含 nvm-windows 与官方安装器位置）
//     + 交互登录 shell 兜底（仅 Unix：fnm/asdf 等由 .bashrc 注入 PATH）
//  2. **每个候选执行 `npm --version` 验证**（10s 超时，子进程 PATH 注入候选
//     同目录——npm 是 env node 脚本，同目录即 node 所在）：PATH 里的断链
//     npm（LookPath 命中但执行 127）会被跳过，直到验证通过的真 npm
//
// 返回 (npm全路径, npm所在bin目录, 是否成功)——bin 目录供子进程 PATH 注入
func resolveNpmExec() (path, binDir string) {
	var cands []string
	if p, err := exec.LookPath("npm"); err == nil {
		cands = append(cands, p)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cands = append(cands, filepath.Join(home, ".volta", "bin", "npm"))
		if runtime.GOOS == "windows" {
			cands = append(cands,
				filepath.Join(home, "AppData", "Roaming", "nvm", "npm.cmd"),
				`C:\Program Files\nodejs\npm.cmd`,
			)
			if hits, _ := filepath.Glob(filepath.Join(home, "AppData", "Roaming", "nvm", "v*", "npm.cmd")); len(hits) > 0 {
				if p := pickNewestNvmWindows(hits); p != "" {
					cands = append(cands, p)
				}
			}
		} else {
			cands = append(cands, "/usr/local/bin/npm", "/usr/bin/npm")
			if hits, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin", "npm")); len(hits) > 0 {
				if p := pickNewestNvmDsh(hits); p != "" {
					cands = append(cands, p)
				}
			}
		}
	}
	if runtime.GOOS != "windows" {
		// 交互登录 shell 会加载用户全部配置（nvm 初始化秒级、坏配置可挂住）：
		// 带超时兜底，与 userbin 的探测超时同语义
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		out, err := exec.CommandContext(ctx, "bash", "-lic", "command -v npm").CombinedOutput()
		cancel()
		if err == nil {
			if p := lastPathLine(string(out), "npm"); p != "" {
				cands = append(cands, p)
			}
		}
	}
	for _, c := range cands {
		dir := filepath.Dir(c)
		if npmVerifyExec(c, dir) {
			return c, dir
		}
	}
	return "", ""
}

// npmVerifyExec 验证候选 npm 真的可执行：跑 `npm --version`（子进程 PATH
// 前置其所在 bin 目录——npm 脚本的 `env node` 依赖同目录 node）。PATH 里的
// 断链 npm / 缺 node 的环境都会在此被剔除
func npmVerifyExec(npmPath, binDir string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, npmPath, "--version")
	cmd.Env = append(os.Environ(), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return cmd.Run() == nil
}

// runShellCmd 经系统 shell 执行（用于派生的 `dsh --version` 探测，WSL 前缀
// 天然透传）；带超时——wsl 首启/交互提示可能永不返回，不能拖死 HTTP 请求
func runShellCmd(cmdStr string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", cmdStr)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", cmdStr)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// parseNpmLsVersion 从 `npm ls -g <pkg> --json` 输出解析当前安装版本
func parseNpmLsVersion(out string) string {
	var parsed struct {
		Dependencies map[string]struct {
			Version string `json:"version"`
		} `json:"dependencies"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return ""
	}
	for _, d := range parsed.Dependencies {
		if d.Version != "" {
			return d.Version
		}
	}
	return ""
}

// parseNpmTimeJSON 从 `npm view <pkg> time --json` 解析版本→发布时间
// （剔除 npm 元数据键 created/modified；按发布时间升序）
func parseNpmTimeJSON(out string) []dshVersionInfo {
	var m map[string]string
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		return nil
	}
	out2 := make([]dshVersionInfo, 0, len(m))
	for k, v := range m {
		if k == "created" || k == "modified" {
			continue
		}
		out2 = append(out2, dshVersionInfo{Version: k, Date: v})
	}
	for i := 1; i < len(out2); i++ {
		for j := i; j > 0 && out2[j].Date < out2[j-1].Date; j-- {
			out2[j], out2[j-1] = out2[j-1], out2[j]
		}
	}
	return out2
}

// detectDshCurrentVersion 当前安装版本探测（两策略）：
//  1. npm 全局安装识别（npm ls -g --json）
//  2. 派生 `dsh --version`：从启动命令截取 " web" 之前的执行体拼 --version
//     （"dsh web --no-open" → "dsh --version"；"wsl.exe dsh web …" →
//     "wsl.exe dsh --version"，WSL 前缀天然透传）——覆盖独立安装的 dsh
func detectDshCurrentVersion() string {
	if out, _, err := runNpmCmd(30*time.Second, "ls", "-g", dshPackage, "--json"); err == nil {
		if v := parseNpmLsVersion(out); v != "" {
			return v
		}
	}
	launch := readConfig().LaunchCommand
	if launch == "" {
		launch = "dsh web --no-open"
	}
	// 按独立 token 找 "web" 子命令（子串匹配会误截 web.js 这类文件名）
	fields := strings.Fields(launch)
	for k, f := range fields {
		if f == "web" && k > 0 {
			vcmd := strings.Join(fields[:k], " ") + " --version"
			if out, err := runShellCmd(vcmd); err == nil {
				for _, line := range strings.Split(out, "\n") {
					line = strings.TrimSpace(line)
					if parseSemver(line) != nil {
						return strings.TrimPrefix(line, "v")
					}
				}
			}
			break
		}
	}
	return ""
}

// DshVersions GET /api/tools/dsh/versions
// 注册表全部已发布版本（版本+发布时间，发布时间升序）+ 当前安装版本 + 最新版本
// + 回退点（P-20261010-2 增量字段：配置里记录的最近一次升级前版本，空 = 无回退点——
// 前端版本弹窗据此常驻回退入口，升级失败态之外的「功能损坏但流程成功」也能回退）。
// 「比当前新」与预发布（prerelease）的过滤由前端做（isNewerVersion 与可升级列表语义一致）。
func DshVersions(c *gin.Context) {
	timeJSON, _, err := runNpmCmd(30*time.Second, "view", dshPackage, "time", "--json")
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "npm registry query failed",
			fmt.Errorf("%v: %s（服务进程找不到 npm 时：nvm/用户级安装已自动探测，仍失败可在设置→终端配置 dsh npm 命令为绝对路径）", err, tailStr(timeJSON, 400)))
		return
	}
	latestOut, _, _ := runNpmCmd(30*time.Second, "view", dshPackage, "version")
	rollback := ""
	if sc := store.Get().Settings.Get(); sc != nil {
		rollback = strings.TrimSpace(sc.Server.DshRollbackVersion)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"current":         detectDshCurrentVersion(),
		"latest":          strings.TrimSpace(latestOut),
		"versions":        parseNpmTimeJSON(timeJSON),
		"rollbackVersion": rollback,
	}})
}

// tailStr 取输出尾部（npm 报错详情在尾部；截断防响应过大）
func tailStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

// ============== 版本 changelog（GitHub releases） ==============

// dshChangelogEntry 单个版本的变更说明（GitHub release 映射）
type dshChangelogEntry struct {
	Version     string `json:"version"`     // tag 去 v 前缀
	Name        string `json:"name"`        // release 标题
	Body        string `json:"body"`        // release notes（markdown）
	PublishedAt string `json:"publishedAt"` // ISO8601
	URL         string `json:"url"`         // release 网页（查看完整原文用）
}

// dshChangelogCache releases 拉取缓存：GitHub API 匿名限流 60 次/时，
// changelog 是低频查看操作，缓存 10min 足够且省配额
var (
	dshChangelogMu    sync.Mutex
	dshChangelogCache struct {
		entries []dshChangelogEntry
		at      time.Time
	}
)

// parseGitHubRepoURL 从 npm 的 repository.url 提取 owner/repo（仅接受
// github.com 的 https/git 形态；owner/repo 字符集校验防注入 API 路径）
func parseGitHubRepoURL(raw string) (owner, repo string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", false
	}
	raw = strings.TrimPrefix(raw, "git+")
	u, err := url.Parse(raw)
	if err != nil || u.Host != "github.com" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), ".git")
	seg := strings.Split(strings.Trim(parts[0], "/"), "/")
	if len(seg) < 2 {
		return "", "", false
	}
	owner, repo = seg[0], seg[1]
	valid := func(s string) bool {
		if s == "" || len(s) > 100 {
			return false
		}
		for _, r := range s {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
				return false
			}
		}
		return true
	}
	if !valid(owner) || !valid(repo) {
		return "", "", false
	}
	return owner, repo, true
}

// parseGitHubReleases 解析 GitHub releases API 响应（按发布时间倒序已是
// API 默认序，不重排）；tag 统一去 v 前缀供版本匹配
func parseGitHubReleases(body []byte) []dshChangelogEntry {
	var raw []struct {
		TagName     string `json:"tag_name"`
		Name        string `json:"name"`
		Body        string `json:"body"`
		PublishedAt string `json:"published_at"`
		HtmlURL     string `json:"html_url"`
		Draft       bool   `json:"draft"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	out := make([]dshChangelogEntry, 0, len(raw))
	for _, r := range raw {
		if r.Draft {
			continue // 草稿对外不可见（匿名 API 也可能返回空 body 占位）
		}
		out = append(out, dshChangelogEntry{
			// release tag 形态：vX.Y.Z / dsh-vX.Y.Z（该仓库 tag 带 dsh- 前缀）——
			// 统一剥到纯版本号供 npm 版本号精确匹配
			Version:     strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(r.TagName), "dsh-"), "dsh"), "v"),
			Name:        r.Name,
			Body:        r.Body,
			PublishedAt: r.PublishedAt,
			URL:         r.HtmlURL,
		})
	}
	return out
}

// DshChangelog GET /api/tools/dsh/changelog
// 版本变更说明：npm 元数据解析 GitHub 仓库 → releases API 拉取（缓存
// 10min）。GitHub 不可达/仓库无 releases 时返回空列表（前端显示引导文案），
// 不阻塞版本列表本身
func DshChangelog(c *gin.Context) {
	dshChangelogMu.Lock()
	if dshChangelogCache.entries != nil && time.Since(dshChangelogCache.at) < 10*time.Minute {
		entries := dshChangelogCache.entries
		dshChangelogMu.Unlock()
		c.JSON(http.StatusOK, gin.H{"data": entries})
		return
	}
	dshChangelogMu.Unlock()

	repoOut, _, err := runNpmCmd(30*time.Second, "view", dshPackage, "repository.url")
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "npm registry query failed", err)
		return
	}
	owner, repo, ok := parseGitHubRepoURL(repoOut)
	if !ok {
		c.JSON(http.StatusOK, gin.H{"data": []dshChangelogEntry{}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	req, rerr := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("https://api.github.com/repos/%s/%s/releases?per_page=30", owner, repo), nil)
	if rerr != nil {
		shared.Error(c, http.StatusInternalServerError, "build github request failed", rerr)
		return
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "codecombo")
	resp, derr := http.DefaultClient.Do(req)
	if derr != nil {
		// 源不可达是预期分支（离线/限流）：空列表 + 说明，不当作服务器异常
		c.JSON(http.StatusOK, gin.H{"data": []dshChangelogEntry{}, "unavailable": true})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusOK, gin.H{"data": []dshChangelogEntry{}, "unavailable": true,
			"reason": fmt.Sprintf("github returned %d", resp.StatusCode)})
		return
	}
	entries := parseGitHubReleases(body)
	dshChangelogMu.Lock()
	dshChangelogCache.entries = entries
	dshChangelogCache.at = time.Now()
	dshChangelogMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": entries})
}

// DshUpgradePrepare POST /api/tools/dsh/upgrade/prepare
// 记录回退点（升级前当前版本）：npm -g 安装会替换全局包，旧版本安装后即不可
// 寻——回退点必须在安装前探测落盘。当前版本未知（独立安装且非 npm 管理）时
// canRollback=false，升级仍可继续
func DshUpgradePrepare(c *gin.Context) {
	var req struct {
		Version string `json:"version"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Version) == "" {
		shared.Error(c, http.StatusBadRequest, "Invalid upgrade request", fmt.Errorf("version is required"))
		return
	}
	current := detectDshCurrentVersion()
	sc := store.Get().Settings.Get()
	if sc == nil {
		shared.Error(c, http.StatusInternalServerError, "Settings unavailable", fmt.Errorf("settings not loaded"))
		return
	}
	sc.Server.DshRollbackVersion = current
	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Save rollback point failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"version":         strings.TrimSpace(req.Version),
		"rollbackVersion": current,
		"canRollback":     current != "",
	}})
}

// DshUpgradeInstall POST /api/tools/dsh/upgrade/install
// npm -g 安装指定版本（长请求，前端按步骤展示进度）
func DshUpgradeInstall(c *gin.Context) {
	var req struct {
		Version string `json:"version"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Version) == "" {
		shared.Error(c, http.StatusBadRequest, "Invalid upgrade request", fmt.Errorf("version is required"))
		return
	}
	v := strings.TrimSpace(req.Version)
	if parseSemver(v) == nil {
		shared.Error(c, http.StatusBadRequest, "Invalid upgrade request", fmt.Errorf("invalid version %q", v))
		return
	}
	// 长操作：清零本响应读写 deadline（主 server WriteTimeout 60s 会截断
	// 冷缓存下超分钟的 npm install；与 router.go 长操作路由同款处理）
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	stdout, stderr, err := runNpmCmd(10*time.Minute, "install", "-g", dshPackage+"@"+v)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"ok":     err == nil,
		"output": tailStr(stdout+"\n"+stderr, 1200),
	}})
}

// DshRollback POST /api/tools/dsh/rollback
// 回退到升级前版本（DshRollbackVersion）：重新安装 + 重启 + 就绪探测——
// 升级后 dsh 起不来（插件不匹配/新版要求变化）时的逃生通道
func DshRollback(c *gin.Context) {
	sc := store.Get().Settings.Get()
	if sc == nil || strings.TrimSpace(sc.Server.DshRollbackVersion) == "" {
		shared.Error(c, http.StatusBadRequest, "No rollback point",
			fmt.Errorf("rollback version is not recorded (dsh not upgraded via this channel, or pre-upgrade version unknown)"))
		return
	}
	v := strings.TrimSpace(sc.Server.DshRollbackVersion)
	// 回退点版本校验（与 install 路径同白名单）+ 长操作清零 deadline
	if parseSemver(v) == nil {
		shared.Error(c, http.StatusBadRequest, "No rollback point",
			fmt.Errorf("recorded rollback version %q is invalid", v))
		return
	}
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	_, stderr, err := runNpmCmd(10*time.Minute, "install", "-g", dshPackage+"@"+v)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Rollback install failed",
			fmt.Errorf("%v: %s", err, tailStr(stderr, 400)))
		return
	}
	stopDsh()
	available, _, logPath, spawnErr, logTail := launchAndWait()
	if spawnErr != nil {
		shared.Error(c, http.StatusInternalServerError, "Rollback restart failed",
			fmt.Errorf("%v\n%s", spawnErr, logTail))
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"ok":        available,
		"available": available,
		"version":   v,
		"logPath":   logPath,
	}})
}
