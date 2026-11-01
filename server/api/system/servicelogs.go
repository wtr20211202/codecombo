package system

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/config"
	"codecombo/server/mask"

	"github.com/gin-gonic/gin"
)

// 服务自身运行日志查看器（P-20261008-15）：DataDir/logs/ 下按日滚动的
// simple-coding-YYYY-MM-DD.log（写侧 server/app/app.go dailyHandler）此前零
// 应用内入口——服务异常（WS 断连/git 超时/更新失败/启动告警）排障要登机 tail，
// 手机/远程无 SSH 形态直接抓瞎。本文件补齐只读查看面：
//
//   - GET /api/system/logs?date=&q=&limit=&mask=   指定日期日志尾部窗口
//     （倒读，默认 200 行封顶 1000；q 关键词过滤；mask 敏感值遮蔽默认开）
//   - GET /api/system/logs/dates                    可用日期清单（降序）
//
// 纪律：运行日志文件只读零写路径改动（写侧滚动/清理链不受影响）；鉴权走全局
// api 组（LockMiddleware+TokenAuth+AgentGuard）= 管理面准入——日志含路径/
// 主机名/错误原文等敏感面，不再另设权限档；读侧过 mask.MaskText 同源遮蔽
// （与审计入账脱敏/录制遮蔽同一模式表，sc?_ 令牌/赋值形态/云密钥+自定义模式），
// 默认开——日志是排障面非取证面，mask=0 显式关。读取即快照语义：追加中的
// 文件读到的是某一瞬间的一致窗口，无锁无一致性承诺（诊断用途足够）。

const (
	// logFilePrefix 日志文件名前缀，与 server/app/app.go dailyHandler.prefix
	// 对齐。app→api 单向依赖不可反向 import，命名改动两处同步（这里只读、
	// 写侧唯一，漂移面=读不到文件，dates 清单空即可见）。
	// P-20261025-1 起 codecombo；legacyLogPrefix 为切换前存量（迁移随目录整体
	// 搬来），dates 清单与按日读取对新旧两个前缀并集兜底，旧文件随保留期消失
	logFilePrefix = "codecombo"
	// legacyLogPrefix 旧版前缀（与 app.go legacyLogPrefix 同字面量同步维护）
	legacyLogPrefix = "simple-coding"
	// logDateLayout 按日文件名的日期段格式（dailyHandler 同款）
	logDateLayout = "2006-01-02"
	// logTailDefaultLines 尾部窗口默认行数（提案口径 200）
	logTailDefaultLines = 200
	// logTailMaxLines limit 封顶（提案口径 1000）——响应体量与遮蔽开销上界
	logTailMaxLines = 1000
	// logTailChunkSize 倒读块大小：每次从文件尾方向读 64KB 切行
	logTailChunkSize = 64 * 1024
	// logScanMaxBytes 过滤态倒扫预算：q 命中不足 limit 时继续向文件头方向扫，
	// 预算耗尽即停（truncated=true 如实回告）。按日滚动的日志正常远小于此，
	// 预算只防病态大文件把请求拖成全量读
	logScanMaxBytes = 8 << 20 // 8MB
	// logCarryMaxBytes 半行缓存上限：跨块的单行（病态长行）只保留尾部
	// 256KB——排障价值在行尾（错误摘要/堆栈尾），行头截断对诊断无损；
	// 与 logScanMaxBytes 共同把倒读内存上界钳在常量级
	logCarryMaxBytes = 256 * 1024
)

// serviceLogDir 运行日志目录（与 app.go dailyHandler.logDir 同源：
// DataDir/logs）。函数化便于单测换目录
func serviceLogDir() string {
	return filepath.Join(config.DataDir(), "logs")
}

// serviceLogPath 指定日期的日志文件路径。date 须已过 time.Parse 校验——
// 文件名由 time.Time 重新 Format 生成而非拼接原始输入，路径注入面消除。
// 新名不存在时回落旧前缀（标识切换前存量），都没有返回新名路径（missing 语义
// 由调用方按文件不存在处理）
func serviceLogPath(day time.Time) string {
	newPath := filepath.Join(serviceLogDir(), logFilePrefix+"-"+day.Format(logDateLayout)+".log")
	if _, err := os.Stat(newPath); err == nil {
		return newPath
	}
	legacy := filepath.Join(serviceLogDir(), legacyLogPrefix+"-"+day.Format(logDateLayout)+".log")
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	return newPath
}

// ServiceLogDates GET /api/system/logs/dates —— 可用日志日期清单（降序新→旧）。
// 只读、无落盘；管理面鉴权由全局 api 组中间件承担
func ServiceLogDates(c *gin.Context) {
	dates, err := listServiceLogDates()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "log dir unreadable", "msg": err.Error()})
		return
	}
	// 清单随滚动/清理变化，禁止中间层缓存（前端每次打开面板现拉）
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"data": dates})
}

// listServiceLogDates 扫描运行日志目录返回可用日期（降序）
func listServiceLogDates() ([]string, error) {
	return listServiceLogDatesOn(serviceLogDir())
}

// listServiceLogDatesOn 目录参数化形态（单测注入临时目录）。非日志命名/坏日期
// 段的文件跳过（与 app.go CleanOldLogs 同款甄别口径）；空清单非错误。
// 新旧两个前缀并集（标识切换过渡期存量文件仍在保留期内）
func listServiceLogDatesOn(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	dates := make([]string, 0, len(entries))
	prefixes := []string{logFilePrefix + "-", legacyLogPrefix + "-"}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		matched := ""
		for _, p := range prefixes {
			if strings.HasPrefix(name, p) && strings.HasSuffix(name, ".log") {
				matched = p
				break
			}
		}
		if matched == "" {
			continue
		}
		d := strings.TrimSuffix(strings.TrimPrefix(name, matched), ".log")
		if _, err := time.Parse(logDateLayout, d); err != nil {
			continue
		}
		dates = append(dates, d)
	}
	// 字典序=时间序（定长 YYYY-MM-DD），降序新日期在前
	sort.Sort(sort.Reverse(sort.StringSlice(dates)))
	return dates, nil
}

// ServiceLogTail GET /api/system/logs 尾部窗口响应
type ServiceLogTail struct {
	// Date 归一后的日期（入参缺省=服务端当日）
	Date string `json:"date"`
	// Lines 尾部窗口（时间序旧→新；已按 mask 参数遮蔽）
	Lines []string `json:"lines"`
	// Truncated 未扫到文件头：更早的内容未进窗口（够行即停 / 过滤态扫到预算
	// 上限都置位）——「窗口之外还有更早日志」的诚实回告
	Truncated bool `json:"truncated"`
	// Missing 该日无日志文件（服务未运行/已过保留期被清）；此时 Lines 恒空
	Missing bool `json:"missing"`
	// Masked 本次响应是否做了敏感值遮蔽（mask 参数回显）
	Masked bool `json:"masked"`
}

// ServiceLogs GET /api/system/logs?date=&q=&limit=&mask= —— 指定日期运行日志
// 尾部窗口。date 缺省=服务端当日（与写侧滚动同口径）；q 为包含匹配（大小写
// 不敏感）；limit 缺省 200 封顶 1000；mask 敏感值遮蔽默认开（0/false 关）。
// agent 排障原语：服务异常自诊断「日志尾部进上下文」（手册 server-logs 节）
func ServiceLogs(c *gin.Context) {
	// date：严格 YYYY-MM-DD，非法 400（稳定原文，前端/agent 可编程分支）；
	// 缺省=今日。ParseInLocation 带本地时区——写侧按本地日期滚动，读侧同域
	rawDate := strings.TrimSpace(c.Query("date"))
	var day time.Time
	if rawDate == "" {
		day = time.Now()
	} else {
		d, err := time.ParseInLocation(logDateLayout, rawDate, time.Local)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid date, want YYYY-MM-DD"})
			return
		}
		day = d
	}
	date := day.Format(logDateLayout)

	// limit：非正/非法入参回落默认（读面宽容），越界封顶
	limit := logTailDefaultLines
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > logTailMaxLines {
		limit = logTailMaxLines
	}

	// q：包含匹配（大小写不敏感），空串=不过滤
	q := strings.TrimSpace(c.Query("q"))

	// mask：缺省开（排障面非取证面——令牌/赋值形态凭据默认不该随日志外发）；
	// 显式 0/false 关闭（确需看原文对账时）
	maskParam := strings.ToLower(strings.TrimSpace(c.Query("mask")))
	maskOn := maskParam != "0" && maskParam != "false"

	lines, truncated, missing, err := tailLogFile(serviceLogPath(day), limit, q, maskOn)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "log read failed", "msg": err.Error()})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"data": ServiceLogTail{
		Date:      date,
		Lines:     lines,
		Truncated: truncated,
		Missing:   missing,
		Masked:    maskOn,
	}})
}

// tailLogFile 倒读日志文件尾部窗口（纯读，即开即关不持句柄）：
// 从文件尾按 logTailChunkSize 块向文件头方向推进，块内切行倒序收集直到凑满
// limit 行（或过滤态耗尽 logScanMaxBytes 预算/到达文件头）。避免全量载入——
// 无过滤时 IO 量 ≈ 窗口尾部几百 KB；过滤态最坏一次预算内的顺序倒扫。
//
// 跨块半行处理：倒读中「块首段」（首个 \n 之前）是半行尾巴，缓存（carry）拼到
// 更旧块的末尾续整；到达文件头时首段即完整首行。行输出统一 TrimSuffix "\r"
// （写侧只有 \n，防御外部工具搬动的文件），空行照实保留（忠实原文）。
//
// truncated 语义 = 窗口未覆盖全文件（够行即停 / 过滤态预算耗尽 / 未推进到
// 文件头都置位）；missing = 文件不存在
// （服务未运行/已过保留期），此时返回空窗口而非错误——「那天没日志」是
// 排障面上的正常答案。
func tailLogFile(path string, limit int, q string, maskOn bool) (lines []string, truncated, missing bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, false, true, nil
		}
		return nil, false, false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, false, false, err
	}
	size := st.Size()
	if size == 0 {
		return []string{}, false, false, nil
	}

	lowerQ := strings.ToLower(q)
	// collected 倒序收集（新→旧），返回前反转为时间序
	collected := make([]string, 0, 64)
	var carry []byte // 上一轮（更新块）切出的半行尾巴，拼到本块末尾续整
	scanned := int64(0)
	pos := size
	buf := make([]byte, logTailChunkSize)
	enough := false
	for pos > 0 && !enough && scanned <= logScanMaxBytes {
		readLen := int64(len(buf))
		if pos < readLen {
			readLen = pos
		}
		pos -= readLen
		if _, err := f.ReadAt(buf[:readLen], pos); err != nil {
			return nil, false, false, err
		}
		block := make([]byte, 0, readLen+int64(len(carry)))
		block = append(block, buf[:readLen]...)
		block = append(block, carry...)
		carry = nil

		segs := strings.Split(string(block), "\n")
		start := 0
		if pos > 0 {
			// 未到文件头：首段是半行尾巴，入缓存续整（超长单行只留尾部）
			carry = []byte(segs[0])
			if len(carry) > logCarryMaxBytes {
				carry = carry[len(carry)-logCarryMaxBytes:]
			}
			start = 1
		}
		end := len(segs)
		// 块尾 \n 切出的空尾段不是行；末段（segs[end-1]）必为完整行——
		// 其终止符或在块内、或在已消费的更新块开头、或是文件尾无终止符
		if end > start && segs[end-1] == "" && strings.HasSuffix(string(block), "\n") {
			end--
		}
		for i := end - 1; i >= start; i-- {
			line := strings.TrimSuffix(segs[i], "\r")
			scanned += int64(len(line)) + 1
			if lowerQ != "" && !strings.Contains(strings.ToLower(line), lowerQ) {
				continue
			}
			if maskOn {
				line = mask.MaskText(line)
			}
			collected = append(collected, line)
			if len(collected) >= limit {
				enough = true
				break
			}
		}
	}
	// truncated = 窗口未覆盖全文件：凑满 limit 提前收手（enough）或扫到预算/
	// 文件边界仍未满足（pos>0）都置位——「窗口之外还有更早日志」的诚实回告。
	// 小文件够行即停时 pos 已到 0，但更早的行被 limit 丢弃，语义仍为截断
	truncated = enough || pos > 0
	// 反转为时间序（旧→新）
	for i, j := 0, len(collected)-1; i < j; i, j = i+1, j-1 {
		collected[i], collected[j] = collected[j], collected[i]
	}
	return collected, truncated, false, nil
}

func init() {
	// 智能体手册登记（selfcheck 节同款 init 注册惯例）：服务异常自诊断原语，
	// Order 22 紧随 system 节（21）——同属本机系统观测面
	agentops.RegisterSection(agentops.Section{
		ID: "server-logs", Title: "服务日志（本机排障原文）", Order: 22,
		Summary: "GET /api/system/logs 服务自身运行日志尾部窗口（按日滚动文件只读倒读，q 过滤/limit 封顶/敏感值遮蔽默认开）——服务异常（WS 断连/git 超时/更新失败/启动告警）自诊断的原文来源",
		Body: `服务自身行为异常（更新失败/watcher 告警/启动异常/请求 500）时先拉本机
运行日志尾部定位，不要登机 tail——自托管免 SSH 形态的排障入口。日志按日滚动
（保留期 settings.logRetentionDays，默认 15 天），读侧已做敏感值遮蔽（令牌/
口令赋值/云密钥→***，mask=0 可关；排障面非取证面，默认开防日志外发带凭据）。

- GET /api/system/logs/dates                   可用日期清单（降序）：
                                               {data:["2026-10-24",...]}
- GET /api/system/logs?date=&q=&limit=&mask=   指定日期尾部窗口（只读）：
  - date     缺省=服务端当日；严格 YYYY-MM-DD，非法 400
  - q        包含匹配（大小写不敏感；先 dates 再按关键字过滤命中行）
  - limit    尾部行数，缺省 200，封顶 1000
  - mask     敏感值遮蔽，缺省开；mask=0 关
  返回 {data:{date,lines:[旧→新],truncated,missing,masked}}：
  - truncated=true = 未扫到文件头（更早内容未进窗口——需要更早就加大 limit 重拉）
  - missing=true   = 该日无日志文件（未运行/已过保留期），lines 恒空

## 推荐用法（示例）

` + "```bash" + `
curl "{{BASE}}/api/system/logs?limit=100" -H "X-Lock-Token: $CC_LOCK_TOKEN"
curl "{{BASE}}/api/system/logs?date=2026-10-23&q=update%20failed" -H "X-Lock-Token: $CC_LOCK_TOKEN"
` + "```" + `

诊断闭环：先 GET /api/selfcheck 体检 → 命中异常再拉本端点看原文 → 按错误
原文修复；把日志尾部贴给用户时保持遮蔽（masked=true 的响应已安全）。`,
	})
}
