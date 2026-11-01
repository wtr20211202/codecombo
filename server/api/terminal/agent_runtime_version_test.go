package terminal

import (
	"encoding/json"
	"testing"

	"codecombo/server/store"
)

// 会话 runtime 版本快照（P-20261003-134）单测：预检顺取的版本行经
// saveAgentSessionMeta 落 meta、RuntimeVersionForSession 反查；豁免链（shell /
// 自定义命令）空值落库即无记录（omitempty 不落键——「旧数据面 + 新二进制」
// 读回同形态），反查对无记录会话容忍空串。真实创建链（创建→meta→tooltip）
// 由 e2e agent-runtime-version.spec 守门

func TestSaveAgentSessionMetaRuntimeVersion(t *testing.T) {
	setupMetaTest(t)

	// 有版本：落库可反查（会话中心 tooltip 数据源）
	saveAgentSessionMeta("agent-rtv-1", "", "claude", "n1", "", "2.1.3 (Claude Code)", "", launchMetaExtra{})
	meta, err := store.Get().AgentSession.Get("agent-rtv-1")
	if err != nil || meta == nil {
		t.Fatalf("meta missing: %v", err)
	}
	if meta.RuntimeVersion != "2.1.3 (Claude Code)" {
		t.Fatalf("RuntimeVersion = %q, want 2.1.3 (Claude Code)", meta.RuntimeVersion)
	}
	if got := store.RuntimeVersionForSession("agent-rtv-1"); got != "2.1.3 (Claude Code)" {
		t.Fatalf("RuntimeVersionForSession = %q, want 2.1.3 (Claude Code)", got)
	}

	// 空版本（豁免链）：字段不落盘，读回零值——展示端空显不虚构
	saveAgentSessionMeta("agent-rtv-2", "", "shell", "n2", "", "", "", launchMetaExtra{})
	meta2, err := store.Get().AgentSession.Get("agent-rtv-2")
	if err != nil || meta2 == nil {
		t.Fatalf("meta2 missing: %v", err)
	}
	if meta2.RuntimeVersion != "" {
		t.Fatalf("空版本应落空值，got %q", meta2.RuntimeVersion)
	}
	// 落盘 JSON 无 runtimeVersion 键（omitempty——与既有 meta 文档同形态，
	// 存量数据零迁移）：Save 落盘与同一路 marshal 产出，回程 marshal 即可核验
	b, err := json.Marshal(meta2)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := doc["runtimeVersion"]; present {
		t.Fatalf("空版本不应落 runtimeVersion 键（旧数据面/新二进制同形态）: %v", doc)
	}
	if got := store.RuntimeVersionForSession("agent-rtv-2"); got != "" {
		t.Fatalf("空版本反查 = %q, want 空串", got)
	}

	// 无记录会话 / 空 id：反查空串不报错（旧会话、未知 id 同一出口）
	if got := store.RuntimeVersionForSession("agent-never-existed"); got != "" {
		t.Fatalf("无记录反查 = %q, want 空串", got)
	}
	if got := store.RuntimeVersionForSession(""); got != "" {
		t.Fatalf("空 id 反查 = %q, want 空串", got)
	}
}
