package git

import (
	"log/slog"
	"strings"

	"codecombo/server/filepolicy"
)

// SearchMatch 单行搜索结果
type SearchMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Content string `json:"content"`
	Before  string `json:"before,omitempty"`
	After   string `json:"after,omitempty"`
	Match   string `json:"match"`
}

// SearchOptions 搜索选项
type SearchOptions struct {
	CaseSensitive bool   `json:"caseSensitive"`
	WholeWord     bool   `json:"wholeWord"`
	UseRegex      bool   `json:"useRegex"`
	FilePattern   string `json:"filePattern"` // glob，如 "*.go"
	MaxResults    int    `json:"maxResults"`
}

// SearchContent 在工作目录中进行内容搜索（roadmap M5.1）：
// PATH 上有 ripgrep 时走 rg 后端（快一个数量级），否则 git grep——
// 两种后端输出格式逐字段一致，解析与结果结构完全相同；
// 同时也会扫描未被 git 跟踪的新文件（git grep --untracked / rg --hidden）
func SearchContent(repoPath string, query string, opts SearchOptions) ([]SearchMatch, error) {
	if strings.TrimSpace(query) == "" {
		return []SearchMatch{}, nil
	}
	maxResults := opts.MaxResults
	if maxResults <= 0 {
		maxResults = 500
	}
	matches, err, backend := searchBackend(repoPath, query, opts, maxResults)
	if err == nil {
		slog.Debug("search done", "backend", backend, "matches", len(matches))
	}
	if err != nil {
		return matches, err
	}
	// 非 ASCII 查询在字节级后端扫不到非 UTF-8 文件（GBK 中文字节与 UTF-8
	// 编码不同）：解码空间补扫，文件集/上限见 search_encoding.go
	if hasNonASCII(strings.TrimSpace(query)) && len(matches) < maxResults {
		extra, supplementErr := searchNonUTF8Supplement(repoPath, query, opts, maxResults-len(matches))
		if supplementErr != nil {
			slog.Debug("encoding supplement search failed", "err", supplementErr)
			return matches, nil
		}
		matches = append(matches, extra...)
		if len(matches) > maxResults {
			matches = matches[:maxResults]
		}
	}
	return matches, nil
}

// searchWithGitGrep git grep 后端（回退路径，rg 不可用/失败时使用）
func searchWithGitGrep(repoPath string, query string, opts SearchOptions, maxResults int) ([]SearchMatch, error) {
	// 构造 git grep 命令
	// -n 行号  -I 跳过二进制  --column 输出列  --no-color 不染色
	// -E 扩展正则  -i 大小写不敏感（条件添加）
	args := []string{
		"-c", "core.quotePath=false",
		"grep", "-n", "-I", "--column", "--no-color",
		"--untracked",
	}
	if !opts.CaseSensitive {
		args = append(args, "-i")
	}
	if opts.WholeWord {
		args = append(args, "-w")
	}
	if opts.UseRegex {
		args = append(args, "-E")
	} else {
		args = append(args, "-F")
	}
	args = append(args, "-e", query)
	if opts.FilePattern != "" {
		args = append(args, "--", opts.FilePattern)
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		// git grep 在无匹配时返回 exit code 1，stderr 为空
		if strings.Contains(err.Error(), "exit status 1") || output == "" {
			return []SearchMatch{}, nil
		}
		return nil, err
	}

	// 早停解析（达到 maxResults 即停）+ 解码后再解析：GBK 文件的命中行以
	// 原始字节出现在输出里，UTF-8 直出乱码；逐行解码让预览行可读（ASCII
	// 头部 file:line:col 不受影响）
	matches := parseGrepOutputLimit(filepolicy.DecodeDisplay(output), query, opts.CaseSensitive, maxResults)
	if len(matches) > maxResults {
		matches = matches[:maxResults]
	}
	return matches, nil
}

// parseGrepOutputLimit 带 Early-stop 上限的输出解析（limit <= 0 表示不限）
func parseGrepOutputLimit(output string, query string, caseSensitive bool, limit int) []SearchMatch {
	var matches []SearchMatch
	lines := strings.Split(output, "\n")
	queryForCompare := query
	if !caseSensitive {
		queryForCompare = strings.ToLower(query)
	}
	for _, raw := range lines {
		if limit > 0 && len(matches) >= limit {
			return matches
		}
		if raw == "" {
			continue
		}
		// 跳过二进制文件提示
		if strings.HasPrefix(raw, "Binary file ") {
			continue
		}
		// 找前两个冒号分隔符得到 path 和 line:col 部分
		// 注意 Windows 路径中可能含盘符但无冒号歧义（D:\...）
		// git grep 输出总是 "path:line:col:content" 或 "path:line:content"
		// 找最后一个冒号分隔 content
		lastColon := strings.LastIndex(raw, ":")
		if lastColon < 0 {
			continue
		}
		content := raw[lastColon+1:]
		head := raw[:lastColon]
		// head 为 path:line 或 path:line:col
		// 从右向左解析冒号
		parts := strings.Split(head, ":")
		if len(parts) < 2 {
			continue
		}
		// path 中可能含 ":"（Windows 盘符），重新拼接
		// 但 git grep 输出中 path 不会以数字结尾，所以我们从右向左取
		line := 0
		col := 1
		// 最右侧是 line（数字）或 col（数字）
		// 试两种情况：path:line:col:content（已剥 content）
		if len(parts) >= 3 {
			// 最后一段可能是 col
			lastPart := parts[len(parts)-1]
			secondLast := parts[len(parts)-2]
			if isDigits(lastPart) && isDigits(secondLast) {
				line = atoiSearch(secondLast)
				col = atoiSearch(lastPart)
				parts = parts[:len(parts)-2]
			} else if isDigits(secondLast) {
				line = atoiSearch(secondLast)
				parts = parts[:len(parts)-2]
			}
		} else if len(parts) == 2 {
			if isDigits(parts[1]) {
				line = atoiSearch(parts[1])
				parts = parts[:1]
			}
		}
		path := strings.Join(parts, ":")
		if path == "" || line == 0 {
			continue
		}

		// 高亮匹配片段
		match := ""
		lowerContent := content
		lowerQuery := queryForCompare
		if !caseSensitive {
			lowerContent = strings.ToLower(content)
		}
		idx := strings.Index(lowerContent, lowerQuery)
		if idx >= 0 {
			match = content[idx : idx+len(query)]
		}

		matches = append(matches, SearchMatch{
			Path:    path,
			Line:    line,
			Column:  col,
			Content: content,
			Match:   match,
		})
	}
	return matches
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func atoiSearch(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// JSON helper 用于调试（保留以防未来需要）
