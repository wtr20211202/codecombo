package agentchain

// 会话接续链 HTTP 面（P-20261004-38）。路由（router.go 注册，组中间件
// LockMiddleware + TokenAuthMiddleware + AgentGuard 同 agent-crons 管理面鉴权）：
//
//	POST   /api/agent-chains       新建链定义（源会话在册校验）
//	GET    /api/agent-chains       链列表（创建时间倒序 + 源会话存活态/显示名）
//	DELETE /api/agent-chains/:id   删除链（不拥有会话生命周期，已拉起会话不受影响）
//
// 无 PUT：链是「定义即生效」的轻量实体，改定义 = 删了重建（避免编辑与触发
// 记账互相覆盖的语义面，agentcron 全量替换 Update 的教训不适用于无时刻字段
// 的纯触发定义）。触发引擎与观察者见 trigger.go，模板展开见 prompt.go。

import (
	"net/http"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"codecombo/server/agentops"
	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

const (
	// promptMax 模板 UTF-8 字节上限（launchArgs 服务端上限同口径；占位符
	// 展开增量为注入面，触发时收敛回配额——prompt.go 注记）
	promptMax = 500
	// sourceIDMax 链源会话 ID 长度上限（agent-<unixnano> / tmux 名形态，
	// 设上界防畸形长串入库）
	sourceIDMax = 128
	// dirMax 工作目录长度上限
	dirMax = 1024
)

// chainIDRe 链 ID 白名单（chain- + 数字，防路径穿越形态；expIDRe 同款）
var chainIDRe = regexp.MustCompile(`^chain-[0-9]{1,32}$`)

// chainItem 列表载荷：链本体 + 服务端计算的源会话存活态与显示名（修正项：
// 死链列表置灰可删——存活判定以当前终端管理器在册为准，terminals.changed
// 快照同一事实源；源会话元数据缺失降级显示 ID 不谎称）
type chainItem struct {
	store.AgentChain
	SourceAlive bool   `json:"sourceAlive"`
	SourceName  string `json:"sourceName,omitempty"`
}

// validateChainPayload 创建校验并归一化；返回首个错误的用户可读信息。
// 源会话在册校验单独做（CreateChain 内，需 aliveFn 可换桩）
func validateChainPayload(ch *store.AgentChain) string {
	ch.SourceTerminalID = strings.TrimSpace(ch.SourceTerminalID)
	if ch.SourceTerminalID == "" {
		return "sourceTerminalId is required"
	}
	if len(ch.SourceTerminalID) > sourceIDMax {
		return "sourceTerminalId too long"
	}
	ch.PromptTemplate = strings.TrimSpace(ch.PromptTemplate)
	if !utf8.ValidString(ch.PromptTemplate) || len(ch.PromptTemplate) == 0 {
		return "promptTemplate is required"
	}
	if len(ch.PromptTemplate) > promptMax {
		return "promptTemplate too long (max 500 bytes)"
	}
	ch.Runtime = strings.TrimSpace(ch.Runtime)
	switch ch.Runtime {
	case "", "auto", "shell":
	default:
		if !agentops.IsRegisteredProvider(ch.Runtime) {
			return "unknown runtime"
		}
	}
	ch.Dir = strings.TrimSpace(ch.Dir)
	if len(ch.Dir) > dirMax {
		return "dir too long"
	}
	if ch.Dir != "" {
		if fi, err := os.Stat(ch.Dir); err != nil || !fi.IsDir() {
			return "dir does not exist"
		}
	}
	return ""
}

// CreateChain POST /api/agent-chains
// body: { sourceTerminalId, promptTemplate, runtime?, dir?, onFailure? }
// 创建时源会话必须在册：指向不存在会话的链是打错目标（会话 ID 随手抄错），
// 明确 400 优于静默存一条永不触发的死链；会话关闭导致的后续失效是运行态
// 事实（列表置灰），与创建时点校验分工不同
func CreateChain(c *gin.Context) {
	var req store.AgentChain
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "agent chain operation failed", err)
		return
	}
	if msg := validateChainPayload(&req); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	if !defaultAliveFn(req.SourceTerminalID) {
		shared.Error(c, http.StatusBadRequest, "source session not found", nil)
		return
	}
	ch, err := store.Get().AgentChain.Create(req)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent chain operation failed", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": chainItem{
		AgentChain:  *ch,
		SourceAlive: true,
		SourceName:  sourceSessionName(ch.SourceTerminalID),
	}})
}

// ListChains GET /api/agent-chains
func ListChains(c *gin.Context) {
	chains, err := store.Get().AgentChain.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent chain operation failed", err)
		return
	}
	items := make([]chainItem, 0, len(chains))
	for i := range chains {
		ch := &chains[i]
		items = append(items, chainItem{
			AgentChain:  *ch,
			SourceAlive: defaultAliveFn(ch.SourceTerminalID),
			SourceName:  sourceSessionName(ch.SourceTerminalID),
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": items})
}

// DeleteChain DELETE /api/agent-chains/:id（删链定义；已拉起的会话不受影响——
// 链只管发起，不拥有会话生命周期，compareexp 同语义）
func DeleteChain(c *gin.Context) {
	id := c.Param("id")
	if !chainIDRe.MatchString(id) {
		shared.Error(c, http.StatusBadRequest, "invalid chain id", nil)
		return
	}
	if err := store.Get().AgentChain.Delete(id); err != nil {
		shared.Error(c, http.StatusNotFound, "agent chain not found", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// defaultAliveFn 生产存活判定（触发引擎与 CRUD 校验共用同一实现；变量化供
// 单测换桩）
var defaultAliveFn aliveFn = aliveByManager
