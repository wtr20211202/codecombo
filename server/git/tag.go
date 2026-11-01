package git

import (
	"codecombo/server/model"
	"strings"
	"time"
)

// 获取标签列表
func GetTags(repoPath string) ([]model.Tag, error) {
	// 使用 --format 在一次调用中获取所有标签的 commit hash、名称和日期
	output, err := execGit(repoPath, "tag", "-l", "--format=%(objectname)|%(refname:short)|%(creatordate:iso)")
	if err != nil {
		return nil, err
	}

	var tags []model.Tag
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "|", 3)
		if len(parts) < 2 {
			continue
		}

		commit := strings.TrimSpace(parts[0])
		name := strings.TrimSpace(parts[1])

		var tagDate time.Time
		if len(parts) >= 3 {
			tagDate, _ = time.Parse("2006-01-02 15:04:05 -0700", strings.TrimSpace(parts[2]))
		}

		tags = append(tags, model.Tag{
			Name:   name,
			Commit: commit,
			Date:   tagDate,
		})
	}

	return tags, nil
}

// 创建标签
func CreateTag(repoPath string, req model.CreateTagRequest) error {
	args := []string{"tag"}
	if req.Annotated && req.Message != "" {
		args = append(args, "-a", req.Name, "-m", req.Message)
	} else {
		args = append(args, req.Name)
	}
	if req.Commit != "" {
		args = append(args, req.Commit)
	}

	_, err := execGit(repoPath, args...)
	return err
}

// 删除标签
func DeleteTag(repoPath string, name string) error {
	_, err := execGit(repoPath, "tag", "-d", name)
	return err
}
