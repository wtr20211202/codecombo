package diagnostics

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 原文装箱计划（P-20261122-10 必改E；P-20261124-1 起自 collector.go 拆出）：
// 选文件 + 截断决策 + raw 预算裁剪。与 collector.go 的「派生文件装配/zip 写出」
// 分开，两者各自守着可读的行数（collector 的主链不因新增取证面膨胀）。

// rawFilePlan 原文文件的装箱决策
type rawFilePlan struct {
	abs  string
	size int64
	inc  inclusion
	meta Entry
}

// planRawFiles 枚举并决策全部原文文件（新→旧顺序 + raw 预算裁剪）。
//
// 顺序（重要性递减）：按日主日志（新→旧）→ 更新链固定清单 → DataDir 根
// 期望文件（dsh-web.log / update-result.json / PID 文件）→ 轮转历史（.1）→
// logs/ 通配余项。预算裁剪只砍队尾（= 更旧的文件），当天文件在队首已装完
// ——「绝不砍当天尾部」（必改E）。
func planRawFiles(opts Options, red *Redactor, logDir string) ([]rawFilePlan, []string) {
	var notes []string
	var out []rawFilePlan
	seen := map[string]bool{}

	addExpected := func(zipName, path string) {
		seen[strings.ToLower(filepath.Base(path))] = true
		if plan, ok := expectedEntry(zipName, path, red); ok {
			out = append(out, plan)
			return
		}
		out = append(out, newRawPlanFromPath(path, zipName, red))
	}

	daily, absentDays := selectDailyLogs(logDir, opts.LogDays, opts.Now)
	for _, f := range daily {
		out = append(out, newRawPlan(f, red))
		seen[strings.ToLower(f.base)] = true
	}
	// 更新链固定清单：缺席 = ABSENT 证据（不造空文件）
	for _, name := range fixedChainLogs {
		addExpected("logs/"+name, filepath.Join(logDir, name))
	}
	// dsh-web.log 在 DataDir 根（config.go:390），显式列举——通配 logs/ 漏它
	addExpected("logs/"+dshWebLogName, filepath.Join(opts.DataDir, dshWebLogName))
	// update-result.json（manager.go:750 落点）：更新结局文件，与更新链日志同族证据
	addExpected("state/update-result.json", filepath.Join(opts.DataDir, "update-result.json"))
	// PID 文件全文（含第五行版本，P-20261122-6）：换包后「谁在跑哪版」的直接证据
	addExpected("state/pid.txt", filepath.Join(opts.DataDir, "codecombo.pid"))
	// 轮转历史（S1 按次轮转留 2 文件；`.1` 后缀不被 *.log 通配命中）
	for _, name := range legacyTailFiles {
		addExpected("logs/"+name, filepath.Join(logDir, name))
	}
	// logs/ 通配余项（排除半成品/zip、跳过符号链接、重名去重取最新）
	for _, f := range wildcardLogs(logDir, seen) {
		out = append(out, newRawPlan(f, red))
	}
	// 按日缺席证据（窗口内某天没有文件）
	for _, name := range absentDays {
		out = append(out, rawFilePlan{meta: Entry{
			Name: "logs/" + name, Status: StatusAbsent,
			Reason: "expected daily log missing (service not running that day, or past retention)",
		}})
	}

	// raw 预算：新→旧扫描，超预算的原文条目降级为 omitted
	used := int64(0)
	for i := range out {
		e := &out[i]
		if e.meta.Status != StatusPresent && e.meta.Status != StatusTruncated {
			continue
		}
		if used+e.meta.IncludedBytes > rawBudgetBytes {
			e.meta.Status = StatusOmitted
			e.meta.Reason = fmt.Sprintf("raw budget %s reached — older files dropped first; today's file is always packed first", humanBytes(rawBudgetBytes))
			e.meta.OmittedBytes = e.meta.IncludedBytes
			e.meta.IncludedBytes = 0
			notes = append(notes, "raw budget reached: older logs omitted (see manifest)")
			continue
		}
		used += e.meta.IncludedBytes
	}
	return out, notes
}

// newRawPlan 单个已 stat 文件的装箱决策（zip 名默认 logs/<base>）
func newRawPlan(f sourceFile, red *Redactor) rawFilePlan {
	return newRawPlanFromPath(f.abs, "logs/"+f.base, red)
}

// newRawPlanFromPath 按路径 stat 并决策（zipName 显式给：state/ 族的落点不同）
func newRawPlanFromPath(p, zipName string, red *Redactor) rawFilePlan {
	st, err := os.Stat(p)
	if err != nil {
		// 竞态删除（正常：轮转清理正好发生）——如实缺席
		return rawFilePlan{meta: Entry{
			Name: zipName, Source: red.Path(p), Status: StatusAbsent,
			Reason: "file disappeared during collection: " + red.Line(err.Error()),
		}}
	}
	size := st.Size()
	inc := planInclusion(p, size)
	status := StatusPresent
	var omitted int64
	if !inc.full {
		status = StatusTruncated
		omitted = inc.omittedBytes(size)
	}
	return rawFilePlan{
		abs:  p,
		size: size,
		inc:  inc,
		meta: Entry{
			Name:          zipName,
			Source:        red.Path(p),
			Status:        status,
			OriginalBytes: size,
			IncludedBytes: inc.includedBytes(size),
			OmittedBytes:  omitted,
			Reason:        truncationReason(inc, size),
		},
	}
}

// expectedEntry 期望文件缺席 / 凭据 denylist 命中时的 manifest 条目
// （ok=true 表示"已决定，不需要再 stat"）
func expectedEntry(zipName, path string, red *Redactor) (rawFilePlan, bool) {
	if why := deniedReason(path, red.dataDir); why != "" {
		return rawFilePlan{meta: Entry{
			Name: zipName, Source: red.Path(path), Status: StatusDenied, Reason: why,
		}}, true
	}
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return rawFilePlan{meta: Entry{
				Name: zipName, Source: red.Path(path), Status: StatusAbsent,
				Reason: "expected file absent (the absence itself is evidence — see runbook §11)",
			}}, true
		}
		return rawFilePlan{meta: Entry{
			Name: zipName, Source: red.Path(path), Status: StatusAbsent,
			Reason: "stat failed: " + red.Line(err.Error()),
		}}, true
	}
	return rawFilePlan{}, false
}

func truncationReason(inc inclusion, size int64) string {
	if inc.full {
		return ""
	}
	return fmt.Sprintf(">8MiB: head %s + tail %s kept (tail-biased — failure evidence lives at the end)",
		humanBytes(uint64(inc.head)), humanBytes(uint64(size-inc.tailAt)))
}
