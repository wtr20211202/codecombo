package terminal

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// TestPruneStaleSessionMetaKeepsNamed 清理陈旧会话元数据时，用户命名记录
// （Named）豁免——它是重启后新建会话槽位名继承的唯一来源；native 平台重启
// 后所有会话都不在 live 列表，若一并清掉，改名永远无法还原。
// 测试内 Manager 无会话（live 为空）：无命名记录全部清理，命名记录保留
func TestPruneStaleSessionMetaKeepsNamed(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	now := time.Now()
	mustSave := func(t *testing.T, m store.AgentSessionMeta) {
		t.Helper()
		if err := store.Get().AgentSession.Save(m); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	mustSave(t, store.AgentSessionMeta{ID: "dead-plain", Dir: "C:/a", CreatedAt: now})
	mustSave(t, store.AgentSessionMeta{ID: "dead-named", Dir: "C:/b", Name: "构建终端",
		Named: true, NamedAt: now, CreatedAt: now})

	pruneStaleSessionMeta()

	if _, err := store.Get().AgentSession.Get("dead-plain"); err == nil {
		t.Fatalf("stale unnamed meta should be pruned")
	}
	kept, err := store.Get().AgentSession.Get("dead-named")
	if err != nil || kept == nil {
		t.Fatalf("named meta must survive pruning: %v", err)
	}
	if kept.Name != "构建终端" || !kept.Named {
		t.Fatalf("named meta corrupted: %+v", kept)
	}
}
