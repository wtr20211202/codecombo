package store

import (
	"encoding/json"
	"sync"

	"codecombo/server/config"
)

// SettingsStore 运行时配置存储（Server/Proxy/Changelist）
type SettingsStore interface {
	Get() *config.Config
	Save() error
}

type settingsRepo struct {
	doc DocumentStore
	mu  sync.Mutex
	cfg *config.Config
}

func (r *settingsRepo) Get() *config.Config {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cfg != nil {
		return r.cfg
	}
	data, err := r.doc.Get("config", "default")
	if err != nil {
		cfg := config.Load() // fallback to legacy config.Load
		r.cfg = cfg
		return cfg
	}
	var cfg config.Config
	if json.Unmarshal(data, &cfg) != nil {
		cfg := *config.Load()
		r.cfg = &cfg
		return &cfg
	}
	r.cfg = &cfg
	return &cfg
}

func (r *settingsRepo) Save() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cfg == nil {
		return nil
	}
	data, err := json.Marshal(r.cfg)
	if err != nil {
		return err
	}
	return r.doc.Upsert("config", "default", data)
}
