package pastetmp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 碰撞步进：同名已被占用时 -1 后缀步进（自 terminal_paste_image.go 时代
// 迁入的行为面，P-20261122-1 随实现下沉微包）
func TestCreateCollisionSteps(t *testing.T) {
	dir := t.TempDir()
	taken := filepath.Join(dir, "sc-paste-1700000000000.png")
	if err := os.WriteFile(taken, []byte("occupied"), 0600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	f, full, err := Create(dir, "sc-paste-1700000000000.png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer f.Close()
	defer os.Remove(full)
	if full != filepath.Join(dir, "sc-paste-1700000000000-1.png") {
		t.Fatalf("collision should step to -1 suffix, got %s", full)
	}
	// O_EXCL：不覆盖既有文件（occupied 内容原样）
	got, err := os.ReadFile(taken)
	if err != nil || string(got) != "occupied" {
		t.Fatalf("existing file must not be overwritten: %v %q", err, got)
	}
}

// 同毫秒并发：两连 Create 各得独立文件（批内逐个上传的现实形态，互不覆盖）
func TestCreateConcurrentMillisecond(t *testing.T) {
	dir := t.TempDir()
	name := Name(".png")
	f1, p1, err := Create(dir, name)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	defer f1.Close()
	defer os.Remove(p1)
	f2, p2, err := Create(dir, name)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	defer f2.Close()
	defer os.Remove(p2)
	if p1 == p2 {
		t.Fatalf("same-millisecond creates must not share a path: %s", p1)
	}
	if _, err := os.Stat(p2); err != nil {
		t.Fatalf("second file missing: %v", err)
	}
}

// 命名形态：sc-paste- 前缀 + 毫秒数字 + 传入扩展名（paste-cleaner 前缀匹配面）
func TestNameShape(t *testing.T) {
	n := Name(".jpg")
	if !strings.HasPrefix(n, Prefix) {
		t.Fatalf("name %q missing prefix %q", n, Prefix)
	}
	if filepath.Ext(n) != ".jpg" {
		t.Fatalf("name %q ext = %q, want .jpg", n, filepath.Ext(n))
	}
	ms := strings.TrimSuffix(strings.TrimPrefix(n, Prefix), ".jpg")
	if len(ms) != 13 {
		t.Fatalf("name %q millis segment %q should be 13 digits", n, ms)
	}
	for _, c := range ms {
		if c < '0' || c > '9' {
			t.Fatalf("name %q millis segment has non-digit %q", n, ms)
		}
	}
}

// 0600 权限：粘贴载荷可能含敏感内容，收敛到本用户可读（POSIX 语义面；
// Windows 无 POSIX 权限位，Go 从只读属性合成 0666——断言只在 unix 族跑）
func TestCreatePerm(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows synthesizes 0666 from the read-only attribute; POSIX perms are a no-op here")
	}
	dir := t.TempDir()
	f, p, err := Create(dir, Name(".png"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer f.Close()
	defer os.Remove(p)
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("perm = %o, want 600", info.Mode().Perm())
	}
}
