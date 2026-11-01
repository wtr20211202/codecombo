package git

import (
	"codecombo/server/model"
	"strconv"
	"strings"
	"time"
)

// ReflogEntry 表示一条 reflog 记录
type ReflogEntry struct {
	Hash      string    `json:"hash"`
	ShortHash string    `json:"shortHash"`
	RefName   string    `json:"refName"`
	Index     int       `json:"index"`
	Message   string    `json:"message"`
	Author    string    `json:"author"`
	Date      time.Time `json:"date"`
}

// GetReflog 获取 reflog 记录
func GetReflog(repoPath string, ref string, limit int) ([]ReflogEntry, error) {
	args := []string{"reflog", "--format=%H|%h|%gd|%gs|%an|%at"}
	if limit > 0 {
		args = append(args, "-n", strconv.Itoa(limit))
	}
	if ref != "" {
		args = append(args, ref)
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}

	return parseReflog(output), nil
}

func parseReflog(output string) []ReflogEntry {
	var entries []ReflogEntry
	lines := strings.Split(output, "\n")

	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// 格式: %H|%h|%gd|%gs|%an|%at
		parts := strings.SplitN(line, "|", 6)
		if len(parts) < 6 {
			continue
		}

		timestamp, _ := strconv.ParseInt(parts[5], 10, 64)
		// 从 %gd 中提取序号，如 refs/heads/master@{0}
		index := 0
		gd := parts[2]
		if idx := strings.LastIndex(gd, "@{"); idx >= 0 {
			numStr := strings.TrimSuffix(gd[idx+2:], "}")
			index, _ = strconv.Atoi(numStr)
		}

		// 提取 ref 名称
		refName := gd
		if atIdx := strings.LastIndex(gd, "@{"); atIdx >= 0 {
			refName = strings.TrimSpace(gd[:atIdx])
		}

		entry := ReflogEntry{
			Hash:      parts[0],
			ShortHash: parts[1],
			RefName:   refName,
			Index:     index,
			Message:   parts[3],
			Author:    parts[4],
			Date:      time.Unix(timestamp, 0),
		}

		_ = i
		entries = append(entries, entry)
	}

	return entries
}

// GetReflogCommitDiff 获取 reflog 某条记录对应的 diff
func GetReflogCommitDiff(repoPath string, hash string) (string, error) {
	output, err := execGit(repoPath, "show", "--format=", "--stat", "-p", hash)
	if err != nil {
		return "", err
	}
	return output, nil
}

// ResetToReflogEntry 重置到 reflog 中的某条记录
func ResetToReflogEntry(repoPath string, hash string, mode string) error {
	args := []string{"reset", "--" + mode, hash}
	_, err := execGit(repoPath, args...)
	return err
}

// 确保 ReflogEntry 满足需要
var _ model.Commit = model.Commit{}
