package system

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 审计定期自动归档（P-20261003-277）：审计是滚动保留窗口（默认 30 天，可配），
// 窗口翻转即永久丢失——过期前把将出窗的事件转成 CSV 落 <DataDir>/artifacts/
// audit-archive/（合规离线留档），随后才执行时间窗清理。归档点挂在既有
// auditlog-cleanup 每日巡更链（本文件 RunAuditRetentionPass），与容量第二道闸
// （store.MaxAuditEntries，P-20261004-80）同链协同：归档 → 时间窗清理 → 容量闸
// → 归档文件窗口清账，次序固定。
//
// 存储车道（三车道纪律）：归档 CSV 是清理动作的大块产物，车道 2
// artifacts/<feature>/ 惯例（同 trash/recordings），文件本身即数据、无字段级
// 查询面（可查询状态仍在车道 1 auditlog kind 里直到出窗）；膨胀防线 = 归档
// 文件沿既有保留窗口清账（RunAuditRetentionPass 内 cleanupAuditArchiveFiles，
// 注记见该函数）。

// auditArchiveDir 归档根（车道 2：<DataDir>/artifacts/audit-archive/；独立函数
// 供测试经 SC_DATA_DIR 隔离，同 trashRootDir / recording.ArtifactsDir 惯例）
func auditArchiveDir() string {
	return filepath.Join(config.DataDir(), "artifacts", "audit-archive")
}

// auditArchiveFilePrefix 归档文件名前缀：cleanupAuditArchiveFiles 只清自家
// 命名形态的文件——目录若被投放了其他文件（用户手工存放的留档等）不借机
// 波及（回收站 trashListMax 防外部投放同款防御姿态）
const auditArchiveFilePrefix = "audit-archive-"

// auditArchiveMu 串行化归档 pass：每日 ticker 与手动触发端点（POST
// /api/audit/archive）可能并发进入，追加写同一日归档文件不能交错（人操作级
// 低频，锁零成本保险，trashMu 同款）
var auditArchiveMu sync.Mutex

// AuditRetentionResult 一次保留巡更 pass 的结果摘要（手动触发端点响应面 +
// ticker 日志同源）
type AuditRetentionResult struct {
	// Archived 本轮转 CSV 的过期事件数（0 = 窗口内无过期条目，未产生归档文件）
	Archived int `json:"archived"`
	// Removed 时间窗清理删除的活动条目数（仅归档成功后才清理——先落档再删除，
	// 归档失败轮跳过清理把事件留在活动窗口等下轮重试，绝不不告而别）
	Removed int `json:"removed"`
	// Pruned 容量第二道闸删除的最旧条目数（P-20261004-80 链路原样透出）
	Pruned int `json:"pruned"`
	// ArchiveFilesRemoved 归档目录按窗口清账删除的过期 CSV 文件数
	ArchiveFilesRemoved int `json:"archiveFilesRemoved"`
	// File 本轮归档文件名（仅 Archived > 0 时非空；basename——绝对路径是
	// 服务端本机形态，出响应面无消费价值）
	File string `json:"file,omitempty"`
}

// RunAuditRetentionPass 审计保留巡更（auditlog-cleanup 每日 ticker 的实体 +
// POST /api/audit/archive 手动触发同入口）。clientIP 为空 = 系统巡更触发
// （audit.prune「系统动作无请求方 IP」同惯例）；rid 同口径——手动触发经
// middleware.RequestIDFromGin 携请求关联 ID（审计条目可与访问日志对齐，
// P-20261006-53），ticker 巡更传空串（后台路径无请求上下文，Rid 留零值；
// 双口口径见 middleware.AuditAppend 注释）。
//
// 协同序（固定，勿重排）：
//  1. 归档过期事件 → CSV（先落档）
//  2. 时间窗清理 CleanupBefore（后删除；第 1 步失败则跳过）
//  3. 容量第二道闸 EnforceMaxEntries（P-20261004-80）：磁盘自保优先级高于
//     归档完整性——归档失败（如磁盘满）时闸照常执行，超量最旧条目仍会被
//     直接删除（audit.prune 摘要留痕），否则故障盘上的审计只增不减
//  4. 归档文件窗口清账（目录膨胀防线）
//
// 量级注记：过期事件读取沿 ExportAudit 同款分页循环（单页钳制
// auditMaxLimit，防单次拉全量截断），CSV 行硬上限沿用 auditExportRowCap；
// 每日一次的巡更点位 + 人操作级写入频率，成本与既有导出面同级
func RunAuditRetentionPass(now time.Time, clientIP, rid string) AuditRetentionResult {
	auditArchiveMu.Lock()
	defer auditArchiveMu.Unlock()

	days := store.Get().Settings.Get().Server.AuditRetentionDaysOrDefault()
	cutoff := now.AddDate(0, 0, -days)

	res := AuditRetentionResult{}
	rows, file, capReached, err := archiveExpiringEvents(cutoff, now)
	if err != nil {
		// 归档失败不静默也不阻断同链后续步骤（容量闸照常）；过期事件留在
		// 活动窗口，下轮巡更重试归档
		slog.Warn("audit archive failed, window cleanup skipped this round", "days", days, "err", err)
	} else {
		res.Archived = rows
		res.File = file
		if capReached {
			// 行数硬上限击穿的诚实边界：本轮 CSV 装不下的过期溢出尾随清理
			// 直接出窗（无归档副本）——与容量闸删最旧同级的事前防线兜底
			// 形态，日志留痕不静默。结构上不可达：容量闸（本 pass 第 3 步）
			// 把全仓封顶在 MaxAuditEntries（=10 万）以内，过期集合 ≤ 全仓 ≤
			// 行上限；上限纯防御共享常量的漂移
			slog.Warn("audit archive row cap reached, overflow expires unarchived", "rows", rows)
		}
		if n, err := store.Get().Audit.CleanupBefore(cutoff); err != nil {
			slog.Warn("audit log cleanup failed", "days", days, "err", err)
		} else {
			res.Removed = n
		}
	}
	// 容量第二道闸（P-20261004-80）：时间窗之外的保留防线，失败轮不跳过
	//（见上「协同序」第 3 步注记）；超量清理自身在 store 内记 audit.prune 摘要
	if n, err := store.Get().Audit.EnforceMaxEntries(store.MaxAuditEntries); err != nil {
		slog.Warn("audit log capacity prune failed", "max", store.MaxAuditEntries, "err", err)
	} else {
		res.Pruned = n
	}
	res.ArchiveFilesRemoved = cleanupAuditArchiveFiles(now, days)

	if res.Archived > 0 {
		// 归档动作同路入账（audit.export 同族惯例；系统巡更无 IP）。本 pass 是
		// ticker 与手动触发共用的巡更实体，无 *gin.Context 可传中央口——按
		// 双口口径走裸 Append、Rid 由调用方透传（手动触发携请求 rid）
		store.Get().Audit.Append(store.AuditEvent{
			Action: store.AuditLogArchive,
			Result: store.AuditResultSuccess,
			IP:     clientIP,
			Rid:    rid,
			Detail: fmt.Sprintf("rows=%d file=%s", res.Archived, res.File),
		})
		// 归档通知（i18n 模板双语，audit.notify.archive.*）：category system
		// 随既有通知偏好门控——用户静音系统类即不收（「归档通知可选」的
		// 实现面，不另立开关）
		store.Get().Notification.Add(notification.Notification{
			Type:     "info",
			Category: notification.CategorySystem,
			TitleKey: "audit.notify.archive.title",
			BodyKey:  "audit.notify.archive.body",
			Title:    "审计归档",
			Body:     fmt.Sprintf("archived=%d file=%s", res.Archived, res.File),
			MsgParams: map[string]any{
				"rows": res.Archived,
				"file": res.File,
			},
		})
		slog.Info("audit archive pass", "archived", res.Archived, "removed", res.Removed,
			"file", res.File, "archiveFilesRemoved", res.ArchiveFilesRemoved)
	}
	return res
}

// archiveExpiringEvents 把将出窗（Time 不晚于 cutoff，与 CleanupBefore 删除
// 谓词同一口径）的事件追加写入当日归档 CSV，返回行数与文件 basename。
//
// 文件粒度 = 每自然日一个（audit-archive-<2006-01-02>.csv，与导出面
// simple-coding-audit-<日期>.csv 同族命名）：存在则追加、不存在才落 BOM 与
// 表头——追加语义让同日多次 pass（手动触发 + 每日巡更）共处一文件不产生
// 碎片。行级幂等不做：pass 是「归档→清理」原子序的半程，进程中途崩溃可能
// 留下「已写 CSV 未清理」的重复窗口，下轮重归档会产生重复行——归档件是
// 留痕 trail 不是账本，宁重复不丢失。
//
// CSV 形态 = 审计 CSV 惯例（P-20261003-66 导出面同款）：UTF-8 BOM（Detail
// 常含非 ASCII，Excel 无 BOM 按 ANSI 误读）+ 五列 time/action/result/ip/
// detail + encoding/csv RFC 4180 转义 + 公式注入防护
func archiveExpiringEvents(cutoff, now time.Time) (rows int, file string, capReached bool, err error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	for offset := 0; ; offset += auditMaxLimit {
		page, total, err := store.Get().Audit.List(auditMaxLimit, offset)
		if err != nil {
			return 0, "", false, err
		}
		for _, e := range page {
			if e.Time.After(cutoff) {
				continue
			}
			if rows >= auditExportRowCap {
				capReached = true
				break
			}
			rows++
			_ = w.Write([]string{
				e.Time.Format(time.RFC3339),
				shared.SanitizeCSVCell(e.Action),
				e.Result,
				e.IP,
				shared.SanitizeCSVCell(e.Detail),
			})
		}
		if len(page) < auditMaxLimit || offset+auditMaxLimit >= total || rows >= auditExportRowCap {
			break
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return 0, "", capReached, err
	}
	if rows == 0 {
		// 窗口内无过期条目：不建文件不发通知（每日巡更的常态路径零写盘）
		return 0, "", false, nil
	}

	name := auditArchiveFilePrefix + now.Format("2006-01-02") + ".csv"
	path := filepath.Join(auditArchiveDir(), name)
	if err := os.MkdirAll(auditArchiveDir(), 0o700); err != nil {
		return 0, "", capReached, err
	}
	flags := os.O_WRONLY | os.O_APPEND | os.O_CREATE
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return 0, "", capReached, err
	}
	defer f.Close()
	// 首建才落 BOM + 表头（追加轮文件里已有）；Stat 在 OpenFile 前后都行，
	// 这里以「追加前大小为 0」判定，对被清空的残留文件同样补全表头
	if info, serr := f.Stat(); serr != nil {
		return 0, "", capReached, serr
	} else if info.Size() == 0 {
		if _, err := f.WriteString("\xEF\xBB\xBF"); err != nil {
			return 0, "", capReached, err
		}
		if _, err := f.WriteString("time,action,result,ip,detail\n"); err != nil {
			return 0, "", capReached, err
		}
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		return 0, "", capReached, err
	}
	return rows, name, capReached, nil
}

// cleanupAuditArchiveFiles 归档文件窗口清账（目录膨胀防线）：归档文件
// ModTime 早于保留窗口即删——窗口沿既有 settings.auditRetentionDays（执行时
// 读当前值，P-20261003-123 同源语义），归档文件因此比事件本体多活一个窗口，
// 总覆盖 ≈ 2×窗口；需要更长合规留档的场景调长保留期（上限 3650 天，磁盘
// 责任自负注记同既有）或把 CSV 移出数据目录自行归保管。目录不存在 = 从未
// 归档过，零成本返回
func cleanupAuditArchiveFiles(now time.Time, days int) int {
	dir := auditArchiveDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	window := time.Duration(days) * 24 * time.Hour
	removed := 0
	for _, en := range entries {
		if en.IsDir() || !en.Type().IsRegular() {
			continue
		}
		if !strings.HasPrefix(en.Name(), auditArchiveFilePrefix) {
			continue
		}
		info, err := en.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > window {
			if os.Remove(filepath.Join(dir, en.Name())) == nil {
				removed++
			}
		}
	}
	return removed
}

// TriggerAuditArchive POST /api/audit/archive —— 手动触发一轮审计保留巡更
// （归档 + 时间窗清理 + 容量闸 + 归档文件清账，与每日 ticker 同一
// RunAuditRetentionPass）。管理面鉴权同 List 面（全局 api 组中间件同域）；
// 为运维「缩短窗口/升级前先落档」提供即时入口，也是 e2e 窗口翻转用例的
// 驱动点（巡更是次日 tick，e2e 不等一天）
func TriggerAuditArchive(c *gin.Context) {
	res := RunAuditRetentionPass(time.Now(), c.ClientIP(), middleware.RequestIDFromGin(c))
	c.JSON(http.StatusOK, gin.H{"data": res})
}
