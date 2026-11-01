package remote

import (
	"net/http"
	"strings"

	"codecombo/server/api/shared"
	"codecombo/server/errmarkers"

	"github.com/gin-gonic/gin"
)

// remote 域错误码迁移（P-20261005-160）：SSH 认证失败/主机指纹变更是
// remoteErrors.ts 第二张正则表的服务端源头（P-29 AuthRejectedPrefix/HostKeyChanged
// 文本标记承载前端人读映射），此前 agent 想按 code 分支（指纹变更→引导用户重置
// 指纹 / 认证失败→核对凭据，勿重试防对端限频）只能解析 message。本文件把两个
// 标记与 P-305 结构化错误码成对附挂：marker 文本保留不回退（正则过渡层零破坏）。

// remoteErrCode 把 SSH 通道错误按稳定标记映射为结构化错误码。标记唯一事实源在
// errmarkers 注册表，此处只做 Contains 嗅探、不复刻任何字面量；未命中返回
// false，调用方保持无 code 旧形态。覆盖面注记：两个标记均只在 Dial/认证握手期
// 发射（hostkey 校验与 auth 协商都在建连阶段），拨号后的 SFTP/Exec 通道错误
// 天然不命中
func remoteErrCode(err error) (shared.ErrCode, bool) {
	if err == nil {
		return "", false
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, errmarkers.HostKeyChanged):
		return shared.CodeRemoteHostKeyChanged, true
	case strings.Contains(msg, errmarkers.AuthRejectedPrefix):
		return shared.CodeRemoteAuthFailed, true
	}
	return "", false
}

// respondRemoteDialError SSH 拨号错误的统一出口：命中标记附结构化 code（status
// 由注册表派生，与迁移前既有 502 一致），否则保持无 code 旧形态。本包拨号失败
// 路径全部 502（网关语义：远端 SSH 不可达/拒绝），handler 侧不再手传 status
//
// 边界注记：diag/exec/test-connection/gitcompare 等端点把连接错误装进 200 响应
// 的 error 字段（UI 先行设计），不经本出口——那些面继续按文本标记降级判断，
// code 面只覆盖 JSON 错误通道端点（手册「错误码对照」分节同款注记）
func respondRemoteDialError(c *gin.Context, publicMsg string, err error) {
	if code, ok := remoteErrCode(err); ok {
		shared.ErrorWithCode(c, code, publicMsg, err)
		return
	}
	shared.Error(c, http.StatusBadGateway, publicMsg, err)
}
