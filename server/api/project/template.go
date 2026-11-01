package project

import (
	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetCommitTemplates 获取提交信息模板列表
func GetCommitTemplates(c *gin.Context) {
	templates, err := store.Get().Template.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Template operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": templates})
}

// CreateCommitTemplate 创建提交信息模板
func CreateCommitTemplate(c *gin.Context) {
	var req struct {
		Name    string `json:"name" binding:"required"`
		Content string `json:"content" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Template operation failed", err)
		return
	}

	if err := store.Get().Template.Create(config.CommitTemplate{Name: req.Name, Content: req.Content}); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Template operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "template created"})
}

// DeleteCommitTemplate 删除提交信息模板
func DeleteCommitTemplate(c *gin.Context) {
	name := c.Param("name")
	if err := store.Get().Template.Delete(name); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Template operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "template deleted"})
}
