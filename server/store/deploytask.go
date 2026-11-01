package store

import (
	"encoding/json"
	"sort"
	"time"

	"codecombo/server/config"
)

// DeployTaskStore 部署任务存储
type DeployTaskStore interface {
	Save(task config.DeployTask) error
	Get(id string) (*config.DeployTask, error)
	ListRecent(limit int) ([]config.DeployTask, error)
	// CleanupBefore 删除 StartedAt 早于 before 的任务（StartedAt 为 nil 的
	// 远古记录一并删除），返回删除数。部署任务是自动产生的追加型历史，
	// 无保留策略会无限增长（持久化纪律：append 型 kind 必须带清理）
	CleanupBefore(before time.Time) (int, error)
}

type deployTaskRepo struct{ doc DocumentStore }

func (r *deployTaskRepo) Save(task config.DeployTask) error {
	data, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return r.doc.Upsert("deploytasks", task.ID, data)
}

func (r *deployTaskRepo) Get(id string) (*config.DeployTask, error) {
	data, err := r.doc.Get("deploytasks", id)
	if err != nil {
		return nil, ErrNotFound
	}
	var task config.DeployTask
	if json.Unmarshal(data, &task) != nil {
		return nil, ErrNotFound
	}
	return &task, nil
}

func (r *deployTaskRepo) ListRecent(limit int) ([]config.DeployTask, error) {
	keys, _, err := r.doc.List("deploytasks", ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]config.DeployTask, 0, len(keys))
	for _, k := range keys {
		data, _ := r.doc.Get("deploytasks", k)
		var task config.DeployTask
		if json.Unmarshal(data, &task) == nil {
			out = append(out, task)
		}
	}
	// 按 StartedAt 降序
	sort.Slice(out, func(i, j int) bool {
		var ti, tj int64
		if out[i].StartedAt != nil {
			ti = out[i].StartedAt.Unix()
		}
		if out[j].StartedAt != nil {
			tj = out[j].StartedAt.Unix()
		}
		return ti > tj
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// CleanupBefore 实现 DeployTaskStore.CleanupBefore
func (r *deployTaskRepo) CleanupBefore(before time.Time) (int, error) {
	keys, _, err := r.doc.List("deploytasks", ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		data, err := r.doc.Get("deploytasks", k)
		if err != nil {
			continue
		}
		var task config.DeployTask
		if json.Unmarshal(data, &task) != nil {
			continue
		}
		if task.StartedAt != nil && task.StartedAt.After(before) {
			continue
		}
		if err := r.doc.Delete("deploytasks", k); err == nil {
			removed++
		}
	}
	return removed, nil
}
