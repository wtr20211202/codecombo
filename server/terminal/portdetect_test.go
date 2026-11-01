package terminal

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// dev 端口被动探测（P-20261002-83）单测：模式命中 / 防抖 / 预筛跳过 / 端口范围
// 过滤 / 滑窗滚动。用例经 collectHits 挂 OnDevPortDetected 收集命中，测试结束复位

// collectHits 挂钩子收集命中，返回收集切片（条目形如 "label:sessionID|port"）
func collectHits(t *testing.T) *[]string {
	t.Helper()
	hits := &[]string{}
	prev := OnDevPortDetected
	OnDevPortDetected = func(sessionID string, port int, label string) {
		*hits = append(*hits, label+":"+sessionID+"|"+strconv.Itoa(port))
	}
	t.Cleanup(func() { OnDevPortDetected = prev })
	return hits
}

func TestDevPortDetect_PatternHits(t *testing.T) {
	hits := collectHits(t)
	cases := []struct {
		name      string
		chunks    []string // 依次 feed 的输出片段（可拆块模拟跨包到达）
		wantLabel string
		wantPort  string
	}{
		{
			name: "Vite 启动横幅（着色，ready in 与 Local: 两行）",
			chunks: []string{"\x1b[32m  VITE v5.4.8  \x1b[36mready in 312 ms\x1b[0m\n",
				"\n  \x1b[36m➜  Local\x1b[0m:   \x1b[36mhttp://localhost:5173/\x1b[0m\n"},
			wantLabel: "vite",
			wantPort:  "5173",
		},
		{
			name:      "Next.js Ready on",
			chunks:    []string{"  ▲ Next.js 14.1.0\n  ✓ Ready on http://localhost:3000\n"},
			wantLabel: "next",
			wantPort:  "3000",
		},
		{
			name:      "webpack-dev-server running at（无 on 字样）",
			chunks:    []string{"Project is running at http://localhost:8080/\nwebpack: Compiled successfully.\n"},
			wantLabel: "webpack",
			wantPort:  "8080",
		},
		{
			name:      "CRA Local: 文案（通用模式，不断言工具 → 无 label）",
			chunks:    []string{"Starting the development server...\nCompiled successfully!\n\n  Local:            http://localhost:3000/\n"},
			wantLabel: "",
			wantPort:  "3000",
		},
		{
			name:      "gin Listening and serving HTTP on :8080（关键词与 on 之间有中缀）",
			chunks:    []string{"[GIN-debug] Listening and serving HTTP on :8080\n"},
			wantLabel: "",
			wantPort:  "8080",
		},
		{
			name:      "go run 裸端口 listening on 0.0.0.0:9000",
			chunks:    []string{"server listening on 0.0.0.0:9000\n"},
			wantLabel: "",
			wantPort:  "9000",
		},
		{
			name:      "跨包到达：URL 拆在两次 feed 之间（滑窗聚合命中）",
			chunks:    []string{"listening on http://local", "host:5174\n"},
			wantLabel: "",
			wantPort:  "5174",
		},
		{
			name:      "着色割裂单词与 URL（CSI 剥除后命中）",
			chunks:    []string{"\x1b[36mLocal:\x1b[0m \x1b[36mhttp://localhost:5175\x1b[0m\n"},
			wantLabel: "",
			wantPort:  "5175",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			*hits = nil
			d := newDevPortDetector("term-1")
			for _, c := range tc.chunks {
				d.feed([]byte(c))
			}
			if len(*hits) != 1 {
				t.Fatalf("应命中 1 次，得到 %v", *hits)
			}
			if got := (*hits)[0]; !strings.HasSuffix(got, "|"+tc.wantPort) || !strings.HasPrefix(got, tc.wantLabel+":") {
				t.Fatalf("命中应为 label=%q port=%q，得到 %q", tc.wantLabel, tc.wantPort, got)
			}
		})
	}
}

func TestDevPortDetect_OSCTitleNotMatched(t *testing.T) {
	// OSC 终端标题（shell 常设 Local: 形态文案）不参与端口匹配
	//（P-20261005-8）：修复前滑窗只剥 CSI，标题原文留在匹配面、URL 模式命中
	// 即误报；修复后 OSC 整段剥除不触发。预筛关键词（"local"）在标题里存在、
	// 照常放行进模式匹配——本用例证明防住它的是 OSC 剥离而非预筛。
	// 正文横幅照常命中（探测活性不因剥离面扩大而受损）
	hits := collectHits(t)
	d := newDevPortDetector("term-1")

	d.feed([]byte("\x1b]0;user@host: ~/app — Local: http://localhost:7777/\x07"))
	if len(*hits) != 0 {
		t.Fatalf("OSC 标题里的 URL 不应触发端口探测，得到 %v", *hits)
	}

	d.feed([]byte("\x1b[36m➜  Local:\x1b[0m \x1b[36mhttp://localhost:5173/\x1b[0m\n"))
	if len(*hits) != 1 || !strings.HasSuffix((*hits)[0], "|5173") {
		t.Fatalf("正文横幅应照常命中 5173，得到 %v", *hits)
	}
}

func TestDevPortDetect_PreFilterSkips(t *testing.T) {
	hits := collectHits(t)
	d := newDevPortDetector("term-1")

	// 大流量输出（下载进度/二进制乱码/构建日志）不含任何预筛关键词 → 正则整体跳过、零命中
	for _, junk := range []string{
		strings.Repeat("downloading pkg-1.tgz [=====>   ] 55%\n", 100),
		"\x00\x01\x02\xff\xfe random binary \xdb\xdb\n",
		"SCSS deprecation warnings, 200 lines of sass noise\n",
	} {
		d.feed([]byte(junk))
	}
	if len(*hits) != 0 {
		t.Fatalf("无关键词输出不应命中，得到 %v", *hits)
	}

	// 预筛本身：ASCII 不区分大小写（gin "Listening" / 横幅 "LOCAL" 同样放行）
	if !asciiContainsFold([]byte("... [GIN-debug] Listening and serving ..."), "listening") {
		t.Fatal("Listening 应命中关键词 listening（大小写不敏感）")
	}
	if !asciiContainsFold([]byte("  LOCAL:  http://localhost:5173"), "local") {
		t.Fatal("LOCAL 应命中关键词 local")
	}
	if asciiContainsFold([]byte("全是中文输出，没有 ascii 关键词"), "ready") {
		t.Fatal("不含关键词的文本不应命中")
	}
	if asciiContainsFold([]byte("rea"), "ready") {
		t.Fatal("短于关键词的文本不应命中")
	}
}

func TestDevPortDetect_Debounce(t *testing.T) {
	hits := collectHits(t)
	d := newDevPortDetector("term-1")
	d.debounce = 40 * time.Millisecond // 注入短窗口验证过期再报

	// 同端口窗口内重复命中（横幅常驻滑窗、滚动重扫）→ 只报一次
	d.feed([]byte("listening on :4173\n"))
	d.feed([]byte("listening on :4173\n"))
	d.feed([]byte("Local: http://localhost:4173/\n")) // 换模式同端口，仍在防抖窗
	if n := len(*hits); n != 1 {
		t.Fatalf("防抖窗内同端口应只报 1 次，得到 %d 次", n)
	}

	// 不同端口不受防抖影响
	d.feed([]byte("listening on :4174\n"))
	if n := len(*hits); n != 2 {
		t.Fatalf("不同端口应正常上报，得到 %d 次", n)
	}

	// 防抖窗过期后同端口可再报（服务重启复用端口的真实形态）
	time.Sleep(60 * time.Millisecond)
	d.feed([]byte("listening on :4173\n"))
	if n := len(*hits); n != 3 {
		t.Fatalf("防抖过期后同端口应再报，得到 %d 次", n)
	}
}

func TestDevPortDetect_PortRangeFilter(t *testing.T) {
	hits := collectHits(t)
	d := newDevPortDetector("term-1")

	// 特权段 / 越界 / 时间戳片段：模式可匹配但范围过滤挡下，且应继续尝试（不中断）
	d.feed([]byte("listening on :80\nlistening on :99999\nbuild finished at 12:30\nstarted on 2026-10-03 08:00:00\n"))
	if len(*hits) != 0 {
		t.Fatalf("非法端口/时间戳片段不应上报，得到 %v", *hits)
	}
	// 同一批输出末尾追加合法端口：范围过滤未中断后续模式的尝试
	d.feed([]byte("listening on :5173\n"))
	if len(*hits) != 1 {
		t.Fatalf("合法端口应上报，得到 %v", *hits)
	}
}

func TestDevPortDetect_WindowCap(t *testing.T) {
	hits := collectHits(t)
	d := newDevPortDetector("term-1")

	// 先灌入超窗量的无关键词输出（按行，模拟真实构建日志），再给命中文案：
	// 滑窗只保尾部，仍能命中
	d.feed([]byte(strings.Repeat("compiling module ...\n", devPortWindowCap/10)))
	d.feed([]byte("listening on :4321\n"))
	if len(*hits) != 1 {
		t.Fatalf("滑窗滚动后命中不应丢失，得到 %v", *hits)
	}
	if len(d.window) > devPortWindowCap {
		t.Fatalf("窗口应不超过 %d 字节，得到 %d", devPortWindowCap, len(d.window))
	}
}

func TestDevPortDetect_HookNilSafe(t *testing.T) {
	prev := OnDevPortDetected
	OnDevPortDetected = nil
	t.Cleanup(func() { OnDevPortDetected = prev })

	d := newDevPortDetector("term-1")
	d.feed([]byte("listening on :3000\n")) // 不应 panic；探测状态照常推进
	if _, ok := d.lastHit[3000]; !ok {
		t.Fatal("钩子为空时探测状态仍应记录命中（保证注册时机晚不丢防抖）")
	}
}

func TestDevPortDetect_MultiByteSafeTrim(t *testing.T) {
	// 滑窗裁剪越过 UTF-8 字符边界不越裁进关键词（中文日志 + 端口文案混排）
	hits := collectHits(t)
	d := newDevPortDetector("term-1")
	d.feed([]byte(strings.Repeat("构建输出：依赖解析完成，共 3 项", 200))) // 多字节填窗触发裁剪
	d.feed([]byte("listening on :7080\n"))
	if len(*hits) != 1 {
		t.Fatalf("多字节内容后仍应命中，得到 %v", *hits)
	}
}
