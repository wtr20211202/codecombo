package share

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// scanFixture 建一个含敏感文件全谱系 + 干净文件的临时项目树
func scanFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWrite := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 模式表全覆盖 + 大小写变体 + 嵌套层级
	mustWrite(".env", "A=1")
	mustWrite(".env.local", "A=1")
	mustWrite("config/id_rsa", "key")
	mustWrite("config/id_rsa.pub", "pub")
	mustWrite("config/cert.pem", "pem")
	mustWrite("config/KEYS.key", "key")
	mustWrite("registry/.npmrc", "token")
	mustWrite("registry/.netrc", "token")
	mustWrite("registry/.git-credentials", "cred")
	mustWrite("vault/db.kdbx", "kdbx")
	mustWrite("gcp/serviceAccount-prod.json", "{}")
	mustWrite("gcp/CREDENTIALS.JSON", "{}")
	// 干净对照：普通源码/文档不应命中
	mustWrite("main.go", "package main")
	mustWrite("docs/readme.md", "# doc")
	mustWrite("notes.txt", "n")
	return root
}

func TestScanSensitiveDirHits(t *testing.T) {
	root := scanFixture(t)
	res, err := ScanSensitive(root, "")
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	want := []string{
		".env",
		".env.local",
		"config/KEYS.key",
		"config/cert.pem",
		"config/id_rsa",
		"config/id_rsa.pub",
		"gcp/CREDENTIALS.JSON",
		"gcp/serviceAccount-prod.json",
		"registry/.git-credentials",
		"registry/.netrc",
		"registry/.npmrc",
		"vault/db.kdbx",
	}
	// WalkDir 字典序，结果确定；大小写变体同样命中（跨平台一致）
	if !reflect.DeepEqual(res.Warnings, want) {
		t.Fatalf("warnings = %v, want %v", res.Warnings, want)
	}
	if res.Truncated {
		t.Fatal("small tree must not be truncated")
	}
}

func TestScanSensitiveClean(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"a/main.go", "a/b/readme.md", "env.txt", "credentials.json.bak"} {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := ScanSensitive(root, "a")
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(res.Warnings) != 0 || res.Truncated {
		t.Fatalf("clean dir should have no warnings, got %v (truncated=%v)", res.Warnings, res.Truncated)
	}
}

func TestScanSensitiveFileTarget(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{".env", "app.go"} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 敏感文件本身被分享：命中报文件名
	res, err := ScanSensitive(root, ".env")
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !reflect.DeepEqual(res.Warnings, []string{".env"}) {
		t.Fatalf("warnings = %v, want [.env]", res.Warnings)
	}

	// 普通文件：无命中
	res2, err := ScanSensitive(root, "app.go")
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(res2.Warnings) != 0 {
		t.Fatalf("warnings = %v, want empty", res2.Warnings)
	}
}

func TestScanSensitiveEntryLimit(t *testing.T) {
	root := t.TempDir()
	// 3 个干净文件 + 1 个敏感文件；limit=3 触发截断——敏感文件排在字典序
	// 之后（id_rsa > a/b/c.txt）验证截断后确实漏检并标注 Truncated。
	// （注意 .env* 是前缀模式：z.env 这类扩展名形态本就不命中，零误报根）
	if err := os.MkdirAll(filepath.Join(root, "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"b/a.txt", "b/b.txt", "b/c.txt", "b/id_rsa"} {
		if err := os.WriteFile(filepath.Join(root, rel), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := scanSensitive(root, "b", 3)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !res.Truncated {
		t.Fatal("limit=3 with 4 entries must mark truncated")
	}
	if !reflect.DeepEqual(res.Warnings, []string{}) {
		t.Fatalf("warnings = %v, want empty (id_rsa beyond limit)", res.Warnings)
	}

	// 上限恰好不触发：4 个条目 limit=4 → 全量扫描无截断
	res2, err := scanSensitive(root, "b", 4)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if res2.Truncated {
		t.Fatal("limit=4 with exactly 4 entries must not be truncated")
	}
	// 警告路径相对分享根（目标目录 b 本身不出现在路径里）
	if !reflect.DeepEqual(res2.Warnings, []string{"id_rsa"}) {
		t.Fatalf("warnings = %v, want [id_rsa]", res2.Warnings)
	}
}

func TestScanSensitiveSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	mustWrite := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 分享根内唯一真实敏感文件（注意 .env* 是前缀模式：real.env 这类扩展名
	// 形态不命中——首版夹具误用 real.env 作正例，Linux 符号链接可用的首跑
	// 才暴露期望错误）
	mustWrite("share/.env", "A=1")
	mustWrite("outside/cert.pem", "PEM")
	mustWrite("outside/.env", "SECRET")
	// 两个符号链接均构造为「不跳过就必失败」：
	//   link.pem 名字本身命中 *.pem——若当普通文件匹配会混入警告；
	//   linkdir 指向分享外目录（内含 .env）——若递归跟进会泄出 linkdir/.env。
	// 访客面对符号链接不可见，扫描同样跳过（Windows 无符号链接权限时跳过）
	if err := os.Symlink(filepath.Join(root, "outside", "cert.pem"), filepath.Join(root, "share", "link.pem")); err != nil {
		t.Skipf("symlink unavailable on this platform: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(root, "share", "linkdir")); err != nil {
		t.Skipf("symlink unavailable on this platform: %v", err)
	}
	res, err := ScanSensitive(root, "share")
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !reflect.DeepEqual(res.Warnings, []string{".env"}) {
		t.Fatalf("warnings = %v, want [.env] (symlinks must be skipped)", res.Warnings)
	}
}

func TestScanSensitiveTargetMissing(t *testing.T) {
	root := t.TempDir()
	if _, err := ScanSensitive(root, "no-such-dir"); err == nil {
		t.Fatal("missing target must error")
	}
}

// MatchSensitivePaths 补丁导出族（P-20261004-97）消费的同源匹配 util：
// 路径清单 → 命中子集（basename 级、大小写不敏感、保序去重）
func TestMatchSensitivePaths(t *testing.T) {
	got := MatchSensitivePaths([]string{
		".env",                            // 根下命中
		"config/.env.production",          // 嵌套：末段命中
		"keys/ID_RSA",                     // 大小写变体命中
		"src/main.go",                     // 干净：不命中
		"docs/env.example.md",             // env 子串但非 .env* 模式：不命中（防误报对照）
		"deploy/serviceaccount-test.json", // 通配前缀命中
		".env",                            // 重复：去重
	})
	want := []string{".env", "config/.env.production", "keys/ID_RSA", "deploy/serviceaccount-test.json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("MatchSensitivePaths = %v, want %v", got, want)
	}
	if out := MatchSensitivePaths(nil); out != nil {
		t.Fatalf("nil input = %v, want nil", out)
	}
	// 反斜杠分隔符无条件归一（不依赖 filepath.ToSlash 的平台语义——Linux 上
	// 它是恒等操作，反斜杠输入只在 Windows 被归一）：三平台断言同一结果
	if out := MatchSensitivePaths([]string{`config\id_rsa`}); len(out) != 1 {
		t.Fatalf(`backslash path should hit: %v`, out)
	}
}
