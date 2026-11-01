package compareexp

// 未跟踪新文件的 diff 合成（P-20261003-46 对比数据面）：git diff 不含 untracked，
// 「基线 vs 侧产出」对新建文件需要读文件自造 new-file unified diff，让前端
// DiffViewer 走同一渲染路径。合成只读不写（车道 3 对等读：用户工作区文件，
// 不镜像不缓存）。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// untrackedReadCap 单文件读取上限（字节）：超出截断并在 diff 尾部注明——
	// 对比视图是扫读面，超大产物的全量行渲染前端吃不消（git 侧大 diff 已有
	// MaxDiffOutput 同款护栏，此处对齐语义）
	untrackedReadCap = 1 << 20
	// binaryProbeLen 二进制嗅探窗口：首窗口出现 NUL 字节即按二进制处理
	//（git diff 同口径，输出 "Binary files ... differ" 一行说明）
	binaryProbeLen = 8000
)

// untrackedFileDiff 把未跟踪新文件合成为 new-file unified diff（/dev/null → 文件）。
// 文件不可读/超限截断时如实呈现；路径穿越已由调用方校验，此处仅做目录内拼装
func untrackedFileDiff(dir, file string) (string, error) {
	abs := filepath.Join(dir, filepath.FromSlash(file))
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("read untracked file: %w", err)
	}
	head := data
	if len(head) > binaryProbeLen {
		head = head[:binaryProbeLen]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\n", file, file)
	fmt.Fprintf(&b, "new file mode 100644\n")
	if isBinary(head) {
		fmt.Fprintf(&b, "Binary files /dev/null and b/%s differ\n", file)
		return b.String(), nil
	}
	truncated := false
	if len(data) > untrackedReadCap {
		data = data[:untrackedReadCap]
		truncated = true
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	// 尾部换行产生的空尾行不是内容行（git diff 同口径）
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	fmt.Fprintf(&b, "--- /dev/null\n+++ b/%s\n", file)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteByte('+')
		b.WriteString(line)
		b.WriteByte('\n')
	}
	if truncated {
		b.WriteString("...[diff truncated: file exceeds 1MB read cap]\n")
	}
	return b.String(), nil
}

// isBinary 首窗口 NUL 字节嗅探（git heuristics 同款）
func isBinary(head []byte) bool {
	for _, b := range head {
		if b == 0 {
			return true
		}
	}
	return false
}
