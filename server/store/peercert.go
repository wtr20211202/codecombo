package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// PeerCertStore 实例间 TLS 连接的证书指纹库（TOFU 语义，SSH known_hosts 同款）。
//
// 车道 1 kind "peercerts"：host 一文档。历史实现是 DataDir/peer-certs.json
// 整文件读改写——持久化纪律落地前的越界反例（可并发查询、增量修改的应用
// 实体住了 ad-hoc 文件，见 docs/PERSISTENCE_LANES.md 债务 #1），已收编；
// 旧文件由组合根启动期 MigrateLegacy 导入。
type PeerCertStore interface {
	// GetFingerprint host 已记录返回指纹；未记录 ok=false
	GetFingerprint(host string) (fp string, ok bool, err error)
	// PutFingerprint 记录/覆盖 host 指纹（TOFU 首见 pin）
	PutFingerprint(host, fp string) error
	// AllFingerprints 全量（调试/导出用）
	AllFingerprints() (map[string]string, error)
	// ResetPeerCerts 清除全部指纹（下次连接重新 TOFU）
	ResetPeerCerts() error
}

type peerCertRepo struct{ doc DocumentStore }

func newPeerCertRepo(doc DocumentStore) *peerCertRepo { return &peerCertRepo{doc: doc} }

const peerCertKind = "peercerts"

// peerCertKey host → 稳定文件名键。host 取自 SNI，通常是主机名/IPv4，但
// IPv6 字面量含 ':'（validKey 拒绝）——统一用 sha256 前 32 hex 字符，
// 任何 host 形态都能落键；host 原文存文档体内
func peerCertKey(host string) string {
	sum := sha256.Sum256([]byte(host))
	return hex.EncodeToString(sum[:16])
}

// peerCertDoc 落盘结构（host 原文 + 指纹，键为 host 哈希）
type peerCertDoc struct {
	Host        string `json:"host"`
	Fingerprint string `json:"fingerprint"`
}

func (r *peerCertRepo) GetFingerprint(host string) (string, bool, error) {
	b, err := r.doc.Get(peerCertKind, peerCertKey(host))
	if err == ErrNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var d peerCertDoc
	if json.Unmarshal(b, &d) != nil || d.Fingerprint == "" {
		return "", false, nil
	}
	return d.Fingerprint, true, nil
}

func (r *peerCertRepo) PutFingerprint(host, fp string) error {
	if host == "" || fp == "" {
		return ErrInvalidArg
	}
	b, err := json.Marshal(peerCertDoc{Host: host, Fingerprint: fp})
	if err != nil {
		return err
	}
	return r.doc.Upsert(peerCertKind, peerCertKey(host), b)
}

func (r *peerCertRepo) AllFingerprints() (map[string]string, error) {
	keys, _, err := r.doc.List(peerCertKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		b, err := r.doc.Get(peerCertKind, k)
		if err != nil {
			continue
		}
		var d peerCertDoc
		if json.Unmarshal(b, &d) == nil && d.Host != "" {
			out[d.Host] = d.Fingerprint
		}
	}
	return out, nil
}

func (r *peerCertRepo) ResetPeerCerts() error {
	return r.doc.Clear(peerCertKind)
}
