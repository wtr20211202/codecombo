package files

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 文件回收站（P-20261003-304）：DeleteFile 删除前把目标整体挪入
// <DataDir>/artifacts/trash/<projectId>/<entryId>/，7 天内可原路径恢复——
// git 兜不住的误删（未跟踪文件/外部编辑内容）从此有后悔药。
//
// 存储车道（三车道纪律）：回收站内容是删除动作的大块产物，走车道 2
// artifacts/<feature>/ 惯例（同 recordings），第一天即配双上限清账
//（age > TrashRetention 或全实例总量 > TrashMaxTotalBytes 逐最旧）。
// 每条目自带 manifest.json——列表 = 逐条目读清单，磁盘即事实源（清掉
// trash 目录不存在孤儿索引问题），manifest 缺失时从目录名/mtime 降级推导。
//
// 一致性：trashMu 串行化全部 trash 变更（人操作级低频，锁零成本保险）；
// 同名并发删除由 entryId 的纳秒时间戳段区分（撞名步进兜底，filehistory
// 撞键同款），互不覆盖。

const (
	// TrashRetention 条目保留窗口：7 天足够「当晚发现误删」的后悔场景
	TrashRetention = 7 * 24 * time.Hour
	// TrashMaxTotalBytes 全实例回收站总量上限：超限按最旧逐出（磁盘占用护栏）
	TrashMaxTotalBytes int64 = 500 << 20
	// trashNameSegMax entryId 内 basename 段的截断长度：entryId 是目录名，
	// 超长 basename（深路径 + 长文件名）会顶到文件系统名长上限，截断保底，
	// 全名以 manifest 为准
	trashNameSegMax = 100
	// trashListMax 列表条目上限：正常容量护栏下远达不到，防外部投放
	//（绕过本服务直接塞目录）拖垮列表端点
	trashListMax = 500
)

// ErrTrashTargetExists 恢复目标已存在（API 层转 409，与 CreateFile/RenameFile
// 的「file already exists」同串——前端 KNOWN_ERROR_I18N 既有映射直达）
var ErrTrashTargetExists = errors.New("file already exists")

// ErrTrashEntry 回收站条目不存在（API 层转 404）
var ErrTrashEntry = errors.New("trash entry not found")

// ErrTrashAsName 重命名恢复（?as=，P-20261006-15）的目标名非法——API 层转
// 400 + code files.name_invalid（前端既有映射直达，无需新登记）
var ErrTrashAsName = errors.New("invalid restore name")

// trashManifest 条目清单：内容（entryDir/c）旁边的自描述元数据
type trashManifest struct {
	Version      int    `json:"version"`
	OriginalPath string `json:"originalPath"` // 项目相对路径（正斜杠归一）
	Basename     string `json:"basename"`     // 原名（entryId 截断后从这里取全名）
	IsDir        bool   `json:"isDir"`
	Size         int64  `json:"size"`        // 删除时内容字节（目录为递归累计）
	DeletedAtMs  int64  `json:"deletedAtMs"` // 删除时刻（unix 毫秒）
}

// trashEntry 列表条目（对外形态；前端直接渲染）
type trashEntry struct {
	ID          string `json:"id"`
	Path        string `json:"path"` // 原项目相对路径（恢复目标）
	Name        string `json:"name"` // 展示名（basename）
	IsDir       bool   `json:"isDir"`
	Size        int64  `json:"size"`
	DeletedAtMs int64  `json:"deletedAtMs"` // unix 毫秒（前端本地化格式化）
	// Degraded manifest 缺失/损坏：name/时间从目录名与 mtime 降级推导，
	// path 未知 → 恢复不可用（仅可彻底删除）
	Degraded bool `json:"degraded,omitempty"`
}

// trashMu 串行化 trash 变更与列表（跨项目共享一个 trashRoot，全局锁足够；
// 清账与恢复/彻底删互斥，防 rename 与 RemoveAll 竞态）
var trashMu sync.Mutex

// trashRootDir 回收站根（车道 2：<DataDir>/artifacts/trash/；独立函数供测试
// 经 SC_DATA_DIR 隔离，同 recording.ArtifactsDir 惯例）
func trashRootDir() string {
	return filepath.Join(config.DataDir(), "artifacts", "trash")
}

func trashProjectDir(projectID string) string {
	return filepath.Join(trashRootDir(), projectID)
}

// entryContentPath 条目内容固定子名 "c"：内容不与 manifest 同层，恢复目录时
// 不会把 manifest 一并带回项目树
func entryContentPath(entryDir string) string {
	return filepath.Join(entryDir, "c")
}

// validEntryID entryId 是路径段：拒绝分隔符与点段（防拼接穿越）
func validEntryID(id string) bool {
	return id != "" && id != "." && id != ".." &&
		!strings.ContainsAny(id, `/\`) && !strings.Contains(id, string(filepath.Separator)) &&
		filepath.Base(id) == id
}

// sizeOf 内容字节规模：文件取自身大小；目录元数据 WalkDir 累计（与删除本体
// 的 RemoveAll 同阶走盘成本，不引入新的量级；链接不深入，条目本身计入）
func sizeOf(absPath string, isDir bool) int64 {
	info, err := os.Lstat(absPath)
	if err != nil {
		return 0
	}
	if !isDir {
		return info.Size()
	}
	total := int64(0)
	_ = filepath.WalkDir(absPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			total++
			return nil
		}
		if !d.IsDir() {
			if fi, e := d.Info(); e == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total
}

// renameFn 测试缝：跨盘回退分支（EXDEV）无法在单机双卷单元测试里稳定复现，
// 注入失败替换实现来驱动回退路径（生产恒为 os.Rename）
var renameFn = os.Rename

// trashMaxTotalBytes 总量上限的运行时值（= TrashMaxTotalBytes）：var 而非 const
// 直读，为「逐最旧直到回线内」的清账分支留注入小档位的测试缝（同 renameFn）
var trashMaxTotalBytes = TrashMaxTotalBytes

// movePath src → dst：同卷直接 rename（原子、零拷贝）；跨卷 rename 失败回退
// copyTree + 删源（提案「跨盘回退 copy+delete」分支；项目盘与数据盘异卷的真实
// 场景）。copy 成功但删源失败时返回错误——dst 已有完整副本，调用方保留 dst
// 交由上层处置（trash 场景条目已入站，数据不丢）
func movePath(src, dst string) error {
	if err := renameFn(src, dst); err == nil {
		return nil
	}
	if err := copyTree(src, dst); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

// copyTree 递归复制（Lstat 语义）：目录按源权限重建；符号链接重建链接本身
// （不沿链进入目标子树——链接可指向项目外，跨盘回退不该把外部子树吸进回收站；
// Windows 无特权建链失败时跳过并记日志，与 sizeOf/RemoveAll 的「移除链接本身」
// 语义一致）。其余文件 io.Copy + 保留源权限
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.Type()&fs.ModeSymlink != 0 {
			linkTarget, e := os.Readlink(p)
			if e != nil {
				slog.Warn("trash copy readlink failed", "path", p, "err", e)
				return nil
			}
			if e := os.Symlink(linkTarget, target); e != nil && !os.IsExist(e) {
				slog.Warn("trash copy symlink failed", "path", p, "err", e)
			}
			return nil
		}
		if d.IsDir() {
			info, e := d.Info()
			mode := fs.FileMode(0755)
			if e == nil {
				mode = info.Mode().Perm()
			}
			return os.MkdirAll(target, mode)
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		in, e := os.Open(p)
		if e != nil {
			return e
		}
		defer in.Close()
		out, e := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
		if e != nil {
			return e
		}
		if _, e := io.Copy(out, in); e != nil {
			out.Close()
			return e
		}
		return out.Close()
	})
}

// moveToTrash 删除前入站：把 absPath（项目相对 relPath）整体挪入回收站，
// 返回 entryId。挪入失败返回错误——删除端点据此拒绝删除（数据安全底线：
// 回收站失败时静默退回不可逆直删，正是本提案要消灭的形态）
func moveToTrash(projectID, projectRoot, relPath, absPath string) (string, error) {
	info, err := os.Lstat(absPath)
	if err != nil {
		return "", err
	}
	isDir := info.IsDir()

	trashMu.Lock()
	defer trashMu.Unlock()

	projDir := trashProjectDir(projectID)
	if err := os.MkdirAll(projDir, 0o700); err != nil {
		return "", err
	}

	// entryId = <纳秒时间戳>-<basename 截断>：时间序前缀天然按删除时间排布；
	// Windows 粗时钟粒度下同秒批量删除同名文件（不同子目录）可撞名，步进兜底
	//（锁内串行，步进必得空位，filehistory 撞键同款）
	basename := filepath.Base(absPath)
	now := time.Now().UnixNano()
	entryID := trashEntryID(now, basename)
	entryDir := filepath.Join(projDir, entryID)
	for {
		if _, err := os.Lstat(entryDir); err != nil {
			break
		}
		now++
		entryID = trashEntryID(now, basename)
		entryDir = filepath.Join(projDir, entryID)
	}
	if err := os.Mkdir(entryDir, 0o700); err != nil {
		return "", err
	}

	if err := movePath(absPath, entryContentPath(entryDir)); err != nil {
		_ = os.RemoveAll(entryDir)
		return "", err
	}

	// manifest 尽力而为：写失败条目仍可用（降级信息推导），不回滚已完成的挪入
	m := trashManifest{
		Version:      1,
		OriginalPath: NormalizeRelPath(relPath),
		Basename:     basename,
		IsDir:        isDir,
		Size:         sizeOf(entryContentPath(entryDir), isDir),
		DeletedAtMs:  now / int64(time.Millisecond),
	}
	data, err := json.Marshal(m)
	if err == nil {
		if err := os.WriteFile(filepath.Join(entryDir, "manifest.json"), data, 0o600); err != nil {
			slog.Warn("trash manifest write failed", "entry", entryID, "err", err)
		}
	} else {
		slog.Warn("trash manifest marshal failed", "entry", entryID, "err", err)
	}
	return entryID, nil
}

// trashEntryID 条目目录名：<纳秒十进制>-<basename 截断>（首段定界 '-' 前必为
// 纯数字，parseEntryID 据此降级解析）
func trashEntryID(tsNano int64, basename string) string {
	seg := basename
	if len(seg) > trashNameSegMax {
		seg = seg[:trashNameSegMax]
	}
	return strconv.FormatInt(tsNano, 10) + "-" + seg
}

// parseEntryID 目录名 → (basename, 删除时刻毫秒)；非本服务命名的目录降级为
// （目录名, mtime）
func parseEntryID(entryDir string, id string, fi os.FileInfo) (string, int64) {
	if idx := strings.Index(id, "-"); idx > 0 {
		if ts, err := strconv.ParseInt(id[:idx], 10, 64); err == nil {
			return id[idx+1:], ts / int64(time.Millisecond)
		}
	}
	return id, fi.ModTime().UnixMilli()
}

// listTrash 项目回收站列表（新→旧）。manifest 是权威信息源，缺失/损坏降级
// 推导（Degraded 标记：path 未知，仅可彻底删除）
func listTrash(projectID string) ([]trashEntry, error) {
	projDir := trashProjectDir(projectID)
	dirEntries, err := os.ReadDir(projDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []trashEntry{}, nil
		}
		return nil, err
	}
	out := make([]trashEntry, 0, len(dirEntries))
	for _, de := range dirEntries {
		if !de.IsDir() || len(out) >= trashListMax {
			continue
		}
		id := de.Name()
		fi, err := de.Info()
		if err != nil {
			continue
		}
		e := trashEntry{ID: id, Size: -1, DeletedAtMs: fi.ModTime().UnixMilli()}
		if data, err := os.ReadFile(filepath.Join(projDir, id, "manifest.json")); err == nil {
			var m trashManifest
			if json.Unmarshal(data, &m) == nil && m.OriginalPath != "" {
				e.Path = m.OriginalPath
				e.Name = m.Basename
				e.IsDir = m.IsDir
				e.Size = m.Size
				e.DeletedAtMs = m.DeletedAtMs
			}
		}
		if e.Path == "" {
			// 降级：manifest 缺失（外部投放/写失败）。目录名可解析时至少
			// 还原名与时间，path 不可知 → 前端禁用恢复只留彻底删除
			name, ts := parseEntryID(filepath.Join(projDir, id), id, fi)
			e.Name, e.DeletedAtMs, e.Degraded = name, ts, true
			if e.Size < 0 {
				e.Size = 0
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAtMs > out[j].DeletedAtMs })
	return out, nil
}

// checkRestoreAsName as 参数守卫（P-20261006-15）：重命名恢复仅接受 basename
// 形态——拒绝路径分隔符与点段，防借恢复把内容写到原父目录之外的任意位置
// （validEntryID 同构守卫，路径穿越守卫族）；跨平台兼容名（P-132）沿写族口径
// 同步校验（Windows 保留设备名/段尾点空格在此入口同样拒绝）。敏感写入路径闸
// （P-235）不在此设防：as 只换叶子名、父目录即条目原籍（不带 as 的恢复同样
// 原位落回），守卫面与既有恢复语义等宽，引入只会造成同文件两分支不一致
func checkRestoreAsName(name string) error {
	if name == "" || name == "." || name == ".." ||
		strings.ContainsAny(name, `/\`) || strings.Contains(name, string(filepath.Separator)) ||
		filepath.Base(name) != name {
		return fmt.Errorf("%w: %q (as must be a bare file name, no path separators or dot segments)", ErrTrashAsName, name)
	}
	if err := validateNameCompat(name); err != nil {
		return fmt.Errorf("%w: %s", ErrTrashAsName, err)
	}
	return nil
}

// restoreTrash 把条目恢复回项目树：原父目录仍在 → 原路径恢复；父目录已随
// 后续删除/改名消失 → 按提案落到项目根（relocated=true，前端如实提示）。
// 目标已存在 → ErrTrashTargetExists（409，不静默覆盖现有文件）。
// asName 非空 = 重命名恢复（P-20261006-15）：只替换叶子名、保留原父目录——
// 409 冲突的前进路径（前端据此一键「恢复为建议名」），不带 as 原语义零变化
func restoreTrash(projectID, projectRoot, entryID, asName string) (restoredRel string, relocated bool, err error) {
	if !validEntryID(entryID) {
		return "", false, store.ErrInvalidArg
	}
	if asName != "" {
		if err := checkRestoreAsName(asName); err != nil {
			return "", false, err
		}
	}
	entryDir := filepath.Join(trashProjectDir(projectID), entryID)
	src := entryContentPath(entryDir)
	if _, err := os.Lstat(src); err != nil {
		return "", false, ErrTrashEntry
	}

	rel := ""
	if data, err := os.ReadFile(filepath.Join(entryDir, "manifest.json")); err == nil {
		var m trashManifest
		if json.Unmarshal(data, &m) == nil {
			rel = NormalizeRelPath(m.OriginalPath)
		}
	}
	if rel == "" {
		return "", false, ErrTrashEntry
	}

	// as 只替换叶子名（rel 已归一正斜杠）：原父目录缺失的落根分支在下游按
	// 替换后的叶子名同语义落根，重命名恢复两分支语义一致
	if asName != "" {
		if idx := strings.LastIndexByte(rel, '/'); idx >= 0 {
			rel = rel[:idx+1] + asName
		} else {
			rel = asName
		}
	}

	targetAbs, err := SafeJoinProject(projectRoot, rel)
	if err != nil {
		return "", false, err
	}
	name := filepath.Base(targetAbs)

	// 原父目录缺失（被删/改名）→ 落项目根（提案风险节既定处置）
	if _, err := os.Lstat(filepath.Dir(targetAbs)); err != nil {
		targetAbs = filepath.Join(mustAbsRoot(projectRoot), name)
		relocated = true
		rel = name
	}

	if _, err := os.Lstat(targetAbs); err == nil {
		return "", false, ErrTrashTargetExists
	}

	trashMu.Lock()
	defer trashMu.Unlock()
	if _, err := os.Lstat(targetAbs); err == nil {
		return "", false, ErrTrashTargetExists // 锁内复验（并发恢复同路径）
	}
	if _, err := os.Lstat(src); err != nil {
		return "", false, ErrTrashEntry // 锁内复验（并发彻底删同条目）
	}
	// 自环标记（P-20261005-15）：恢复是向项目树回填内容的写入动作，目标路径
	// 会产生 Create 事件，先行标记避免被外部写入观测误记
	markSelfWrite(targetAbs)
	if err := movePath(src, targetAbs); err != nil {
		return "", false, err
	}
	_ = os.RemoveAll(entryDir)
	return rel, relocated, nil
}

// purgeTrash 彻底删除单条目（不可恢复；不存在按幂等成功处理——列表与删除
// 间隙条目被清账吞掉是正常时序）
func purgeTrash(projectID, entryID string) error {
	if !validEntryID(entryID) {
		return store.ErrInvalidArg
	}
	trashMu.Lock()
	defer trashMu.Unlock()
	entryDir := filepath.Join(trashProjectDir(projectID), entryID)
	if _, err := os.Lstat(entryDir); err != nil {
		return ErrTrashEntry
	}
	return os.RemoveAll(entryDir)
}

// DeleteProjectTrash 项目删除级联清理：整个项目子树一锅端（孤儿语义——
// 项目 ID 不复用，条目永无恢复入口；导出供 project.DeleteProject 级联调用，
// 同 FileHistory.DeleteProject 惯例）
func DeleteProjectTrash(projectID string) {
	if projectID == "" {
		return
	}
	_ = os.RemoveAll(trashProjectDir(projectID))
}

// PurgeExpiredTrash 清账（启动 + 每日 ticker）：age 超 TrashRetention 的条目
// 先清；全实例总量超 TrashMaxTotalBytes 再逐最旧直到回线内。条目时间/大小
// 以 manifest 为准（缺失降级 mtime/0——孤儿条目按 age 兜底清，不累计大小）。
// 尽力而为：单条目清失败记日志继续，不阻断其余条目
func PurgeExpiredTrash() {
	root := trashRootDir()
	projDirs, err := os.ReadDir(root)
	if err != nil {
		return // 回收站从未使用（目录未建）或不可读：无事可做
	}

	trashMu.Lock()
	defer trashMu.Unlock()

	type aged struct {
		dir  string
		size int64
		ts   int64
	}
	var all []aged
	total := int64(0)
	cutoff := time.Now().Add(-TrashRetention).UnixMilli()
	for _, pd := range projDirs {
		if !pd.IsDir() {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(root, pd.Name()))
		if err != nil {
			continue
		}
		for _, de := range entries {
			if !de.IsDir() {
				continue
			}
			entryDir := filepath.Join(root, pd.Name(), de.Name())
			fi, err := de.Info()
			if err != nil {
				continue
			}
			a := aged{dir: entryDir, ts: fi.ModTime().UnixMilli()}
			if data, err := os.ReadFile(filepath.Join(entryDir, "manifest.json")); err == nil {
				var m trashManifest
				if json.Unmarshal(data, &m) == nil {
					a.size, a.ts = m.Size, m.DeletedAtMs
				}
			}
			if a.ts > 0 && a.ts < cutoff {
				if err := os.RemoveAll(entryDir); err != nil {
					slog.Warn("trash age purge failed", "dir", entryDir, "err", err)
				}
				continue
			}
			all = append(all, a)
			total += a.size
		}
	}
	if total <= trashMaxTotalBytes {
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ts < all[j].ts })
	for _, a := range all {
		if total <= trashMaxTotalBytes {
			break
		}
		if err := os.RemoveAll(a.dir); err != nil {
			slog.Warn("trash size purge failed", "dir", a.dir, "err", err)
			continue
		}
		total -= a.size
	}
}

// ============== HTTP handlers ==============

// TrashList GET /api/projects/:id/trash — 回收站列表（读面，挂 no-store：
// 列表随删除/恢复/清账实时变，陈旧缓存的条目点了恢复必 404）
func TrashList(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	entries, err := listTrash(p.ID)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": entries})
}

// TrashRestore POST /api/projects/:id/trash/:entryId/restore — 恢复到原路径。
// 可选 ?as=<newname> 重命名恢复（P-20261006-15）：只换叶子名保留原父目录，
// 仅 basename 形态（checkRestoreAsName 守卫，违规 400 code files.name_invalid）。
// 200 携 restoredPath（落点项目相对路径）与 relocated（父目录缺失落根标记，
// 前端据此如实提示「未恢复到原位置」）；409 目标已存在；404 条目不存在
func TrashRestore(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	rel, relocated, err := restoreTrash(p.ID, p.Path, c.Param("entryId"), c.Query("as"))
	switch {
	case err == nil:
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditFileRestore,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s", p.Name, rel),
		})
		c.JSON(http.StatusOK, gin.H{"message": "restored", "restoredPath": rel, "relocated": relocated})
	case errors.Is(err, ErrTrashEntry):
		shared.Error(c, http.StatusNotFound, "trash entry not found", nil)
	case errors.Is(err, ErrTrashTargetExists):
		shared.Error(c, http.StatusConflict, "file already exists", nil)
	case errors.Is(err, ErrTrashAsName):
		shared.ErrorWithCode(c, shared.CodeFilesNameInvalid, err.Error(), nil)
	case errors.Is(err, store.ErrInvalidArg):
		shared.Error(c, http.StatusBadRequest, "invalid entry id", nil)
	default:
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
	}
}

// TrashPurge DELETE /api/projects/:id/trash/:entryId — 彻底删除（不可恢复）。
// 404 条目不存在；成功入审计（file.purge）
func TrashPurge(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	err := purgeTrash(p.ID, c.Param("entryId"))
	switch {
	case err == nil:
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditFilePurge,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s", p.Name, c.Param("entryId")),
		})
		c.JSON(http.StatusOK, gin.H{"message": "purged"})
	case errors.Is(err, ErrTrashEntry):
		shared.Error(c, http.StatusNotFound, "trash entry not found", nil)
	case errors.Is(err, store.ErrInvalidArg):
		shared.Error(c, http.StatusBadRequest, "invalid entry id", nil)
	default:
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
	}
}
