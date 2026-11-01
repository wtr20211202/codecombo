package git

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"codecombo/server/filepolicy"
)

// 非 UTF-8 文件的搜索补充通道。背景：rg/git grep 都在字节空间匹配，查询串
// 按 UTF-8 编码，GBK/Big5 文件里的中文永远命不中（ASCII 查询不受影响，两种
// 编码的 ASCII 字节相同）。主通道保持 rg/git grep（快且覆盖 UTF-8 全量），
// 本通道只对含非 ASCII 字符的查询补扫「字节级不可见」的文件——与 VS Code
// 「在解码后的文本空间搜索」同模型。
//
// 稳定性边界（保证有界、不拖垮大仓库）：
//   - 文件集与主后端对齐：git ls-files（tracked + 未忽略的 untracked，
//     即尊重 .gitignore）；ls-files 失败（非 git 目录）回退 os WalkDir 跳 .git
//   - 单文件 >2MB 跳过、总读取量 128MB / 3000 文件封顶
//   - 已知二进制扩展名跳过（filepolicy.IsBinaryExt）
//   - 合法 UTF-8 文件跳过（主通道已覆盖，避免重复结果）
//   - 命中数达到 maxResults 即停
const (
	encodingSearchMaxFiles    = 3000
	encodingSearchMaxBytes    = 128 << 20
	encodingSearchMaxFileSize = 2 << 20
)

// hasNonASCII 查询串是否含非 ASCII 字符（纯 ASCII 查询字节级匹配已覆盖
// 所有编码，无需补扫）
func hasNonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return true
		}
	}
	return false
}

// compileSearchRegex 按搜索选项编译正则（语义对齐 rg 参数：-F 字面量、
// -w 整词、-i 大小写不敏感）
func compileSearchRegex(query string, opts SearchOptions) (*regexp.Regexp, error) {
	pattern := query
	if !opts.UseRegex {
		pattern = regexp.QuoteMeta(query)
	}
	if opts.WholeWord {
		pattern = `\b(?:` + pattern + `)\b`
	}
	if !opts.CaseSensitive {
		pattern = `(?i)` + pattern
	}
	return regexp.Compile(pattern)
}

// searchNonUTF8Supplement 在解码空间补扫非 UTF-8 文件。返回新增匹配
// （调用方已保证 maxResults>0）
func searchNonUTF8Supplement(repoPath, query string, opts SearchOptions, maxResults int) ([]SearchMatch, error) {
	re, err := compileSearchRegex(query, opts)
	if err != nil {
		return nil, err
	}
	files, err := searchCandidateFiles(repoPath)
	if err != nil {
		return nil, err
	}

	var matches []SearchMatch
	totalBytes := 0
	for _, rel := range files {
		if len(matches) >= maxResults || totalBytes >= encodingSearchMaxBytes {
			break
		}
		if filepolicy.IsBinaryExt(filepath.Ext(rel)) {
			continue
		}
		full := filepath.Join(repoPath, rel)
		info, err := os.Stat(full)
		if err != nil || info.IsDir() || info.Size() > encodingSearchMaxFileSize {
			continue
		}
		raw, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		totalBytes += len(raw)
		if utf8.Valid(raw) {
			continue // 主通道（rg/git grep）已覆盖合法 UTF-8
		}
		text, _ := filepolicy.DecodeText(raw)
		for lineNo, line := range strings.Split(text, "\n") {
			loc := re.FindStringIndex(line)
			if loc == nil {
				continue
			}
			matches = append(matches, SearchMatch{
				Path:    filepath.ToSlash(rel),
				Line:    lineNo + 1,
				Column:  utf8.RuneCountInString(line[:loc[0]]) + 1,
				Content: line,
				Match:   line[loc[0]:loc[1]],
			})
			if len(matches) >= maxResults {
				break
			}
		}
	}
	return matches, nil
}

// searchCandidateFiles 候选文件集：git ls-files（tracked + 未忽略 untracked，
// 与 rg/git grep 主通道的扫描范围一致）；失败（非 git 目录）回退全量
// WalkDir 跳 .git
func searchCandidateFiles(repoPath string) ([]string, error) {
	output, err := execGit(repoPath, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	if err == nil && output != "" {
		var files []string
		for _, f := range strings.Split(output, "\x00") {
			if f != "" {
				files = append(files, f)
			}
		}
		return files, nil
	}
	var files []string
	_ = filepath.WalkDir(repoPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rerr := filepath.Rel(repoPath, path)
		if rerr != nil {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	return files, nil
}
