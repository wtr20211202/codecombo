package diagnostics

import (
	"path/filepath"
	"time"
)

// ?probe=1 轻量预览（P-20261122-10 必改E）：只回 manifest 级别的体量决策，
// 不打包、不分析、不起平台探针——agent 先看体量再决定是否触发一次导出
// （导出是 20s 级、几十 MB 的流式响应，不该盲拉）。
//
// 与正式包的 manifest 同口径（同样走 planRawFiles 的 stat + 截断决策），
// 差异只在「不做派生活）：派生文件（README/manifest/summary/errors/platform/
// runtime/inventory）合计通常几百 KB，未计入 includedBytes，故同时给
// derivedFiles 清单让人自己估算。

// ProbeReport 探针响应（GET /api/system/diagnostics/export?probe=1 的 data）
type ProbeReport struct {
	GeneratedAt string      `json:"generatedAt"`
	Version     string      `json:"version"`
	Source      string      `json:"source"`
	Mask        bool        `json:"mask"`
	LogDays     int         `json:"logDays"`
	Files       []Entry     `json:"files"`
	Totals      ProbeTotals `json:"totals"`
	Limits      ProbeLimits `json:"limits"`
	Derived     []string    `json:"derivedFiles"`
	Notes       []string    `json:"notes,omitempty"`
}

// ProbeTotals 探针汇总
type ProbeTotals struct {
	Files       int `json:"files"`
	PackedFiles int `json:"packedFiles"`
	Absent      int `json:"absent"`
	Truncated   int `json:"truncated"`
	Omitted     int `json:"omitted"`
	// IncludedBytes 原文入包字节（不含派生文件）
	IncludedBytes int64 `json:"includedBytes"`
	// ZipUpperBoundBytes 无压缩上界 = includedBytes（真实 zip 通常远小于此，
	// 文本 5-10x 压缩；这是上界不是估计值——不编造压缩比）
	ZipUpperBoundBytes int64 `json:"zipUpperBoundBytes"`
}

// ProbeLimits 体量纪律常量（前端/agent 直接展示，不用猜）
type ProbeLimits struct {
	FullFileBytes  int64 `json:"fullFileBytes"`
	HeadBytes      int64 `json:"headBytes"`
	TailBytes      int64 `json:"tailBytes"`
	RawBudgetBytes int64 `json:"rawBudgetBytes"`
	ZipCapBytes    int64 `json:"zipCapBytes"`
}

// probeDerivedFiles 派生文件清单（固定，探针不生成也不计字节）
var probeDerivedFiles = []string{
	"README.txt", "manifest.json", "logs-summary.txt", "slow-requests.txt", "stalls.txt",
	"errors.txt", "dsh-summary.txt", "platform.txt", "tls-summary.txt",
	"state/runtime.json", "state/selfcheck.json", "state/update-status.json",
	"state/data-dir-inventory.txt", "state/storage.json", "state/large-files.json",
	"state/requests.json", "state/stalls.json", "state/host.json", "state/host-history.json",
	"state/net.json", "state/tls.json", "state/share-health.json", "state/self-probe.json",
	"state/collection-report.json",
	// P-20261126-3：Go 运行时快照+趋势环 / 路由级热点聚合 / deep 档 pprof 档案。
	// profiles/* 仅 deep 导出存在（cpu 另需显式 &cpu=1；shallow 一张档案都没有）；
	// P-20261126-2：浏览器侧报告是条件性条目（导出请求携带 ?clientReport=1 且
	// 5 分钟会话窗内有报告才入包——前端点导出时自动 POST，P-20261127-1），
	// 缺席缘由见 manifest 的 reason 字段
	"state/browser.json",
	// goroutine 栈按停顿事件动态出现（state/goroutine-stalls-NN.txt），不列固定项
	"state/goruntime.json", "state/routes.json",
	"profiles/heap", "profiles/goroutine", "profiles/block", "profiles/mutex",
}

// Probe 轻量体量预览（stat + 截断决策；不读日志内容、不起子进程）
func Probe(opts Options) (*ProbeReport, error) {
	if err := normalizeOptions(&opts); err != nil {
		return nil, err
	}
	red := NewRedactor(opts.DataDir, opts.Mask)
	raw, notes := planRawFiles(opts, red, filepath.Join(opts.DataDir, "logs"))
	rep := &ProbeReport{
		GeneratedAt: time.Now().Format(time.RFC3339),
		Version:     opts.Version,
		Source:      opts.Source,
		Mask:        opts.Mask,
		LogDays:     opts.LogDays,
		Limits: ProbeLimits{
			FullFileBytes:  fullLogMaxBytes,
			HeadBytes:      logHeadBytes,
			TailBytes:      logTailBytes,
			RawBudgetBytes: rawBudgetBytes,
			ZipCapBytes:    zipCapBytes,
		},
		Derived: probeDerivedFiles,
	}
	for _, r := range raw {
		rep.Files = append(rep.Files, r.meta)
		rep.Totals.Files++
		switch r.meta.Status {
		case StatusPresent, StatusTruncated:
			rep.Totals.PackedFiles++
			rep.Totals.IncludedBytes += r.meta.IncludedBytes
			if r.meta.Status == StatusTruncated {
				rep.Totals.Truncated++
			}
		case StatusAbsent, StatusDenied:
			rep.Totals.Absent++
		case StatusOmitted:
			rep.Totals.Omitted++
		}
	}
	rep.Totals.ZipUpperBoundBytes = rep.Totals.IncludedBytes
	rep.Notes = dedupeNotes(notes)
	// profiles/* 的 deep-only 语义（P-20261126-3 S3）：probe 与实包对账时不要把
	// 四个档案当 shallow 也有的固定项
	if opts.Deep {
		rep.Notes = append(rep.Notes, "deep: profiles/{heap,goroutine,block,mutex} will be packed (cpu also requires &cpu=1); oversized binary profiles are dropped WHOLE, not truncated")
	} else {
		rep.Notes = append(rep.Notes, "shallow: no profiles/* entries — they are deep-only (cpu also requires &cpu=1)")
	}
	// 条件性条目注记（P-20261126-2 B5；P-20261127-1 措辞同步——前端点导出时自动
	// POST，不再要求「先点导出浏览器诊断」）：探针不携带 cookie 上下文，browser.json
	// 是否真入包由导出请求的 ?clientReport=1 参数 + 会话窗决定——这里只声明条件性，
	// 让 reader 不把「derivedFiles 里有它」误读成「包里必有」
	rep.Notes = append(rep.Notes, "state/browser.json is a CONDITIONAL derived entry: packed only when the export request carries ?clientReport=1 (the web UI POSTs a fresh browser snapshot automatically on export click) and a report is present in the 5-minute session window (absence reason lives in the manifest)")
	return rep, nil
}
