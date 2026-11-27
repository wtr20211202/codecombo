package diagnostics

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// dsh-web.log 摘要（P-20261124-1 S2④）：350MB 的 dsh 反代 stdout 日志只做
// 「头 8MiB + 尾 16MiB + 中段采样」，绝不整读——行数标 estimated=true（采样
// 外推不是精确值，读者不应据此做容量决策，但足以判断量级与增长趋势）。
//
// 输出 dsh-summary.txt：大小/轮转结论、估算行数、Top20 归一错误签名、最后
// 20 行（脱敏）。原文仍按打包窗口进 logs/dsh-web.log，本文件是它的索引。

const (
	// dshHeadBytes 头部窗口（启动期证据）
	dshHeadBytes = 8 << 20
	// dshTailBytes 尾部窗口（失败证据在尾）
	dshTailBytes = 16 << 20
	// dshMiddleSamples 中段采样块数（每块 dshMiddleSampleBytes）
	dshMiddleSamples = 4
	// dshMiddleSampleBytes 中段单块字节
	dshMiddleSampleBytes = 256 << 10
	// dshLastLines 最后 N 行原文
	dshLastLines = 20
	// dshTopSignatures Top 错误签名数
	dshTopSignatures = 20
)

// dshCollected dsh 摘要采集结果
type dshCollected struct {
	text    string
	bytes   int64
	status  ProbeStatus
	note    string
	covered int64
}

// collectDshSummary 采集 dsh-web.log 摘要（DataDir 根，config.go 的 stdout 重定向落点）
func collectDshSummary(dataDir string, red *Redactor) dshCollected {
	path := dshWebLogPath(dataDir)
	info, err := os.Stat(path)
	if err != nil {
		return dshCollected{
			status: ProbeSkipped,
			note:   "dsh-web.log absent — dsh reverse proxy stdout log not written on this instance",
			text:   "# dsh-web.log absent — nothing to summarise\n",
		}
	}
	size := info.Size()
	f, err := os.Open(path)
	if err != nil {
		return dshCollected{status: ProbeSkipped, note: "dsh-web.log unreadable: " + red.Line(err.Error())}
	}
	defer f.Close()

	type seg struct{ off, n int64 }
	var segs []seg
	if size <= dshHeadBytes+dshTailBytes {
		segs = append(segs, seg{0, size})
	} else {
		segs = append(segs, seg{0, dshHeadBytes})
		// 中段均匀采样（不重复头尾）
		mid := size - dshHeadBytes - dshTailBytes
		block := int64(dshMiddleSampleBytes)
		for i := 0; i < dshMiddleSamples && block > 0; i++ {
			off := dshHeadBytes + mid*int64(i)/int64(dshMiddleSamples)
			if off+block > size-dshTailBytes {
				break
			}
			segs = append(segs, seg{off, block})
		}
		segs = append(segs, seg{size - dshTailBytes, dshTailBytes})
	}

	var (
		lines    int64
		covered  int64
		sigs     = map[string]*errorSignature{}
		lastRing []string
	)
	for _, s := range segs {
		if s.n <= 0 {
			continue
		}
		covered += s.n
		sr := io.NewSectionReader(f, s.off, s.n)
		scanDshLines(sr, func(line string) {
			lines++
			lower := strings.ToLower(line)
			if strings.Contains(lower, "error") || strings.Contains(lower, "fatal") ||
				strings.Contains(lower, "panic") || strings.Contains(lower, "failed") {
				sig := errorSignatureOf(line)
				es := sigs[sig]
				if es == nil {
					es = &errorSignature{Sample: red.Line(truncate(line, signatureSampleMax))}
					sigs[sig] = es
				}
				es.Count++
			}
			lastRing = append(lastRing, red.Line(truncate(line, 400)))
			if len(lastRing) > dshLastLines {
				lastRing = lastRing[len(lastRing)-dshLastLines:]
			}
		})
	}
	estimated := size > covered
	estLines := lines
	if estimated && covered > 0 {
		estLines = lines * size / covered
	}

	var b strings.Builder
	b.WriteString("# dsh-web.log summary — sampled windows only (never read whole: 350MB-class files)\n")
	fmt.Fprintf(&b, "# path: %s\n", red.Path(path))
	fmt.Fprintf(&b, "# sizeBytes: %d\n", size)
	fmt.Fprintf(&b, "# sampledBytes: %d (head=%d tail=%d middleSamples=%d×%d)\n",
		covered, dshHeadBytes, dshTailBytes, dshMiddleSamples, dshMiddleSampleBytes)
	fmt.Fprintf(&b, "# lines: %d estimated=%t\n", estLines, estimated)
	if note := rotationNote(path, size); note != "" {
		fmt.Fprintf(&b, "# rotation: %s\n", note)
	} else {
		b.WriteString("# rotation: n/a (below 100MB)\n")
	}
	b.WriteString("# note: line counts are extrapolated from sampled windows; use them for magnitude, not accounting\n\n")

	type row struct {
		sig string
		es  *errorSignature
	}
	rows := make([]row, 0, len(sigs))
	for sig, es := range sigs {
		rows = append(rows, row{sig, es})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].es.Count != rows[j].es.Count {
			return rows[i].es.Count > rows[j].es.Count
		}
		return rows[i].sig < rows[j].sig
	})
	if len(rows) > dshTopSignatures {
		rows = rows[:dshTopSignatures]
	}
	b.WriteString("## top error signatures\n")
	if len(rows) == 0 {
		b.WriteString("(no error-like lines in sampled windows)\n")
	} else {
		for _, r := range rows {
			fmt.Fprintf(&b, "%d | %s\n", r.es.Count, strings.ReplaceAll(r.es.Sample, "\n", " "))
		}
	}
	b.WriteString("\n## last " + itoa(dshLastLines) + " lines (masked)\n")
	for _, l := range lastRing {
		b.WriteString("| " + l + "\n")
	}
	return dshCollected{
		text:    b.String(),
		bytes:   size,
		status:  ProbeOK,
		note:    fmt.Sprintf("size=%d sampled=%d estimatedLines=%d", size, covered, estLines),
		covered: covered,
	}
}

// scanDshLines 逐行扫描（行上限沿用 scanBufMax；病态长行由 Scanner 报错后
// 停止该窗口，不中断整份摘要）
func scanDshLines(r io.Reader, fn func(string)) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), scanBufMax)
	for sc.Scan() {
		fn(sc.Text())
	}
}

// dshWebLogPath dsh-web.log 落点（DataDir 根，与 collector 的 addExpected 同源）
func dshWebLogPath(dataDir string) string {
	return filepath.Join(dataDir, dshWebLogName)
}
