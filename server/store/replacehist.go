package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 批量替换历史（P-20261004-66）：替换前备份补丁在 P-20261004-114 落的是车道 2
// artifacts/replace-backups/（下载即走、30 天清账），产品内零留痕——「三天前那次
// 替换改了什么/想回滚」既无记录也找不到补丁。本文件把每次批量替换落为车道 1
// 结构化文档（一替换一文档），补丁以 base64 内嵌：
//   - 历史面板（设置·安全）按项目可查「何时/什么 pattern→replacement/改了几文件」
//   - 一键还原直接消费内嵌补丁（artifacts 副本被清账后仍可回滚，可逆性不依赖
//     用户保管下载文件）
//
// 边界与纪律注记：
//   - pattern/replacement 是功能性数据（历史面板就是要展示「那次替换改了什么」），
//     不是审计账——审计侧 file.replace 只记元数据的纪律不受影响（replace.go
//     auditReplace 同注释）；落盘数据面属用户自己的数据目录，与回收站/本地历史
//     快照同敏感级。
//   - append 型 kind 必须带保留策略（三车道纪律）：每项目 20 份逐最旧裁 + 30 天
//     TTL（与 artifacts 侧 replaceBackupRetention 同周期，files 模块每日 ticker
//     触发 PurgeExpired），双重上界保证落盘/内存有界：每项目至多
//     20 × (2MB 补丁 × 4/3 base64 + 元数据) ≈ 55MB 极限（现实替换补丁为 KB 级）。

// replaceHistKind 文档存储 kind 名
const replaceHistKind = "replacehist"

// ReplaceHistMaxPerProject 每项目保留的替换历史条数上限（Append 后逐最旧裁剪，
// 与 artifacts 侧 replaceBackupMaxPerProject=50 相比收紧——本侧内嵌补丁字节更重）
const ReplaceHistMaxPerProject = 20

// ReplaceHistPatchMaxBytes 内嵌补丁字节上限：超过则只留元数据 + artifacts 文件名
// 引用（PatchTruncated=true，还原端回落读 artifacts 文件；两侧同内容，内嵌副本
// 的价值是「清账后仍可还原」，超大补丁放弃内嵌换存储有界）
const ReplaceHistPatchMaxBytes = 2 << 20 // 2MB

// ReplaceHistRetention 替换历史保留期（TTL 清账，与 artifacts 备份 30 天同周期）
const ReplaceHistRetention = 30 * 24 * time.Hour

// ReplaceHistFile 单文件改动明细（还原端圈定 checkout 范围 + 面板展示）
type ReplaceHistFile struct {
	Path string `json:"path"`
	Hits int    `json:"hits"`
}

// ReplaceHistRecord 单次批量替换的历史档案（一替换一文档）
type ReplaceHistRecord struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Time      time.Time `json:"time"`
	// Pattern/Replacement 替换语义本体（面板展示「那次替换改了什么」；注释头）
	Pattern     string `json:"pattern"`
	Replacement string `json:"replacement,omitempty"`
	// 替换选项快照（面板徽标：正则/大小写/整词——同 pattern 不同选项是不同替换）
	UseRegex      bool `json:"useRegex,omitempty"`
	CaseSensitive bool `json:"caseSensitive,omitempty"`
	WholeWord     bool `json:"wholeWord,omitempty"`
	// PreserveCase 保留大小写（P-20261006-16）：替换输出跟随命中词形态——
	// 选项快照完整性义务，omitempty 缺省 false 旧记录零迁移
	PreserveCase bool `json:"preserveCase,omitempty"`
	// 执行结果计数（Files=实际改写文件数，Hits=实际替换处数；跳过/冲突如实留痕）
	Files     int `json:"files"`
	Hits      int `json:"hits"`
	Skipped   int `json:"skipped,omitempty"`
	Conflicts int `json:"conflicts,omitempty"`
	// Changed 改写文件明细（还原端圈定回滚范围）
	Changed []ReplaceHistFile `json:"changed,omitempty"`
	// BackupName 车道 2 artifacts 备份文件名（replace-backups/<项目>/，还原端
	// 在内嵌补丁缺失时的回落源；空 = 替换前工作区干净，Empty=true）
	BackupName  string `json:"backupName,omitempty"`
	BackupEmpty bool   `json:"backupEmpty,omitempty"`
	// PatchB64 内嵌备份补丁（base64（--binary patch，替换前工作区 vs 暂存区）；
	// 一键还原的直接原料）。超 ReplaceHistPatchMaxBytes 不内嵌，PatchTruncated
	// 如实标注（还原回落 artifacts 文件）
	PatchB64       string `json:"patchB64,omitempty"`
	PatchBytes     int    `json:"patchBytes,omitempty"`
	PatchTruncated bool   `json:"patchTruncated,omitempty"`
}

// ReplaceHistStore 批量替换历史存储（一替换一文档，每项目环形 + TTL 双重上界）
type ReplaceHistStore interface {
	// Append 落档（填 ID/Time；每项目超 ReplaceHistMaxPerProject 逐最旧裁剪）。
	// 尽力而为：落档失败记日志不 panic，返回零值记录
	Append(rec ReplaceHistRecord) ReplaceHistRecord
	// List 指定项目的历史（时间倒序，limit<=0 视为全部保留窗）
	List(projectID string, limit int) []ReplaceHistRecord
	// Get 单条（projectID × id 双重圈定，跨项目 ID 不串读）；无记录 ok=false
	Get(projectID, id string) (ReplaceHistRecord, bool)
	// Delete 单条移除（面板手动清账）；条目不存在返回 false
	Delete(projectID, id string) bool
	// DeleteProject 项目删除级联清理（项目 ID 不复用，历史随项目一锅端）
	DeleteProject(projectID string)
	// PurgeExpired TTL 清账（files 模块每日 ticker 触发），返回清理条数
	PurgeExpired(cutoff time.Time) int
}

type replaceHistRepo struct {
	doc DocumentStore
	// mu 串行化同 kind 的读改写（Append 裁剪 / PurgeExpired 并发互踩）
	mu sync.Mutex
}

// NewReplaceHistRepo 构造替换历史仓储（导出供测试注入独立 DocumentStore，
// 同 NewDiagHistRepo 惯例）
func NewReplaceHistRepo(doc DocumentStore) ReplaceHistStore {
	return &replaceHistRepo{doc: doc}
}

// replaceHistKey 文档键 = <projectID>-<unixNano>-<4字节随机>：
//   - projectID 前缀使 List 走 filestore 的 Prefix 键过滤（只读本项目的文档，
//     不为列一个项目的历史读全 kind——内嵌补丁的文档不便宜）
//   - unixNano 使键序≈创建序（裁剪按键序即时间序，免逐文档反序列化）
//   - 随机段防同纳秒撞键（Windows 时钟粒度粗，连续两次 time.Now() 可能同值；
//     crypto/rand 与 saveReplaceBackup 备份文件名同源）
//
// projectID 为系统生成的 uuid（无 / \ : .. 字符，filestore validKey 合法），键
// 总长 ~64 字符远低于 256 上限
func replaceHistKey(projectID string, now time.Time) string {
	var rnd [4]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		// 熵源失败（极罕见）：退化为纳秒低位派生，仅损失抗碰撞性不损失唯一性主段
		rnd[0] = byte(now.Nanosecond() >> 24)
		rnd[1] = byte(now.Nanosecond() >> 16)
		rnd[2] = byte(now.Nanosecond() >> 8)
		rnd[3] = byte(now.Nanosecond())
	}
	return projectID + "-" + strconv.FormatInt(now.UnixNano(), 10) + "-" + hex.EncodeToString(rnd[:])
}

// replaceHistTimeFromKey 从文档键提取创建时刻（TTL 清账免读文档正文；
// 解析失败返回零值 = 视为过期清理）
func replaceHistTimeFromKey(key string) time.Time {
	i := strings.LastIndex(key, "-")
	if i <= 0 {
		return time.Time{}
	}
	j := strings.LastIndex(key[:i], "-")
	if j <= 0 {
		return time.Time{}
	}
	nano, err := strconv.ParseInt(key[j+1:i], 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(0, nano)
}

func (r *replaceHistRepo) Append(rec ReplaceHistRecord) ReplaceHistRecord {
	if rec.ProjectID == "" {
		return ReplaceHistRecord{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if rec.Time.IsZero() {
		rec.Time = time.Now()
	}
	now := rec.Time
	rec.ID = replaceHistKey(rec.ProjectID, now)
	data, err := json.Marshal(rec)
	if err != nil {
		slog.Warn("replacehist marshal failed", "project", rec.ProjectID, "err", err)
		return ReplaceHistRecord{}
	}
	if err := r.doc.Create(replaceHistKind, rec.ID, data); err != nil {
		slog.Warn("replacehist persist failed", "project", rec.ProjectID, "err", err)
		return ReplaceHistRecord{}
	}
	// 环形裁剪：键含 unixNano，键序即创建序——按键排序删最旧，免逐文档读
	keys, total, err := r.doc.List(replaceHistKind, ListOpts{Prefix: rec.ProjectID + "-"})
	if err == nil && total > ReplaceHistMaxPerProject {
		sorted := append([]string(nil), keys...)
		sort.Strings(sorted)
		stale := sorted[:total-ReplaceHistMaxPerProject]
		if err := r.doc.DeleteBatch(replaceHistKind, stale); err != nil {
			slog.Warn("replacehist trim failed", "project", rec.ProjectID, "err", err)
		}
	}
	return rec
}

func (r *replaceHistRepo) List(projectID string, limit int) []ReplaceHistRecord {
	if projectID == "" {
		return []ReplaceHistRecord{}
	}
	keys, _, err := r.doc.List(replaceHistKind, ListOpts{Prefix: projectID + "-"})
	if err != nil {
		return []ReplaceHistRecord{}
	}
	out := make([]ReplaceHistRecord, 0, len(keys))
	for _, key := range keys {
		data, err := r.doc.Get(replaceHistKind, key)
		if err != nil {
			continue
		}
		var rec ReplaceHistRecord
		if json.Unmarshal(data, &rec) != nil {
			continue // 损坏文档跳过（历史可弃，不阻断面板）
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Time.After(out[j].Time) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (r *replaceHistRepo) Get(projectID, id string) (ReplaceHistRecord, bool) {
	if projectID == "" || id == "" || !strings.HasPrefix(id, projectID+"-") {
		// 前缀圈定：id 必须携带本项目前缀（路径穿越/跨项目读双防线，
		// filestore validKey 是第二道）
		return ReplaceHistRecord{}, false
	}
	data, err := r.doc.Get(replaceHistKind, id)
	if err != nil {
		return ReplaceHistRecord{}, false
	}
	var rec ReplaceHistRecord
	if json.Unmarshal(data, &rec) != nil || rec.ProjectID != projectID {
		return ReplaceHistRecord{}, false
	}
	return rec, true
}

func (r *replaceHistRepo) Delete(projectID, id string) bool {
	if _, ok := r.Get(projectID, id); !ok {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.doc.Delete(replaceHistKind, id) == nil
}

func (r *replaceHistRepo) DeleteProject(projectID string) {
	if projectID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(replaceHistKind, ListOpts{Prefix: projectID + "-"})
	if err != nil || len(keys) == 0 {
		return
	}
	if err := r.doc.DeleteBatch(replaceHistKind, keys); err != nil {
		slog.Warn("replacehist project cleanup failed", "project", projectID, "err", err)
	}
}

func (r *replaceHistRepo) PurgeExpired(cutoff time.Time) int {
	keys, _, err := r.doc.List(replaceHistKind, ListOpts{})
	if err != nil {
		return 0
	}
	var stale []string
	for _, key := range keys {
		ts := replaceHistTimeFromKey(key)
		if ts.IsZero() || ts.Before(cutoff) {
			stale = append(stale, key)
		}
	}
	if len(stale) == 0 {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.DeleteBatch(replaceHistKind, stale); err != nil {
		slog.Warn("replacehist purge failed", "err", err)
		return 0
	}
	return len(stale)
}
