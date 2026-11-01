package gitops

import (
	"net/http"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"

	"github.com/gin-gonic/gin"
)

// git 域错误码迁移（P-20261005-160）：git 操作错误此前只有「HTTP 500 + 稳定
// 文本标记」（P-29 errmarkers 注册表，前端 KNOWN_ERROR_I18N 正则过渡层），agent
// 想按「遗留锁→一键清理→重试」自纠仍要解析 message。本文件把高频标记与 P-305
// 结构化错误码成对附挂：marker 常量保留在错误文本中不回退（前端正则零破坏），
// code 供 agent 程序化分支（双轨并存，互不替代——分工注记见 errmarkers 包注释）。

// gitErrCode 把 git 操作错误按稳定标记映射为结构化错误码。标记唯一事实源在
// errmarkers 注册表（git 包保名别名引用），此处只做 Contains 嗅探、不复刻任何
// 字面量；未命中返回 false，调用方保持无 code 旧形态（增量兼容约定）。
// 覆盖面注记：标记只能由写命令路径发射（IndexLockStaleMarker 限定写命令、
// GitWriteBusyMarker 由写队列发射），嗅探对读路径错误天然不误报
func gitErrCode(err error) (shared.ErrCode, bool) {
	if err == nil {
		return "", false
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, git.IndexLockStaleMarker):
		return shared.CodeGitIndexLockStale, true
	case strings.Contains(msg, git.GitWriteBusyMarker):
		return shared.CodeGitWriteBusy, true
	}
	return "", false
}

// respondGitError git 操作失败的统一出口：错误文本命中已注册标记时附结构化
// code，命中失败分类特征时附恢复语义 hint（P-20261005-194，与 code 正交——
// 码管注册文案分支，kind 管恢复动作；可同体也可各自单独出现），两者皆无保持
// 无 code/hint 旧形态。本包既有操作失败路径全部 500，handler 侧不再手传 status
// （P-305 防双源漂移同款纪律）；code 命中时 status 仍由注册表派生，未迁移端点
// 的既有 500 一律不变
func respondGitError(c *gin.Context, publicMsg string, err error) {
	code, hasCode := gitErrCode(err)
	hint, hasHint := git.ClassifyFailHint(err)
	if !hasCode && !hasHint {
		shared.Error(c, http.StatusInternalServerError, publicMsg, err)
		return
	}
	status := http.StatusInternalServerError
	if hasCode {
		status = shared.StatusFor(code)
	}
	meta := gin.H{}
	if hasCode {
		meta["code"] = string(code)
	}
	if hasHint {
		meta["hint"] = hint
	}
	shared.ErrorWithMeta(c, status, publicMsg, err, meta)
}
