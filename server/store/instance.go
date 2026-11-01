package store

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"codecombo/server/config"

	"github.com/google/uuid"
)

type InstanceStore interface {
	List() ([]config.InstanceConfig, error)
	GetLocal(port int) (*config.InstanceConfig, error)
	NewRemote(name, url, token string) config.InstanceConfig
	Save(inst config.InstanceConfig) error
	Delete(id string) error
	GetStatus(id string) string
	SetStatus(id, status string)
	BuildRoleMap(instances []config.InstanceConfig) map[string]string
	CheckCycleAdd(parentID, childID string) error
}

type instanceRepo struct {
	doc      DocumentStore
	statusMu sync.Mutex
	status   map[string]string
	cache    []config.InstanceConfig
	cacheAt  time.Time
	cacheMu  sync.RWMutex
}

func (r *instanceRepo) List() ([]config.InstanceConfig, error) {
	// 5 秒缓存，避免高频代理请求频繁读磁盘
	r.cacheMu.RLock()
	if r.cache != nil && time.Since(r.cacheAt) < 5*time.Second {
		result := r.cache
		r.cacheMu.RUnlock()
		return result, nil
	}
	r.cacheMu.RUnlock()

	keys, _, err := r.doc.List("instances", ListOpts{})
	if err != nil {
		return nil, err
	}
	result := make([]config.InstanceConfig, 0, len(keys))
	for _, key := range keys {
		data, _ := r.doc.Get("instances", key)
		var inst config.InstanceConfig
		if json.Unmarshal(data, &inst) == nil {
			if inst.Token != "" {
				if plain, err := config.DecryptToken(inst.Token); err == nil {
					inst.Token = plain
				}
			}
			// PairingKey 同 Token 的静态加密口径（enc: 态落盘，读链解明文；
			// 解密失败保 enc: 原样——携密路径按「未配对」处置，不炸清单）
			if inst.PairingKey != "" {
				if plain, err := config.DecryptToken(inst.PairingKey); err == nil {
					inst.PairingKey = plain
				}
			}
			result = append(result, inst)
		}
	}

	// 更新缓存
	r.cacheMu.Lock()
	r.cache = result
	r.cacheAt = time.Now()
	r.cacheMu.Unlock()

	return result, nil
}

func (r *instanceRepo) GetLocal(port int) (*config.InstanceConfig, error) {
	all, err := r.List()
	if err != nil {
		return nil, err
	}
	now := time.Now().Format(time.RFC3339)
	newURL := fmt.Sprintf("http://localhost:%d", port)
	for i := range all {
		if all[i].IsLocal {
			inst := &all[i]
			if inst.URL != newURL {
				inst.URL = newURL
				inst.UpdatedAt = now
				_ = r.Save(*inst)
			}
			return inst, nil
		}
	}
	local := config.InstanceConfig{
		ID: "local", Name: "本机", URL: newURL,
		IsLocal: true, CreatedAt: now, UpdatedAt: now,
	}
	if err := r.Save(local); err != nil {
		return nil, err
	}
	return &local, nil
}

func (r *instanceRepo) NewRemote(name, url, token string) config.InstanceConfig {
	encToken := token
	if token != "" && len(token) > 4 && token[:4] != "enc:" {
		if enc, err := config.EncryptToken(token); err == nil {
			encToken = enc
		}
	}
	now := time.Now().Format(time.RFC3339)
	return config.InstanceConfig{
		ID: uuid.New().String(), Name: name, URL: url, Token: encToken,
		IsLocal: false, CreatedAt: now, UpdatedAt: now,
	}
}

func (r *instanceRepo) Save(inst config.InstanceConfig) error {
	// 加密 token 后存储（PairingKey 同款：明文进 enc: 落盘，机器密钥不出本机）
	if inst.Token != "" && len(inst.Token) > 4 && inst.Token[:4] != "enc:" {
		if enc, err := config.EncryptToken(inst.Token); err == nil {
			inst.Token = enc
		}
	}
	if inst.PairingKey != "" && len(inst.PairingKey) > 4 && inst.PairingKey[:4] != "enc:" {
		if enc, err := config.EncryptToken(inst.PairingKey); err == nil {
			inst.PairingKey = enc
		}
	}
	data, err := json.Marshal(inst)
	if err != nil {
		return err
	}
	// 写前失效缓存：Update 与 Create 两条路径都要清，否则 5 秒内 List 仍返回旧数据
	// （如 UpdateInstance 改 URL 后代理继续按旧地址转发）
	r.cacheMu.Lock()
	r.cache = nil
	r.cacheMu.Unlock()
	return r.doc.Upsert("instances", inst.ID, data)
}

func (r *instanceRepo) Delete(id string) error {
	r.cacheMu.Lock()
	r.cache = nil
	r.cacheMu.Unlock()
	return r.doc.Delete("instances", id)
}

func (r *instanceRepo) GetStatus(id string) string {
	r.statusMu.Lock()
	defer r.statusMu.Unlock()
	if r.status == nil {
		r.status = make(map[string]string)
		// 从 DocumentStore 恢复状态
		r.loadStatusFromStore()
	}
	return r.status[id]
}

func (r *instanceRepo) SetStatus(id, status string) {
	r.statusMu.Lock()
	defer r.statusMu.Unlock()
	if r.status == nil {
		r.status = make(map[string]string)
		// 先恢复已落盘状态再做变更检测：否则重启后首写总被误判为「变化」
		r.loadStatusFromStore()
	}
	// 变更才落盘：代理每个请求都会 SetStatus(online)，历史实现每请求
	// Has+Update 两次磁盘操作（写放大）。状态语义是「最近一次迁移时间」，
	// 未变化的重复上报无需刷新 ts
	if prev, ok := r.status[id]; ok && prev == status {
		return
	}
	r.status[id] = status
	data, _ := json.Marshal(map[string]string{"id": id, "status": status, "ts": time.Now().Format(time.RFC3339)})
	_ = r.doc.Upsert("inst-status", id, data)
}

func (r *instanceRepo) loadStatusFromStore() {
	keys, _, _ := r.doc.List("inst-status", ListOpts{})
	for _, key := range keys {
		data, err := r.doc.Get("inst-status", key)
		if err != nil {
			continue
		}
		var item struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		if json.Unmarshal(data, &item) == nil {
			r.status[item.ID] = item.Status
		}
	}
}

func (r *instanceRepo) BuildRoleMap(instances []config.InstanceConfig) map[string]string {
	return config.BuildInstanceRoleMap(instances)
}

func (r *instanceRepo) CheckCycleAdd(parentID, childID string) error {
	if parentID == "" {
		return nil
	}
	if parentID == childID {
		return ErrAlreadyExists // 不能设置自己为父节点
	}
	all, err := r.List()
	if err != nil {
		return err
	}
	instMap := make(map[string]*config.InstanceConfig, len(all))
	for i := range all {
		instMap[all[i].ID] = &all[i]
	}
	// 检查 parentID 的祖先链中是否包含 childID（形成环）
	current := parentID
	for depth := 0; depth < 100; depth++ {
		inst, ok := instMap[current]
		if !ok || inst.ParentID == "" {
			return nil
		}
		if inst.ParentID == childID {
			return ErrAlreadyExists
		}
		current = inst.ParentID
	}
	return nil
}
