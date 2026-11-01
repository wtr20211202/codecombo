package store

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"codecombo/server/config"

	"github.com/google/uuid"
)

// decryptField 解密敏感字段；失败时保留密文原样返回（列表/编辑流不中断），
// 由 ResolveRemoteHostAuth 在拨号前拦截 IsEncrypted 残留并给出可行动错误
func decryptField(s string) string {
	if s == "" || !config.IsEncrypted(s) {
		return s
	}
	plain, err := config.DecryptToken(s)
	if err != nil {
		slog.Warn("remotehost: credential decrypt failed, keeping ciphertext",
			"reason", err.Error())
		return s
	}
	return plain
}

// RemoteHostStore 远程主机凭据存储
type RemoteHostStore interface {
	List() ([]config.RemoteHost, error)
	Get(id string) (*config.RemoteHost, error)
	Create(input config.RemoteHost) (*config.RemoteHost, error)
	Save(rh config.RemoteHost) error
	Delete(id string) error
}

type remoteHostRepo struct{ doc DocumentStore }

func (r *remoteHostRepo) List() ([]config.RemoteHost, error) {
	keys, _, err := r.doc.List("remotehosts", ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]config.RemoteHost, 0, len(keys))
	for _, k := range keys {
		data, _ := r.doc.Get("remotehosts", k)
		var rh config.RemoteHost
		if json.Unmarshal(data, &rh) == nil {
			// 不解密凭据：List 的两个消费方（列表接口、TCP 状态探测器）
			// 都用不到明文——列表响应会剥掉敏感字段，探测器只用地址。
			// 拨号场景走 Get()（按需解密单条），省掉每轮 N 次 AES-GCM
			out = append(out, rh)
		}
	}
	return out, nil
}

func (r *remoteHostRepo) Get(id string) (*config.RemoteHost, error) {
	data, err := r.doc.Get("remotehosts", id)
	if err != nil {
		return nil, ErrNotFound
	}
	var rh config.RemoteHost
	if json.Unmarshal(data, &rh) != nil {
		return nil, ErrNotFound
	}
	rh.Password = decryptField(rh.Password)
	rh.PemContent = decryptField(rh.PemContent)
	return &rh, nil
}

// Create 返回值已解密敏感字段（Password/PemContent 为明文），方便上层直接使用
func (r *remoteHostRepo) Create(input config.RemoteHost) (*config.RemoteHost, error) {
	if input.ID == "" {
		input.ID = "sc_rh_" + uuid.New().String()
	}
	input.ApplyDefaults()
	plainPassword := input.Password
	plainPem := input.PemContent
	input.Password = config.EncryptIfNeeded(input.Password)
	input.PemContent = config.EncryptIfNeeded(input.PemContent)
	if err := r.persist(input); err != nil {
		return nil, err
	}
	input.Password = plainPassword
	input.PemContent = plainPem
	return &input, nil
}

func (r *remoteHostRepo) Save(rh config.RemoteHost) error {
	rh.Password = config.EncryptIfNeeded(rh.Password)
	rh.PemContent = config.EncryptIfNeeded(rh.PemContent)
	return r.persist(rh)
}

func (r *remoteHostRepo) Delete(id string) error {
	return r.doc.Delete("remotehosts", id)
}

func (r *remoteHostRepo) persist(rh config.RemoteHost) error {
	data, err := json.Marshal(rh)
	if err != nil {
		return fmt.Errorf("marshal remote host: %w", err)
	}
	return r.doc.Upsert("remotehosts", rh.ID, data)
}
