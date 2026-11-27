package diagnostics

import (
	"fmt"
	"io"
	"runtime/pprof"
	"sync"
	"time"
)

// deep 档 pprof 档案入包（P-20261126-3 S3）：profile 端点只绑 127.0.0.1 主端口+2
// （C6 本地排查），远程实例用不上，而诊断包恰恰是为远程排查设计的——deep 导出
// 自采 heap/goroutine/block/mutex（+ 显式 &cpu=1 的 5s CPU 档案）入 zip profiles/。
//
// 截断策略分轨（评审 A1）：
//   - 二进制档案（heap/block/mutex/cpu）是 gzip+protobuf——线性截断即死字节，
//     go tool pprof 直接解析失败。**有界缓冲预写 → 超限整份丢弃不入包**，
//     manifest/collection-report 标 skipped(oversized)；
//   - 文本形态 goroutine（debug=1 聚合）可线性截断 ≤512KB 入包
//     （watchdog.captureGoroutines 先例：那份上限 1MiB，本案 512KB 是新值）。
//
// 采样率：block/mutex 采样全仓此前未启用（SetBlockProfileRate/SetMutexProfileFraction
// 无调用点），档案恒空——启动期低速率常开（observability.go installDiagProfileRates，
// env CC_DIAG_PROFILE_RATE=0 全关，envWhitelist 包内可见）。
// CPU 档案：仅 deep 且显式 &cpu=1；时长可注入（CPUProfileDuration，集成测试用
// 短时长）；与 loopback /debug/pprof/profile 并发时 StartCPUProfile 返回
// "already in use" → skipped（pprof 包内单飞）；失败/超时标 skipped——诊断包
// 不能死在要诊断的故障上。

const (
	// profileHeapMaxBytes heap 档案上限（gzip 后通常 <200KB；2MB 是防御档）
	profileHeapMaxBytes = 2 << 20
	// profileBlockMaxBytes / profileMutexMaxBytes 低速率采样下的典型量级在 KB 级
	profileBlockMaxBytes = 512 << 10
	profileMutexMaxBytes = 512 << 10
	// profileGoroutineMaxBytes goroutine 聚合文本上限（可线性截断）
	profileGoroutineMaxBytes = 512 << 10
	// profileCPUMaxBytes CPU 档案上限（5s 窗 100Hz×线程数，典型 <1MB）
	profileCPUMaxBytes = 2 << 20
)

// CPUProfileDurationDefault &cpu=1 的采样时长。导出窗口口径（README 同步）：
// 采的是导出开始后 5s、**含导出自身 CPU**（采集/分析工作与采样并发运行）。
const CPUProfileDurationDefault = 5 * time.Second

// writeProfileTo 档案写入口（变量形态供单测注入假输出；生产指向 pprof.Lookup）
var writeProfileTo = func(name string, w io.Writer, debugLevel int) error {
	p := pprof.Lookup(name)
	if p == nil {
		return fmt.Errorf("profile %q not registered", name)
	}
	return p.WriteTo(w, debugLevel)
}

// （CPU 采样时长注入点 = Options.CPUProfileDuration；0/负回落
// CPUProfileDurationDefault——生效值见 stop 的补足逻辑与 profiles/cpu 的
// manifest reason，避免再留一个只读一次的换算函数）

// captureBinaryProfile 二进制档案有界预写：truncated → 整份丢弃（data=nil），
// skipped="oversized(n bytes > cap)"；写入失败 → skipped=错误原文（可能含路径，
// 调用方过 Redactor）。bytes 恒如实（丢弃时也报告原写入量，供体量归因）。
func captureBinaryProfile(name string, capBytes int) (data []byte, bytes int64, skipped string) {
	buf := &limitedBuffer{limit: capBytes}
	// countingWriter 记原写入量（limitedBuffer 超限即弃，真实体量只有它知道）
	cw := &countingWriter{w: buf}
	if err := writeProfileTo(name, cw, 0); err != nil {
		return nil, cw.n, "error: " + err.Error()
	}
	if buf.truncated {
		return nil, cw.n, fmt.Sprintf("oversized(%s written > %s cap) — dropped WHOLE (gzip+protobuf truncation would be dead bytes for go tool pprof)", humanBytes(uint64(cw.n)), humanBytes(uint64(capBytes)))
	}
	return buf.data, cw.n, ""
}

// captureGoroutineText goroutine 聚合文本（debug=1）：线性截断可入包，
// truncated 标记进 manifest reason。调用方负责过 Redactor（文本面含构建路径）。
func captureGoroutineText(capBytes int) (data []byte, truncated bool, bytes int64, skipped string) {
	buf := &limitedBuffer{limit: capBytes}
	if err := writeProfileTo("goroutine", buf, 1); err != nil {
		return nil, false, int64(len(buf.data)), "error: " + err.Error()
	}
	return buf.data, buf.truncated, int64(len(buf.data)), ""
}

// cpuProfileState CPU 档案采样句柄（start/stop 分离：采样窗与采集工作并发）
type cpuProfileState struct {
	buf       *limitedBuffer
	startErr  string
	startedAt time.Time
}

// startCPUProfile 开始 CPU 采样（opts.CPUProfile=false 直接返回 nil；已在采样的
// "already in use" 与其它失败都落 startErr，stop 时转 skipped——不 panic 不阻塞）。
// 采样时长在 stop 时补足：目标窗 = opts.CPUProfileDuration（零/负 → 默认 5s；
// 测试注入短值）。
func startCPUProfile(opts Options) *cpuProfileState {
	if !opts.CPUProfile {
		return nil
	}
	buf := &limitedBuffer{limit: profileCPUMaxBytes}
	if err := pprof.StartCPUProfile(buf); err != nil {
		return &cpuProfileState{startErr: err.Error()}
	}
	return &cpuProfileState{buf: buf, startedAt: time.Now()}
}

// stopCPUProfile 结束采样（window=实际采样窗；未启动/启动失败 → skipped）。
// 超限整份丢弃（二进制分轨，同 captureBinaryProfile）。
func (s *cpuProfileState) stop(duration time.Duration) (data []byte, bytes int64, skipped string, window time.Duration) {
	if s == nil {
		return nil, 0, "", 0
	}
	if s.startErr != "" {
		return nil, 0, "error: " + s.startErr, 0
	}
	// 等满采样窗：采集工作通常已消耗一部分窗（重叠执行，README「含导出自身
	// CPU」口径）；剩余部分在此补足（duration<=0 → 默认 5s）
	target := duration
	if target <= 0 {
		target = CPUProfileDurationDefault
	}
	if remain := target - time.Since(s.startedAt); remain > 0 {
		time.Sleep(remain)
	}
	// StopCPUProfile 无返回值（pprof 包内不报错）；start 失败面已在 startCPUProfile
	// 兜住。补足窗后 stop：若 start 从未成功，这里 no-op 安全（startErr 分支已返回）。
	pprof.StopCPUProfile()
	d := time.Since(s.startedAt)
	if s.buf.truncated {
		return nil, int64(s.buf.limit), fmt.Sprintf("oversized(> %s) — dropped WHOLE (gzip+protobuf truncation would be dead bytes) after %s window", humanBytes(uint64(s.buf.limit)), d.Round(time.Millisecond)), d
	}
	return s.buf.data, int64(len(s.buf.data)), "", d
}

// collectDeepProfiles deep 档案装配（collector 在 ⑦ 之后调用）：返回
// (二进制条目, 文本条目)；每份档案一条 ProbeResult（oversized/skipped 也登记）。
func collectDeepProfiles(opts Options, red *Redactor, report *CollectionReport) (binaries []bundleEntry, texts []bundleEntry) {
	addReport := func(id string, bytes int64, status ProbeStatus, note string) {
		report.Add(ProbeResult{ID: id, Kind: "profile", Status: string(status),
			DurationMS: 0, Bytes: bytes, Note: note, Deep: true})
	}
	for _, spec := range []struct {
		name string
		cap  int
	}{
		{"heap", profileHeapMaxBytes},
		{"block", profileBlockMaxBytes},
		{"mutex", profileMutexMaxBytes},
	} {
		data, bytes, skipped := captureBinaryProfile(spec.name, spec.cap)
		if skipped != "" {
			addReport("profile:"+spec.name, bytes, ProbeSkipped, skipped)
			continue
		}
		addReport("profile:"+spec.name, bytes, ProbeOK,
			fmt.Sprintf("standard pprof gzip protobuf (%s); analyze offline: go tool pprof <binary-from-manifest> profiles/%s", humanBytes(uint64(bytes)), spec.name))
		binaries = append(binaries, bundleEntry{
			meta: Entry{
				Name: "profiles/" + spec.name, Status: StatusDerived,
				IncludedBytes: bytes,
				Reason:        "deep-mode pprof profile; written WHOLE or not at all (never truncated); binary payload skips the text redactor — -trimpath builds embed no build-machine paths",
			},
			content: data,
		})
	}
	// goroutine 文本：线性截断允许（文本面），过 Redactor 后入包
	text, truncated, bytes, skipped := captureGoroutineText(profileGoroutineMaxBytes)
	if skipped != "" {
		addReport("profile:goroutine", bytes, ProbeSkipped, red.Line(skipped))
	} else {
		content := red.Line(string(text))
		reason := "deep-mode aggregated goroutine stacks (pprof debug=1); text face passed the redactor"
		if truncated {
			reason += "; linearly truncated at cap (text form stays parseable)"
		}
		addReport("profile:goroutine", int64(len(content)), ProbeOK, reason)
		texts = append(texts, bundleEntry{
			meta: Entry{
				Name: "profiles/goroutine", Status: StatusDerived,
				IncludedBytes: int64(len(content)), Reason: reason,
			},
			content: []byte(content),
		})
	}
	return binaries, texts
}

// profileRatesConfigured 启动期采样率登记（state/runtime.json 注记用）。不能读：
// SetBlockProfileRate 无「读」语义（rate<=0 是**关闭**，SetMutexProfileFraction 才
// 支持负值读）——安装侧写、导出侧读，进程内一致。CC_DIAG_PROFILE_RATE=0 时
// enabled=false，agent 从包内可读「block/mutex 档案为什么是空的」。
var profileRatesConfigured struct {
	mu            sync.Mutex
	blockRate     int
	mutexFraction int
	installed     bool
}

// SetProfileSamplingRates 组合根启动期登记（app/observability 调用；仅登记，
// 真正设置 runtime 的动作在调用侧完成）
func SetProfileSamplingRates(blockRate, mutexFraction int) {
	profileRatesConfigured.mu.Lock()
	defer profileRatesConfigured.mu.Unlock()
	profileRatesConfigured.blockRate = blockRate
	profileRatesConfigured.mutexFraction = mutexFraction
	profileRatesConfigured.installed = true
}

// ProfileSamplingRates 注记读口（未安装时 installed=false）
func ProfileSamplingRates() (blockRate, mutexFraction int, installed bool) {
	profileRatesConfigured.mu.Lock()
	defer profileRatesConfigured.mu.Unlock()
	return profileRatesConfigured.blockRate, profileRatesConfigured.mutexFraction, profileRatesConfigured.installed
}
