package terminal

import (
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/store"
)

// 会话快照 meta 投影（P-20261003-238 会话中心按 runtime 分组视图数据面）单测：
// runtime 与 runtimeVersion 一次 meta 读同携；无记录会话两键皆不携带（对外
// 契约「缺 key = 无记录」，前端空值归 shell 组不虚构）；空 runtime（项目会话
// meta 同形态）不落键。sessionSnapshot 全量快照（manager 会话 + 广播）由 e2e
// session-runtime-groups.spec 守门

func TestApplySessionMetaSnapshot(t *testing.T) {
	setupMetaTest(t)

	// agent 会话（创建链落库 runtime + 版本）：两键同携
	saveAgentSessionMeta("agent-ssm-1", "", "claude", "n1", "", "2.1.3 (Claude Code)", "", launchMetaExtra{})
	item := gin.H{"id": "agent-ssm-1"}
	applySessionMetaSnapshot(item, "agent-ssm-1")
	if item["runtime"] != "claude" {
		t.Fatalf("runtime = %v, want claude", item["runtime"])
	}
	if item["runtimeVersion"] != "2.1.3 (Claude Code)" {
		t.Fatalf("runtimeVersion = %v, want 2.1.3 (Claude Code)", item["runtimeVersion"])
	}

	// shell 一等选项（预检豁免链无版本）：runtime 携带、runtimeVersion 不落键
	saveAgentSessionMeta("agent-ssm-2", "", "shell", "n2", "", "", "", launchMetaExtra{})
	item2 := gin.H{"id": "agent-ssm-2"}
	applySessionMetaSnapshot(item2, "agent-ssm-2")
	if item2["runtime"] != "shell" {
		t.Fatalf("runtime = %v, want shell", item2["runtime"])
	}
	if _, present := item2["runtimeVersion"]; present {
		t.Fatalf("空版本不应落 runtimeVersion 键: %v", item2)
	}

	// 项目会话（meta runtime 空串——terminal.go 项目创建链传空）：runtime 不落键
	saveAgentSessionMeta("proj-ssm-3", "D:\\p", "", "n3", "p1", "", "", launchMetaExtra{})
	item3 := gin.H{"id": "proj-ssm-3"}
	applySessionMetaSnapshot(item3, "proj-ssm-3")
	if _, present := item3["runtime"]; present {
		t.Fatalf("空 runtime 不应落键（前端按 kind 归 shell 组）: %v", item3)
	}

	// 无 meta 记录（旧会话/未知 id）：两键皆不携带且不报错
	item4 := gin.H{"id": "agent-never-existed"}
	applySessionMetaSnapshot(item4, "agent-never-existed")
	if _, present := item4["runtime"]; present {
		t.Fatalf("无记录不应落 runtime 键: %v", item4)
	}
	if _, present := item4["runtimeVersion"]; present {
		t.Fatalf("无记录不应落 runtimeVersion 键: %v", item4)
	}
}

// TestApplySessionMetaSnapshotFleetBatch 编队批元数据投影（P-20261005-145）：
// 编队成员携带 fleetBatch（batchId/launchedAt/members 全量），非编队会话（旧
// 会话/单开/调度链）不落键——对外契约「缺 key = 非编队」，前端聚合卡按批分组
// 的数据面
func TestApplySessionMetaSnapshotFleetBatch(t *testing.T) {
	setupMetaTest(t)

	// 编队成员：saveAgentSessionMeta 尾参携带批元数据 → 快照全量投影
	fb := &store.FleetBatch{
		BatchID:    "fleet-1759987200000000000",
		LaunchedAt: time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC),
		Members:    []string{"agent-fb-1", "agent-fb-2"},
	}
	saveAgentSessionMeta("agent-fb-1", "", "shell", "fleet: 审计", "", "", "", launchMetaExtra{fleetBatch: fb})
	item := gin.H{"id": "agent-fb-1"}
	applySessionMetaSnapshot(item, "agent-fb-1")
	got, present := item["fleetBatch"].(gin.H)
	if !present {
		t.Fatalf("编队成员应携带 fleetBatch 键: %v", item)
	}
	if got["batchId"] != fb.BatchID {
		t.Fatalf("batchId = %v, want %s", got["batchId"], fb.BatchID)
	}
	members, ok := got["members"].([]string)
	if !ok || len(members) != 2 || members[0] != "agent-fb-1" {
		t.Fatalf("members 投影形态/内容不符: %v", got["members"])
	}

	// 非编队会话（批元数据 nil）：键不携带
	saveAgentSessionMeta("agent-solo", "", "shell", "普通会话", "", "", "", launchMetaExtra{})
	item2 := gin.H{"id": "agent-solo"}
	applySessionMetaSnapshot(item2, "agent-solo")
	if _, present := item2["fleetBatch"]; present {
		t.Fatalf("非编队会话不应落 fleetBatch 键: %v", item2)
	}
}
