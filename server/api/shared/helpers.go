package shared

import (
	"codecombo/server/config"
	"codecombo/server/store"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

func GetProjectFromContext(c *gin.Context) *config.ProjectConfig {
	id := c.Param("id")
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		ErrorWithCode(c, CodeProjectsNotFound, "project not found", nil)
		return nil
	}
	return p
}

// LimitBody 给请求体套大小上限（http.MaxBytesReader）：gin 默认不限 body，
// content 承载类端点（文件写入 JSON / 粘贴图片 multipart）的超大请求体会
// 在解析期整体进内存。必须在 ShouldBindJSON / FormFile 等解析动作之前调用。
// 超限时后续解析返回读错误，用 BodyTooLarge(err) 判别并回 413
func LimitBody(c *gin.Context, maxBytes int64) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
}

// BodyTooLarge 判别解析错误是否由 LimitBody 的上限触发（http.MaxBytesError
// 会从 json.Decoder / multipart Reader 原样透传上来）
func BodyTooLarge(err error) bool {
	var mbe *http.MaxBytesError
	return errors.As(err, &mbe)
}

// BindJSON 解析 JSON 请求体；失败统一回 400 bind 基线响应并返回 false（响应已
// 写出，调用方直接 return），成功返回 true。
//
// message 基线统一 "invalid request body"（P-20261007-24：同类故障同文案，agent
// 对 400 bind 类错误的分类策略才有稳定基线）；域定位走 code 参数——迁移域传该域
// 已登记的 *.payload_invalid 稳定码（ErrorWithCode 出 code 字段，agent 程序化分
// 支），未迁移域传 ""（Error 旧形态，响应无 code 字段走降级路径），域做错误码迁
// 移时把 "" 换成码值即可。
//
// err 不进响应也不进日志：errText 在开发模式会以解析器原文覆盖基线文案使 message
// 失稳（已迁移端点 nil 先例），畸形请求风暴也不刷错误日志——bind 失败的排障线
// 索由 agent 自查请求体与 code/message 基线承接。
//
// LimitBody 封顶端点不适用本 helper（bind 失败需先 BodyTooLarge 分流 413，
// too_large 码与封顶文案域内各异），保持既有内联 bind 块。
func BindJSON(c *gin.Context, req any, code ErrCode) bool {
	if err := c.ShouldBindJSON(req); err != nil {
		if code == "" {
			Error(c, http.StatusBadRequest, "invalid request body", nil)
		} else {
			ErrorWithCode(c, code, "invalid request body", nil)
		}
		return false
	}
	return true
}
