package diagnostics

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fixtureDir 建一个含日志/更新链/凭据路径的临时数据目录（P-20261122-10 契约面）
func fixtureDir(t *testing.T) (dir string, now time.Time) {
	t.Helper()
	dir = t.TempDir()
	logDir := filepath.Join(dir, "logs")
	for _, d := range []string{logDir, filepath.Join(dir, "data")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	now = time.Date(2026, 11, 22, 12, 0, 0, 0, time.Local)
	today := now.Format(dailyLogDateLayout)
	yesterday := now.AddDate(0, 0, -1).Format(dailyLogDateLayout)

	// 当天主日志：含敏感 token、DataDir 绝对路径、WARN/ERROR 各一条
	body := strings.Join([]string{
		`time=2026-11-22T09:00:00Z level=INFO msg="boot: started" dataDir=` + dir,
		`time=2026-11-22T09:00:01Z level=WARN msg="watcher: degraded"`,
		`time=2026-11-22T09:00:02Z level=ERROR msg="update: failed" token=supersecret123`,
	}, "\n") + "\n"
	writeFile(t, filepath.Join(logDir, "codecombo-"+today+".log"), body)
	writeFile(t, filepath.Join(logDir, "simple-coding-"+yesterday+".log"), "legacy day\n")
	writeFile(t, filepath.Join(logDir, "update.log"), "update decision\n")
	writeFile(t, filepath.Join(logDir, "extra.log"), "extra module log\n")
	writeFile(t, filepath.Join(logDir, "half.part.log"), "partial\n")

	// DataDir 根：dsh-web.log 在根不在 logs/（config.go:390）——通配漏它，
	// 必须靠显式列举；update-result + pid + 凭据（config.json 不入包）
	writeFile(t, filepath.Join(dir, "dsh-web.log"), "dsh stdout\n")
	writeFile(t, filepath.Join(dir, "update-result.json"), `{"status":"failed","error":"boom"}`)
	writeFile(t, filepath.Join(dir, "codecombo.pid"), "4242\n9999\nhttps\n0.0.1-beta.11")
	writeFile(t, filepath.Join(dir, "config.json"), `{"server":{"port":9999}}`)
	writeFile(t, filepath.Join(dir, "data", "master-key"), "0123456789abcdef0123456789abcdef")
	return dir, now
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// 采集全文契约：条目状态、缺席即证据、凭据硬拒、通配口径、zip 内容与脱敏
func TestPlanAndWriteZip(t *testing.T) {
	dir, now := fixtureDir(t)
	b, err := Plan(context.Background(), Options{DataDir: dir, Version: "9.9.9", Now: now, Mask: true})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	byName := map[string]Entry{}
	for _, e := range b.Manifest.Entries {
		byName[e.Name] = e
	}
	// 必须有的条目
	for _, want := range []string{
		"README.txt", "manifest.json", "logs-summary.txt", "errors.txt", "platform.txt",
		"state/runtime.json", "state/selfcheck.json", "state/update-status.json",
		"state/data-dir-inventory.txt", "state/storage.json", "state/update-result.json", "state/pid.txt",
		"logs/dsh-web.log", "logs/update.log", "logs/extra.log",
	} {
		e, ok := byName[want]
		if !ok {
			t.Fatalf("manifest missing entry %q (have %v)", want, keys(byName))
		}
		if e.Status == StatusAbsent && want != "state/update-result.json" {
			t.Fatalf("%s unexpectedly absent: %+v", want, e)
		}
	}
	// 缺席即证据：更新链未写过的文件必须 ABSENT（不造空文件）
	if e := byName["logs/update-subprocess.log"]; e.Status != StatusAbsent {
		t.Fatalf("update-subprocess.log status = %q, want absent", e.Status)
	}
	if e := byName["logs/crash.log"]; e.Status != StatusAbsent {
		t.Fatalf("crash.log status = %q, want absent", e.Status)
	}
	// 凭据永不入包
	for name := range byName {
		low := strings.ToLower(name)
		if strings.Contains(low, "master-key") || strings.Contains(low, "config.json") {
			t.Fatalf("credential path leaked into manifest: %s", name)
		}
	}
	// 半成品不入包
	if _, ok := byName["logs/half.part.log"]; ok {
		t.Fatal("*.part.log must be excluded from the wildcard set")
	}

	// zip 内容
	var buf bytes.Buffer
	if err := b.WriteZip(&buf); err != nil {
		t.Fatalf("WriteZip: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip invalid: %v", err)
	}
	files := map[string]string{}
	order := []string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(rc)
		_ = rc.Close()
		files[f.Name] = string(body)
		order = append(order, f.Name)
	}
	// 头先出：README + manifest 是前两个条目
	if len(order) < 2 || order[0] != "README.txt" || order[1] != "manifest.json" {
		t.Fatalf("first entries = %v, want README then manifest", order)
	}
	// 缺席/拒绝条目不得有文件体
	for _, absent := range []string{"logs/update-subprocess.log", "logs/crash.log"} {
		if _, ok := files[absent]; ok {
			t.Fatalf("%s must not be materialized (absent = evidence, no empty file)", absent)
		}
	}
	// errors.txt：WARN+ERROR 原文、敏感值遮蔽
	errs := files["errors.txt"]
	if !strings.Contains(errs, "watcher: degraded") || !strings.Contains(errs, "update: failed") {
		t.Fatalf("errors.txt missing WARN/ERROR lines: %q", errs)
	}
	if strings.Contains(errs, "supersecret123") {
		t.Fatal("sensitive token leaked into errors.txt")
	}
	if !strings.Contains(errs, "token=***") {
		t.Fatalf("mask marker missing: %q", errs)
	}
	// 原文：DataDir 绝对路径归一为 $DATA_DIR
	daily := files["logs/codecombo-"+now.Format(dailyLogDateLayout)+".log"]
	if !strings.Contains(daily, "$DATA_DIR") {
		t.Fatalf("data dir path not normalized in raw log: %q", daily)
	}
	if !strings.Contains(daily, "token=***") {
		t.Fatalf("raw log not masked: %q", daily)
	}
	// PID 文件全文（含第五行版本）
	if got := files["state/pid.txt"]; !strings.Contains(got, "0.0.1-beta.11") {
		t.Fatalf("pid.txt must carry the version line, got %q", got)
	}
	// 数据目录清点：只元数据
	inv := files["state/data-dir-inventory.txt"]
	if !strings.Contains(inv, "master-key") || !strings.Contains(inv, "content never packed") {
		t.Fatalf("inventory must list master-key as metadata only: %q", inv)
	}
	if strings.Contains(inv, "0123456789abcdef") {
		t.Fatal("master-key content leaked into inventory")
	}
	if !strings.Contains(inv, "DENIED: instance config") {
		t.Fatalf("config.json must be flagged DENIED in inventory: %q", inv)
	}
	// 存储统计：data/ 只统计；凭据内容绝不入包
	storageJSON := files["state/storage.json"]
	if !strings.Contains(storageJSON, "\"data\"") || !strings.Contains(storageJSON, "credential store") {
		t.Fatalf("storage.json must break down data/: %q", storageJSON)
	}
	if strings.Contains(storageJSON, "0123456789abcdef") {
		t.Fatal("master-key content leaked into storage.json")
	}
	// CLI 形态：终端会话摘要如实 skipped（没有会话管理器）
	if !strings.Contains(files["state/runtime.json"], "terminalSessions") {
		t.Fatalf("runtime.json must carry the terminalSessions block: %q", files["state/runtime.json"])
	}
	// manifest 落盘可解析且 totals 自洽
	var m Manifest
	if err := json.Unmarshal([]byte(files["manifest.json"]), &m); err != nil {
		t.Fatalf("manifest.json invalid: %v", err)
	}
	if m.Totals.Entries != len(m.Entries) || m.Version != "9.9.9" || !m.Mask {
		t.Fatalf("manifest totals/header off: %+v", m)
	}
	if m.Totals.IncludedBytes <= 0 {
		t.Fatalf("includedBytes = %d", m.Totals.IncludedBytes)
	}
}

// mask=0：显式关（取证对账档）——原文出包
func TestPlanMaskDisabled(t *testing.T) {
	dir, now := fixtureDir(t)
	b, err := Plan(context.Background(), Options{DataDir: dir, Version: "x", Now: now, Mask: false})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	var buf bytes.Buffer
	if err := b.WriteZip(&buf); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name != "errors.txt" {
			continue
		}
		rc, _ := f.Open()
		body, _ := io.ReadAll(rc)
		_ = rc.Close()
		if !strings.Contains(string(body), "supersecret123") {
			t.Fatalf("mask=0 must keep raw values, got %q", string(body))
		}
		if !strings.Contains(string(body), "masked=false") {
			t.Fatalf("errors.txt header must echo mask=false: %q", string(body))
		}
		return
	}
	t.Fatal("errors.txt missing")
}

// 探针：只 stat 不打包，条目与正式包同口径、缺席可见
func TestProbeReportsSizes(t *testing.T) {
	dir, now := fixtureDir(t)
	rep, err := Probe(Options{DataDir: dir, Version: "v", Now: now, Mask: true})
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if rep.Totals.PackedFiles == 0 || rep.Totals.IncludedBytes == 0 {
		t.Fatalf("probe totals = %+v", rep.Totals)
	}
	if rep.Totals.Absent == 0 {
		t.Fatal("probe must surface absent entries (update chain never ran)")
	}
	if rep.Limits.RawBudgetBytes != rawBudgetBytes || rep.Limits.ZipCapBytes != zipCapBytes {
		t.Fatalf("limits = %+v", rep.Limits)
	}
	var haveAbsent bool
	for _, e := range rep.Files {
		if e.Name == "logs/crash.log" && e.Status == StatusAbsent {
			haveAbsent = true
		}
	}
	if !haveAbsent {
		t.Fatal("probe missing crash.log absent entry")
	}
	if len(rep.Derived) == 0 {
		t.Fatal("probe must list derived files so the caller can size the bundle")
	}
}

// 缺席的日志目录：不报错，全部进 absent（服务从未启动的形态）
func TestPlanMissingLogsDir(t *testing.T) {
	dir := t.TempDir()
	b, err := Plan(context.Background(), Options{
		DataDir: dir, Version: "x",
		Now:  time.Date(2026, 11, 22, 12, 0, 0, 0, time.Local),
		Mask: true,
	})
	if err != nil {
		t.Fatalf("Plan on empty dir: %v", err)
	}
	if b.Manifest.Totals.Absent == 0 {
		t.Fatalf("expected absent entries, got %+v", b.Manifest.Totals)
	}
	var buf bytes.Buffer
	if err := b.WriteZip(&buf); err != nil {
		t.Fatalf("WriteZip on empty dir: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("zip must still contain derived files (README/manifest/platform)")
	}
}

// 凭据 denylist 直判（单测覆盖扩展/前缀/目录三道闸）
func TestDeniedReason(t *testing.T) {
	dataDir := filepath.Join("x", "data-dir")
	cases := []struct{ path, want string }{
		{filepath.Join(dataDir, "data", "master-key"), "master"},
		{filepath.Join(dataDir, "config.json"), "config"},
		{filepath.Join(dataDir, "certs", "server.pem"), "private key"},
		{filepath.Join(dataDir, "certs", "server.key"), "private key"},
		{filepath.Join(dataDir, "id_ed25519"), "SSH"},
		{filepath.Join(dataDir, "cookies.txt"), "cookie"},
		{filepath.Join(dataDir, "authorization.json"), "cookie"},
		{filepath.Join(dataDir, "logs", "codecombo-2026-11-22.log"), ""},
	}
	for _, c := range cases {
		got := deniedReason(c.path, dataDir)
		if (c.want == "") != (got == "") || (c.want != "" && !strings.Contains(got, c.want)) {
			t.Fatalf("deniedReason(%s) = %q, want %q", c.path, got, c.want)
		}
	}
}

// 未知来源 env 不入包 / 白名单 env 过归一（用 t.Setenv 隔离进程环境）
func TestRuntimeEnvWhitelist(t *testing.T) {
	t.Setenv("CC_LOG_LEVEL", "debug")
	t.Setenv("CC_SUPER_SECRET_TOKEN", "leak-me")
	red := NewRedactor(t.TempDir(), true)
	env := runtimeEnv(red)
	if env["CC_LOG_LEVEL"] != "debug" {
		t.Fatalf("whitelisted env missing: %v", env)
	}
	if _, ok := env["CC_SUPER_SECRET_TOKEN"]; ok {
		t.Fatal("non-whitelisted env leaked into runtime.json")
	}
}

func keys(m map[string]Entry) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
