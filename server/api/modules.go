package api

import (
	"net/http"

	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// HandleListModules GET /api/modules——模块发现端点。
// 内核注册表是模块清单的唯一来源（roadmap 收尾：静态声明清单已删除，
// 全部领域模块经 app/modules.go 注册进 kernel，前端与外部 Agent 据此
// 感知能力面；未来插件按同一 manifest 契约动态并入）
func HandleListModules(c *gin.Context) {
	var mods []kernel.Manifest
	if k, ok := kernelDefault.(kernel.Kernel); ok {
		for _, m := range k.Modules() {
			mods = append(mods, m.Manifest)
		}
	}
	if mods == nil {
		mods = []kernel.Manifest{}
	}
	c.JSON(http.StatusOK, gin.H{
		"apiVersion": kernel.APIVersion,
		"data":       mods,
	})
}

// kernelDefault 由组合根注入（避免 api 包硬依赖内核实例的构造时序）
var kernelDefault any

// SetKernel 供启动装配注入内核实例（nil 安全）
func SetKernel(k kernel.Kernel) { kernelDefault = k }
