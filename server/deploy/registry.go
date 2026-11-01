package deploy

import (
	"sort"
	"sync"
)

var (
	registryMu sync.RWMutex
	registry   = map[string]Deployer{}
	listCache  []Deployer
)

func Register(d Deployer) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[d.ID()] = d
	listCache = nil
}

func Get(id string) Deployer {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return registry[id]
}

// List 返回按 Category 排序的所有 Deployer（缓存，注册变更时失效）
func List() []Deployer {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if listCache != nil {
		return listCache
	}
	out := make([]Deployer, 0, len(registry))
	for _, d := range registry {
		out = append(out, d)
	}
	catOrder := map[string]int{
		CategoryInit:     0,
		CategoryDevTool:  1,
		CategorySelfHost: 2,
	}
	sort.Slice(out, func(i, j int) bool {
		ci, cj := catOrder[out[i].Category()], catOrder[out[j].Category()]
		if ci != cj {
			return ci < cj
		}
		return out[i].ID() < out[j].ID()
	})
	listCache = out
	return out
}

// unregister 仅测试用
func unregister(id string) {
	registryMu.Lock()
	defer registryMu.Unlock()
	delete(registry, id)
	listCache = nil
}
