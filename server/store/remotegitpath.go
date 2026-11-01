package store

import (
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// RemoteGitPath 本地-远端同项目 Git 对照（P-20261004-34）的远端路径记忆：
// 「这台主机的这个项目，远端 checkout 在哪个目录」是每次对照都要重问的
// 高频问题——按 host+project 维度记住上次使用的远端路径，下次对照免手填。
//
// 车道归属（docs/PERSISTENCE_LANES.md）：kind "remotegitpath"，车道 1 结构化
// 状态（应用拥有的可查询实体，键控 upsert 非追加型）。数量上界 = 用户实际
// 对照过的「主机 × 项目」对数（同 claudecur 的键控 upsert 语义，无需保留策略；
// 单条仅一个路径字符串，体积天然有界）。
//
// 键 = <hostId>__<projectId>：两者都是服务端生成的 hex id（无路径分隔符/
// 冒号等 DocumentStore 键黑名单字符），__ 分隔与 claudecur 同款。主机删除时
// 级联清理（remote.DeleteRemoteHost，同 DiagHist 先例）；项目删除产生的孤儿
// 条目无害（不参与任何列表，仅在被再次对照到该 host+project 时被覆盖）。
type RemoteGitPath struct {
	Path      string    `json:"path"`
	UpdatedAt time.Time `json:"updatedAt"`
}

const remoteGitPathKind = "remotegitpath"

// RemoteGitPathStore 远端路径记忆（host+project 一键一条）
type RemoteGitPathStore interface {
	// Get 某主机+项目的记忆路径（无记忆时 ok=false）
	Get(hostID, projectID string) (string, bool)
	// Set 写入/覆盖记忆路径（空路径视为清记忆 → Delete）
	Set(hostID, projectID, path string) error
	// DeleteHost 主机删除时级联清理该主机全部条目（避免孤儿文档累积）
	DeleteHost(hostID string)
}

type remoteGitPathRepo struct {
	doc DocumentStore
	// mu 串行化同键读-改-写（Set 并发竞态会让 Update 打在未 Create 的键上）
	mu sync.Mutex
}

// NewRemoteGitPathRepo 构造远端路径记忆仓储（导出供 store_test 注入独立
// DocumentStore，同 NewDiagHistRepo 惯例）
func NewRemoteGitPathRepo(doc DocumentStore) RemoteGitPathStore {
	return &remoteGitPathRepo{doc: doc}
}

// remoteGitPathKey 组合键：<hostId>__<projectId>
func remoteGitPathKey(hostID, projectID string) string {
	return hostID + "__" + projectID
}

func (r *remoteGitPathRepo) Get(hostID, projectID string) (string, bool) {
	data, err := r.doc.Get(remoteGitPathKind, remoteGitPathKey(hostID, projectID))
	if err != nil {
		return "", false
	}
	var rec RemoteGitPath
	if json.Unmarshal(data, &rec) != nil || strings.TrimSpace(rec.Path) == "" {
		return "", false
	}
	return rec.Path, true
}

func (r *remoteGitPathRepo) Set(hostID, projectID, path string) error {
	if hostID == "" || projectID == "" {
		return ErrInvalidArg
	}
	path = strings.TrimSpace(path)
	if path == "" {
		// 空路径语义 = 清记忆（前端「忘记此路径」出口），不是写空串
		r.mu.Lock()
		defer r.mu.Unlock()
		if err := r.doc.Delete(remoteGitPathKind, remoteGitPathKey(hostID, projectID)); err != nil && err != ErrNotFound {
			return err
		}
		return nil
	}
	rec := RemoteGitPath{Path: path, UpdatedAt: time.Now()}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := remoteGitPathKey(hostID, projectID)
	return r.doc.Upsert(remoteGitPathKind, key, b)
}

func (r *remoteGitPathRepo) DeleteHost(hostID string) {
	if hostID == "" {
		return
	}
	keys, _, err := r.doc.List(remoteGitPathKind, ListOpts{Prefix: hostID + "__"})
	if err != nil {
		slog.Warn("remotegitpath list failed", "host", hostID, "err", err)
		return
	}
	if len(keys) == 0 {
		return
	}
	if err := r.doc.DeleteBatch(remoteGitPathKind, keys); err != nil {
		slog.Warn("remotegitpath delete-host failed", "host", hostID, "err", err)
	}
}
