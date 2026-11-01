package deploy

import (
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
)

// 部署日志留档下载（P-20261003-142）：任务日志是排障与合规留档（装了什么/
// 失败在哪），但 logBuf 只驻内存（running map，终态 taskRetainTtl 1h 后随
// 条目整体消失）。本文件提供 GET /api/deploy/:taskId/log 的数据面：内存日志
// 环快照 → 纯文本留档直出（HTTP 附件，不落盘）。日志落盘（车道 2 artifacts +
// 寿命同任务记录）已由 P-20261007-8 落地（logpersist.go）：终态快照写入，
// 1h 窗外读路回源落盘；本文件的 410 语义（LogExpiredMarker）降级为「内存与
// 落盘皆无」的兜底（首启前历史任务等），不再是一般情形。

// LogExpiredMarker 任务日志超出内存保留窗的稳定错误标记（对外契约）：GET
// /api/deploy/:taskId/log 对 1h 窗外任务（TTL 过期 / 进程重启内存清空——
// 日志仅驻内存，两者都不可恢复）的 410 拒绝原文。前端 KNOWN_ERROR_I18N 与
// blob 错误体解析按此串映射「日志已过期」文案，改措辞须两侧同步。文本唯一
// 事实源在 errmarkers 注册表（P-20261004-29），此处保名别名
const LogExpiredMarker = errmarkers.LogExpired

// logNameMaxRunes 下载名摘要 rune 截断（terminal/claudesessions 导出名同值）
const logNameMaxRunes = 40

// LogEntries 任务内存日志环的快照（拷贝出锁后再消费，避免调用方持 Manager 锁）。
// ok=false = 任务已不在内存。任务记录本身在存库保留 30 天（module.go
// deployTaskRetention）远超日志窗，api 层据此区分「过期不可下载」与「任务不存在」
func (m *Manager) LogEntries(taskID string) ([]LogEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt, ok := m.running[taskID]
	if !ok {
		return nil, false
	}
	out := make([]LogEntry, len(rt.logBuf))
	copy(out, rt.logBuf)
	return out, true
}

// RenderLogText 把日志条目渲染为留档 txt：头部任务元数据（存库记录，nil 容忍——
// 存库读失败时仍应服务内存日志）+ 逐条日志行。行格式
// `<RFC3339> [级别] [工具] 步骤: 消息`，Message 为空而 MessageKey 在场时
// （taskLogger.LogKV 形态）以 key 原样落盘——服务端不做 i18n 渲染，留档保
// 原始可对账形态而非翻译猜测。换行恒 LF（三平台一致；留档文本按行消费）。
// 体积天然有界：logBuf 环形上限 200 条（broadcastLocked），无需独立字节闸
func RenderLogText(task *config.DeployTask, entries []LogEntry) []byte {
	var b strings.Builder
	b.WriteString("codecombo deploy log\n")
	if task != nil {
		b.WriteString("task:     " + task.ID + "\n")
		b.WriteString("host:     " + task.Host + "\n")
		if ids := deployerSummary(task.Instances); ids != "" {
			b.WriteString("tools:    " + ids + "\n")
		}
		b.WriteString("status:   " + task.Status + "\n")
		if task.StartedAt != nil {
			b.WriteString("started:  " + task.StartedAt.Format(time.RFC3339) + "\n")
		}
		if task.FinishedAt != nil {
			b.WriteString("finished: " + task.FinishedAt.Format(time.RFC3339) + "\n")
		}
		if task.Error != "" {
			b.WriteString("error:    " + task.Error + "\n")
		}
	}
	b.WriteString("\n")
	for _, e := range entries {
		msg := e.Message
		if msg == "" {
			msg = e.MessageKey
		}
		b.WriteString(e.Time.Format(time.RFC3339))
		b.WriteString(" [" + e.Level + "]")
		if e.Deployer != "" {
			b.WriteString(" [" + e.Deployer + "]")
		}
		b.WriteString(" " + e.Step + ": " + msg + "\n")
	}
	return []byte(b.String())
}

// LogDownloadName 下载文件名：deploy-<主机摘要>-<yyyymmdd>.txt。主机地址是
// 用户配置内容（可含非 ASCII/控制字符/路径分隔符）：控制字符与跨平台不安全
// 字符折叠 '-'（空格合法保留）、连续并缩、rune 截断、首尾 '-. ' 修整（Windows
// 段规则），空摘要回退任务 id（服务端生成的 ASCII）。非 ASCII 由
// Content-Disposition 的 RFC 5987 形式承载（api 层经 shared.ContentDispositionFile
// 统一净化头），本函数只保证文件系统安全。净化规则与 terminal/claudesessions
// 的 ExportDownloadName 同约定、实现各自持有（域内小 helper，不为此跨包抽公共）
func LogDownloadName(host, taskID string, now time.Time) string {
	slug := strings.Map(func(r rune) rune {
		if r >= 0x20 && r != 0x7f && !strings.ContainsRune(`\/:*?"<>|`, r) {
			return r
		}
		return '-'
	}, host)
	// 连续折叠符并缩：按 '-' 切分（连续折叠段并成一个空隙）再单杠连接
	slug = strings.Join(strings.FieldsFunc(slug, func(r rune) bool { return r == '-' }), "-")
	if runes := []rune(slug); len(runes) > logNameMaxRunes {
		slug = string(runes[:logNameMaxRunes])
	}
	slug = strings.Trim(slug, "-. ")
	if slug == "" {
		// 任务 id 是服务端生成 ASCII（sc_dt_+uuid），只截断保文件系统安全
		if runes := []rune(taskID); len(runes) > logNameMaxRunes {
			taskID = string(runes[:logNameMaxRunes])
		}
		slug = taskID
	}
	return "deploy-" + slug + "-" + now.Format("20060102") + ".txt"
}
