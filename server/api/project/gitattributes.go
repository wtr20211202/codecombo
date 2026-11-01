package project

import (
	shared "codecombo/server/api/shared"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// 获取 .gitattributes 内容
func GetGitAttributes(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	content, err := readGitAttributes(p.Path)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitattributes operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": content})
}

// 更新 .gitattributes 内容
func UpdateGitAttributes(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Gitattributes operation failed", err)
		return
	}

	gitattributesPath := filepath.Join(p.Path, ".gitattributes")
	if strings.TrimSpace(req.Content) == "" {
		// 内容为空时删除文件
		os.Remove(gitattributesPath)
		c.JSON(http.StatusOK, gin.H{"message": ".gitattributes cleared"})
		return
	}

	if err := os.WriteFile(gitattributesPath, []byte(req.Content), 0644); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitattributes operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": ".gitattributes updated"})
}

// 添加单条规则到 .gitattributes
func AddGitAttributesRule(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Rule string `json:"rule" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Gitattributes operation failed", err)
		return
	}

	content, _ := readGitAttributes(p.Path)
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += req.Rule + "\n"

	gitattributesPath := filepath.Join(p.Path, ".gitattributes")
	if err := os.WriteFile(gitattributesPath, []byte(content), 0644); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitattributes operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "rule added"})
}

func readGitAttributes(repoPath string) (string, error) {
	gitattributesPath := filepath.Join(repoPath, ".gitattributes")
	data, err := os.ReadFile(gitattributesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}
