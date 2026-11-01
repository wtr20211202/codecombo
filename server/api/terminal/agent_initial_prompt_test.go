package terminal

import (
	"encoding/json"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/store"
)

// 会话初始指令（P-20261003-146）单测：创建链 launchArgs 原文经
// saveAgentSessionMeta 落 meta.InitialPrompt；空注入（无 prompt 创建）omitempty
// 不落键——「旧数据面 + 新二进制」读回同形态零迁移。快照投影按「缺 key =
// 无记录」契约（会话行「重新发起」入口的数据面）。真实创建链全路（HTTP 建会话
// →meta→重新发起预填）由 e2e agent-relaunch.spec 守门；写入点唯一在
// LaunchAgentSessionWithShell 漏斗（HTTP/调度/链式/对比/编队/运行书共用），
// 单测守的是漏斗出口与投影面

func TestSaveAgentSessionMetaInitialPrompt(t *testing.T) {
	setupMetaTest(t)

	// 有 prompt：落库可反查（「重新发起」预填数据源）
	const prompt = "对项目做依赖审计，输出过时依赖清单"
	saveAgentSessionMeta("agent-ip-1", "", "claude", "n1", "", "2.1.3 (Claude Code)", prompt, launchMetaExtra{derived: true})
	meta, err := store.Get().AgentSession.Get("agent-ip-1")
	if err != nil || meta == nil {
		t.Fatalf("meta missing: %v", err)
	}
	if meta.InitialPrompt != prompt {
		t.Fatalf("InitialPrompt = %q, want %q", meta.InitialPrompt, prompt)
	}

	// 无 prompt（纯终端/空注入创建）：字段不落盘，读回零值——空显不虚构
	saveAgentSessionMeta("agent-ip-2", "", "shell", "n2", "", "", "", launchMetaExtra{})
	meta2, err := store.Get().AgentSession.Get("agent-ip-2")
	if err != nil || meta2 == nil {
		t.Fatalf("meta2 missing: %v", err)
	}
	if meta2.InitialPrompt != "" {
		t.Fatalf("空注入应落空值，got %q", meta2.InitialPrompt)
	}
	// 落盘 JSON 无 initialPrompt 键（omitempty——与存量 meta 文档同形态，
	// 旧数据面 + 新二进制互读零迁移）
	b, err := json.Marshal(meta2)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := doc["initialPrompt"]; present {
		t.Fatalf("空注入不应落 initialPrompt 键（存量数据同形态）: %v", doc)
	}

	// 旧文档缺字段（功能上线前的存量 meta）：反序列化为空串不报错
	var legacy store.AgentSessionMeta
	if err := json.Unmarshal([]byte(`{"id":"agent-ip-3","dir":"/tmp","createdAt":"2026-01-01T00:00:00Z"}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy doc: %v", err)
	}
	if legacy.InitialPrompt != "" {
		t.Fatalf("旧文档缺字段应读回空串，got %q", legacy.InitialPrompt)
	}
}

func TestApplySessionMetaSnapshotInitialPrompt(t *testing.T) {
	setupMetaTest(t)

	// 有 prompt：快照携键（「重新发起」入口可用的判据）
	saveAgentSessionMeta("agent-ips-1", "", "claude", "n1", "", "", "审计任务指令", launchMetaExtra{derived: true})
	item := gin.H{"id": "agent-ips-1"}
	applySessionMetaSnapshot(item, "agent-ips-1")
	if item["initialPrompt"] != "审计任务指令" {
		t.Fatalf("initialPrompt = %v, want 审计任务指令", item["initialPrompt"])
	}

	// 无 prompt：不落键（缺 key = 无记录，前端空显不虚构）
	saveAgentSessionMeta("agent-ips-2", "", "shell", "n2", "", "", "", launchMetaExtra{})
	item2 := gin.H{"id": "agent-ips-2"}
	applySessionMetaSnapshot(item2, "agent-ips-2")
	if _, present := item2["initialPrompt"]; present {
		t.Fatalf("空注入不应落 initialPrompt 键: %v", item2)
	}

	// 无 meta 记录（旧会话/未知 id）：不落键且不报错
	item3 := gin.H{"id": "agent-never-existed"}
	applySessionMetaSnapshot(item3, "agent-never-existed")
	if _, present := item3["initialPrompt"]; present {
		t.Fatalf("无记录不应落 initialPrompt 键: %v", item3)
	}
}

// 会话身份标记（P-20261023-3）：derived/resumed 随创建漏斗落 meta 并投影进
// 快照——「新/接续」徽标与命名来源的数据面；仅置位携键（omitempty），旧文档
// 缺字段反序列化 false 零迁移
func TestSessionIdentityMetaFlags(t *testing.T) {
	setupMetaTest(t)

	// 派生名 + 恢复旗标创建：双标记落库
	saveAgentSessionMeta("agent-id-1", "", "claude", "旧命名", "", "", "--resume abc", launchMetaExtra{derived: true, resumed: true})
	meta, err := store.Get().AgentSession.Get("agent-id-1")
	if err != nil || meta == nil {
		t.Fatalf("meta missing: %v", err)
	}
	if !meta.Derived || !meta.Resumed {
		t.Fatalf("identity flags not saved: %+v", meta)
	}

	// 显式命名（非派生）：derived/resumed 不落键（旧数据同形态）
	saveAgentSessionMeta("agent-id-2", "", "shell", "我的终端", "", "", "", launchMetaExtra{})
	meta2 := mustMeta(t, "agent-id-2")
	b, err := json.Marshal(meta2)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := doc["derived"]; present {
		t.Fatalf("非派生名不应落 derived 键（旧数据同形态）: %v", doc)
	}
	if _, present := doc["resumed"]; present {
		t.Fatalf("非旗标创建不应落 resumed 键: %v", doc)
	}

	// 旧文档缺字段（功能上线前的存量 meta）：反序列化 false 不报错
	var legacy store.AgentSessionMeta
	if err := json.Unmarshal([]byte(`{"id":"agent-id-3","createdAt":"2026-01-01T00:00:00Z"}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy: %v", err)
	}
	if legacy.Derived || legacy.Resumed {
		t.Fatalf("旧文档缺字段应读回 false: %+v", legacy)
	}

	// 快照投影：仅置位携键（缺 key = false，前端徽标判据与响应先行字段同形）
	saveAgentSessionMeta("agent-id-4", "", "claude", "n4", "", "", "--resume abc", launchMetaExtra{resumed: true})
	item := gin.H{"id": "agent-id-4"}
	applySessionMetaSnapshot(item, "agent-id-4")
	if item["resumed"] != true {
		t.Fatalf("resumed key missing: %v", item)
	}
	if _, present := item["derived"]; present {
		t.Fatalf("未置位不应落 derived 键: %v", item)
	}
}

func mustMeta(t *testing.T, id string) *store.AgentSessionMeta {
	t.Helper()
	meta, err := store.Get().AgentSession.Get(id)
	if err != nil || meta == nil {
		t.Fatalf("meta %s missing: %v", id, err)
	}
	return meta
}
