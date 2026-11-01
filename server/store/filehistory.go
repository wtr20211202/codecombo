package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"
)

// 本地文件历史（P-20261002-130，JetBrains Local History 式后悔药）：
// 文件被覆盖（WriteFile 保存 / 重命名挪走）之前把磁盘旧内容留档，agent 改坏
// 或误覆盖连 git 都兜不住时（未纳管目录/未提交改动）仍可回滚到任一历史版本。
//
// 存储（两 kind，均走 DocumentStore 车道 1）：
//   - kind "filehistory"：一版本一文档，键 = <projHash12>__<pathHash16>__<tsHex16>
//     （全 hex 安全段，claudeindex 同惯例——相对路径含 / \ : 与点开头/连续点段，
//     直排必撞 DocumentStore 键黑名单；原文 projectId/rel 存文档体内）。
//     ts 段定长 hex，字典序 = 时间序，List 前缀扫描即得时间序版本列表，零内容读
//   - kind "filehistorymeta"：一项目一台账文档（键 = <projHash12>），按时间升序
//     记录 {key, fileKey, ts, size, hash}。容量治理（每项目总字节/条目上限，
//     超限按最旧跨文件逐出）与「同内容跳过」去重都只读这份小台账，
//     快照热路径不触碰任何版本文档内容
//
// 二进制/超大文件是否留档属调用方策略（files API 依据 filepolicy 决定），本层
// 只负责字节级存取与容量纪律。
//
// 一致性：repo 级互斥锁串行化「读台账 → 写版本文档 → 改台账 → 逐出」的读改写；
// 与 diaghist 同桁（并发同项目快照极罕见，锁是零成本保险）。快照语义为尽力而为，
// 任何失败由调用方记日志后放行原写入——安全网绝不阻塞业务写。

// fileHistoryKind 版本文档 kind 名
const fileHistoryKind = "filehistory"

// fileHistoryMetaKind 项目容量台账 kind 名
const fileHistoryMetaKind = "filehistorymeta"

// FileHistoryMaxTotalBytes 每项目快照总字节上限（内容原文字节，跨文件累计）：
// 50MB 足够容纳活跃开发数天的文本留档，同时把车道 1 存储占用钉死
const FileHistoryMaxTotalBytes int64 = 50 << 20

// FileHistoryMaxEntries 每项目快照条数上限：纯字节上限在「大量小文件高频保存」
// 下仍可让台账文档无限膨胀（1KB×5 万条也是 50MB），条数档位一并封顶
const FileHistoryMaxEntries = 512

// FileVersion 单个历史版本的元数据（列表展示用；内容经 Content 按 ID 另取）
type FileVersion struct {
	// ID 版本寻址标识（ts 的 16 位 hex）。前端回传 content/restore 端点时
	// 原样带回——JSON number 装不下 UnixNano（超 JS 安全整数），故对外一律
	// 以字符串寻址，毫秒级 Ts 仅作展示排序参考
	ID string `json:"id"`
	// Ts 版本时间（毫秒，展示用）
	Ts int64 `json:"ts"`
	// Size 快照内容字节数
	Size int64 `json:"size"`
}

// fileHistoryDoc 单版本文档（Content []byte 经 encoding/json 落为 base64——
// 历史内容必须字节级保真还原（GBK/UTF-16 等非 UTF-8 文本按原字节写回），
// 不能走 string 字段的非法 UTF-8 → U+FFFD 有损替换）
type fileHistoryDoc struct {
	ProjectID string `json:"projectId"`
	Rel       string `json:"rel"`
	Ts        int64  `json:"ts"`
	Size      int64  `json:"size"`
	Hash      string `json:"hash"`
	Content   []byte `json:"content"`
}

// fileHistoryAcctItem 台账条目：一个快照在容量账本里的占位（不携内容）
type fileHistoryAcctItem struct {
	// Key 版本文档键（含 ts 段），逐出时按此删文档
	Key string `json:"key"`
	// FileKey 该版本所属文件的键前缀（<projHash>__<pathHash>），同内容去重按此找最新版
	FileKey string `json:"fileKey"`
	// Ts 版本时间（UnixNano，升序权威）
	Ts int64 `json:"ts"`
	// Size 内容字节数（容量累计口径 = 原文字节，非 base64 落盘字节）
	Size int64 `json:"size"`
	// Hash 内容 sha256 前 16 hex——同内容跳过去重的比对凭据
	Hash string `json:"hash"`
}

// fileHistoryMetaDoc 项目台账：Total 为 Items Size 累计（不变式由逐出循环维持）
type fileHistoryMetaDoc struct {
	Total int64                 `json:"total"`
	Items []fileHistoryAcctItem `json:"items"` // 按 Ts 升序（尾端最新）
}

// FileHistoryStore 本地文件历史仓储
type FileHistoryStore interface {
	// Append 覆盖前快照：把 content 留档为 (projectID, rel) 的一个新版本。
	// 最新版内容相同（sha256 前缀比对）时静默跳过——无变化的重复保存/被
	// 409 拒绝的重命名不留噪声版本。返回是否落了新版本
	Append(projectID, rel string, content []byte) (bool, error)
	// List 某文件的历史版本（新→旧）。无历史返回空切片
	List(projectID, rel string) ([]FileVersion, error)
	// Content 取单版内容；版本不存在返回 ErrNotFound
	Content(projectID, rel, id string) ([]byte, error)
	// DeleteProject 项目删除级联清理（版本文档 + 台账；不存在静默成功）
	DeleteProject(projectID string) error
}

type fileHistoryRepo struct {
	doc DocumentStore
	// mu 串行化台账读改写（Append 的去重/逐出并发交错会互相踩账/丢环尾）
	mu sync.Mutex
	// maxTotalBytes / maxEntries 容量档位（生产取常量；测试注入小档位）
	maxTotalBytes int64
	maxEntries    int
}

// NewFileHistoryRepo 构造本地历史仓储（导出供测试注入独立 DocumentStore，
// 同 NewProjectNotesRepo 惯例）
func NewFileHistoryRepo(doc DocumentStore) FileHistoryStore {
	return newFileHistoryRepo(doc, FileHistoryMaxTotalBytes, FileHistoryMaxEntries)
}

// NewFileHistoryRepoWithLimits 以指定容量档位构造（测试注档用：小档位让
// 字节/条数逐出与跨文件语义可观测，免灌 50MB 数据）
func NewFileHistoryRepoWithLimits(doc DocumentStore, maxTotalBytes int64, maxEntries int) FileHistoryStore {
	return newFileHistoryRepo(doc, maxTotalBytes, maxEntries)
}

func newFileHistoryRepo(doc DocumentStore, maxTotalBytes int64, maxEntries int) *fileHistoryRepo {
	return &fileHistoryRepo{doc: doc, maxTotalBytes: maxTotalBytes, maxEntries: maxEntries}
}

// fileHash 内容指纹（sha256 截 16 hex = 64 位）：仅用于「同内容跳过」，
// 64 位空间内误判概率可忽略
func fileHash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:8])
}

// projHash 项目 ID → 12 位 hex 键段（项目 ID 形态不受键黑名单约束的保证，
// claudeindex rootHash 同思路）
func projHash(projectID string) string {
	sum := sha256.Sum256([]byte("filehistory:" + projectID))
	return hex.EncodeToString(sum[:6])
}

// pathHash 相对路径 → 16 位 hex 键段（路径含分隔符/点段，无法直排键）
func pathHash(rel string) string {
	sum := sha256.Sum256([]byte(rel))
	return hex.EncodeToString(sum[:8])
}

// fileHistoryFileKey 文件的键前缀：<projHash>__<pathHash>
func fileHistoryFileKey(projectID, rel string) string {
	return projHash(projectID) + "__" + pathHash(rel)
}

// tsHex 版本时间 → 定长 16 位 hex 段（定长保证字典序 = 时间序）
func tsHex(ts int64) string {
	return fmt.Sprintf("%016x", ts)
}

// parseTsHex 版本 ID（16 位 hex）→ ts；非法 ID 返回错误（API 层转 404/400）
func parseTsHex(id string) (int64, error) {
	if len(id) != 16 {
		return 0, ErrInvalidArg
	}
	ts, err := strconv.ParseInt(id, 16, 64)
	if err != nil {
		return 0, ErrInvalidArg
	}
	return ts, nil
}

func (r *fileHistoryRepo) Append(projectID, rel string, content []byte) (bool, error) {
	if projectID == "" || rel == "" {
		return false, ErrInvalidArg
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	ts := time.Now().UnixNano()
	hash := fileHash(content)
	fileKey := fileHistoryFileKey(projectID, rel)
	meta := r.loadMeta(projectID)

	// 同内容跳过：该文件最新版与本次内容一致 → 无信息量的重复快照不入档
	for i := len(meta.Items) - 1; i >= 0; i-- {
		it := meta.Items[i]
		if it.FileKey == fileKey {
			if it.Hash == hash {
				return false, nil
			}
			break
		}
	}

	// ts 取自墙钟：Windows 计时粒度可让相邻两次快照同值，撞键时步进兜底
	// （锁内串行，步进必得空键）
	key := fileKey + "__" + tsHex(ts)
	for {
		if has, _ := r.doc.Has(fileHistoryKind, key); !has {
			break
		}
		ts++
		key = fileKey + "__" + tsHex(ts)
	}

	data, err := json.Marshal(fileHistoryDoc{
		ProjectID: projectID,
		Rel:       rel,
		Ts:        ts,
		Size:      int64(len(content)),
		Hash:      hash,
		Content:   content,
	})
	if err != nil {
		return false, err
	}
	if err := r.doc.Create(fileHistoryKind, key, data); err != nil {
		return false, err
	}

	// 台账入账（append 后防御性保序：墙钟回拨时维持 ts 升序不变式）
	meta.Total += int64(len(content))
	meta.Items = append(meta.Items, fileHistoryAcctItem{
		Key: key, FileKey: fileKey, Ts: ts, Size: int64(len(content)), Hash: hash,
	})
	if n := len(meta.Items); n > 1 && meta.Items[n-1].Ts < meta.Items[n-2].Ts {
		sort.Slice(meta.Items, func(i, j int) bool { return meta.Items[i].Ts < meta.Items[j].Ts })
	}
	r.evict(projectID, &meta)
	return true, r.saveMeta(projectID, &meta)
}

// evict 容量治理：总字节超 FileHistoryMaxTotalBytes 或条数超 FileHistoryMaxEntries
// 时按最旧跨文件逐出（删版本文档 + 出账），直到回到档位内
func (r *fileHistoryRepo) evict(projectID string, meta *fileHistoryMetaDoc) {
	for len(meta.Items) > 0 && (meta.Total > r.maxTotalBytes || len(meta.Items) > r.maxEntries) {
		oldest := meta.Items[0]
		if err := r.doc.Delete(fileHistoryKind, oldest.Key); err != nil && err != ErrNotFound {
			// 删不动即停：账实同步优先于纪律达成，避免台账指向已消失的版本
			slog.Warn("filehistory evict delete failed", "project", projectID, "key", oldest.Key, "err", err)
			return
		}
		meta.Total -= oldest.Size
		meta.Items = meta.Items[1:]
	}
}

func (r *fileHistoryRepo) List(projectID, rel string) ([]FileVersion, error) {
	if projectID == "" || rel == "" {
		return nil, ErrInvalidArg
	}
	prefix := fileHistoryFileKey(projectID, rel) + "__"
	keys, _, err := r.doc.List(fileHistoryKind, ListOpts{Prefix: prefix})
	if err != nil {
		return nil, err
	}
	// List 升序返回（ts 段定长 → 字典序 = 时间序），倒序输出最新在前
	out := make([]FileVersion, 0, len(keys))
	for i := len(keys) - 1; i >= 0; i-- {
		id := keys[i][len(prefix):]
		ts, err := parseTsHex(id)
		if err != nil {
			continue // 异形键（外部投放）跳过不致命
		}
		out = append(out, FileVersion{ID: id, Ts: ts / int64(time.Millisecond)})
	}
	// Size 从台账补（零内容读）；台账缺失（如外部删过）回退 0，前端隐藏大小即可
	meta := r.loadMeta(projectID)
	if len(meta.Items) > 0 {
		byKey := make(map[string]int64, len(meta.Items))
		for _, it := range meta.Items {
			byKey[it.Key] = it.Size
		}
		for i := range out {
			out[i].Size = byKey[prefix+out[i].ID]
		}
	}
	return out, nil
}

func (r *fileHistoryRepo) Content(projectID, rel, id string) ([]byte, error) {
	if projectID == "" || rel == "" {
		return nil, ErrInvalidArg
	}
	ts, err := parseTsHex(id)
	if err != nil {
		return nil, err
	}
	data, err := r.doc.Get(fileHistoryKind, fileHistoryFileKey(projectID, rel)+"__"+tsHex(ts))
	if err != nil {
		if err == ErrNotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var d fileHistoryDoc
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, err
	}
	return d.Content, nil
}

func (r *fileHistoryRepo) DeleteProject(projectID string) error {
	if projectID == "" {
		return ErrInvalidArg
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(fileHistoryKind, ListOpts{Prefix: projHash(projectID) + "__"})
	if err != nil {
		return err
	}
	if len(keys) > 0 {
		if err := r.doc.DeleteBatch(fileHistoryKind, keys); err != nil {
			return err
		}
	}
	if err := r.doc.Delete(fileHistoryMetaKind, projHash(projectID)); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}

// loadMeta 读项目台账（缺失/损坏视为空账——快照可随时从零重建，不视为错误）
func (r *fileHistoryRepo) loadMeta(projectID string) fileHistoryMetaDoc {
	data, err := r.doc.Get(fileHistoryMetaKind, projHash(projectID))
	if err != nil {
		return fileHistoryMetaDoc{}
	}
	var meta fileHistoryMetaDoc
	if json.Unmarshal(data, &meta) != nil {
		return fileHistoryMetaDoc{}
	}
	return meta
}

// saveMeta 台账落盘（upsert；写失败由调用方决定放行语义）
func (r *fileHistoryRepo) saveMeta(projectID string, meta *fileHistoryMetaDoc) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return r.doc.Upsert(fileHistoryMetaKind, projHash(projectID), data)
}
