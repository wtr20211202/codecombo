package config

import (
	"testing"
)

// 变更列表 per-project 作用域单测（P-20261007-19）：同作用域重名拒绝 / 跨作用域
// 同名允许 / 活跃切换同域互斥 / 文件移动同域内摘除 / 可见集过滤（存量全局条目
// 全项目可见）。直接构造 Config 操作（不触 save 落盘路径——方法内 save 失败被
// 忽略、纯内存断言语义）。

func clFixture() *Config {
	// Default 种子 Active:false（与服务端种子一致——active 是本轮起消费中的
	// UI 态，恒活跃种子会让每个项目都看到无文件的活跃组；全局活跃的兼容形态
	// 在 TestSetActiveChangelist_GlobalActiveUntouched 单独覆盖）
	return &Config{Changelists: []Changelist{
		{Name: "Default", Files: []string{}, Active: false},
	}}
}

func TestAddChangelist_ScopeDupRejected(t *testing.T) {
	c := clFixture()
	if !c.AddChangelist("work", "p1") {
		t.Fatal("first create should succeed")
	}
	if c.AddChangelist("work", "p1") {
		t.Fatal("same-scope duplicate should be rejected")
	}
	// 跨作用域同名允许（项目 p2 与全局各自一份 work）
	if !c.AddChangelist("work", "p2") || !c.AddChangelist("work", "") {
		t.Fatal("cross-scope same name should be allowed")
	}
}

func TestSetActiveChangelist_ScopeIsolated(t *testing.T) {
	c := clFixture()
	c.AddChangelist("a", "p1")
	c.AddChangelist("b", "p1")
	c.AddChangelist("x", "p2")
	c.SetActiveChangelist("a", "p1")
	for _, cl := range c.Changelists {
		want := cl.Name == "a"
		if cl.Active != want {
			t.Fatalf("list %s (p=%s) active=%v, want %v", cl.Name, cl.ProjectID, cl.Active, want)
		}
	}
	// p2 切活跃不动 p1 的活跃态（多项目并行各自有正在做的组）
	c.SetActiveChangelist("x", "p2")
	for _, cl := range c.Changelists {
		want := cl.Name == "a" || cl.Name == "x"
		if cl.Active != want {
			t.Fatalf("after p2 switch, list %s (p=%s) active=%v, want %v", cl.Name, cl.ProjectID, cl.Active, want)
		}
	}
}

func TestSetActiveChangelist_GlobalActiveUntouched(t *testing.T) {
	// 全局活跃条目（存量 Default active 形态）不被项目作用域的激活清除：
	// 作用域隔离的另一面（老配置的活跃标记不因新项目操作意外消失）
	c := clFixture()
	c.Changelists[0].Active = true
	c.AddChangelist("a", "p1")
	c.SetActiveChangelist("a", "p1")
	if !c.Changelists[0].Active {
		t.Fatal("global active should be untouched by project-scope activation")
	}
	if !c.Changelists[1].Active {
		t.Fatal("p1 list should be active")
	}
}

func TestAddFileToChangelist_ScopeInternalMove(t *testing.T) {
	c := clFixture()
	c.AddChangelist("a", "p1")
	c.AddChangelist("b", "p1")
	c.AddChangelist("other", "p2")
	c.AddFileToChangelist("a", "src/x.go", "p1")
	// 同域移动：从 a 到 b，b 有、a 无（下标：0=Default 1=a 2=b 3=other）
	c.AddFileToChangelist("b", "src/x.go", "p1")
	if got := c.Changelists[2].Files; len(got) != 1 || got[0] != "src/x.go" {
		t.Fatalf("b files = %v", got)
	}
	if got := c.Changelists[1].Files; len(got) != 0 {
		t.Fatalf("a files = %v, want empty after move", got)
	}
	// p2 的列表不受 p1 移动影响
	c.AddFileToChangelist("other", "src/x.go", "p2")
	if got := c.Changelists[3].Files; len(got) != 1 {
		t.Fatalf("p2 list files = %v", got)
	}
	// 同域文件至多属一组：p2 再移同文件不出重复
	c.AddFileToChangelist("other", "src/x.go", "p2")
	if got := c.Changelists[3].Files; len(got) != 1 {
		t.Fatalf("p2 list files after re-add = %v", got)
	}
}

func TestVisibleChangelists(t *testing.T) {
	c := clFixture()
	c.AddChangelist("p1-only", "p1")
	c.AddChangelist("p2-only", "p2")
	// 项目 p1 可见：p1 条目 + 存量全局（Default）；p2 条目不可见
	vis := c.VisibleChangelists("p1")
	names := map[string]bool{}
	for _, cl := range vis {
		names[cl.Name] = true
	}
	if !names["Default"] || !names["p1-only"] || names["p2-only"] {
		t.Fatalf("p1 visible set = %v", names)
	}
	// 不带项目（空串）：全局条目 + 空 projectId 条目（legacy 形态）
	vis = c.VisibleChangelists("")
	if len(vis) != 1 || vis[0].Name != "Default" {
		t.Fatalf("global visible set = %v", vis)
	}
}

func TestRemoveChangelist_ScopeMatch(t *testing.T) {
	c := clFixture()
	c.AddChangelist("work", "p1")
	c.AddChangelist("work", "")
	// 删 p1 的 work，全局同名保留
	c.RemoveChangelist("work", "p1")
	for _, cl := range c.Changelists {
		if cl.Name == "work" && cl.ProjectID == "p1" {
			t.Fatal("p1 work should be removed")
		}
	}
	found := false
	for _, cl := range c.Changelists {
		if cl.Name == "work" && cl.ProjectID == "" {
			found = true
		}
	}
	if !found {
		t.Fatal("global work should survive scoped removal")
	}
	// Default 保护（种子条目不可删）
	c.RemoveChangelist("Default", "")
	for _, cl := range c.Changelists {
		if cl.Name == "Default" {
			return
		}
	}
	t.Fatal("Default list should be protected from removal")
}
