package git

import (
	"strings"
	"testing"
)

// FilterPatchToPaths 单测（P-20261004-66 还原边界修复）：备份补丁自 P-56 起含
// untracked new-file 段，还原 apply 前须裁剪到圈定路径——覆盖裸路径/引用路径
// （含空格、八进制转义非 ASCII）/tracked diff 段保留/注记行随裁剪消失/rename
// 段 old 命中保留/解析失败保守保留。
func TestFilterPatchToPaths_TrackedOnly(t *testing.T) {
	patch := `diff --git a/svc.txt b/svc.txt
index 1111111..2222222 100644
--- a/svc.txt
+++ b/svc.txt
@@ -1 +1 @@
-hit Alpha here
+hit Beta here
diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1 @@
+hit Alpha too
`
	got := FilterPatchToPaths(patch, []string{"svc.txt"})
	if !strings.Contains(got, "diff --git a/svc.txt b/svc.txt") {
		t.Fatalf("tracked segment dropped:\n%s", got)
	}
	if strings.Contains(got, "newfile.txt") {
		t.Fatalf("untracked segment not filtered:\n%s", got)
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatalf("filtered patch must end with newline:\n%q", got)
	}
}

func TestFilterPatchToPaths_QuotedAndOctalPaths(t *testing.T) {
	patch := `diff --git "a/has space.txt" "b/has space.txt"
new file mode 100644
--- /dev/null
+++ "b/has space.txt"
@@ -0,0 +1 @@
+x
diff --git "a/\346\226\207.txt" "b/\346\226\207.txt"
new file mode 100644
--- /dev/null
+++ "b/\346\226\207.txt"
@@ -0,0 +1 @@
+y
`
	// 引号路径（空格）与八进制转义路径（非 ASCII）都按解引后的真实路径匹配
	got := FilterPatchToPaths(patch, []string{"文.txt"})
	if !strings.Contains(got, `b/\346\226\207.txt`) {
		t.Fatalf("octal-escaped path segment dropped:\n%s", got)
	}
	if strings.Contains(got, "has space") {
		t.Fatalf("unmatched quoted path segment kept:\n%s", got)
	}
}

func TestFilterPatchToPaths_AnnotationAndRename(t *testing.T) {
	patch := `...[untracked file omitted from patch: big.bin (oversized: 3000000 > 2097152 bytes)]
diff --git a/old-name.txt b/renamed.txt
similarity index 100%
rename from old-name.txt
rename to renamed.txt
diff --git a/keep.txt b/keep.txt
--- a/keep.txt
+++ b/keep.txt
@@ -1 +1 @@
-a
+b
`
	// rename 段 old 侧命中即保留；段间注记行随裁剪消失
	got := FilterPatchToPaths(patch, []string{"old-name.txt", "keep.txt"})
	if !strings.Contains(got, "rename from old-name.txt") {
		t.Fatalf("rename segment (old side hit) dropped:\n%s", got)
	}
	if !strings.Contains(got, "diff --git a/keep.txt b/keep.txt") {
		t.Fatalf("plain segment dropped:\n%s", got)
	}
	if strings.Contains(got, "untracked file omitted") {
		t.Fatalf("annotation line should vanish with its segment:\n%s", got)
	}
}

func TestFilterPatchToPaths_UnparseableHeaderKept(t *testing.T) {
	// 头行解析失败保守保留（宁多勿漏——行为同修复前整补丁 apply）
	patch := "diff --git malformed\n--- a/x\n+++ b/x\n"
	if got := FilterPatchToPaths(patch, []string{"other.txt"}); got == "" {
		t.Fatal("unparseable header should be kept verbatim")
	}
	// 空输入/空 keep 集恒空
	if FilterPatchToPaths("", []string{"a"}) != "" {
		t.Fatal("empty patch should stay empty")
	}
	if FilterPatchToPaths("diff --git a/x b/x\n", nil) != "" {
		t.Fatal("empty keep set should produce empty patch")
	}
}
