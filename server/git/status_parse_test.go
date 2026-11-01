package git

import "testing"

// parseStatus 未合并行路径解析回归（P-20261003-136）：porcelain v2 'u' 行的
// 路径在三个 40 位 stage hash 之后（Fields 取 parts[10] / 定长前缀 161 字符），
// 此前取 parts[8] 实为第二条 stage hash h2——冲突文件在变更树里显示成裸 SHA。
// 样例行取自真实 git status --porcelain=v2 冲突态输出。
func TestParseStatusUnmergedPath(t *testing.T) {
	const uLine = "u UU N... 100644 100644 100644 100644 " +
		"df967b96a579e45a18b8251732d16804b2e56a55 " +
		"ba2906d0666cf726c7eaadd2cd3db615dedfdf3a " +
		"a7453f07505c42ea8d6fdda75fa91710c81c53d6 conflict.txt"

	files := parseStatus(uLine)
	if len(files) != 1 {
		t.Fatalf("parseStatus(u行) 条数 = %d, want 1", len(files))
	}
	f := files[0]
	if f.Path != "conflict.txt" {
		t.Errorf("Path = %q, want conflict.txt（出现 40 位裸 SHA 说明定长前缀偏移漂移）", f.Path)
	}
	if f.Status != "Unmerged" {
		t.Errorf("Status = %q, want Unmerged", f.Status)
	}
	if f.Staged {
		t.Error("Staged = true, want false（未合并恒不入暂存侧）")
	}
}

// 普通变更/未跟踪行解析不受本次改动影响（line[113:] 与 '?' 分支回归锚）
func TestParseStatusOrdinaryAndUntracked(t *testing.T) {
	// 113 字符定长前缀 + 路径：'1 '+'MM'+' '+'N...'+' '+100644×3+' '+40+40+' '
	ordinary := "1 MM N... 100644 100644 100644 " +
		"df967b96a579e45a18b8251732d16804b2e56a55 " +
		"ba2906d0666cf726c7eaadd2cd3db615dedfdf3a src/main.go"
	files := parseStatus(ordinary)
	if len(files) != 1 || files[0].Path != "src/main.go" || !files[0].Staged || files[0].Status != "Modified" {
		t.Fatalf("parseStatus(普通行) = %+v, want src/main.go staged Modified", files)
	}

	files = parseStatus("? new-file.txt")
	if len(files) != 1 || files[0].Path != "new-file.txt" || files[0].Status != "Untracked" {
		t.Fatalf("parseStatus(未跟踪行) = %+v, want new-file.txt Untracked", files)
	}
}

// rename 行解析回归（2026-10-12 e2e 期实抓）：porcelain v2 '2' 行的首字段恒为
// 字面量 "2"（长度 1），此前取 parts[0][2:4] 切片越界 panic——工作树暂存任何
// 改名（git mv / CommitPanel 暂存改名文件）即令 GetStatus/ListFileTree 全链
// 500（文件树挂 + 服务器异常 toast 风暴）。XY 在第二个字段；样例行取自真实
// git status --porcelain=v2 输出（useNotifBatchSelect→useBatchSelect 改名）。
// 尾二字段的新老路径取法是既有行为，此处不断言方向（Path/OldPath 归属另有
// 存疑，见实施记录），只锁「不再 panic + 正确识别为已暂存 Renamed」
func TestParseStatusRenameEntry(t *testing.T) {
	const rLine = "2 RM N... 100644 100644 100644 " +
		"b75102f0f3c0f6da20429f4e4fcc8b568697cc88 " +
		"b75102f0f3c0f6da20429f4e4fcc8b568697cc88 " +
		"R100 web/src/composables/useBatchSelect.ts\tweb/src/composables/useNotifBatchSelect.ts"

	files := parseStatus(rLine)
	if len(files) != 1 {
		t.Fatalf("parseStatus(2行) 条数 = %d, want 1（此前在此处 panic）", len(files))
	}
	f := files[0]
	if !f.Staged || f.Status != "Renamed" {
		t.Errorf("Staged/Status = %v/%q, want true/Renamed（XY 取自第二字段）", f.Staged, f.Status)
	}
	if f.Path == "" || f.Path == "R100" {
		t.Errorf("Path = %q, want 改名路径之一（不得取到 score 字段）", f.Path)
	}

	// XY 字段异常缩短时防御性返回零值，不再越界
	files = parseStatus("2 R N... 1 2 3 a b R100 p\tq")
	if len(files) != 1 || files[0].Status != "" {
		t.Fatalf("parseStatus(畸形XY行) = %+v, want 零值条目不 panic", files)
	}
}
