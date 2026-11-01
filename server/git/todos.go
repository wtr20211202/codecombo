package git

import (
	"log/slog"
	"strings"

	"codecombo/server/filepolicy"
)

// ── 代码标记扫描（P-20261002-25）：TODO/FIXME/XXX/HACK 聚合的数据面 ──
//
// 后端选择沿用 searchBackend 的 rg 优先/git grep 回退与排除语义（.git 排除、
// .gitignore 生效、未跟踪新文件纳入），但不用通用解析器 parseGrepOutputLimit：
// 它按「最后一个冒号」切 content，命中行自带冒号（`// TODO: xxx` 几乎必然）
// 时 path/line/col 整体错位。本扫描用左锚定解析——两种后端在 --vimgrep /
// -n --column 下输出形状恒为 path:line:col:content（工作区相对路径、正斜杠），
// content 中的冒号不影响。

// TodoQuery 整词交替模式。词边界不写进 pattern（POSIX ERE 的 \b 是 GNU 扩展，
// git-for-windows 语义不稳），由后端原生 flag 提供：rg -w / git grep -w，
// 对交替的每个分支独立生效
const TodoQuery = "TODO|FIXME|XXX|HACK"

// SearchTodoMarks 扫描工作区内的 TODO/FIXME/XXX/HACK 整词标记（大小写敏感：
// 小写 todo/普通词 hack 不计入，与主流 TODO 面板口径一致）。
// 返回行级命中（path/line/column/content）；无匹配返回空切片
func SearchTodoMarks(repoPath string, maxResults int) ([]SearchMatch, error) {
	if maxResults <= 0 {
		maxResults = 500
	}
	opts := SearchOptions{CaseSensitive: true, UseRegex: true, WholeWord: true}
	if rgResolved() {
		out, err := runRg(repoPath, rgSearchArgs(TodoQuery, opts))
		if err == nil {
			return parseMarkLines(filepolicy.DecodeDisplay(out), maxResults), nil
		}
		slog.Debug("todos: rg failed, falling back to git grep", "err", err)
	}
	return searchTodoMarksWithGitGrep(repoPath, maxResults)
}

// searchTodoMarksWithGitGrep git grep 后端（回退路径，rg 不可用/失败时使用）。
// 参数与 searchWithGitGrep 的固定前缀同源（quotePath 关闭防非 ASCII 路径
// 八进制转义、-I 跳过二进制、--column 补列号、--untracked 对齐 rg 的工作区
// 语义），仅解析器换成标记专用
func searchTodoMarksWithGitGrep(repoPath string, maxResults int) ([]SearchMatch, error) {
	output, err := execGit(repoPath,
		"-c", "core.quotePath=false",
		"grep", "-n", "-I", "--column", "--no-color",
		"--untracked",
		"-E", "-w",
		"-e", TodoQuery,
	)
	if err != nil {
		// git grep 在无匹配时返回 exit code 1，stderr 为空
		if strings.Contains(err.Error(), "exit status 1") || output == "" {
			return []SearchMatch{}, nil
		}
		return nil, err
	}
	return parseMarkLines(filepolicy.DecodeDisplay(output), maxResults), nil
}

// parseMarkLines 带 Early-stop 上限的左锚定解析（limit <= 0 表示不限）。
// 无匹配返回空切片（与 SearchContent 既有契约一致，JSON 序列化为 []）
func parseMarkLines(output string, limit int) []SearchMatch {
	matches := []SearchMatch{}
	for _, raw := range strings.Split(output, "\n") {
		if limit > 0 && len(matches) >= limit {
			return matches
		}
		if raw == "" || strings.HasPrefix(raw, "Binary file ") {
			continue
		}
		if m, ok := parseMarkLine(raw); ok {
			matches = append(matches, m)
		}
	}
	return matches
}

// parseMarkLine 单行 path:line:col:content 左锚定解析：path 不含冒号
// （相对路径、正斜杠——git grep 正斜杠直出、rg 经 --path-separator 归一），
// 其后两段必须为数字，剩余整体归 content（content 含冒号安全）。
// 行号/列号非法的行（异常输出）不产生条目
func parseMarkLine(raw string) (SearchMatch, bool) {
	first := strings.Index(raw, ":")
	if first <= 0 {
		return SearchMatch{}, false
	}
	path := raw[:first]
	rest := raw[first+1:]
	second := strings.Index(rest, ":")
	if second <= 0 {
		return SearchMatch{}, false
	}
	lineStr := rest[:second]
	rest = rest[second+1:]
	third := strings.Index(rest, ":")
	if third < 0 {
		return SearchMatch{}, false
	}
	colStr := rest[:third]
	content := rest[third+1:]
	if !isDigits(lineStr) || !isDigits(colStr) {
		return SearchMatch{}, false
	}
	line := atoiSearch(lineStr)
	if line <= 0 {
		return SearchMatch{}, false
	}
	return SearchMatch{Path: path, Line: line, Column: atoiSearch(colStr), Content: content}, true
}
