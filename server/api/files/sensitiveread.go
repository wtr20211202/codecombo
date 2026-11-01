package files

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 敏感文件读取审计观测（P-20261003-315）：files 域审计此前只覆盖写侧
// （file.rename / file.delete），而 agent 持 sca_ 令牌可 GET 任意项目文件，
// .env/密钥/凭据文件被哪个会话读取零痕迹——「谁读了密钥」无从回答。
// 本文件在 ReadFile 成功读出内容后按敏感模式清单 best-effort 入账
// file.sensitive_read。纯观测 MVP：不拦截不弹窗（拦截属 AgentGuard 高危面
// 另行设计，不混入本观测面），审计页（P-13）从实际事件自然可见。

// sensitiveReadPatterns 敏感文件名模式清单（集中常量可扩；path.Match 语法）。
// 不含「/」的模式对路径末段（basename）匹配——嵌套路径 config/.env.production
// 照常命中；含「/」的模式对整条归一相对路径匹配（预留子目录级规则）。
// 清单窄域是刻意取舍：观测面不误伤正常开发（源码/README 零记录），
// 漏报是启发式清单的本质，靠扩清单收敛
var sensitiveReadPatterns = []string{
	".env*",        // 环境变量文件（.env / .env.local / .env.production 等）
	"id_rsa*",      // SSH 私钥（含 id_rsa.pub 等同族）
	"*.pem",        // 证书/私钥容器
	"*.key",        // 密钥文件
	"credentials*", // 云厂商/工具凭据清单
	"secrets*",     // 密钥集合清单
}

// IsSensitiveReadPath 判定项目相对路径是否命中敏感模式清单。
// 大小写不敏感（安全观测宁多勿漏：大小写变体 .ENV 与 .env 是同类威胁，
// 不区分宿主文件系统的大小写语义）；路径分隔符先归一为「/」再匹配
func IsSensitiveReadPath(relPath string) bool {
	norm := strings.ToLower(filepath.ToSlash(strings.TrimSpace(relPath)))
	if norm == "" || norm == "." {
		return false
	}
	base := path.Base(norm)
	for _, pat := range sensitiveReadPatterns {
		lower := strings.ToLower(pat)
		// path.Match 的错误只因模式非法（此处模式为包内常量，恒合法），忽略
		target := base
		if strings.Contains(lower, "/") {
			target = norm
		}
		if ok, _ := path.Match(lower, target); ok {
			return true
		}
	}
	return false
}

// sensitiveReadDedupWindow 去重窗口：同（会话 × 项目 × 路径）在窗口内只记
// 一条——编辑器重开/agent 轮询同一密钥文件不把审计台账刷成同一动作的重复行，
// 窗口外的再次读取照常入账（任务书注记的 5min 每会话每路径一条）
const sensitiveReadDedupWindow = 5 * time.Minute

// sensitiveReadDedupCap 去重表条目上限：观测面的内存有界线。超限先清过期
// 条目，仍超限整表重置——代价只是窗口语义偶尔失效（多记一条事件），
// 绝不丢事件本身，观测面可接受
const sensitiveReadDedupCap = 4096

// sensitiveReadDedup 进程内去重表（内存态重启清空：观测面 MVP，台账本体
// 在审计持久层，去重表只影响记录频率不影响事实可追溯）
type sensitiveReadDedup struct {
	mu   sync.Mutex
	last map[string]time.Time
}

// seen 报告 key 在窗口内是否已有记录（true = 本次应去重跳过），未记录则记账。
// now 由调用方注入：测试可拨时钟，生产传 time.Now()
func (d *sensitiveReadDedup) seen(now time.Time, key string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.last == nil {
		d.last = make(map[string]time.Time)
	}
	if t, ok := d.last[key]; ok && now.Sub(t) < sensitiveReadDedupWindow {
		return true
	}
	if len(d.last) >= sensitiveReadDedupCap {
		for k, t := range d.last {
			if now.Sub(t) >= sensitiveReadDedupWindow {
				delete(d.last, k)
			}
		}
		if len(d.last) >= sensitiveReadDedupCap {
			// 表全为窗口内活跃键：重置保内存有界（频率语义让位内存纪律）
			d.last = make(map[string]time.Time)
		}
	}
	d.last[key] = now
	return false
}

// sensitiveReadTable ReadFile 消费的全局去重表（人读与各 agent 会话共享一张表，
// 键含会话段互不吞记；读写均在锁内，读路径人操作级/agent 轮询级低频）
var sensitiveReadTable sensitiveReadDedup

// maybeAuditSensitiveRead ReadFile 成功读出内容后的敏感读取观测入口：
// 命中敏感清单且不在去重窗口内才入账。best-effort 语义与全域审计一致
// （Append 失败仅记日志），绝不阻断读路径
func maybeAuditSensitiveRead(c *gin.Context, p *config.ProjectConfig, relPath string) {
	if !IsSensitiveReadPath(relPath) {
		return
	}
	sid := strings.TrimSpace(c.GetHeader("X-Session-ID"))
	// 键含项目 id：两个项目的同名 .env 互不吞记；\x00 分隔防字段拼接歧义
	key := strings.Join([]string{p.ID, sid, relPath}, "\x00")
	if sensitiveReadTable.seen(time.Now(), key) {
		return
	}
	recordSensitiveReadAudit(c, p, relPath)
}

// recordSensitiveReadAudit 实际入账：Detail 只放项目名 + 相对路径 + 会话归属
// 摘要，绝不放文件内容（审计台账只记元数据的全域纪律）。X-Session-ID 是
// agent 会话归属（ops 手册约定全量携带），人类浏览器请求无此头则不带会话段
func recordSensitiveReadAudit(c *gin.Context, p *config.ProjectConfig, relPath string) {
	if store.Get() == nil || store.Get().Audit == nil {
		return // 测试环境未装配 Store 时静默跳过（snapshotForHistory 同款守卫）
	}
	detail := fmt.Sprintf("%s: %s", p.Name, relPath)
	if sid := strings.TrimSpace(c.GetHeader("X-Session-ID")); sid != "" {
		detail = fmt.Sprintf("%s (session %s)", detail, sid)
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileSensitiveRead,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}
