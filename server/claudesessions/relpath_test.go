package claudesessions

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// 出域路径相对化（P-20261003-113）单测：改写口径（前缀精确匹配、双分隔形态、
// 裸 root 收敛 "."）+ 误判面（兄弟目录名前缀不命中、非 root 路径保留）+
// JSONL 转义字节层的边界判定（转义分隔符/JSON 串界）与结构无损（合法 JSON、
// 换行保留）

func TestRelativizeText(t *testing.T) {
	cases := []struct {
		name string
		s    string
		root string
		want string
	}{
		{
			name: "反斜杠子路径剥除根前缀",
			s:    `D:\p\src\main.go`,
			root: `D:\p`,
			want: `src\main.go`,
		},
		{
			name: "正斜杠形态（Windows 下 claude 两种都写）",
			s:    "D:/p/docs/plan.md",
			root: `D:\p`,
			want: "docs/plan.md",
		},
		{
			name: "裸 root 到串尾收敛点号",
			s:    `D:\p`,
			root: `D:\p`,
			want: ".",
		},
		{
			name: "多处命中全部改写",
			s:    `对比 D:\p\a.go 与 D:\p\b.go`,
			root: `D:\p`,
			want: `对比 a.go 与 b.go`,
		},
		{
			name: "兄弟目录名前缀不命中（完整路径段前缀才改写）",
			s:    `D:\project\file 与 D:\p-v2\x`,
			root: `D:\p`,
			want: `D:\project\file 与 D:\p-v2\x`,
		},
		{
			name: "root 后随普通字符原样保留",
			s:    `cd D:\p && go test`,
			root: `D:\p`,
			want: `cd D:\p && go test`,
		},
		{
			name: "Unix root 同口径",
			s:    "/home/u/proj/src/a.go 与 /home/u/proj",
			root: "/home/u/proj",
			want: "src/a.go 与 .",
		},
		{
			name: "非项目路径保留（降级不改写）",
			s:    `配置在 C:\elsewhere\cfg.json`,
			root: `D:\p`,
			want: `配置在 C:\elsewhere\cfg.json`,
		},
		{
			name: "root 带尾分隔符归一后同效",
			s:    `D:\p\README.md`,
			root: `D:\p\`,
			want: `README.md`,
		},
		{
			name: "盘根级 root 放弃改写（前缀过泛）",
			s:    `C:\Windows\system32 与 C:\p\x`,
			root: `C:`,
			want: `C:\Windows\system32 与 C:\p\x`,
		},
		{
			name: "root 为空原样返回",
			s:    `D:\p\x`,
			root: "",
			want: `D:\p\x`,
		},
		{
			name: "文本为空原样返回",
			s:    "",
			root: `D:\p`,
			want: "",
		},
		{
			name: "不含 root 的文本原样返回",
			s:    "普通消息，没有路径",
			root: `D:\p`,
			want: "普通消息，没有路径",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RelativizeText(tc.s, tc.root); got != tc.want {
				t.Errorf("RelativizeText(%q, %q) = %q, want %q", tc.s, tc.root, got, tc.want)
			}
		})
	}
}

func TestCopyRelativizedJSONL(t *testing.T) {
	t.Run("cwd 字段与转义子路径改写且结构无损", func(t *testing.T) {
		var src, dst bytes.Buffer
		src.WriteString("{\"type\":\"user\",\"cwd\":\"D:\\\\p\",\"file_path\":\"D:\\\\p\\\\src\\\\a.go\"}\n")
		src.WriteString(`{"type":"assistant","text":"改 D:/p/docs/plan.md"}` + "\n")
		src.WriteString(`{"type":"tail","quote":"D:\\p"}`) // 末行无换行
		if _, err := CopyRelativizedJSONL(&dst, &src, `D:\p`); err != nil {
			t.Fatal(err)
		}
		got := dst.String()
		for _, want := range []string{`"cwd":"."`, `"file_path":"src\\a.go"`, `"text":"改 docs/plan.md"`, `"quote":"."`} {
			if !strings.Contains(got, want) {
				t.Errorf("output missing %q:\n%s", want, got)
			}
		}
		if strings.Contains(got, "D:\\\\p") || strings.Contains(got, "D:/p") {
			t.Errorf("output still contains project root:\n%s", got)
		}
		// 结构无损：逐行仍是合法 JSON，行数与换行原样（末行原本无换行）
		lines := strings.Split(got, "\n")
		for i, line := range lines {
			if line == "" {
				continue // 末行无换行时 Split 产出的尾空段
			}
			if !json.Valid([]byte(line)) {
				t.Errorf("line %d not valid JSON: %q", i, line)
			}
		}
		if n := strings.Count(got, "\n"); n != 2 {
			t.Errorf("newline count = %d, want 2 (换行结构原样)", n)
		}
		if !strings.HasSuffix(got, `"."}`) {
			t.Errorf("末行无换行的形态被破坏: %q", got)
		}
	})
	t.Run("JSON 串界是裸 root 边界", func(t *testing.T) {
		var src, dst bytes.Buffer
		src.WriteString(`{"cwd":"D:\\p"}`)
		if _, err := CopyRelativizedJSONL(&dst, &src, `D:\p`); err != nil {
			t.Fatal(err)
		}
		if got := dst.String(); got != `{"cwd":"."}` {
			t.Errorf("got %q, want {\"cwd\":\".\"}", got)
		}
	})
	t.Run("转义引号不是分隔符（\\\" 不得被当 \\ 吃掉）", func(t *testing.T) {
		var src, dst bytes.Buffer
		src.WriteString(`{"p":"D:\\p\""}`) // 内容 = D:\p"（root 后随引号，非分隔符）
		if _, err := CopyRelativizedJSONL(&dst, &src, `D:\p`); err != nil {
			t.Fatal(err)
		}
		if got := dst.String(); got != `{"p":"D:\\p\""}` {
			t.Errorf("got %q, want unchanged", got)
		}
	})
	t.Run("兄弟目录名前缀保留", func(t *testing.T) {
		var src, dst bytes.Buffer
		src.WriteString(`{"p":"D:\\project\\a"}`)
		if _, err := CopyRelativizedJSONL(&dst, &src, `D:\p`); err != nil {
			t.Fatal(err)
		}
		if got := dst.String(); got != `{"p":"D:\\project\\a"}` {
			t.Errorf("got %q, want unchanged", got)
		}
	})
	t.Run("Unix root（无转义形态）同口径", func(t *testing.T) {
		var src, dst bytes.Buffer
		src.WriteString("{\"cwd\":\"/home/u/proj\",\"f\":\"/home/u/proj/src/a.go\"}")
		if _, err := CopyRelativizedJSONL(&dst, &src, "/home/u/proj"); err != nil {
			t.Fatal(err)
		}
		want := `{"cwd":".","f":"src/a.go"}`
		if got := dst.String(); got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
	t.Run("root 不可用退化为直通拷贝", func(t *testing.T) {
		payload := "{\"a\":\"D:\\\\p\"}\n{\"b\":2}\n"
		for _, root := range []string{"", "C:"} { // 空 / 盘根级
			var src, dst bytes.Buffer
			src.WriteString(payload)
			if _, err := CopyRelativizedJSONL(&dst, &src, root); err != nil {
				t.Fatal(err)
			}
			if got := dst.String(); got != payload {
				t.Errorf("root=%q: got %q, want identity copy", root, got)
			}
		}
	})
}

// 出域敏感扫描挂点在改写链下游（P-20261004-113）：ScanRelativizedJSONL 回吐的
// 是「已经剥掉 root 前缀」的字节——扫描看到的即最终出域内容，root 本身在当前
// 行被改写掉后不再出现在扫描输入里（防「扫源文件」与「出改写后文件」的口径
// 分叉）；root 不可用时按原样直通（与拷贝链同口径）。
func TestScanRelativizedJSONL_ScansRewrittenBytes(t *testing.T) {
	t.Run("改写后回吐", func(t *testing.T) {
		root := `D:\secrets\project`
		line1, _ := json.Marshal(map[string]string{"cwd": root, "f": root + `\docs\plan.md`})
		line2, _ := json.Marshal(map[string]string{"cwd": root})
		payload := string(line1) + "\n" + string(line2) + "\n"
		var got bytes.Buffer
		if err := ScanRelativizedJSONL(strings.NewReader(payload), root, func(line []byte) {
			got.Write(line)
		}); err != nil {
			t.Fatal(err)
		}
		out := got.String()
		if strings.Contains(out, "secrets") || strings.Contains(out, `D:\\`) {
			t.Fatalf("scan input still contains rewritten root: %q", out)
		}
		if !strings.Contains(out, `"cwd":"."`) {
			t.Fatalf("scan input missing relativized cwd: %q", out)
		}
		// 与拷贝链产出一致（同一改写真子）
		var copied bytes.Buffer
		if _, err := CopyRelativizedJSONL(&copied, strings.NewReader(payload), root); err != nil {
			t.Fatal(err)
		}
		if copied.String() != out {
			t.Fatalf("scan bytes %q != copy bytes %q", out, copied.String())
		}
	})
	t.Run("root 不可用直通", func(t *testing.T) {
		payload := `{"a":"x"}` + "\n"
		var got bytes.Buffer
		if err := ScanRelativizedJSONL(strings.NewReader(payload), "", func(line []byte) {
			got.Write(line)
		}); err != nil {
			t.Fatal(err)
		}
		if got.String() != payload {
			t.Fatalf("got %q, want passthrough", got.String())
		}
	})
	t.Run("空输入", func(t *testing.T) {
		called := false
		if err := ScanRelativizedJSONL(strings.NewReader(""), `D:\p`, func([]byte) { called = true }); err != nil {
			t.Fatal(err)
		}
		if called {
			t.Fatal("onLine called for empty input")
		}
	})
}
