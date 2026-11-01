package git

import (
	"reflect"
	"testing"
)

// PatchHeaderPaths 补丁导出族出域敏感扫描（P-20261004-97）的路径提取面：
// 裸/引用形态、rename 两侧、非 diff 行忽略。ParsePatchFiles 只服务展示面
// （裸形态 b/ 侧），这里要对出域判定覆盖更全（宁多勿漏）
func TestPatchHeaderPaths(t *testing.T) {
	content := "" +
		"diff --git a/main.go b/main.go\n" +
		"index 111..222 100644\n" +
		"--- a/main.go\n" +
		"+++ b/main.go\n" +
		"@@ -1 +1 @@\n" +
		"-a\n" +
		"+b\n" +
		"diff --git \"a/config/.env prod\" \"b/config/.env prod\"\n" + // 引用形态：路径含空格
		"new file mode 100644\n" +
		"diff --git a/old name.txt b/new name.txt\n" + // 裸形态多空格：git 真实输出对含空格路径恒走引用形态，此处只验证不炸（碎片化宁多勿漏）
		"similarity index 90%\n" +
		"rename from old name.txt\n" +
		"rename to new name.txt\n" +
		"...[untracked file omitted from patch: oversized.bin]\n" // 段间注记行：忽略
	got := PatchHeaderPaths(content)
	// 裸形态碎片（old/name.txt/new）是多空格行的 Fields 切分产物：出域匹配
	// 只会对碎片名单多查一遍 basename，过匹配可接受（确认闸，宁多勿漏）
	want := []string{"main.go", "config/.env prod", "old", "name.txt", "new"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PatchHeaderPaths = %#v, want %#v", got, want)
	}

	if out := PatchHeaderPaths(""); out != nil {
		t.Fatalf("empty content = %#v, want nil", out)
	}

	// rename 段两侧都提取（old 命中敏感名同样要警示——补丁携带其历史内容）
	got = PatchHeaderPaths("diff --git a/.env.local b/renamed.env.local\nrename from .env.local\n")
	if !reflect.DeepEqual(got, []string{".env.local", "renamed.env.local"}) {
		t.Fatalf("rename both sides = %#v", got)
	}
}
