package deploy

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 部署日志长期留档落盘（P-20261007-8，P-142 二阶段）：内存日志环终态 1h 后即逝，
// 而任务记录存库 30 天（module.go deployTaskRetention）——「任务在而日志亡」的
// 错位让排障回看（上周那次失败部署到底说了啥）拿不到原料。本文件把终态日志
// 快照写入车道 2（docs/PERSISTENCE_LANES.md：artifacts/<feature>/，文件本身即
// 数据、无字段级查询；可查询元数据仍在车道 1 deploytasks——文件名即任务 id，
// 无需独立索引），寿命与任务记录同源（每日 deploytask-cleanup 巡更同批对账清理）。
// 内存环保留不动：1h 窗内双源幂等（优先内存、过期读落盘），读端见
// server/api/deploy GetDeployTaskLog。

const (
	// persistedLogExt 留档文件扩展名（内容 = RenderLogText 渲染终形，纯文本）
	persistedLogExt = ".log"
	// persistedLogDirName 车道 2 特性目录名（<DataDir>/artifacts/ 下）
	persistedLogDirName = "deploy-logs"
)

// deployLogSnapshotCap 单任务快照字节封顶（容量护栏）：logBuf 的 200 条环形闸
// 只约束条数不约束字节——单条日志行来自部署器步骤输出，远端大输出可把一行撑到
// 任意大。超限保尾截头 + 头部截断标注：错误定位信息多在尾部（manager.go
// truncateTail 同判），头部任务元数据是留档身份段原样保留。正常任务远够：
// 200 条 × 数百字节 ≈ 百 KB 级
const deployLogSnapshotCap = 1 << 20 // 1 MiB

// snapshotTruncAnnot 截断标注（包级 var：文案内嵌封顶常量 → 长度编译期可定，
// 免去「标注长度依赖截断量、截断量依赖标注长度」的循环）
var snapshotTruncAnnot = fmt.Sprintf("log truncated: earlier lines omitted to fit snapshot byte cap %d\n\n", deployLogSnapshotCap)

// LogSourceHeader 双源读回的来源标注响应头：内存窗内命中 memory、落盘回源
// persisted——排障时分辨「实时窗」与「留档回放」，e2e/agent 据此断言读路
const (
	LogSourceHeader    = "X-Deploy-Log-Source"
	LogSourceMemory    = "memory"
	LogSourcePersisted = "persisted"
)

// deployLogDir 留档根（车道 2：<DataDir>/artifacts/deploy-logs/；独立函数供
// 测试经 SC_DATA_DIR 隔离，同 trashRootDir / recording.ArtifactsDir 惯例）
func deployLogDir() string {
	return filepath.Join(config.DataDir(), "artifacts", persistedLogDirName)
}

// persistKeySafe 留档文件名的任务 id 安全校验（filestore validKey 同款黑名单
// 语义——读路径的 id 来自 URL 参数，直拼文件名必须挡路径穿越）：拒绝路径分隔
// 符（/ \）、Windows 盘符与 NTFS 流（:）、点开头与连续点段、空值与超长。
// 真实任务 id（sc_dt_<uuid>）恒过；黑名单而非白名单，与存库 key 校验同宽
func persistKeySafe(id string) bool {
	if id == "" || len(id) > 256 {
		return false
	}
	if strings.ContainsAny(id, `/\:`) {
		return false
	}
	if strings.HasPrefix(id, ".") || strings.Contains(id, "..") {
		return false
	}
	return true
}

// persistedLogPath 任务留档文件路径；id 不安全返回 ok=false（调用方按无留档处理）
func persistedLogPath(taskID string) (string, bool) {
	if !persistKeySafe(taskID) {
		return "", false
	}
	return filepath.Join(deployLogDir(), taskID+persistedLogExt), true
}

// capSnapshot 快照字节封顶：头部（首个空行前，RenderLogText 的任务元数据段）
// 原样保留，正文超限保尾截头、截在整行边界（不劈行/不劈多字节 rune——按行
// 消费的留档形态），标注行插在头部与保尾正文之间。len ≤ cap 原样返回（零拷贝）
func capSnapshot(text []byte) []byte {
	if len(text) <= deployLogSnapshotCap {
		return text
	}
	head := text
	if sep := bytes.Index(text, []byte("\n\n")); sep >= 0 {
		head = text[:sep+2]
	}
	budget := deployLogSnapshotCap - len(head) - len(snapshotTruncAnnot)
	if budget <= 0 {
		// 头部+标注自身超限（理论不可达：头部几百字节级）：硬字节尾兜底不失界
		return text[len(text)-deployLogSnapshotCap:]
	}
	body := text[len(head):]
	cut := len(body) - budget
	if i := bytes.IndexByte(body[cut:], '\n'); i >= 0 {
		cut += i + 1 // 对齐到下一整行行首
	} else {
		cut = len(body) // 保尾窗内无整行（理论不可达）：退化为只留头+标注
	}
	out := make([]byte, 0, len(head)+len(snapshotTruncAnnot)+len(body)-cut)
	out = append(out, head...)
	out = append(out, snapshotTruncAnnot...)
	out = append(out, body[cut:]...)
	return out
}

// WritePersistedLog 把渲染好的留档文本落盘（整文件覆盖写：快照是终态一次性
// 产物，同任务重入终态幂等覆盖）。0700/0600 同数据目录敏感级惯例
func WritePersistedLog(taskID string, text []byte) error {
	p, ok := persistedLogPath(taskID)
	if !ok {
		return fmt.Errorf("unsafe deploy log task id %q", taskID)
	}
	if err := os.MkdirAll(deployLogDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, text, 0o600)
}

// ReadPersistedLog 读任务留档快照（内存窗外回源）：无文件/id 不安全 → ok=false，
// 由调用方维持既有 410 语义（首启前历史任务无留档，如实不可下载）
func ReadPersistedLog(taskID string) ([]byte, bool) {
	p, ok := persistedLogPath(taskID)
	if !ok {
		return nil, false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	return data, true
}

// persistLogSnapshot 终态收尾点的落盘动作（finishTask 专属：终态先行、快照
// 后补）：内存环此时仍在保留窗内（taskRetainTtl 1h），快照必然可得；取不到
// 说明 running 记录已先被清（理论边缘），如实不落。写失败 slog.Warn + 审计
// failure——留档是尽力而为的旁路，绝不阻塞任务终态（失败部署的日志恰恰最
// 重要，但收尾路径不能被文件 IO 拖垮）
func (m *Manager) persistLogSnapshot(task *config.DeployTask) {
	entries, ok := m.LogEntries(task.ID)
	if !ok {
		return
	}
	err := WritePersistedLog(task.ID, capSnapshot(RenderLogText(task, entries)))
	if err != nil {
		slog.Warn("deploy log persist failed", "task", task.ID, "err", err)
	}
	auditLogPersist(task.ID, len(entries), err)
}

// auditLogPersist 落盘动作入审计摘要（taskId/条数；系统动作无请求方 IP——
// audit.archive 同族惯例）：成功/失败各成一条，Append 本就尽力而为不向上传播
func auditLogPersist(taskID string, lines int, err error) {
	s := store.Get()
	if s == nil {
		return
	}
	ev := store.AuditEvent{
		Action: store.AuditDeployLogArchive,
		Result: store.AuditResultSuccess,
		Detail: fmt.Sprintf("task=%s lines=%d", taskID, lines),
	}
	if err != nil {
		ev.Result = store.AuditResultFailure
		ev.Detail = fmt.Sprintf("task=%s err=%v", taskID, err)
	}
	s.Audit.Append(ev)
}

// SweepPersistedLogs 留档日志随任务寿命对账清理（寿命同源：不新增独立保留
// 配置）：任务记录已不在库（出窗被 CleanupBefore 删除 / 记录损坏隔离）的
// 孤儿留档删除，任务在库的一律保留。挂在既有 deploytask-cleanup 每日巡更
// CleanupBefore 之后同批执行——清理失败轮任务记录留存 → 无孤儿 → 空转，
// 与任务清理天然一致。只认本功能命名形态（persistKeySafe + 扩展名）的文件，
// 目录里被投放的其他文件不借机波及（audit-archive 前缀防御同姿态）。
// 量级：文件数受任务保留窗约束（窗内任务数），每文件一次存库 Get——每日
// 一次的巡更点位，成本与 deploytasks 清理同族
func SweepPersistedLogs(s store.DeployTaskStore) int {
	entries, err := os.ReadDir(deployLogDir())
	if err != nil {
		return 0 // 目录不存在 = 从未落盘，零成本返回
	}
	removed := 0
	for _, en := range entries {
		if en.IsDir() || !en.Type().IsRegular() {
			continue
		}
		name := en.Name()
		if !strings.HasSuffix(name, persistedLogExt) {
			continue
		}
		id := strings.TrimSuffix(name, persistedLogExt)
		if !persistKeySafe(id) {
			continue
		}
		// 任务在库 → 日志随任务活着；ErrNotFound（出窗删除/损坏隔离按同语义
		// 回落）→ 孤儿删除；其余错误（IO 抖动）按在库保守跳过，下轮巡更重判
		if _, gerr := s.Get(id); gerr == nil {
			continue
		} else if !isNotFound(gerr) {
			continue
		}
		if os.Remove(filepath.Join(deployLogDir(), name)) == nil {
			removed++
		}
	}
	return removed
}

// isNotFound 存库「查无此任务」判定（store.ErrNotFound；deploy 包内
// repo.Get 对损坏 JSON 也按 ErrNotFound 回落——见 store/deploytask.go）
func isNotFound(err error) bool {
	return err == store.ErrNotFound
}
