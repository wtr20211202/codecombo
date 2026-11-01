package git

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// GetCommitTemplate 读取 git config commit.template 指向的模板文件内容
// （P-20261003-172）：git commit 命令行会把该文件预填进编辑器，而本产品提交
// 走 -m 直提不经过编辑器，团队以该配置承载的提交规范在产品里丢失——提交框
// 初始化预填即补齐同一惯例。
//
// 路径解析与 git 惯例对齐（git_config_pathname 语义）：
//   - ~/ 前缀展开为当前用户 home（git config --get 返回原始值，~ 展开发生在
//     git 消费侧，本产品自读文件时补齐同一语义；~user/ 形态不支持，按失败跳过）
//   - 绝对路径直接使用（个人跨仓库模板/团队共享路径的合法形态）
//   - 相对路径按仓库根解析并做根内边界校验（rejectRepoEscape）：execGit 以
//     仓库根为 cmd.Dir，与 git commit 在仓库根运行的相对路径解析一致；同时
//     防恶意仓库借相对路径（如 ../../secrets）让服务端读出仓外文件内容
//
// 任何失败（未配置/文件缺失/越界/不可读/二进制/超限）返回空串由调用方静默
// 跳过——模板是尽力而为的预填，绝不因它报错打断提交流程；「配置了但读不到」
// 记 warn 留排障线索，「未配置」是常态静默。
func GetCommitTemplate(repoPath string) string {
	out, err := execGitProbe(repoPath, "config", "--get", "commit.template")
	if err != nil {
		return ""
	}
	tmplPath := strings.TrimSpace(out)
	if tmplPath == "" {
		return ""
	}
	if strings.HasPrefix(tmplPath, "~") {
		tmplPath = expandHomePath(tmplPath)
	}
	if !filepath.IsAbs(tmplPath) {
		abs, jerr := resolveWithinRepo(repoPath, tmplPath)
		if jerr != nil {
			slog.Warn("commit.template rejected (outside repo root)", "path", tmplPath, "repo", repoPath, "err", jerr)
			return ""
		}
		tmplPath = abs
	}
	content, err := os.ReadFile(tmplPath)
	if err != nil {
		slog.Warn("commit.template unreadable", "path", tmplPath, "err", err)
		return ""
	}
	if len(content) > maxCommitTemplateBytes {
		// 超限截断：模板给提交框预填用，64KB 已远超任何合理提交规范，
		// 封顶防误配置/恶意配置把大文件整读进 JSON 响应
		content = content[:maxCommitTemplateBytes]
	}
	if bytes.IndexByte(content, 0) >= 0 {
		// 含 NUL 字节 = 二进制文件，不是合法提交模板（与文件预览侧 NUL 嗅探同判定）
		return ""
	}
	return string(content)
}

// maxCommitTemplateBytes 提交模板回传上限（字节）。团队提交规范惯例 <1KB，
// 64KB 是防御性封顶而非业务预期
const maxCommitTemplateBytes = 64 * 1024

// expandHomePath 展开 ~/ 前缀为当前用户 home（正斜杠/反斜杠两种写法都认，
// git 在 Windows 上写入的值常带正斜杠）；~ 单独出现或无法取 home 时原样返回
// （后续 IsAbs/SafeJoin 校验自然拦下）
func expandHomePath(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") && !strings.HasPrefix(p, `~\`) {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	rest := strings.TrimLeft(strings.TrimPrefix(p, "~"), `/\`)
	if rest == "" {
		return home
	}
	return filepath.Join(home, rest)
}

// errOutsideRepo 相对路径越出仓库根（.. 穿越/符号链接外逃）
var errOutsideRepo = errors.New("path escapes repo root")

// resolveWithinRepo 把 commit.template 的相对路径解析到仓库根内，语义与
// server/api/files.SafeJoinProject 同标准：拒绝 ".." 段 → Abs 规范化 →
// 真实路径（符号链接解析后）与规范化路径双前缀校验（拦兄弟目录名伪装与
// 链接外逃）。git 包不能反向 import api 层，此处按同值最小实现（差异分支
// 仅此一处用途，不做共享抽象）
func resolveWithinRepo(root, rel string) (string, error) {
	if strings.Contains(rel, "..") {
		return "", errOutsideRepo
	}
	absPath, err := filepath.Abs(filepath.Join(root, rel))
	if err != nil {
		return "", err
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	checkPath, checkRoot := absPath, absRoot
	if real, e := filepath.EvalSymlinks(absPath); e == nil {
		checkPath = real
	}
	if realRoot, e := filepath.EvalSymlinks(absRoot); e == nil {
		checkRoot = realRoot
	}
	if checkPath != checkRoot && !strings.HasPrefix(checkPath, checkRoot+string(filepath.Separator)) {
		return "", errOutsideRepo
	}
	if absPath != absRoot && !strings.HasPrefix(absPath, absRoot+string(filepath.Separator)) {
		return "", errOutsideRepo
	}
	return absPath, nil
}
