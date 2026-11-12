package store_test

// MutateNamespace 命名空间级手术式读-改-写（P-20261111-1-S3）单测：服务端
// 写入方（agent ops 面）在 repo 锁内只动一个命名空间内部——与并发 Merge/PUT
// 全程互斥不吞键、err 中止不落盘、nil 摘键、缺失实例/命名空间从零新建。

import (
	"fmt"
	"sync"
	"testing"

	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

func newMutateForTest(t *testing.T) store.UIStateStore {
	t.Helper()
	return store.New(filestore.New(t.TempDir())).UIState
}

func TestMutateNamespace_Basics(t *testing.T) {
	r := newMutateForTest(t)

	// 实例与命名空间均缺失：current=nil，transform 从零建
	err := r.MutateNamespace("local", "agentTerminal", func(cur interface{}) (interface{}, error) {
		if cur != nil {
			t.Fatalf("current on empty store = %v, want nil", cur)
		}
		return map[string]interface{}{"groups": []interface{}{"g1"}}, nil
	})
	if err != nil {
		t.Fatalf("mutate empty: %v", err)
	}
	data, _ := r.Get()
	ns := data["local"].(map[string]interface{})["agentTerminal"].(map[string]interface{})
	if len(ns["groups"].([]interface{})) != 1 {
		t.Fatalf("groups after first mutate = %+v", ns)
	}

	// 二次 mutate 收到当前值，其余键原样
	err = r.MutateNamespace("local", "agentTerminal", func(cur interface{}) (interface{}, error) {
		m := cur.(map[string]interface{})
		m["collapsedGroups"] = []interface{}{"x"}
		return m, nil
	})
	if err != nil {
		t.Fatalf("mutate second: %v", err)
	}
	data, _ = r.Get()
	ns = data["local"].(map[string]interface{})["agentTerminal"].(map[string]interface{})
	if len(ns["groups"].([]interface{})) != 1 || len(ns["collapsedGroups"].([]interface{})) != 1 {
		t.Fatalf("ns after second mutate = %+v", ns)
	}

	// nil 返回值 = 摘除该键（实例记录保留）
	err = r.MutateNamespace("local", "agentTerminal", func(interface{}) (interface{}, error) {
		return nil, nil
	})
	if err != nil {
		t.Fatalf("mutate nil: %v", err)
	}
	data, _ = r.Get()
	if _, ok := data["local"].(map[string]interface{})["agentTerminal"]; ok {
		t.Fatalf("agentTerminal key should be removed: %+v", data["local"])
	}

	// 实例记录缺失时摘键 no-op 不落盘不报错
	err = r.MutateNamespace("ghost-inst", "ns", func(interface{}) (interface{}, error) { return nil, nil })
	if err != nil {
		t.Fatalf("mutate nil missing instance: %v", err)
	}
}

func TestMutateNamespace_ErrorAborts(t *testing.T) {
	r := newMutateForTest(t)
	if err := r.Update(map[string]interface{}{
		"local": map[string]interface{}{
			"agentTerminal": map[string]interface{}{"groups": []interface{}{"keep"}},
			"layout":        map[string]interface{}{"width": 460.0},
		},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	wantErr := fmt.Errorf("business rejection")
	err := r.MutateNamespace("local", "agentTerminal", func(interface{}) (interface{}, error) {
		return nil, wantErr
	})
	if err != wantErr {
		t.Fatalf("err = %v, want business error passthrough", err)
	}
	data, _ := r.Get()
	inst := data["local"].(map[string]interface{})
	if got := len(inst["agentTerminal"].(map[string]interface{})["groups"].([]interface{})); got != 1 {
		t.Fatalf("failed mutate must not write: groups = %d", got)
	}
	if inst["layout"] == nil {
		t.Fatalf("failed mutate must not touch sibling keys")
	}
}

// TestMutateNamespace_ConcurrentWriters 与 Merge 并发：手术写只动目标命名
// 空间，Merge 写的兄弟命名空间不得被手术写回滚（同锁互斥的直接推论，
// 回归锚防未来把 transform 挪出锁外）
func TestMutateNamespace_ConcurrentWriters(t *testing.T) {
	r := newMutateForTest(t)
	if err := r.Update(map[string]interface{}{
		"local": map[string]interface{}{"layout": map[string]interface{}{"width": 460.0}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	const n = 40
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_ = r.MutateNamespace("local", "agentTerminal", func(cur interface{}) (interface{}, error) {
				var m map[string]interface{}
				if cur != nil {
					m = cur.(map[string]interface{})
				} else {
					m = map[string]interface{}{}
				}
				g, _ := m["groups"].([]interface{})
				m["groups"] = append(append([]interface{}{}, g...), fmt.Sprintf("g%d", i))
				return m, nil
			})
		}(i)
		go func(i int) {
			defer wg.Done()
			_ = r.Merge(map[string]interface{}{
				"local": map[string]interface{}{
					"editor": map[string]interface{}{"openFiles": []interface{}{fmt.Sprintf("f%d.ts", i)}},
				},
			})
		}(i)
	}
	wg.Wait()
	data, _ := r.Get()
	inst := data["local"].(map[string]interface{})
	// 手术写全部到达：n 条组无一被吞（错开锁窗口就会少）
	if got := len(inst["agentTerminal"].(map[string]interface{})["groups"].([]interface{})); got != n {
		t.Fatalf("groups = %d, want %d（并发手术写被吞）", got, n)
	}
	// Merge 兄弟命名空间存活
	if inst["editor"] == nil || inst["layout"] == nil {
		t.Fatalf("sibling namespaces lost: %+v", inst)
	}
}
