package terminal

// 终端会话自定义分组的智能体操作面（P-20261111-1-S3）：分组此前只是前端
// uiState（agentTerminal.groups）里的组织结构，agent 无结构化入口建组/归置
// 会话——分组结构成为智能体可操作实体（值班 agent 自建分组归置会话）。
//
// 落点选型：分组数据本体在 uiState（车道：agentTerminal 命名空间，前端唯一
// 写入方历来是页面），本文件不动存储格式、经 store.UIStateStore.MutateNamespace
// 在 repo 锁内做「只动 groups 数组、其余键原样」的手术式读-改-写——外部拿全表
// 自己改再 Merge 会携带陈旧副本与并发前端补丁互吞（跨读改写无锁窗口），故
// store 层新增 MutateNamespace 原语而非在 handler 拼 Merge 载荷。
//
// 生效面：前端 boot/恢复链读同一条记录（本地实例 "local"，ui-state 不走远程
// 代理——LOCAL_PREFIXES 恒发本机后端），live 页面经 ops-channel 广播
// agent.groups.changed → useOpsChannel 映射既有窗口事件 OPS_AGENT_GROUPS_CHANGED
// → useAgentTerminalGroups 既有外部变更重读链就地跟随（P-20261004-79 同链复用，
// 零新前端订阅面）。
//
// 语义边界（对齐前端既有行为，不做增强）：
//   - 分组是纯组织结构：成员可为幽灵会话（S1 计数渲染层过滤既有语义）；移动
//     入组校验会话在册（早失败优于假成功，队列端点同判据），组内既有幽灵成员不清理；
//   - 删组 = 组内会话回到未分组（归属=「在某个组的 sessionIds 里」，组消失即归位）；
//   - 组序/组内序是前端拖拽产物，本面不暴露排序（agent 无从感知视觉顺序，
//     暴露只会造出无人消费的写面）。
//
// 权限：TokenAuth 门内（agent 令牌可调）；不经 AgentGuard 高危审批——分组是
// 组织元数据非数据破坏面（增删组均不触碰会话本体，删组成员自动归位）。

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 业务闭包哨兵错误：status 映射与 agent 自纠文案的单一事实源（errors.Is 判别
// 禁 message 子串匹配漂移），原文即稳定标记（respondAgentGroupsError 按哨兵
// 映射 status，队列端点同款口径——错误原文 publicMsg 保留）
var (
	// errGroupNotFound 组 id 不在册：404
	errGroupNotFound = errors.New("session group not found")
	// errSessionNotInGroup 移出目标会话不在该组：404（明确动作非幂等清理）
	errSessionNotInGroup = errors.New("session not in group")
	// errGroupsLimitReached 组数触顶：400（护栏值随包装携带）
	errGroupsLimitReached = errors.New("session groups limit reached")
)

// 分组的 uiState 定位：本地实例记录 → agentTerminal 命名空间 → groups 键
// （前端 saveAgentTerminalState 写同一位置）。远程实例浏览态的分组属于该实例
// 自己的工作区记录（对端服务器的 uiState），不在本面——agent 令牌面对的是
// 本机服务，会话本体也全在本机
const (
	agentGroupsInstance = "local"
	agentGroupsNS       = "agentTerminal"
	agentGroupsKey      = "groups"
	// agentGroupsMax 组数上限：防程序化调用无界增长 uiState（前端无上限是
	// 人工操作的现实约束，agent 面必须自带护栏）；个位数现实用量，100 充裕
	agentGroupsMax = 100
	// agentGroupNameMax 组名长度上限（rune）：组名是侧栏一行标签，前端输入
	// 无显式限长，服务端按 UI 标签量级收口
	agentGroupNameMax = 64
)

// agentSessionGroup 分组的 API 视图（GET/POST/PUT 响应共用，与前端模型同形：
// {id,name,sessionIds}——前端收到即按同形并入渲染模型）
type agentSessionGroup struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	SessionIDs []string `json:"sessionIds"`
}

// agentGroupIDSeq 组 id 单调序列：同毫秒并发创建不撞 id（rand 同毫秒有 1/万
// 碰撞面，agent 高频建组循环下并非不可能；计数器在同一毫秒内严格唯一，
// 跨毫秒由 unixms 区分——回绕仅在同毫秒 1 万次调用时出现，现实不可达）
var agentGroupIDSeq atomic.Uint64

// newAgentGroupID 服务端铸组 id：与前端生成形同构（at_<unixms>_<4位数字>）。
// 前端不解析 id 形态（只当不透明串用），形同即可互认；响应回传权威 id
func newAgentGroupID() string {
	return fmt.Sprintf("at_%d_%04d", time.Now().UnixMilli(), agentGroupIDSeq.Add(1)%10000)
}

// agentGroupsView 把 uiState 里的 groups 原始值解码为 API 视图。防御口径与
// 前端读取端一致（getAgentTerminalState：非数组=空表）。map 形态且带非空 id
// 的条目进视图（id 是寻址键），其余条目原样进 rest（写回时原位保留——服务端
// 不清洗它读不懂的存量形状，宁可带着也不丢数据）；视图条目缺失字段按零值
// 归一（sessionIds 缺失=空组，与前端「空组可见可移入」语义一致）
func agentGroupsView(raw interface{}) (groups []agentSessionGroup, rest []interface{}) {
	arr, ok := raw.([]interface{})
	if !ok {
		return nil, nil
	}
	groups = make([]agentSessionGroup, 0, len(arr))
	rest = make([]interface{}, 0, len(arr))
	for _, entry := range arr {
		m, ok := entry.(map[string]interface{})
		if !ok {
			rest = append(rest, entry)
			continue
		}
		id, _ := m["id"].(string)
		if id == "" {
			rest = append(rest, entry)
			continue
		}
		name, _ := m["name"].(string)
		g := agentSessionGroup{ID: id, Name: name, SessionIDs: []string{}}
		if ids, ok := m["sessionIds"].([]interface{}); ok {
			for _, sid := range ids {
				if s, ok := sid.(string); ok {
					g.SessionIDs = append(g.SessionIDs, s)
				}
			}
		}
		groups = append(groups, g)
	}
	return groups, rest
}

// encodeAgentGroups 组列表写回形态（与前端写入的 JSON 形状一致：
// [{id,name,sessionIds}]）；rest 是解码时摘出的不可寻址原样条目，殿后保留
// （它们本就无渲染语义，位置仅保持「不丢」）
func encodeAgentGroups(groups []agentSessionGroup, rest []interface{}) interface{} {
	out := make([]interface{}, 0, len(groups)+len(rest))
	for _, g := range groups {
		ids := make([]interface{}, 0, len(g.SessionIDs))
		for _, s := range g.SessionIDs {
			ids = append(ids, s)
		}
		out = append(out, map[string]interface{}{"id": g.ID, "name": g.Name, "sessionIds": ids})
	}
	return append(out, rest...)
}

// broadcastAgentGroupsChanged 分组结构变更广播（写端点成功路径统一出口）：
// 载荷恒空——消费方收到即拉全量（settings.changed 同纪律，不信任载荷内容）；
// live 页面经既有 OPS_AGENT_GROUPS_CHANGED 重读链就地跟随
func broadcastAgentGroupsChanged() {
	opschannel.BroadcastEvent(opschannel.EventAgentGroupsChanged, gin.H{})
}

// readAgentGroupsRaw 读当前 groups 原始值（只读不写盘，Get 出的独立副本随意解引用）
func readAgentGroupsRaw() interface{} {
	data, err := store.Get().UIState.Get()
	if err != nil {
		return nil
	}
	inst, ok := data[agentGroupsInstance].(map[string]interface{})
	if !ok {
		return nil
	}
	ns, ok := inst[agentGroupsNS].(map[string]interface{})
	if !ok {
		return nil
	}
	return ns[agentGroupsKey]
}

// mutateAgentGroups 经 store 层 MutateNamespace 定位到 groups 原始值的类型化
// 读-改-写：解码 → 业务闭包 → 编码写回；业务闭包返回错误即整体放弃（不落盘
// 不广播）。handler 不感知 uiState 的实例/命名空间/键三段定位
func mutateAgentGroups(fn func(groups []agentSessionGroup, rest []interface{}) ([]agentSessionGroup, []interface{}, error)) error {
	return store.Get().UIState.MutateNamespace(agentGroupsInstance, agentGroupsNS, func(cur interface{}) (interface{}, error) {
		var ns map[string]interface{}
		if m, ok := cur.(map[string]interface{}); ok {
			ns = m
		}
		var raw interface{}
		if ns != nil {
			raw = ns[agentGroupsKey]
		}
		groups, rest := agentGroupsView(raw)
		next, nextRest, err := fn(groups, rest)
		if err != nil {
			return nil, err
		}
		if ns == nil {
			ns = map[string]interface{}{}
		}
		ns[agentGroupsKey] = encodeAgentGroups(next, nextRest)
		return ns, nil
	})
}

// respondAgentGroupsError 业务闭包错误映射：组/关系不存在 404、其余（组数
// 触顶）400——errors.Is 判别哨兵，原文随响应 publicMsg 保留
func respondAgentGroupsError(c *gin.Context, err error) {
	if errors.Is(err, errGroupNotFound) || errors.Is(err, errSessionNotInGroup) {
		shared.Error(c, http.StatusNotFound, err.Error(), nil)
		return
	}
	shared.Error(c, http.StatusBadRequest, err.Error(), nil)
}

// bindGroupName 组名载荷校验：trim 后非空且 ≤64 rune（UI 标签量级）；失败
// 400 stable message（agent 自纠：补非空短名）
func bindGroupName(c *gin.Context) (string, bool) {
	var req struct {
		Name string `json:"name"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return "", false
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		shared.Error(c, http.StatusBadRequest, "name required", nil)
		return "", false
	}
	if len([]rune(name)) > agentGroupNameMax {
		shared.Error(c, http.StatusBadRequest, fmt.Sprintf("name too long (max %d runes)", agentGroupNameMax), nil)
		return "", false
	}
	return name, true
}

// ListSessionGroups GET /api/terminals/session-groups：分组清单（含空组）。
// 读不广播；非数组存量按空表回（与前端读取端同口径）
func ListSessionGroups(c *gin.Context) {
	groups, _ := agentGroupsView(readAgentGroupsRaw())
	if groups == nil {
		groups = []agentSessionGroup{}
	}
	c.JSON(http.StatusOK, gin.H{"data": groups})
}

// CreateSessionGroup POST /api/terminals/session-groups {"name"}：新建空组。
// 201 返回铸好 id 的组视图（agent 后续按 id 引用）；组数触顶 400
func CreateSessionGroup(c *gin.Context) {
	name, ok := bindGroupName(c)
	if !ok {
		return
	}
	var createdID string
	err := mutateAgentGroups(func(groups []agentSessionGroup, rest []interface{}) ([]agentSessionGroup, []interface{}, error) {
		if len(groups)+len(rest) >= agentGroupsMax {
			return nil, nil, fmt.Errorf("%w (%d)", errGroupsLimitReached, agentGroupsMax)
		}
		g := agentSessionGroup{ID: newAgentGroupID(), Name: name, SessionIDs: []string{}}
		createdID = g.ID
		return append(groups, g), rest, nil
	})
	if err != nil {
		respondAgentGroupsError(c, err)
		return
	}
	// 新组同样广播：live 侧栏只有经重读链才会出现新组段（不广播则 agent 建的
	// 组要等下次 boot 才可见——正是本提案要消灭的「建了看不见」形态）
	broadcastAgentGroupsChanged()
	// 按闭包捕获的 id 重读组装响应（transform 在锁内已落定，权威 id 是它）
	groups, _ := agentGroupsView(readAgentGroupsRaw())
	for _, g := range groups {
		if g.ID == createdID {
			c.JSON(http.StatusCreated, gin.H{"data": g})
			return
		}
	}
	// 重读异常的兜底：至少如实回 id 不静默假成功
	c.JSON(http.StatusCreated, gin.H{"data": agentSessionGroup{ID: createdID, Name: name, SessionIDs: []string{}}})
}

// RenameSessionGroup PUT /api/terminals/session-groups/:id {"name"}：改名。
// 组不存在 404
func RenameSessionGroup(c *gin.Context) {
	id := c.Param("id")
	name, ok := bindGroupName(c)
	if !ok {
		return
	}
	err := mutateAgentGroups(func(groups []agentSessionGroup, rest []interface{}) ([]agentSessionGroup, []interface{}, error) {
		for i := range groups {
			if groups[i].ID == id {
				groups[i].Name = name
				return groups, rest, nil
			}
		}
		return nil, nil, fmt.Errorf("%w: %s", errGroupNotFound, id)
	})
	if err != nil {
		respondAgentGroupsError(c, err)
		return
	}
	broadcastAgentGroupsChanged()
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// DeleteSessionGroup DELETE /api/terminals/session-groups/:id：删组，组内
// 会话回到未分组（归属随组消失自动归位，无需搬移成员）；组不存在 404
func DeleteSessionGroup(c *gin.Context) {
	id := c.Param("id")
	err := mutateAgentGroups(func(groups []agentSessionGroup, rest []interface{}) ([]agentSessionGroup, []interface{}, error) {
		for i := range groups {
			if groups[i].ID == id {
				return append(groups[:i], groups[i+1:]...), rest, nil
			}
		}
		return nil, nil, fmt.Errorf("%w: %s", errGroupNotFound, id)
	})
	if err != nil {
		respondAgentGroupsError(c, err)
		return
	}
	broadcastAgentGroupsChanged()
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// MoveSessionsIntoGroup PUT /api/terminals/session-groups/:id/sessions
// {"sessionIds":[...]}：把会话移入组（从原组摘除再入目标组尾部——前端
// onBatchMove/onMoveSessionByDrag 同语义）。全量校验先行：任一 id 不在册
// 404 整体不动（原子语义）；sessionIds 空清单 400；组不存在 404
func MoveSessionsIntoGroup(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		SessionIDs []string `json:"sessionIds"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	if len(req.SessionIDs) == 0 {
		shared.Error(c, http.StatusBadRequest, "sessionIds required", nil)
		return
	}
	for _, sid := range req.SessionIDs {
		if terminal.DefaultManager.GetSession(sid) == nil {
			shared.Error(c, http.StatusNotFound, fmt.Sprintf("session not found: %s", sid), nil)
			return
		}
	}
	err := mutateAgentGroups(func(groups []agentSessionGroup, rest []interface{}) ([]agentSessionGroup, []interface{}, error) {
		var target *agentSessionGroup
		for i := range groups {
			if groups[i].ID == id {
				target = &groups[i]
				break
			}
		}
		if target == nil {
			return nil, nil, fmt.Errorf("%w: %s", errGroupNotFound, id)
		}
		moving := make(map[string]bool, len(req.SessionIDs))
		for _, sid := range req.SessionIDs {
			moving[sid] = true
		}
		// 从全部组摘除（含目标组——已在组内的重入即视为「移到尾部」，幂等不重复）
		for i := range groups {
			kept := make([]string, 0, len(groups[i].SessionIDs))
			for _, sid := range groups[i].SessionIDs {
				if !moving[sid] {
					kept = append(kept, sid)
				}
			}
			groups[i].SessionIDs = kept
		}
		target.SessionIDs = append(target.SessionIDs, req.SessionIDs...)
		return groups, rest, nil
	})
	if err != nil {
		respondAgentGroupsError(c, err)
		return
	}
	broadcastAgentGroupsChanged()
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// RemoveSessionFromGroup DELETE /api/terminals/session-groups/:id/sessions/:sid：
// 把会话移出组（回到未分组）。组不存在/会话不在该组 404（这里是明确动作非
// 幂等清理，早失败优于假成功，队列端点同判据）
func RemoveSessionFromGroup(c *gin.Context) {
	id := c.Param("id")
	sid := c.Param("sid")
	err := mutateAgentGroups(func(groups []agentSessionGroup, rest []interface{}) ([]agentSessionGroup, []interface{}, error) {
		for i := range groups {
			if groups[i].ID != id {
				continue
			}
			for j, member := range groups[i].SessionIDs {
				if member == sid {
					groups[i].SessionIDs = append(groups[i].SessionIDs[:j], groups[i].SessionIDs[j+1:]...)
					return groups, rest, nil
				}
			}
			return nil, nil, fmt.Errorf("%w: %s (group %s)", errSessionNotInGroup, sid, id)
		}
		return nil, nil, fmt.Errorf("%w: %s", errGroupNotFound, id)
	})
	if err != nil {
		respondAgentGroupsError(c, err)
		return
	}
	broadcastAgentGroupsChanged()
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}
