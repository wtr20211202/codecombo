package license

import (
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/license"

	"github.com/gin-gonic/gin"
)

// GetLicenseStatus GET /api/license/status
// 返回当前许可状态（激活信息、版次、功能列表、是否启用等）
func GetLicenseStatus(c *gin.Context) {
	status := license.FormatStatus()
	status["available"] = license.ShowLicenseUI || license.LicenseEnforced
	c.JSON(http.StatusOK, gin.H{"data": status})
}

// ActivateLicense POST /api/license/activate {key: "..."}
// 验证并激活许可密钥（需管理员已解锁）
func ActivateLicense(c *gin.Context) {
	var req struct {
		Key string `json:"key" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "license key is required", nil)
		return
	}

	store := license.NewStore(config.DataDir())
	lic, err := license.Activate(req.Key)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	if err := store.Save(req.Key); err != nil {
		shared.Error(c, http.StatusInternalServerError, "persist license: "+err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"licensee":  lic.Licensee,
		"edition":   lic.Edition,
		"features":  lic.Features,
		"expiresAt": lic.ExpiresAt,
	}})
}

// DeactivateLicense DELETE /api/license
// 清除当前许可（恢复到未激活状态）
func DeactivateLicense(c *gin.Context) {
	store := license.NewStore(config.DataDir())
	if err := store.Remove(); err != nil {
		// 文件不存在也视为成功
		c.JSON(http.StatusOK, gin.H{"message": "license removed"})
		return
	}
	license.Deactivate()
	c.JSON(http.StatusOK, gin.H{"message": "license deactivated"})
}

// LoadPersistedLicense 启动时从 DataDir 加载持久化的许可密钥
func LoadPersistedLicense(dataDir string) {
	store := license.NewStore(dataDir)
	key, err := store.LoadKey()
	if err != nil {
		return // 无持久化许可
	}
	license.Load(key)
}
