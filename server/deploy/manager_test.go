package deploy

import (
	"context"
	"sync"
	"testing"
	"time"

	"codecombo/server/config"
)

// fakeTaskStore 记录 Save 调用，用于断言校验失败时任务未被创建。
// mu 保护并发 Save：run/finishTask goroutine 会与测试主 goroutine 同时读写
type fakeTaskStore struct {
	mu    sync.Mutex
	saved []config.DeployTask
}

func (f *fakeTaskStore) Save(task config.DeployTask) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saved = append(f.saved, task)
	return nil
}

// snapshot 返回已保存记录的拷贝（测试并发读取安全）
func (f *fakeTaskStore) snapshot() []config.DeployTask {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]config.DeployTask, len(f.saved))
	copy(out, f.saved)
	return out
}

// distinctTaskIDs 返回已保存任务的去重 ID 数（断言「被拒触发不产生任务」用，
// 不能数 Save 次数——run/finishTask 对同一任务会追加持久化）
func (f *fakeTaskStore) distinctTaskIDs() int {
	seen := map[string]bool{}
	for _, t := range f.snapshot() {
		seen[t.ID] = true
	}
	return len(seen)
}

// lastStatusByID 返回某任务最近一次持久化的状态与是否存在记录
func (f *fakeTaskStore) lastStatusByID(id string) (string, bool) {
	found, status := false, ""
	for _, t := range f.snapshot() {
		if t.ID == id {
			found, status = true, t.Status
		}
	}
	return status, found
}

// lastTaskByID 返回某任务最近一次持久化的完整记录（排队 waitingFor 等字段断言用）
func (f *fakeTaskStore) lastTaskByID(id string) (config.DeployTask, bool) {
	var out config.DeployTask
	found := false
	for _, t := range f.snapshot() {
		if t.ID == id {
			out, found = t, true
		}
	}
	return out, found
}

func (f *fakeTaskStore) Get(id string) (*config.DeployTask, error) { return nil, nil }

func (f *fakeTaskStore) ListRecent(limit int) ([]config.DeployTask, error) { return nil, nil }

func (f *fakeTaskStore) CleanupBefore(before time.Time) (int, error) { return 0, nil }

func TestTriggerValidatesClaudeCfg(t *testing.T) {
	cases := []struct {
		name string
		cfg  *config.DeployConfig
	}{
		{"nil cfg", nil},
		{"missing token", &config.DeployConfig{AnthropicBaseURL: "http://gw/", Model: "m"}},
		{"missing baseUrl", &config.DeployConfig{AnthropicToken: "tk", Model: "m"}},
		{"missing model", &config.DeployConfig{AnthropicToken: "tk", AnthropicBaseURL: "http://gw/"}},
	}
	for _, c := range cases {
		s := &fakeTaskStore{}
		m := NewManager(s)
		_, err := m.Trigger(context.Background(), TriggerRequest{
			Instances: []config.DeployerInstance{{DeployerID: "claude_code", Params: map[string]string{}}},
		}, &config.RemoteHost{}, c.cfg)
		if err == nil {
			t.Errorf("%s: expected validation error, got nil", c.name)
		}
		if len(s.saved) != 0 {
			t.Errorf("%s: task should not be created on validation failure, got %d saved", c.name, len(s.saved))
		}
	}
}

// 不含 claude_code 的部署（如仅 simple_coding）不应做 Anthropic 配置校验——
// 即使 token/baseUrl/model 全空也放行，锁住「只在选了 claude 时才校验」的行为契约。
// host 显式指回环死端口：零值 host 的 Port=0 会被 sshclient.Dial 回退成 22，
// 任务结局随机器上是否有 sshd 漂移；死端口秒失败让派生的 run goroutine 可确定排空
// （Trigger 成功即有 goroutine 在途，测试返回前必须等它退出，否则残留 goroutine
// 读全局 store 会与后续测试的 store swap 构成数据竞态——race 门禁捕获）
func TestTriggerSkipsClaudeCfgValidationWithoutClaude(t *testing.T) {
	installTaskDoneStore(t)
	s := &fakeTaskStore{}
	m := NewManager(s)
	id, err := m.Trigger(context.Background(), TriggerRequest{
		Instances: []config.DeployerInstance{{DeployerID: "codecombo", Params: map[string]string{}}},
	}, &config.RemoteHost{Host: "127.0.0.1", Port: 1}, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("should not validate anthropic cfg without claude_code, got: %v", err)
	}
	if s.distinctTaskIDs() != 1 {
		t.Errorf("task should be created, got %d distinct tasks", s.distinctTaskIDs())
	}
	waitTasksDrained(t, s, id)
}
