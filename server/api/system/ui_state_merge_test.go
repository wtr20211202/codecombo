package system

import (
	"fmt"
	"sync"
	"testing"

	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

// uiState 键级合并写（P-20261002-8）：PATCH/PUT 共用 Merge 的服务端契约——
// 实例内顶层键浅合并、未携带键保留、null 清实例、并发写互不吞键
//（与 TestCleanupProjectUIState 同款装配：真实 filestore + SetDefault）

func newUIStateForTest(t *testing.T) store.UIStateStore {
	t.Helper()
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	return store.Get().UIState
}

func getUIStateForTest(t *testing.T, r store.UIStateStore) map[string]interface{} {
	t.Helper()
	data, err := r.Get()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestUIStateMergePartialRecord(t *testing.T) {
	r := newUIStateForTest(t)
	if err := r.Update(map[string]interface{}{
		"local": map[string]interface{}{
			"projectId": "p1",
			"layout":    map[string]interface{}{"sidePanelWidth": 460.0},
			"editor":    map[string]interface{}{"openFiles": []interface{}{"keep.ts"}},
			"agentTerminal": map[string]interface{}{
				"groups": []interface{}{map[string]interface{}{"id": "g1"}},
			},
		},
		"remote1": map[string]interface{}{"projectId": "p2"},
	}); err != nil {
		t.Fatal(err)
	}

	// 补丁只携带 layout 一个键：同实例其他命名空间与其他实例必须原样保留
	if err := r.Merge(map[string]interface{}{
		"local": map[string]interface{}{
			"layout": map[string]interface{}{"sidePanelWidth": 280.0, "showSidePanel": false},
		},
	}); err != nil {
		t.Fatal(err)
	}

	data := getUIStateForTest(t, r)
	local := data["local"].(map[string]interface{})
	layout := local["layout"].(map[string]interface{})
	if layout["sidePanelWidth"] != 280.0 || layout["showSidePanel"] != false {
		t.Errorf("layout not merged: %v", layout)
	}
	if local["projectId"] != "p1" {
		t.Errorf("projectId must survive: %v", local["projectId"])
	}
	if _, ok := local["agentTerminal"]; !ok {
		t.Error("unrelated namespace must survive")
	}
	if editor, ok := local["editor"].(map[string]interface{}); !ok || editor["openFiles"] == nil {
		t.Errorf("editor must survive: %v", local["editor"])
	}
	remote := data["remote1"].(map[string]interface{})
	if remote["projectId"] != "p2" {
		t.Errorf("other instances untouched: %v", remote)
	}
}

func TestUIStateMergeNullClearsInstance(t *testing.T) {
	r := newUIStateForTest(t)
	if err := r.Merge(map[string]interface{}{
		"local":   map[string]interface{}{"layout": map[string]interface{}{"sidePanelWidth": 280.0}},
		"remote1": map[string]interface{}{"projectId": "p2"},
	}); err != nil {
		t.Fatal(err)
	}
	// 显式 null 清空实例记录（布局重置/测试清理语义），其他实例不动
	if err := r.Merge(map[string]interface{}{"local": nil}); err != nil {
		t.Fatal(err)
	}
	data := getUIStateForTest(t, r)
	if _, ok := data["local"]; ok {
		t.Error("local should be cleared by null record")
	}
	if _, ok := data["remote1"]; !ok {
		t.Error("remote1 must survive")
	}
}

func TestUIStateMergeNewInstance(t *testing.T) {
	r := newUIStateForTest(t)
	// 文档尚不存在时 Merge 直接建档（首访实例的第一次保存路径）
	if err := r.Merge(map[string]interface{}{
		"local": map[string]interface{}{"projectId": "p1"},
	}); err != nil {
		t.Fatal(err)
	}
	data := getUIStateForTest(t, r)
	if data["local"].(map[string]interface{})["projectId"] != "p1" {
		t.Errorf("expected new instance record, got %v", data)
	}
}

// 并发 Merge 各写各的键：互斥下不允许任何一方丢键（多标签写竞争的服务端封口）
func TestUIStateMergeConcurrentWriters(t *testing.T) {
	r := newUIStateForTest(t)
	const writers = 16
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("ns%d", i)
			err := r.Merge(map[string]interface{}{
				"local": map[string]interface{}{
					key: map[string]interface{}{"writer": i},
				},
			})
			if err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	data := getUIStateForTest(t, r)
	local := data["local"].(map[string]interface{})
	for i := 0; i < writers; i++ {
		key := fmt.Sprintf("ns%d", i)
		if _, ok := local[key]; !ok {
			t.Errorf("concurrent writer %d lost its key %q (read-merge-write interleaved)", i, key)
		}
	}
}
