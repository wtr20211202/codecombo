package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

// P-20261126-3 契约：goruntime 快照/趋势环封顶滚动/CLI scope、进程自观测
// tracker 差分与 warmup、档案 oversized 整份丢弃与 goroutine 文本截断、CPU
// 短时长采样、routes 排序/WS 剔除/小时桶过期/sentinel 归一/隐私面、采样率开关

func TestGoRuntimeSnapshotShape(t *testing.T) {
	doc := GoRuntimeSnapshot("api")
	if doc.Status != "ok" || doc.Scope != "service-process" {
		t.Fatalf("status=%q scope=%q, want ok/service-process", doc.Status, doc.Scope)
	}
	if doc.GoVersion == "" || doc.GOMAXPROCS <= 0 || doc.NumGoroutine <= 0 {
		t.Fatalf("snapshot baseline fields empty: goVersion=%q gomaxprocs=%d numGoroutine=%d", doc.GoVersion, doc.GOMAXPROCS, doc.NumGoroutine)
	}
	if doc.HeapAllocBytes <= 0 || doc.SysBytes <= 0 {
		t.Fatalf("memstats look empty: heapAlloc=%d sys=%d", doc.HeapAllocBytes, doc.SysBytes)
	}
	if doc.NumGC == 0 && doc.PauseTotalMS != 0 {
		t.Fatal("pauseTotal must be 0 when NumGC=0")
	}
	// 未启动采样器 → 趋势段 skipped（理由如实，不是静默空环）
	if doc.Trend.Status != "skipped" || doc.Trend.Reason == "" {
		t.Fatalf("trend must be skipped with reason when sampler not started: %+v", doc.Trend)
	}
	// 采样率登记（未安装=false；安装后可读）
	if _, _, installed := ProfileSamplingRates(); installed {
		t.Fatal("rates must not be installed before SetProfileSamplingRates")
	}
	SetProfileSamplingRates(10000, 100)
	t.Cleanup(func() { SetProfileSamplingRates(0, 0) })
	doc2 := GoRuntimeSnapshot("api")
	if !doc2.ProfileRatesInstalled || doc2.BlockProfileRate != 10000 || doc2.MutexProfileFraction != 100 {
		t.Fatalf("rate registration not visible in snapshot: %+v", doc2)
	}
}

func TestGoRuntimeTrendRingCapAndRoll(t *testing.T) {
	s := &goRuntimeSampler{}
	for i := 0; i < goRuntimeCapacity+5; i++ {
		s.record(time.Now())
	}
	s.mu.Lock()
	n := len(s.pts)
	first := s.pts[0]
	s.mu.Unlock()
	if n != goRuntimeCapacity {
		t.Fatalf("ring size = %d, want %d (capped)", n, goRuntimeCapacity)
	}
	if first.BaselineWarmup {
		t.Fatal("first point must have been rolled out (only the oldest point is baselineWarmup)")
	}
	// 每 point 都要有时间戳与 goroutine 数
	if first.NumGoroutine <= 0 || first.At == "" {
		t.Fatalf("point shape broken: %+v", first)
	}
}

func TestGoRuntimeLifecycleStartStop(t *testing.T) {
	// 真实 Start/Stop：启动即采首点（立刻导出也有首点，hosthistory 同款）；
	// 幂等；stop 后快照回 skipped
	ResetGoRuntimeForTesting()
	t.Cleanup(ResetGoRuntimeForTesting)
	StartGoRuntime()
	StartGoRuntime() // 幂等
	doc := GoRuntimeSnapshot("api")
	if doc.Trend.Status != "ok" || doc.Trend.Count < 1 {
		t.Fatalf("started sampler must have at least the boot point: %+v", doc.Trend)
	}
	if doc.Trend.Points[0].NumGoroutine <= 0 {
		t.Fatalf("boot point shape broken: %+v", doc.Trend.Points[0])
	}
	StopGoRuntime()
	StopGoRuntime() // 幂等
	doc2 := GoRuntimeSnapshot("api")
	if doc2.Trend.Status != "skipped" {
		t.Fatalf("stopped sampler must report skipped trend: %+v", doc2.Trend)
	}
}

func TestGoRuntimeCLIScopeDisclosure(t *testing.T) {
	doc := GoRuntimeSnapshot("cli")
	if doc.Status != "skipped" || doc.Scope != "collector-process" {
		t.Fatalf("cli snapshot must be skipped with collector-process scope: %+v", doc)
	}
	if doc.Trend.Status != "skipped" {
		t.Fatalf("cli trend must be skipped: %+v", doc.Trend)
	}
	if !strings.Contains(doc.Reason, "COLLECTOR") {
		t.Fatalf("cli reason must disclose the scope trap: %q", doc.Reason)
	}
	// JSON 渲染不炸（CLI 包内该文件仍存在——缺席即证据的对面：有文件、有说明）
	if out := renderGoRuntimeJSON("cli"); !strings.Contains(out, "collector-process") {
		t.Fatalf("rendered goruntime.json missing scope: %s", out)
	}
}

func TestProcessCPUTrackerWarmupAndDelta(t *testing.T) {
	// 注入差分对：100% 单核（1s 内烧 1 CPU 秒）
	prevRead, prevNow := procCPUSecondsNow, procCPUTracker.nowFunc
	resetTracker := func() {
		procCPUTracker.mu.Lock()
		procCPUTracker.have = false
		procCPUTracker.percent = 0
		procCPUTracker.mu.Unlock()
	}
	resetTracker() // 其它用例可能已把 tracker 送过 warmup（collectProcessSection 先例）
	t.Cleanup(func() {
		procCPUSecondsNow = prevRead
		procCPUTracker.nowFunc = prevNow
		resetTracker()
	})
	now := time.Now()
	cpu := 0.0
	procCPUSecondsNow = func() (float64, bool) { return cpu, true }
	procCPUTracker.nowFunc = func() time.Time { return now }

	pct, warmup := sampleProcessCPUPercent()
	if !warmup || pct != 0 {
		t.Fatalf("first sample must be warmup: pct=%v warmup=%v", pct, warmup)
	}
	cpu = 1.0
	now = now.Add(time.Second)
	pct, warmup = sampleProcessCPUPercent()
	if warmup {
		t.Fatal("second sample must not be warmup")
	}
	if pct < 99 || pct > 101 {
		t.Fatalf("100%% busy window should read ~100, got %v", pct)
	}
	// 四核满载 → 400%（单核归一可 >100）
	cpu = 5.0
	now = now.Add(time.Second)
	if pct := func() float64 { v, _ := sampleProcessCPUPercent(); return v }(); pct < 399 || pct > 401 {
		t.Fatalf("400%% busy window should read ~400, got %v", pct)
	}
}

func TestProcessSampleRealMachine(t *testing.T) {
	// Windows 主力开发机真跑（评审 B4）：本测在 linux/darwin 下同样有意义——
	// 各平台实现至少不崩、字段口径自洽
	p, ok := collectProcessSection()
	if !ok {
		t.Fatalf("process sample failed on %s: %+v", runtimeGOOS(), p)
	}
	if p.Note != "" && p.RSSMB == 0 && p.Threads == 0 && p.Handles == 0 {
		t.Fatalf("process sample all-empty with a note: %+v", p)
	}
	if p.Basis == "" {
		t.Fatal("basis note required (cross-platform semantics disclosure)")
	}
	if p.RSSMB > 0 && p.RSSMB < 1 {
		t.Fatalf("rssMb implausibly small: %v", p.RSSMB)
	}
	if p.CPUPercent < 0 || p.CPUPercent > 10000 {
		t.Fatalf("cpuPercent out of plausible range: %v", p.CPUPercent)
	}
}

func TestProcessCPUSampleFieldsInHostHistory(t *testing.T) {
	pt := &HostHistoryPoint{At: time.Now().Format(time.RFC3339)}
	sampleProcessFields(pt)
	// 三平台都应至少产出 RSS 或 warmup 标记（进程观测跨平台后不再整段缺席）
	if pt.ProcessRSSMB == 0 && !pt.ProcessCPUWarmup && pt.ProcessCPUPercent == 0 {
		t.Fatalf("process fields empty on %s (cross-platform stub broken)", runtimeGOOSForTest())
	}
}

func runtimeGOOSForTest() string { return runtimeGOOS() }

func TestProfileBinaryOversizeDroppedWhole(t *testing.T) {
	prev := writeProfileTo
	t.Cleanup(func() { writeProfileTo = prev })
	// 假档案写 cap+10 字节 → truncated → 整份丢弃（data=nil），不落死字节
	writeProfileTo = func(name string, w io.Writer, _ int) error {
		_, err := w.Write(bytes.Repeat([]byte{0x1f}, profileHeapMaxBytes+10))
		return err
	}
	data, written, skipped := captureBinaryProfile("heap", profileHeapMaxBytes)
	if data != nil {
		t.Fatal("oversized binary profile must be dropped WHOLE (nil data)")
	}
	if skipped == "" || !strings.Contains(skipped, "oversized") || !strings.Contains(skipped, "WHOLE") {
		t.Fatalf("skipped must explain the whole-drop policy: %q", skipped)
	}
	if written != profileHeapMaxBytes+10 {
		t.Fatalf("bytes must report the ORIGINAL written amount, got %d", written)
	}
	// 正常尺寸：整份保留
	writeProfileTo = func(name string, w io.Writer, _ int) error {
		_, err := w.Write(bytes.Repeat([]byte{0x1f}, 100))
		return err
	}
	data, written, skipped = captureBinaryProfile("heap", profileHeapMaxBytes)
	if data == nil || skipped != "" || written != 100 {
		t.Fatalf("normal-size profile must be kept: data=%d bytes=%d skipped=%q", len(data), written, skipped)
	}
}

func TestProfileGoroutineTextTruncation(t *testing.T) {
	prev := writeProfileTo
	t.Cleanup(func() { writeProfileTo = prev })
	writeProfileTo = func(name string, w io.Writer, level int) error {
		if level != 1 {
			t.Fatalf("goroutine text must use debug=1 aggregation, got %d", level)
		}
		_, err := w.Write(bytes.Repeat([]byte("g 1 [running]\n"), 100))
		return err
	}
	small := 64 // 收紧上限注入截断
	data, truncated, bytes, skipped := captureGoroutineText(small)
	if skipped != "" {
		t.Fatalf("text form must be packed even when truncated: %q", skipped)
	}
	if !truncated || len(data) != small || int64(len(data)) != bytes {
		t.Fatalf("linear truncation semantics broken: truncated=%v len=%d bytes=%d", truncated, len(data), bytes)
	}
	if !strings.Contains(string(data), "g 1 [running]") {
		t.Fatal("truncated text must keep its leading content")
	}
}

func TestCPUProfileShortDurationAndConflict(t *testing.T) {
	// 短时长注入（B1）：真实 StartCPUProfile 50ms；进程内单飞——第一张在采期间
	// 第二张 start 即 "already in use"，其 stop 转 skipped（不炸、不覆盖）
	opts := Options{CPUProfile: true, CPUProfileDuration: 50 * time.Millisecond}
	h := startCPUProfile(opts)
	if h == nil || h.startErr != "" {
		t.Fatalf("cpu profile start failed: %+v", h)
	}
	h2 := startCPUProfile(opts)
	if h2 == nil || h2.startErr == "" || !strings.Contains(h2.startErr, "in use") {
		t.Fatalf("second concurrent start must fail with 'already in use': %+v", h2)
	}
	if data2, _, skipped2, _ := h2.stop(opts.CPUProfileDuration); data2 != nil || skipped2 == "" {
		t.Fatalf("conflicting handle must be skipped: skipped=%q", skipped2)
	}
	data, bytes, skipped, window := h.stop(opts.CPUProfileDuration)
	if skipped != "" || data == nil || bytes <= 0 {
		t.Fatalf("short cpu profile must succeed: bytes=%d skipped=%q", bytes, skipped)
	}
	if window < 50*time.Millisecond || window > 2*time.Second {
		t.Fatalf("cpu window should honor the injected 50ms target: %v", window)
	}
	// CPUProfile=false → 不启动
	if h3 := startCPUProfile(Options{}); h3 != nil {
		t.Fatal("shallow/without cpu=1 must not start a cpu profile")
	}
}

func TestDeepPlanPacksProfilesShallowDoesNot(t *testing.T) {
	dir, now := fixtureDir(t)
	// deep：档案条目在包 + collection-report 逐条登记
	b, err := Plan(context.Background(), Options{
		DataDir: dir, Version: "9.9.9", Now: now, Mask: true, Deep: true,
		Runtime: &RuntimeInputs{}, // api 形态（CLI 形态 profiles 如实 skipped）
	})
	if err != nil {
		t.Fatalf("Plan(deep): %v", err)
	}
	have := map[string]Entry{}
	for _, e := range b.Manifest.Entries {
		have[e.Name] = e
	}
	for _, name := range []string{"profiles/heap", "profiles/goroutine", "profiles/block", "profiles/mutex"} {
		e, ok := have[name]
		if !ok || e.Status != StatusDerived || e.IncludedBytes <= 0 {
			t.Fatalf("deep plan must pack %s: entry=%+v", name, e)
		}
	}
	if _, packed := have["profiles/cpu"]; packed {
		t.Fatal("deep plan without cpu=1 must not invent profiles/cpu")
	}
	reported := map[string]ProbeResult{}
	for _, p := range b.Report.Probes() {
		if p.Kind == "profile" {
			reported[p.ID] = p
		}
	}
	for _, id := range []string{"profile:heap", "profile:goroutine", "profile:block", "profile:mutex"} {
		if p, ok := reported[id]; !ok || p.Status != "ok" {
			t.Fatalf("collection-report missing ok entry for %s: %+v", id, p)
		}
	}
	// shallow：一张档案都没有
	b2, err := Plan(context.Background(), Options{DataDir: dir, Version: "9.9.9", Now: now, Mask: true, Runtime: &RuntimeInputs{}})
	if err != nil {
		t.Fatalf("Plan(shallow): %v", err)
	}
	for _, e := range b2.Manifest.Entries {
		if strings.HasPrefix(e.Name, "profiles/") {
			t.Fatalf("shallow plan must contain zero profiles/* entries, got %s", e.Name)
		}
	}
	// 新契约文件恒在包
	contract := map[string]bool{}
	for _, e := range b2.Manifest.Entries {
		contract[e.Name] = true
	}
	for _, name := range []string{"state/goruntime.json", "state/routes.json"} {
		if !contract[name] {
			t.Fatalf("manifest missing %s", name)
		}
	}
	// probe 契约清单含新条目
	probe, err := Probe(Options{DataDir: dir, Version: "9.9.9", Now: now, Deep: true})
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	joined := strings.Join(probe.Derived, ",")
	for _, name := range []string{"state/goruntime.json", "state/routes.json", "profiles/heap", "profiles/block"} {
		if !strings.Contains(joined, name) {
			t.Fatalf("probe derivedFiles missing %s", name)
		}
	}
}

func TestProbeShallowNotesProfilesAreDeepOnly(t *testing.T) {
	dir, now := fixtureDir(t)
	rep, err := Probe(Options{DataDir: dir, Version: "9.9.9", Now: now})
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	found := false
	for _, n := range rep.Notes {
		if strings.Contains(n, "deep-only") {
			found = true
		}
	}
	if !found {
		t.Fatalf("shallow probe must note profiles are deep-only: %v", rep.Notes)
	}
}

func TestRouteAggKeySentinels(t *testing.T) {
	cases := []struct{ route, raw, want string }{
		{"/api/projects/:id/files", "/api/projects/abc/files", "/api/projects/:id/files"}, // 匹配路由原样
		{"unmatched", "/api/unknown-thing", "*api-other*"},                                // api 前缀轨
		{"unmatched", "/robots.txt", "*static*"},                                          // 静态轨
		{"unmatched", "/api", "*api-other*"},
		{"", "/s/sc_secrettoken123", "*static*"}, // 未匹配不写原始路径
	}
	for _, c := range cases {
		if got := routeAggKey(c.route, c.raw); got != c.want {
			t.Fatalf("routeAggKey(%q,%q)=%q want %q", c.route, c.raw, got, c.want)
		}
	}
}

func TestRoutesAggregationOrderWSExpiry(t *testing.T) {
	ResetRoutesForTesting()
	t.Cleanup(ResetRoutesForTesting)
	ResetTimelineForTesting()
	t.Cleanup(ResetTimelineForTesting)
	// WS：只计次，不进 totalMs/maxMs
	RecordRouteSample("/ws/terminal/:id", "/ws/terminal/1", 200, 500000, true)
	RecordRouteSample("/api/slow", "/api/slow", 200, 1200, false)
	RecordRouteSample("/api/slow", "/api/slow", 200, 300, false)
	RecordRouteSample("/api/slow", "/api/slow", 404, 10, false)
	RecordRouteSample("/api/slow", "/api/slow", 500, 20, false)
	RecordRouteSample("/api/fast", "/api/fast", 200, 50, false)
	doc := RoutesSnapshot(time.Now(), "api")
	if doc.Status != "ok" {
		t.Fatalf("status=%q", doc.Status)
	}
	if len(doc.Rows) != 3 {
		t.Fatalf("rows=%d want 3", len(doc.Rows))
	}
	byRoute := map[string]routeRow{}
	for _, r := range doc.Rows {
		byRoute[r.Route] = r
	}
	ws := byRoute["/ws/terminal/:id"]
	if ws.Count != 1 || ws.WSCount != 1 || ws.TotalMS != 0 || ws.MaxMS != 0 {
		t.Fatalf("WS must count but not accrue duration: %+v", ws)
	}
	slow := byRoute["/api/slow"]
	// TotalMS 含 4xx/5xx 的耗时（只有 WS 不计）：1200+300+10+20=1530；Avg=1530/4
	if slow.Count != 4 || slow.Count4xx != 1 || slow.Count5xx != 1 || slow.TotalMS != 1530 || slow.MaxMS != 1200 || slow.AvgMS != 382 {
		t.Fatalf("slow aggregation wrong: %+v", slow)
	}
	// 热点榜：totalMs 降序
	if doc.Rows[0].Route != "/api/slow" {
		t.Fatalf("hotspot order wrong: first=%s", doc.Rows[0].Route)
	}
	// 快/WS 排后（totalMs=0 并列 → 字典序）
	if doc.Rows[1].Route != "/api/fast" || doc.Rows[2].Route != "/ws/terminal/:id" {
		t.Fatalf("tie order wrong: %v %v", doc.Rows[1].Route, doc.Rows[2].Route)
	}
}

func TestRoutesHourBucketExpiry(t *testing.T) {
	ResetRoutesForTesting()
	t.Cleanup(ResetRoutesForTesting)
	// 25 小时前写入（直接操纵环——绕过 RecordRouteSample 的 time.Now）
	oldHour := routeHourOf(time.Now()) - 25
	routesState.mu.Lock()
	routesState.routes["/api/old"] = map[int64]*routeHourBucket{
		oldHour: {count: 9, totalMs: 900, maxMs: 900},
	}
	routesState.mu.Unlock()
	doc := RoutesSnapshot(time.Now(), "api")
	for _, r := range doc.Rows {
		if r.Route == "/api/old" {
			t.Fatal("expired hour bucket must be dropped at read time")
		}
	}
	if len(doc.Rows) != 0 {
		t.Fatalf("only the expired bucket existed, rows=%d", len(doc.Rows))
	}
}

func TestRoutesSentinelAndPrivacy(t *testing.T) {
	ResetRoutesForTesting()
	t.Cleanup(ResetRoutesForTesting)
	// 未匹配 API 面与静态面分轨；raw path 带 token 不入任何键
	RecordRouteSample("unmatched", "/api/secret-admin-panel?token=abc", 404, 5, false)
	RecordRouteSample("unmatched", "/s/sc_leaketoken123456", 200, 3, false)
	doc := RoutesSnapshot(time.Now(), "api")
	byRoute := map[string]routeRow{}
	for _, r := range doc.Rows {
		byRoute[r.Route] = r
		if r.Sentinel && strings.Contains(r.Route, "token") {
			t.Fatalf("raw path leaked into a sentinel key: %s", r.Route)
		}
	}
	if r := byRoute["*api-other*"]; r.Count != 1 {
		t.Fatalf("*api-other* track missing: %+v", byRoute)
	}
	if r := byRoute["*static*"]; r.Count != 1 {
		t.Fatalf("*static* track missing: %+v", byRoute)
	}
	out := renderRoutesJSON(time.Now(), "api")
	if strings.Contains(out, "leaketoken") || strings.Contains(out, "secret-admin") {
		t.Fatal("routes.json must never carry raw paths")
	}
	// CLI 形态：如实 skipped
	cliDoc := RoutesSnapshot(time.Now(), "cli")
	if cliDoc.Status != "skipped" || cliDoc.Reason == "" {
		t.Fatalf("cli routes must be skipped with reason: %+v", cliDoc)
	}
}

func TestRoutesEvictionKeepsHotspots(t *testing.T) {
	ResetRoutesForTesting()
	t.Cleanup(ResetRoutesForTesting)
	// 填满 + 溢出：totalMs 最小的路由被淘汰，热点保留
	for i := 0; i < routesMaxRoutes; i++ {
		route := "/api/route-" + strings.Repeat("x", i+1) + "-" + itoa(i)
		RecordRouteSample(route, route, 200, int64(1000+i), false)
	}
	RecordRouteSample("/api/hot", "/api/hot", 200, 999999, false) // 热点挤入（淘汰 totalMs=1000 最冷者）
	RecordRouteSample("/api/cold", "/api/cold", 200, 1, false)    // 再挤入（淘汰次冷者）
	doc := RoutesSnapshot(time.Now(), "api")
	if doc.Count > routesMaxRoutes {
		t.Fatalf("route cap broken: %d", doc.Count)
	}
	found := map[string]bool{}
	for _, r := range doc.Rows {
		found[r.Route] = true
	}
	if !found["/api/hot"] || !found["/api/cold"] {
		t.Fatalf("new arrivals must survive eviction (they evict older, colder keys): hot=%v cold=%v", found["/api/hot"], found["/api/cold"])
	}
	if doc.Dropped < 2 {
		t.Fatalf("eviction must be observable (dropped counter), got %d", doc.Dropped)
	}
}

func TestProfileRatesEnvSwitch(t *testing.T) {
	// installDiagProfileRates 的开关语义在 app 包；这里验证登记面三态可读
	t.Cleanup(func() {
		profileRatesConfigured.mu.Lock()
		profileRatesConfigured.installed = false
		profileRatesConfigured.mu.Unlock()
	})
	SetProfileSamplingRates(10000, 100)
	block, frac, installed := ProfileSamplingRates()
	if !installed || block != 10000 || frac != 100 {
		t.Fatalf("rate registration roundtrip broken: %d %d %v", block, frac, installed)
	}
	SetProfileSamplingRates(0, 0)
	block, frac, installed = ProfileSamplingRates()
	if !installed || block != 0 || frac != 0 {
		t.Fatalf("explicit-off registration broken: %d %d %v", block, frac, installed)
	}
}

func TestProcessInfoWindowsRealAPICalls(t *testing.T) {
	// 仅 Windows 真跑（主力开发机即 Windows）：psapi/toolhelp/x/sys 三路都通
	if runtimeGOOS() != "windows" {
		t.Skip("windows-only real-API check")
	}
	p, ok := processInstantSample()
	if !ok {
		t.Fatal("windows instant sample failed")
	}
	if p.RSSMB <= 0 {
		t.Fatalf("WorkingSetSize missing: %+v", p)
	}
	if p.Handles <= 0 {
		t.Fatalf("GetProcessHandleCount missing: %+v", p)
	}
	if p.Threads <= 0 {
		t.Fatalf("toolhelp thread count missing: %+v", p)
	}
	secs, okSecs := processCPUSecondsTotal()
	if !okSecs || secs <= 0 {
		t.Fatalf("GetProcessTimes missing: %v %v", secs, okSecs)
	}
	if p.Note != "" {
		t.Fatalf("real windows run should have no failed field: %q", p.Note)
	}
}

func TestProcessInfoLinuxProcParsing(t *testing.T) {
	// /proc 解析纯函数在三平台都可测：构造一个合法 stat 行
	// comm 含空格/括号 → 从最后一个 ')' 后切，utime=fields[11] stime=fields[12]
	line := "1234 (my pro)c) R 1 1 1 1 1 1 1 1 1 1 100 50 1 1 0 0 0 0 0 0"
	_ = line // 直接走 processinfo_linux 的私有解析逻辑无法跨平台调用；
	// 该路径在 linux 分支文件里，Windows 下不编译——其解析正确性由 wsl 门禁
	// （scripts/wsl-verify.sh）跑 GOOS=linux 测试兜底，本仓纪律照旧。
	if runtimeGOOS() == "linux" {
		if _, ok := processCPUSecondsTotal(); !ok {
			t.Fatal("linux: /proc/self/stat must be readable")
		}
	}
}

func TestGoruntimeJSONNeverCarriesFreeText(t *testing.T) {
	out := renderGoRuntimeJSON("api")
	var doc map[string]any
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("goruntime.json invalid JSON: %v", err)
	}
	// 红线：无路径/无 argv/env 面（快照只有计数与枚举）
	for _, banned := range []string{"dataDir", "argv", "env", "CC_DATA_DIR"} {
		if _, ok := doc[banned]; ok {
			t.Fatalf("goruntime.json must not carry %s", banned)
		}
	}
}
