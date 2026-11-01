package fsattr

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module fsattr 模块：订阅 file.changed 事件总线做归因入账（watch 模块是
// 唯一发布方，本模块是纯消费方——与 recording 消费审批事件同形态），并订阅
// project 生命周期事件维护「项目 → 根路径」缓存（相对路径换算用）。
// 路由面 GET /api/projects/:id/fs-attribution 在 api/files（读 store，不经
// 本模块）——与 filehistory/replacehist 同分工。
type Module struct {
	unsubFile    func()
	unsubAdded   func()
	unsubRemoved func()

	// rootsMu 保护项目根缓存：启动全量装载 + project.added/removed 增量
	// 维护 + 未命中回落 store 单查（项目路径变更经 removed+added 双事件
	// 发布，见 api/project/project.go publishLifecycle）。量级 = 项目数，
	// 免事件热路径逐条打 store
	rootsMu sync.RWMutex
	roots   map[string]string
}

func NewModule() *Module {
	return &Module{roots: map[string]string{}}
}

func (m *Module) Name() string        { return "fsattr" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	// file.changed 载荷：{path: 绝对路径, op: fsnotify 形态小写}（watch 模块发布）
	m.unsubFile = k.Events().Subscribe("file.changed", func(env kernel.Envelope) {
		projectID := env.ProjectID
		absPath, op := payloadPathOp(env.Payload)
		if projectID == "" || absPath == "" {
			return
		}
		at := env.TS
		if at.IsZero() {
			at = time.Now()
		}
		Record(projectID, m.projectRoot(projectID), absPath, op, at)
	})
	// 项目生命周期 → 根缓存增量维护（载荷为 map，与 watch 模块同款宽松解码）
	m.unsubAdded = k.Events().Subscribe("project.added", func(env kernel.Envelope) {
		var p struct{ ID, Path string }
		if !decodePayload(env.Payload, &p) || p.ID == "" || p.Path == "" {
			return
		}
		m.rootsMu.Lock()
		m.roots[p.ID] = p.Path
		m.rootsMu.Unlock()
	})
	m.unsubRemoved = k.Events().Subscribe("project.removed", func(env kernel.Envelope) {
		var p struct{ ID string }
		if !decodePayload(env.Payload, &p) || p.ID == "" {
			return
		}
		m.rootsMu.Lock()
		delete(m.roots, p.ID)
		m.rootsMu.Unlock()
	})
	return nil
}

func (m *Module) Start(_ context.Context, _ kernel.Kernel) error {
	// 根缓存首发装载（项目清单在 store.SetDefault 之后才可用，放 Start；
	// 装载前窗口的事件回落 store 单查，不丢账）
	if projects, err := store.Get().Project.List(); err == nil {
		m.rootsMu.Lock()
		for _, p := range projects {
			m.roots[p.ID] = p.Path
		}
		m.rootsMu.Unlock()
	}
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	for _, u := range []func(){m.unsubFile, m.unsubAdded, m.unsubRemoved} {
		if u != nil {
			u()
		}
	}
	m.unsubFile, m.unsubAdded, m.unsubRemoved = nil, nil, nil
	return nil
}

// projectRoot 项目根路径：缓存优先，未命中回落 store 单查并回填（启动窗口/
// 事件先于 project.added 到达的竞态）。未知项目返回空串——Record 侧按无根
// 丢弃（记不了相对路径，宁缺不错）
func (m *Module) projectRoot(projectID string) string {
	m.rootsMu.RLock()
	root, ok := m.roots[projectID]
	m.rootsMu.RUnlock()
	if ok {
		return root
	}
	p, err := store.Get().Project.GetByID(projectID)
	if err != nil || p == nil || p.Path == "" {
		return ""
	}
	m.rootsMu.Lock()
	m.roots[projectID] = p.Path
	m.rootsMu.Unlock()
	return p.Path
}

// payloadPathOp 宽松解码 file.changed 载荷（map[string]string 直取；结构性
// 载荷走 json 往返——与 watch.decodePayload 同防御，map 形态零分配直取）
func payloadPathOp(payload any) (path, op string) {
	switch v := payload.(type) {
	case map[string]string:
		return v["path"], v["op"]
	case nil:
		return "", ""
	default:
		var dst map[string]string
		if decodePayload(payload, &dst) {
			return dst["path"], dst["op"]
		}
		return "", ""
	}
}

// decodePayload 宽松解码 map/struct 形态的事件载荷（watch 模块同款实现——
// 本包只消费总线信封，拷贝 ~10 行防御代码不为此拉出公共依赖）
func decodePayload(payload any, dst any) bool {
	switch v := payload.(type) {
	case string:
		return json.Unmarshal([]byte(v), dst) == nil
	default:
		b, err := json.Marshal(payload)
		return err == nil && json.Unmarshal(b, dst) == nil
	}
}
