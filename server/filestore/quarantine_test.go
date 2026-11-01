package filestore_test

// 损坏文档统一隔离语义单测（P-20261004-76）：损坏只可能来自外部（崩溃截断/
// 磁盘损坏/手工编辑），故用例直接按落盘布局 <dir>/data/<kind>/<key>.json 写入
// 坏文件，再经 DocumentStore 接口验证隔离行为——ErrNotFound 回落、改名留证、
// Warn 日志、写路径覆盖式重建。

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// writeCorrupt 直接往落盘布局写一个损坏文档（绕过 store 接口）
func writeCorrupt(t *testing.T, dir, kind, key, content string) {
	t.Helper()
	kindDir := filepath.Join(dir, "data", kind)
	if err := os.MkdirAll(kindDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kindDir, key+".json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// corruptFiles 枚举某文档的 .corrupt-* 隔离留证文件
func corruptFiles(t *testing.T, dir, kind, key string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "data", kind, key+".json.corrupt-*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

// captureLogs 换入 buffer 版默认 logger，返回读取已积累日志的函数（测试结束还原）
func captureLogs(t *testing.T) func() string {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf.String
}

// docPath 文档落盘路径（断言改名用）
func docPath(dir, kind, key string) string {
	return filepath.Join(dir, "data", kind, key+".json")
}

// TestQuarantineOnGet 提案④主用例：造损坏文件 → Get 得 ErrNotFound 且文件改名
// + 日志断言 → 写后重建新文档（自愈闭环）
func TestQuarantineOnGet(t *testing.T) {
	logs := captureLogs(t)
	dir := t.TempDir()
	s := filestore.New(dir)
	writeCorrupt(t, dir, "conf", "k1", `{"name":"a","n":1`) // 崩溃截断形态

	// Get：非法内容 → 与文档缺失同回落
	if _, err := s.Get("conf", "k1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Get corrupt: want ErrNotFound, got %v", err)
	}
	// 原文件改名留证：坏文件不在原位，.corrupt-* 恰有一个
	if _, err := os.Stat(docPath(dir, "conf", "k1")); !os.IsNotExist(err) {
		t.Fatalf("corrupt file must be renamed away, stat err=%v", err)
	}
	if quarantined := corruptFiles(t, dir, "conf", "k1"); len(quarantined) != 1 {
		t.Fatalf("want exactly one .corrupt-* file, got %v", quarantined)
	}
	// not-found 家族语义一致
	if has, err := s.Has("conf", "k1"); err != nil || has {
		t.Fatalf("Has after quarantine: want false,nil got %v,%v", has, err)
	}
	// 日志断言：Warn 带 kind/key
	if logs() == "" || !strings.Contains(logs(), "corrupt document quarantined") ||
		!strings.Contains(logs(), "kind=conf") || !strings.Contains(logs(), "key=k1") {
		t.Fatalf("want quarantine Warn with kind/key, got: %s", logs())
	}

	// 自愈闭环：隔离后写路径覆盖式重建新文档（Create 看到隔离后的空位）
	if err := s.Create("conf", "k1", []byte(`{"name":"reborn","n":2}`)); err != nil {
		t.Fatalf("Create after quarantine: %v", err)
	}
	got, err := s.Get("conf", "k1")
	if err != nil || string(got) != `{"name":"reborn","n":2}` {
		t.Fatalf("Get after rebuild: %q, %v", got, err)
	}
	// 重建后再 Update 覆盖（写路径既有语义零改动）
	if err := s.Update("conf", "k1", []byte(`{"name":"again","n":3}`)); err != nil {
		t.Fatalf("Update after rebuild: %v", err)
	}
}

// TestQuarantineOnGetBatch 隔离失败的降级与成功剔除：GetBatch 中坏键被隔离后
// 从结果剔除（=not-found），好键不受影响
func TestQuarantineOnGetBatch(t *testing.T) {
	logs := captureLogs(t)
	dir := t.TempDir()
	s := filestore.New(dir)
	if err := s.Create("conf", "good", []byte(`{"v":1}`)); err != nil {
		t.Fatal(err)
	}
	writeCorrupt(t, dir, "conf", "bad", `not json at all`)

	m, err := s.GetBatch("conf", []string{"good", "bad"})
	if err != nil {
		t.Fatal(err)
	}
	if string(m["good"]) != `{"v":1}` {
		t.Fatalf("good key must survive: %v", m)
	}
	if _, ok := m["bad"]; ok {
		t.Fatalf("quarantined key must be excluded: %v", m)
	}
	if quarantined := corruptFiles(t, dir, "conf", "bad"); len(quarantined) != 1 {
		t.Fatalf("bad key must be renamed away, got %v", quarantined)
	}
	if !strings.Contains(logs(), "corrupt documents quarantined during scan") {
		t.Fatalf("want batch summary Warn, got: %s", logs())
	}
}

// TestQuarantineOnList 提案②：List 路径同款——扫描跳过（既有语义）+ 整批隔离
// + 一次汇总 Warn；隔离后 List 不再枚举坏文档
func TestQuarantineOnList(t *testing.T) {
	logs := captureLogs(t)
	dir := t.TempDir()
	s := filestore.New(dir)
	for _, k := range []string{"a", "b"} {
		if err := s.Create("conf", k, []byte(`{"status":"pending"}`)); err != nil {
			t.Fatal(err)
		}
	}
	writeCorrupt(t, dir, "conf", "c", `{broken`)
	writeCorrupt(t, dir, "conf", "d", ``) // 空文件形态（崩溃残留）

	// Match 扫描：坏文档跳过（不参与匹配），好文档照常命中
	keys, total, err := s.List("conf", store.ListOpts{Match: map[string]any{"status": "pending"}})
	if err != nil || total != 2 || strings.Join(keys, ",") != "a,b" {
		t.Fatalf("match must skip corrupt: %v %d %v", keys, total, err)
	}
	// 坏文档整批改名留证
	for _, k := range []string{"c", "d"} {
		if quarantined := corruptFiles(t, dir, "conf", k); len(quarantined) != 1 {
			t.Fatalf("key %s must be renamed away, got %v", k, quarantined)
		}
	}
	// 一次汇总 Warn（两条坏文档合一条，不刷屏）
	if n := strings.Count(logs(), "corrupt documents quarantined during scan"); n != 1 {
		t.Fatalf("want exactly one summary Warn, got %d: %s", n, logs())
	}
	if !strings.Contains(logs(), "kind=conf") {
		t.Fatalf("summary Warn must carry kind, got: %s", logs())
	}

	// 隔离后：List 不再枚举（.corrupt-* 不以 .json 结尾）
	keys, total, err = s.List("conf", store.ListOpts{})
	if err != nil || total != 2 || strings.Join(keys, ",") != "a,b" {
		t.Fatalf("quarantined files must not be listed: %v %d %v", keys, total, err)
	}
}

// TestQuarantineOnPatch 单读/写混合路径：Patch 命中坏文档 → ErrNotFound 回落 +
// 改名留证；PatchBatch 同款
func TestQuarantineOnPatch(t *testing.T) {
	dir := t.TempDir()
	s := filestore.New(dir)
	writeCorrupt(t, dir, "conf", "p1", `{"trunc`)
	writeCorrupt(t, dir, "conf", "p2", `[1,2,3]`) // 合法 JSON 但非对象——同属不可用文档

	if err := s.Patch("conf", "p1", map[string]any{"a": 1}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Patch corrupt: want ErrNotFound, got %v", err)
	}
	if err := s.PatchBatch("conf", map[string]map[string]any{"p2": {"a": 1}}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("PatchBatch corrupt: want ErrNotFound, got %v", err)
	}
	for _, k := range []string{"p1", "p2"} {
		if _, err := os.Stat(docPath(dir, "conf", k)); !os.IsNotExist(err) {
			t.Fatalf("key %s must be renamed away, stat err=%v", k, err)
		}
		if quarantined := corruptFiles(t, dir, "conf", k); len(quarantined) != 1 {
			t.Fatalf("key %s: want exactly one .corrupt-* file, got %v", k, quarantined)
		}
	}
	// 隔离后写路径重建（Create 可用——空位）
	if err := s.Create("conf", "p1", []byte(`{"a":1}`)); err != nil {
		t.Fatalf("Create after quarantine: %v", err)
	}
	if err := s.Patch("conf", "p1", map[string]any{"b": 2}); err != nil {
		t.Fatalf("Patch after rebuild: %v", err)
	}
}

// TestQuarantineKeepsEvidenceInList 坏文档隔离后 Count 不把 .corrupt-* 计入文档数
func TestQuarantineKeepsEvidenceInList(t *testing.T) {
	dir := t.TempDir()
	s := filestore.New(dir)
	writeCorrupt(t, dir, "conf", "x", `garbage{`)
	if n, _ := s.Count("conf", store.ListOpts{}); n != 1 {
		t.Fatalf("corrupt file counts before quarantine: %d", n)
	}
	if _, err := s.Get("conf", "x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Get corrupt: want ErrNotFound, got %v", err)
	}
	if n, _ := s.Count("conf", store.ListOpts{}); n != 0 {
		t.Fatalf("quarantined evidence must not count as document: %d", n)
	}
	// 留证文件仍在（取证语义：只改名不删除）
	if quarantined := corruptFiles(t, dir, "conf", "x"); len(quarantined) != 1 {
		t.Fatalf("evidence file must be kept, got %v", quarantined)
	}
}
