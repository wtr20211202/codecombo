package git

import (
	"strings"
	"testing"
)

func TestTruncateDiff(t *testing.T) {
	small := "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"
	if got := truncateDiff(small); got != small {
		t.Fatal("within limit should pass through")
	}

	// 超限：5MB 边界 + 标记
	huge := strings.Repeat("+x\n", 4*1024*1024) // 12MB
	got := truncateDiff(huge)
	if len(got) > MaxDiffOutput+128 {
		t.Fatalf("truncated output too large: %d", len(got))
	}
	if !strings.Contains(got, "[diff truncated") {
		t.Fatal("truncation marker missing")
	}
}

func TestMaxDiffOutput_Default(t *testing.T) {
	if MaxDiffOutput != 5*1024*1024 {
		t.Fatalf("MaxDiffOutput = %d", MaxDiffOutput)
	}
}
