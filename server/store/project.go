package store

import (
	"encoding/json"
	"sort"
	"sync"
	"time"

	"codecombo/server/config"
)

// ProjectStore 项目存储
type ProjectStore interface {
	List() ([]config.ProjectConfig, error)
	GetByID(id string) (*config.ProjectConfig, error)
	Create(p config.ProjectConfig) error
	Update(p config.ProjectConfig) error
	Delete(id string) error
}

type projectRepo struct {
	doc DocumentStore

	// 读缓存：项目文档是 /api/projects/:id/* 每个请求都要读一次的热点
	//（shared.GetProjectFromContext → GetByID，全后端 100+ 调用点），
	// 历史实现每次都 os.ReadFile。3s TTL 内命中内存；写操作即时失效，
	// 应用外直改文件最多陈旧 TTL 窗口（与 repo_info/status 缓存同一权衡）
	mu      sync.RWMutex
	cache   []config.ProjectConfig
	cacheAt time.Time
}

const projectCacheTTL = 3 * time.Second

func (r *projectRepo) List() ([]config.ProjectConfig, error) {
	r.mu.RLock()
	if r.cache != nil && time.Since(r.cacheAt) < projectCacheTTL {
		result := r.cache
		r.mu.RUnlock()
		return result, nil
	}
	r.mu.RUnlock()

	keys, _, err := r.doc.List("projects", ListOpts{})
	if err != nil {
		return nil, err
	}
	var result []config.ProjectConfig
	for _, key := range keys {
		data, err := r.doc.Get("projects", key)
		if err != nil {
			continue
		}
		var p config.ProjectConfig
		if json.Unmarshal(data, &p) != nil {
			continue
		}
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })

	r.mu.Lock()
	r.cache = result
	r.cacheAt = time.Now()
	r.mu.Unlock()
	return result, nil
}

func (r *projectRepo) GetByID(id string) (*config.ProjectConfig, error) {
	all, err := r.List()
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			p := all[i]
			return &p, nil
		}
	}
	return nil, ErrNotFound
}

func (r *projectRepo) invalidate() {
	r.mu.Lock()
	r.cache = nil
	r.mu.Unlock()
}

func (r *projectRepo) Create(p config.ProjectConfig) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if err := r.doc.Create("projects", p.ID, data); err != nil {
		return err
	}
	r.invalidate()
	return nil
}

func (r *projectRepo) Update(p config.ProjectConfig) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if err := r.doc.Update("projects", p.ID, data); err != nil {
		return err
	}
	r.invalidate()
	return nil
}

func (r *projectRepo) Delete(id string) error {
	if err := r.doc.Delete("projects", id); err != nil {
		return err
	}
	r.invalidate()
	return nil
}
