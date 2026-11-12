package store

import (
	"encoding/json"
	"sync"
)

// UIStateStore 前端 UI 状态存储
type UIStateStore interface {
	Get() (map[string]interface{}, error)
	Update(data map[string]interface{}) error
	// Merge 键级合并写（P-20261002-8）：data 按实例 ID 给出部分/完整记录，
	// 实例内顶层键（命名空间）浅合并——写入方未携带的键原样保留；实例记录
	// 整体为 null 表示清空该实例（布局重置/测试清理语义）。读-合并-写整体
	// 原子（与 Update 同锁互斥），并发 PATCH/PUT 不会互相吞键
	Merge(data map[string]interface{}) error
	// MutateNamespace 命名空间级读-改-写（P-20261111-1-S3）：transform 在 repo
	// 锁内收到该实例命名空间的当前值（缺失=nil），返回替换值（nil = 摘除该键）。
	// 专为服务端写入方（agent ops 面）提供「只动一个命名空间内部、其余键原样、
	// 与并发 PATCH 全程互斥」的手术通道——外部调用方拿 Get 结果自己改再 Merge
	// 会携带陈旧副本，与并发前端补丁互吞（跨「读→改→写」无锁窗口，Merge 注释
	// 同款根因）。err 非空中止不落盘
	MutateNamespace(instance, ns string, transform func(current interface{}) (interface{}, error)) error
}

const uiStateKey = "default"

type uiStateRepo struct {
	doc DocumentStore
	// mu 串行化全部读-合并-写（Merge/Update）：filestore 的 per-kind 锁只覆盖
	// 单次磁盘操作，跨「读→改→写」的原子性由本锁保证——否则两个并发 PATCH
	// 各读旧值再各自回写，后写者会丢掉先写者的键（多标签页写竞争正是本提案
	// 要消除的形态，服务端不封口则客户端只发变更键也救不回）
	mu sync.Mutex
}

func (r *uiStateRepo) Get() (map[string]interface{}, error) {
	data, err := r.doc.Get("uistate", uiStateKey)
	if err != nil {
		return map[string]interface{}{}, nil
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return map[string]interface{}{}, nil
	}
	return result, nil
}

func (r *uiStateRepo) Update(data map[string]interface{}) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.putLocked(data)
}

// Merge 见接口注释。合并语义与历史 PUT handler 一致：实例缺失=新增、实例
// 记录=null=清空、实例记录=按顶层键浅合并（键值 nil 写 null，读取端按缺省
// 归一，等效清键）。Get 失败按空表起步（与历史 handler 的 `existing, _` 一致）
func (r *uiStateRepo) Merge(data map[string]interface{}) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	current, _ := r.Get()
	out := make(map[string]interface{}, len(current)+len(data))
	for id, v := range current {
		out[id] = v
	}
	for id, incoming := range data {
		if incoming == nil {
			// 显式 null：清空该实例记录
			delete(out, id)
			continue
		}
		incomingMap, ok := incoming.(map[string]interface{})
		if !ok {
			continue
		}
		var prev map[string]interface{}
		if prevRaw, exists := out[id]; exists {
			if m, ok := prevRaw.(map[string]interface{}); ok {
				prev = m
			}
		}
		merged := make(map[string]interface{}, len(prev)+len(incomingMap))
		for ns, v := range prev {
			merged[ns] = v
		}
		for ns, v := range incomingMap {
			merged[ns] = v
		}
		out[id] = merged
	}
	return r.putLocked(out)
}

// putLocked 落盘（须持 r.mu）
func (r *uiStateRepo) putLocked(data map[string]interface{}) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return r.doc.Upsert("uistate", uiStateKey, raw)
}

// MutateNamespace 见接口注释：Get 当前全表 → 定位实例记录 → transform 命名
// 空间值 → putLocked 回写，全程持 r.mu（与 Update/Merge 同锁互斥）。transform
// 的入参是「命名空间当前值」（map[string]interface{} 或 nil），可直接就地改
// 也可以返回全新值；返回 err 即整体放弃（不写盘）。
// 实例记录缺失/非 map 时 current 传 nil（transform 自行决定新建语义）。
func (r *uiStateRepo) MutateNamespace(instance, ns string, transform func(current interface{}) (interface{}, error)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	current, _ := r.Get()
	var cur interface{}
	if inst, ok := current[instance].(map[string]interface{}); ok {
		cur = inst[ns]
	}
	next, err := transform(cur)
	if err != nil {
		return err
	}
	if next == nil {
		if _, exists := current[instance]; !exists {
			return nil // 实例记录本就缺失，摘键无需落盘
		}
		if inst, ok := current[instance].(map[string]interface{}); ok {
			delete(inst, ns)
		}
	} else {
		inst, ok := current[instance].(map[string]interface{})
		if !ok {
			inst = map[string]interface{}{}
		}
		inst[ns] = next
		current[instance] = inst
	}
	return r.putLocked(current)
}
