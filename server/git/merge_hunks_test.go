package git

import (
	"strings"
	"testing"
)

// 逐块冲突解析（P-20261003-59）：正常分段 / 复杂形态降级 / 行号写回契约

func TestParseConflictHunksTwoBlocks(t *testing.T) {
	content := strings.Join([]string{
		"line01: shared",
		"<<<<<<< HEAD",
		"value = main",
		"=======",
		"value = feature",
		">>>>>>> feature",
		"line03: shared",
		"line04: shared",
		"line05: shared",
		"line06: shared",
		"line07: shared",
		"line08: shared",
		"<<<<<<< HEAD",
		"flag = main",
		"=======",
		"flag = feature",
		">>>>>>> feature",
		"line10: shared",
	}, "\n")

	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("expected ok=true for plain two-hunk conflict")
	}
	if len(hunks) != 2 {
		t.Fatalf("expected 2 hunks, got %d", len(hunks))
	}
	if hunks[0].Ours != "value = main" || hunks[0].Theirs != "value = feature" {
		t.Errorf("hunk0 sections wrong: ours=%q theirs=%q", hunks[0].Ours, hunks[0].Theirs)
	}
	if hunks[0].StartLine != 2 || hunks[0].EndLine != 6 {
		t.Errorf("hunk0 lines wrong: %d-%d, want 2-6", hunks[0].StartLine, hunks[0].EndLine)
	}
	if hunks[1].Ours != "flag = main" || hunks[1].Theirs != "flag = feature" {
		t.Errorf("hunk1 sections wrong: ours=%q theirs=%q", hunks[1].Ours, hunks[1].Theirs)
	}
	if hunks[1].StartLine != 13 || hunks[1].EndLine != 17 {
		t.Errorf("hunk1 lines wrong: %d-%d, want 13-17", hunks[1].StartLine, hunks[1].EndLine)
	}
	if hunks[0].Base != "" || hunks[1].Base != "" {
		t.Errorf("base should stay empty for two-way conflicts, got %q/%q", hunks[0].Base, hunks[1].Base)
	}
}

func TestParseConflictHunksEmptySections(t *testing.T) {
	// 某侧删空是合法冲突形态（如双方同改一行、一方整段删除）
	content := "<<<<<<< HEAD\n=======\nadded by them\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("expected ok=true for empty-ours hunk")
	}
	if len(hunks) != 1 || hunks[0].Ours != "" || hunks[0].Theirs != "added by them" {
		t.Fatalf("unexpected hunks: %+v", hunks)
	}

	content2 := "<<<<<<< HEAD\nkept by us\n=======\n>>>>>>> feature\n"
	hunks2, ok2 := ParseConflictHunks(content2)
	if !ok2 {
		t.Fatal("expected ok=true for empty-theirs hunk")
	}
	if len(hunks2) != 1 || hunks2[0].Ours != "kept by us" || hunks2[0].Theirs != "" {
		t.Fatalf("unexpected hunks2: %+v", hunks2)
	}
}

func TestParseConflictHunksMultiLineSections(t *testing.T) {
	content := "<<<<<<< HEAD\nours a\nours b\n=======\ntheirs a\ntheirs b\ntheirs c\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok || len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, ok=%v len=%d", ok, len(hunks))
	}
	if hunks[0].Ours != "ours a\nours b" || hunks[0].Theirs != "theirs a\ntheirs b\ntheirs c" {
		t.Fatalf("sections wrong: %+v", hunks[0])
	}
}

func TestParseConflictHunksCRLF(t *testing.T) {
	// CRLF 文件：标记行尾带 \r，须照常识别（写回契约：行号按 \n 切分仍对齐）
	content := "<<<<<<< HEAD\r\nours line\r\n=======\r\ntheirs line\r\n>>>>>>> feature\r\nlast\r\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("expected ok=true for CRLF conflict")
	}
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	// 段正文保留原始 \r（忠实磁盘字节，写回不引入换行符漂移）
	if hunks[0].Ours != "ours line\r" {
		t.Errorf("ours wrong: %q", hunks[0].Ours)
	}
	if hunks[0].Theirs != "theirs line\r" {
		t.Errorf("theirs wrong: %q", hunks[0].Theirs)
	}
	// `>>>>>>>` 在第 5 行（\r 只是行尾字节，不影响 \n 计数）
	if hunks[0].StartLine != 1 || hunks[0].EndLine != 5 {
		t.Errorf("lines wrong: %d-%d, want 1-5", hunks[0].StartLine, hunks[0].EndLine)
	}
}

func TestParseConflictHunksNoMarkers(t *testing.T) {
	hunks, ok := ParseConflictHunks("no markers here\njust text\n")
	if !ok {
		t.Fatal("marker-less content is structurally valid (not complex)")
	}
	if len(hunks) != 0 {
		t.Fatalf("expected 0 hunks, got %d", len(hunks))
	}
}

func TestParseConflictHunksDiff3Base(t *testing.T) {
	// diff3（P-20261004-28）：||||||| 引出的基准段解析进 Base，ours/theirs 语义不变
	content := strings.Join([]string{
		"line01: shared",
		"<<<<<<< HEAD",
		"value = main",
		"||||||| merged common ancestors",
		"value = base",
		"=======",
		"value = feature",
		">>>>>>> feature",
		"line03: shared",
	}, "\n")
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("diff3 form is parseable per-hunk since P-20261004-28")
	}
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	h := hunks[0]
	if h.Ours != "value = main" || h.Theirs != "value = feature" || h.Base != "value = base" {
		t.Fatalf("sections wrong: ours=%q theirs=%q base=%q", h.Ours, h.Theirs, h.Base)
	}
	// 行区间仍覆盖全部 5 行标记结构（写回 splice 按此整体剔除）
	if h.StartLine != 2 || h.EndLine != 8 {
		t.Errorf("lines wrong: %d-%d, want 2-8", h.StartLine, h.EndLine)
	}
}

func TestParseConflictHunksDiff3CRLF(t *testing.T) {
	// CRLF：标记行尾带 \r——分隔线剥 \r 后比较、||||||| 前缀匹配，基准段照常识别
	content := "<<<<<<< HEAD\r\nours\r\n||||||| base\r\nbase line\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("CRLF diff3 form should parse")
	}
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	if hunks[0].Ours != "ours\r" || hunks[0].Base != "base line\r" || hunks[0].Theirs != "theirs\r" {
		t.Fatalf("sections wrong: %+v", hunks[0])
	}
	if hunks[0].StartLine != 1 || hunks[0].EndLine != 7 {
		t.Errorf("lines wrong: %d-%d, want 1-7", hunks[0].StartLine, hunks[0].EndLine)
	}
}

func TestParseConflictHunksDiff3EmptyBase(t *testing.T) {
	// base 段合法为空：zdiff3 把两侧共同行外提后基准区无剩余行（git 2.45 实证形态）
	content := "<<<<<<< HEAD\nX\n||||||| 3913749\n=======\nY\n>>>>>>> feature\nCOMMON\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("empty base section is a legal diff3/zdiff3 form")
	}
	if len(hunks) != 1 || hunks[0].Ours != "X" || hunks[0].Theirs != "Y" || hunks[0].Base != "" {
		t.Fatalf("unexpected hunks: %+v", hunks)
	}
	// 外提到标记外的 COMMON 是普通上下文行，不进任何段
	if hunks[0].StartLine != 1 || hunks[0].EndLine != 6 {
		t.Errorf("lines wrong: %d-%d, want 1-6", hunks[0].StartLine, hunks[0].EndLine)
	}
}

func TestParseConflictHunksZdiff3ZealousBase(t *testing.T) {
	// zdiff3 zealotry 形态（git 2.45 实证）：基准段含与 ours 重复的行——
	// ours/theirs/base 各自独立成段，互不串
	content := "<<<<<<< HEAD\nMAIN-A\nMAIN-B\n||||||| 1dca785\nMAIN-A\nline-b\nMAIN-B\n=======\nline-a\nFEATURE-A\n>>>>>>> feature2\nshared-tail\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("zdiff3 zealous form should parse")
	}
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	if hunks[0].Ours != "MAIN-A\nMAIN-B" {
		t.Errorf("ours wrong: %q", hunks[0].Ours)
	}
	if hunks[0].Base != "MAIN-A\nline-b\nMAIN-B" {
		t.Errorf("base wrong: %q", hunks[0].Base)
	}
	if hunks[0].Theirs != "line-a\nFEATURE-A" {
		t.Errorf("theirs wrong: %q", hunks[0].Theirs)
	}
}

func TestParseConflictHunksDiff3AnnotatedBase(t *testing.T) {
	// 定制注解行（#### 前缀，外部合并工具惯例而非 git 原生输出）落在基准段内：
	// 按普通基准段内容收进 Base，不破坏解析
	content := "<<<<<<< HEAD\nours\n||||||| base\n#### ancestor version\nbase line\n=======\ntheirs\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("annotated base section should parse")
	}
	if len(hunks) != 1 || hunks[0].Base != "#### ancestor version\nbase line" {
		t.Fatalf("unexpected hunks: %+v", hunks)
	}
}

func TestParseConflictHunksDiff3UnclosedDegrades(t *testing.T) {
	// 基准段打开后 EOF（文件截断）：未闭合，降级
	content := "<<<<<<< HEAD\nours\n||||||| base\nbase line\n=======\ntheirs\n" // EOF 前无 >>>>>>>
	hunks, ok := ParseConflictHunks(content)
	if ok {
		t.Fatal("unclosed diff3 hunk must degrade (ok=false)")
	}
	if hunks != nil {
		t.Fatalf("degraded parse must return nil hunks, got %+v", hunks)
	}
}

func TestParseConflictHunksDiff3NestedBaseDegrades(t *testing.T) {
	// 基准段内嵌套 <<<<<<<：不可信形态，降级
	content := "<<<<<<< HEAD\nours\n||||||| base\n<<<<<<< inner\nx\n=======\ny\n>>>>>>> inner\n=======\ntheirs\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if ok {
		t.Fatal("nested marker inside base must degrade (ok=false)")
	}
	if hunks != nil {
		t.Fatalf("degraded parse must return nil hunks, got %+v", hunks)
	}
}

func TestParseConflictHunksDoubleBaseDegrades(t *testing.T) {
	// 计数异常：一个块内两个 |||||||（git 任何 conflictStyle 都不产出），降级
	content := "<<<<<<< HEAD\nours\n||||||| a\nbase a\n||||||| b\nbase b\n=======\ntheirs\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if ok {
		t.Fatal("double base marker must degrade (ok=false)")
	}
	if hunks != nil {
		t.Fatalf("degraded parse must return nil hunks, got %+v", hunks)
	}
}

func TestParseConflictHunksBaseAfterSeparatorDegrades(t *testing.T) {
	// 顺序异常：||||||| 出现在分隔线之后（他方段内）。任何 git conflictStyle
	// 都不产出该形态——旧解析静默吞进 theirs 正文属误解析，改为降级
	content := "<<<<<<< HEAD\na\n=======\nb\n||||||| base\nc\n>>>>>>> x\n"
	hunks, ok := ParseConflictHunks(content)
	if ok {
		t.Fatal("||||||| after ======= must degrade (ok=false)")
	}
	if hunks != nil {
		t.Fatalf("degraded parse must return nil hunks, got %+v", hunks)
	}
}

func TestParseConflictHunksNestedDegrades(t *testing.T) {
	content := "<<<<<<< HEAD\nours top\n<<<<<<< inner\ninner ours\n=======\ninner theirs\n>>>>>>> inner\n=======\ntheirs top\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if ok {
		t.Fatal("nested markers must degrade (ok=false)")
	}
	if hunks != nil {
		t.Fatalf("degraded parse must return nil hunks, got %+v", hunks)
	}
}

func TestParseConflictHunksUnterminatedDegrades(t *testing.T) {
	content := "<<<<<<< HEAD\nours\n=======\ntheirs\n" // EOF 前无 >>>>>>>（文件截断）
	hunks, ok := ParseConflictHunks(content)
	if ok {
		t.Fatal("unterminated hunk must degrade (ok=false)")
	}
	if hunks != nil {
		t.Fatalf("degraded parse must return nil hunks, got %+v", hunks)
	}
}

func TestParseConflictHunksRuleLineNotSeparator(t *testing.T) {
	// 正文里的长 ==== 规则线（markdown 分隔线等）不是分隔标记——分隔须恰为 7 个 =
	content := "<<<<<<< HEAD\nheading\n================================\nbody\n=======\ntheirs heading\n>>>>>>> feature\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok {
		t.Fatal("expected ok=true: long rule line must not terminate ours section")
	}
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	if hunks[0].Ours != "heading\n================================\nbody" {
		t.Errorf("ours wrong: %q", hunks[0].Ours)
	}
	if hunks[0].Theirs != "theirs heading" {
		t.Errorf("theirs wrong: %q", hunks[0].Theirs)
	}
}

// 写回契约：按 [StartLine, EndLine] 行区间替换（含两端标记行）后不得残留 marker
func TestParseConflictHunksRangeCoversMarkers(t *testing.T) {
	content := "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nb\nc\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok || len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, ok=%v", ok)
	}
	lines := strings.Split(content, "\n")
	// 模拟前端合成：删除标记区间（1-based → 0-based），替换为 ours 段
	spliced := append(append([]string{}, lines[:hunks[0].StartLine-1]...), "ours")
	spliced = append(spliced, lines[hunks[0].EndLine:]...)
	merged := strings.Join(spliced, "\n")
	if strings.Contains(merged, "<<") || strings.Contains(merged, "======") || strings.Contains(merged, ">>>") {
		t.Fatalf("marker residue after range splice: %q", merged)
	}
	// 末行 \n 使 split 产生尾空串——拼接后保留文件的尾换行
	if merged != "a\nours\nb\nc\n" {
		t.Fatalf("splice result wrong: %q", merged)
	}
}

// 写回契约（diff3 形态）：行区间含全部 5 行标记结构，任取一侧替换后不得残留
// marker 或 base 段（P-20261004-28）
func TestParseConflictHunksRangeCoversMarkersDiff3(t *testing.T) {
	content := "a\n<<<<<<< HEAD\nours\n||||||| base\nbase line\n=======\ntheirs\n>>>>>>> feature\nb\n"
	hunks, ok := ParseConflictHunks(content)
	if !ok || len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, ok=%v", ok)
	}
	lines := strings.Split(content, "\n")
	spliced := append(append([]string{}, lines[:hunks[0].StartLine-1]...), "theirs")
	spliced = append(spliced, lines[hunks[0].EndLine:]...)
	merged := strings.Join(spliced, "\n")
	if strings.Contains(merged, "<<") || strings.Contains(merged, "======") || strings.Contains(merged, ">>>") || strings.Contains(merged, "||||") {
		t.Fatalf("marker/base residue after range splice: %q", merged)
	}
	if merged != "a\ntheirs\nb\n" {
		t.Fatalf("splice result wrong: %q", merged)
	}
}
