package creds

import (
	"codecombo/server/api/remote"
	"codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/git/auth"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ListSshKeys 返回所有 SSH key（不含私钥）
func ListSshKeys(c *gin.Context) {
	keys, err := store.Get().SshKey.ListPublic()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "SSH key operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": keys})
}

// GenerateSshKey 生成 SSH 密钥对
func GenerateSshKey(c *gin.Context) {
	var req struct {
		Name string `json:"name" binding:"required"`
		Algo string `json:"algo"` // ed25519 / rsa
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "SSH key operation failed", err)
		return
	}
	meta, pubKey, err := store.Get().SshKey.Generate(req.Name, req.Algo)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "SSH key operation failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditSSHKeyGenerate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s)", req.Name, meta.Algo),
	})
	c.JSON(http.StatusOK, gin.H{"data": meta, "pubKey": pubKey})
}

// ImportSshKey 导入已有 SSH 私钥
func ImportSshKey(c *gin.Context) {
	var req struct {
		Name       string `json:"name" binding:"required"`
		PrivateKey string `json:"privateKey" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "SSH key operation failed", err)
		return
	}
	meta, err := store.Get().SshKey.Import(req.Name, []byte(req.PrivateKey))
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "SSH key operation failed", err)
		return
	}
	// 审计入账：只记名称与算法，私钥材料绝不入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditSSHKeyImport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s)", req.Name, meta.Algo),
	})
	c.JSON(http.StatusOK, gin.H{"data": meta})
}

// DeleteSshKey 删除 SSH key
//
// 删除后立即失效 LRU 缓存中对应的 tmp key 文件，避免明文 PEM 残留磁盘
// store 层不能 import auth 包（循环依赖），因此失效操作必须在 handler 层完成
func DeleteSshKey(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		shared.Error(c, http.StatusBadRequest, "id is required", nil)
		return
	}
	// 先取元数据再删（P-20261003-133 审计对象名自明化）：拼「name (id)」翻台账
	// 自明。GetByID 返回加密态完整密钥，只取 Name 不碰密钥材料（私钥绝不入账）；
	// 查不到（竞态已删）回退裸 id 不阻断删除
	detail := id
	if key, err := store.Get().SshKey.GetByID(id); err == nil && key != nil && key.Name != "" {
		detail = fmt.Sprintf("%s (%s)", key.Name, id)
	}
	if err := store.Get().SshKey.Delete(id); err != nil {
		shared.Error(c, http.StatusNotFound, "SSH key operation failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditSSHKeyDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
	// 失效 SSH resolver LRU 缓存内的对应 tmp 文件
	// 仅 KeyPathSSHResolver 实现 InvalidateKey；stub / 未来实现可能无此方法，type assert 安全降级
	if r := git.GetSSHResolver(); r != nil {
		if kp, ok := r.(*auth.KeyPathSSHResolver); ok {
			kp.InvalidateKey(id)
		}
	}
	// 引用该 key 的远程主机池内旧连接即时失效（P-20261005-159）：key 已删，
	// 旧连接的公钥语义不再成立，下次借出按「凭据缺失」如实报错提示重录
	remote.FlushPoolHostsReferencingKey(id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetSshKeyPub 返回 SSH 公钥（供复制）
func GetSshKeyPub(c *gin.Context) {
	id := c.Param("id")
	pub, err := store.Get().SshKey.GetPub(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "SSH key operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"pubKey": pub})
}
