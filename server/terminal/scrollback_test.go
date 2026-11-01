package terminal

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestScrollbackBuffer_EmptySnapshot(t *testing.T) {
	b := NewScrollback()
	if got := b.Snapshot(100); got != nil {
		t.Fatalf("空缓冲 Snapshot 应返回 nil，得到 %v", got)
	}
}

func TestScrollbackBuffer_WriteAndSnapshotAll(t *testing.T) {
	b := NewScrollback()
	b.Write([]byte("hello\nworld\n"))
	got := b.Snapshot(0)
	if !bytes.Equal(got, []byte("hello\nworld\n")) {
		t.Fatalf("Snapshot(0) 应返回全部内容，得到 %q", got)
	}
}

func TestScrollbackBuffer_SnapshotByLines(t *testing.T) {
	b := NewScrollback()
	b.Write([]byte("line1\nline2\nline3\nline4\n"))

	// 最近 2 行：应包含 line3、line4（含起始的 line3 前一个 \n 后的内容）
	got := b.Snapshot(2)
	s := string(got)
	if !strings.HasSuffix(s, "line3\nline4\n") {
		t.Fatalf("Snapshot(2) 应以 line3\\nline4\\n 结尾，得到 %q", s)
	}
	if strings.Contains(s, "line1") || strings.Contains(s, "line2") {
		t.Fatalf("Snapshot(2) 不应包含最早两行，得到 %q", s)
	}
}

func TestScrollbackBuffer_Overflow(t *testing.T) {
	b := NewScrollback()
	// 缩小缓冲容量方便测试绕回逻辑
	b.ring = make([]byte, 10)
	b.start = 0
	b.length = 0

	b.Write([]byte("0123456789ABCDEF")) // 16 字节，超出 10
	got := b.Snapshot(0)
	if len(got) != 10 {
		t.Fatalf("超限后应保留最近 10 字节，得到长度 %d (%q)", len(got), got)
	}
	if string(got) != "6789ABCDEF" {
		t.Fatalf("应保留最末 10 字节，得到 %q", got)
	}
}

func TestScrollbackBuffer_Wraparound(t *testing.T) {
	b := NewScrollback()
	b.ring = make([]byte, 5)
	b.start = 0
	b.length = 0

	// 多次小写入触发 start 绕回 ring 末尾，验证数据顺序正确
	b.Write([]byte("AB"))  // ring=[AB___], start=0, length=2
	b.Write([]byte("CDE")) // ring=[ABCDE], start=0, length=5
	b.Write([]byte("FG"))  // 容量超限，跳过 2 字节：start=2, length=5，写入位置 0,1
	// ring=[FGCDE], start=2，逻辑顺序 = CDEFG
	got := b.Snapshot(0)
	if string(got) != "CDEFG" {
		t.Fatalf("绕回后顺序应为 CDEFG，得到 %q", got)
	}
}

func TestScrollbackBuffer_WriteLargerThanCapacity(t *testing.T) {
	b := NewScrollback()
	b.ring = make([]byte, 5)
	b.start = 0
	b.length = 0

	// 单次写入就超过容量：应只保留最末 cap 字节
	b.Write([]byte("ABCDEFGHIJ")) // 10 字节，超 5
	got := b.Snapshot(0)
	if string(got) != "FGHIJ" {
		t.Fatalf("单次超限应只保留最末 5 字节，得到 %q", got)
	}
}

func TestScrollbackBuffer_WriteEmpty(t *testing.T) {
	b := NewScrollback()
	b.Write(nil)
	b.Write([]byte{})
	if got := b.Snapshot(0); got != nil {
		t.Fatalf("空写入不应改变缓冲，得到 %v", got)
	}
}

func TestScrollbackBuffer_Concurrent(t *testing.T) {
	b := NewScrollback()
	var wg sync.WaitGroup
	// 并发 50 个写者 + 50 个读者，验证无 race（需配合 -race 运行）
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			b.Write([]byte("concurrent-write-line\n"))
		}()
		go func() {
			defer wg.Done()
			_ = b.Snapshot(10)
		}()
	}
	wg.Wait()
}

// TestScrollbackBuffer_UTF8SingleWriteOverflow 验证单次写入超出容量时
// 截断点回退到完整 UTF-8 字符边界，避免重连重放显示替换字符
func TestScrollbackBuffer_UTF8SingleWriteOverflow(t *testing.T) {
	b := NewScrollback()
	// 容量 5 字节；中文 "中" 是 3 字节，"文" 也是 3 字节
	b.ring = make([]byte, 5)
	b.start = 0
	b.length = 0

	// "AB中文CD" 共 10 字节，容量 5
	// 字节序列：A(1) B(1) 中(3) 文(3) C(1) D(1) = 10 字节
	// 最末 5 字节 = "文CD" 的开头位置
	// cut = 10 - 5 = 5，data[5:] = "文CD" 的字节（含 "文" 完整 3 字节 + "CD" 2 字节）
	// 切点 5 正好在 "文" 的起始字节，rewindToRuneStart 应保持在 5
	b.Write([]byte("AB中文CD"))
	got := b.Snapshot(0)
	if !utf8.Valid(got) {
		t.Fatalf("缓冲应为合法 UTF-8，得到 % x", got)
	}
	if !bytes.Equal(got, []byte("文CD")) {
		t.Fatalf("应保留最末完整字符，得到 %q", got)
	}
}

// TestScrollbackBuffer_UTF8IncrementalOverflow 验证多次小写入触发滚动覆盖时
// 不会留下 UTF-8 字符前半部分（验证 rewindRingRuneStart 在环形 buffer 内正确回退）
func TestScrollbackBuffer_UTF8IncrementalOverflow(t *testing.T) {
	b := NewScrollback()
	b.ring = make([]byte, 7)
	b.start = 0
	b.length = 0

	// 写入 4 个汉字（12 字节）触发多次滚动覆盖
	// 缓冲最终应只含最近 2 个汉字的完整字节（6 字节，长度 < cap=7）
	b.Write([]byte("一二三四"))
	got := b.Snapshot(0)
	if !utf8.Valid(got) {
		t.Fatalf("缓冲应为合法 UTF-8，得到 % x", got)
	}
	if !bytes.Equal(got, []byte("三四")) {
		t.Fatalf("应保留最末完整汉字，得到 %q", got)
	}
}

func TestGetScrollbackLines(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, DefaultScrollbackLines},
		{-1, DefaultScrollbackLines},
		{999, DefaultScrollbackLines},
		{1000, 1000},
		{20000, 20000},
		{200000, 200000},
		{200001, DefaultScrollbackLines},
	}
	for _, c := range cases {
		if got := GetScrollbackLines(c.in); got != c.want {
			t.Errorf("GetScrollbackLines(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

// drainReader 把读取器窗口按 bufSize 分段读尽拼接（P-20261007-3 测试辅助）
func drainReader(t *testing.T, r *ScrollbackReader, bufSize int) []byte {
	t.Helper()
	var out []byte
	buf := make([]byte, bufSize)
	for i := 0; ; i++ {
		n, err := r.Next(buf)
		out = append(out, buf[:n]...)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				t.Fatalf("Next 意外错误: %v", err)
			}
			return out
		}
		if n == 0 {
			t.Fatalf("Next 返回 0 字节且无 EOF（第 %d 次调用）", i)
		}
	}
}

// TestScrollbackBuffer_ReaderMatchesSnapshot SnapshotReader 分段读出的字节流
// 必须与 Snapshot 整体快照逐字节一致（全量与按行裁剪两种语义、小环多次绕回）
func TestScrollbackBuffer_ReaderMatchesSnapshot(t *testing.T) {
	b := NewScrollback()
	b.ring = make([]byte, 64) // 小环：20 行远超容量，多次滚动覆盖 + 绕回
	b.start, b.length, b.written = 0, 0, 0
	for i := 0; i < 20; i++ {
		b.Write([]byte(fmt.Sprintf("line-%02d\n", i)))
	}

	all := b.Snapshot(0)
	r := b.SnapshotReader(0)
	if r.Len() != len(all) {
		t.Fatalf("Len() = %d, Snapshot 长度 = %d", r.Len(), len(all))
	}
	// 3 字节小段读取强制多次跨段拼接（覆盖绕回处的段边界）
	if got := drainReader(t, r, 3); !bytes.Equal(got, all) {
		t.Fatalf("Reader 全量读与 Snapshot 不一致:\n got=%q\nwant=%q", got, all)
	}
	// 按行裁剪语义与 Snapshot(3) 一致
	r3 := b.SnapshotReader(3)
	if got := drainReader(t, r3, 5); !bytes.Equal(got, b.Snapshot(3)) {
		t.Fatalf("Reader 按行读与 Snapshot(3) 不一致:\n got=%q\nwant=%q", got, b.Snapshot(3))
	}
	// 大段一次读完（窗口不绕回 ring 末尾的简单情形）
	b2 := NewScrollback()
	b2.Write([]byte("hello\nworld\n"))
	if got := drainReader(t, b2.SnapshotReader(0), 1024); !bytes.Equal(got, []byte("hello\nworld\n")) {
		t.Fatalf("简单窗口读不一致: %q", got)
	}
}

// TestScrollbackBuffer_ReaderEmpty 空缓冲：Len=0，Next 立即 EOF
func TestScrollbackBuffer_ReaderEmpty(t *testing.T) {
	b := NewScrollback()
	r := b.SnapshotReader(0)
	if r.Len() != 0 {
		t.Fatalf("空缓冲 Len() = %d, want 0", r.Len())
	}
	n, err := r.Next(make([]byte, 16))
	if n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("空缓冲 Next = (%d, %v), want (0, io.EOF)", n, err)
	}
}

// TestScrollbackBuffer_ReaderSkipsOverwritten 捕获后并发写入覆盖窗口最旧字节：
// Next 跳过失效前缀只交付幸存部分，全部覆盖尽后 EOF——重放绝不交付已覆盖坐标。
// （窗口终点固定于捕获时点，后续写入只推进覆盖前沿、不延展窗口）
func TestScrollbackBuffer_ReaderSkipsOverwritten(t *testing.T) {
	b := NewScrollback()
	b.ring = make([]byte, 10)
	b.start, b.length, b.written = 0, 0, 0
	b.Write([]byte("0123456789")) // 窗口 [0,10)
	r := b.SnapshotReader(0)

	buf := make([]byte, 4) // 小段读取，让覆盖发生在两次 Next 之间
	b.Write([]byte("ABC")) // 覆盖前沿推进到绝对偏移 3
	n, err := r.Next(buf)
	if err != nil || string(buf[:n]) != "3456" {
		t.Fatalf("跳过覆盖前缀后应交付 \"3456\"，得到 (%d, %v, %q)", n, err, buf[:n])
	}

	b.Write([]byte("DEFG")) // 前沿推进到 7，窗口剩余 [7,10) = "789"
	n, err = r.Next(buf)
	if err != nil || string(buf[:n]) != "789" {
		t.Fatalf("再覆盖后应交付 \"789\"，得到 (%d, %v, %q)", n, err, buf[:n])
	}

	n, err = r.Next(buf)
	if n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("窗口耗尽应 EOF，得到 (%d, %v)", n, err)
	}

	b.Write([]byte("HIJ")) // 前沿 10 ≥ 窗口终点：后续读取保持 EOF
	n, err = r.Next(buf)
	if n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("窗口覆盖尽应 EOF，得到 (%d, %v)", n, err)
	}
}

// TestScrollbackBuffer_ReaderEOFStable 窗口耗尽后 Next 持续 EOF；空 p 调用无副作用
func TestScrollbackBuffer_ReaderEOFStable(t *testing.T) {
	b := NewScrollback()
	b.Write([]byte("abc"))
	r := b.SnapshotReader(0)
	if got := drainReader(t, r, 2); string(got) != "abc" {
		t.Fatalf("读尽内容不一致: %q", got)
	}
	for i := 0; i < 3; i++ {
		n, err := r.Next(make([]byte, 8))
		if n != 0 || !errors.Is(err, io.EOF) {
			t.Fatalf("耗尽后第 %d 次 Next = (%d, %v), want (0, io.EOF)", i, n, err)
		}
	}
	if n, err := r.Next(nil); n != 0 || err != nil {
		t.Fatalf("空 p Next = (%d, %v), want (0, nil)", n, err)
	}
}

// TestScrollbackBuffer_ReaderConcurrentWithWrites 写者持续推进时读取器分段读：
// 不 panic、不死锁、交付字节是重复字节流的连续片段（无撕裂/错序）——
// 配合 -race 运行验证块级锁纪律。写者停止后第二次读取与 Snapshot 精确对账
func TestScrollbackBuffer_ReaderConcurrentWithWrites(t *testing.T) {
	const pattern = "concurrent-write-0123456789\n"
	b := NewScrollback()
	b.ring = make([]byte, 4096)
	b.start, b.length, b.written = 0, 0, 0
	b.Write([]byte(pattern)) // 先落一笔：保证捕获窗口非空（写者 goroutine 启动有竞态）
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				b.Write([]byte(pattern))
				// 步进节流：满速热循环会在读取器首次 Next 之前就把整个
				// 捕获窗口覆盖尽（4096 字节仅 ~150 圈，微秒级）——「窗口
				// 全被覆盖→交付 0 字节+EOF」是覆盖语义下的合法交付，却让
				// 本测试的「交付连续片段」断言失去区分度（实跑复现过一次
				// 交付 0 字节红）。1ms/笔把整窗覆盖推到 ~150ms 量级，读取
				// 器微秒级分段读必先完成；期间仍有数十笔交错写，-race
				// 锁纪律验证不受影响
				time.Sleep(time.Millisecond)
			}
		}
	}()

	r := b.SnapshotReader(0)
	got := drainReader(t, r, 7)
	close(stop)
	wg.Wait()

	if len(got) == 0 {
		t.Fatal("并发读取交付 0 字节")
	}
	ideal := strings.Repeat(pattern, len(got)/len(pattern)+2)
	if !bytes.Contains([]byte(ideal), got) {
		t.Fatalf("交付段不是字节流的连续片段（撕裂/错序）: %q", got[:min(64, len(got))])
	}
	// 写者停止后：新读取器与整体快照必须逐字节一致（确定性对账）
	if got2 := drainReader(t, b.SnapshotReader(0), 7); !bytes.Equal(got2, b.Snapshot(0)) {
		t.Fatalf("停写后 Reader 与 Snapshot 不一致: %d vs %d 字节", len(got2), len(b.Snapshot(0)))
	}
}

// TestScrollbackBuffer_EarliestTime 时间锚点与 EarliestTime 语义（P-20261005-233
// 断档检测的检测原语）：估计值恒为「不晚于真实写入时刻」的下界——缺口判定
// 「earliest 晚于断开前最后输出」只会因低估而漏标、不会误标
func TestScrollbackBuffer_EarliestTime(t *testing.T) {
	// 空缓冲：完整性未知（false）
	empty := NewScrollback()
	if _, ok := empty.EarliestTime(); ok {
		t.Fatal("空缓冲 EarliestTime 应返回 false")
	}

	// 首写即采（off=0 锚点）：少量输出也要可解析，且估计落在 [构造, 现在] 窗内
	b := NewScrollback()
	builtAt := time.Now()
	b.Write([]byte("hello\n"))
	est, ok := b.EarliestTime()
	if !ok {
		t.Fatal("有内容缓冲 EarliestTime 应可解析")
	}
	if est.Before(builtAt) || est.After(time.Now()) {
		t.Fatalf("首写锚点估计 %v 应落在 [%v, now] 窗内", est, builtAt)
	}

	// 淘汰推进：小环 + 两批写入——第二枚锚点采样后环内容被第二批覆盖，现存
	// 最旧字节属于第二批，估计必须晚于首批锚点（否则缺口判定会把已淘汰的旧
	// 内容当作仍在，反向误标）。注意两点实现事实：单笔超容量写入被裁到 cap
	// 字节、written 只按实收字节推进——缩环下锚点间隔靠多笔小额写入累计跨越；
	// 采样发生在写入口（裁剪之前），第二枚锚点的坐标 = 'a'/'b' 批次边界
	small := NewScrollbackWithCapacity(4 * 1024) // 4KB 环
	small.ring = make([]byte, 1000)              // 缩环强制淘汰（既有测试同款手法）
	first := time.Now()
	small.Write(bytes.Repeat([]byte("a"), anchorOffInterval)) // 首锚点 off=0（环=末 1000 字节 'a'）
	for i := 0; i < 65; i++ {
		small.Write(bytes.Repeat([]byte("a"), 1000)) // written 累计至 66000，仍全 'a'
	}
	time.Sleep(20 * time.Millisecond)
	small.Write(bytes.Repeat([]byte("b"), 1000)) // written−lastAnchor ≥ 64KB → 第二锚点 off=66000（环仍 'a'）
	small.Write(bytes.Repeat([]byte("b"), 1000)) // 环内容覆写为 'b'
	est2, ok2 := small.EarliestTime()
	if !ok2 {
		t.Fatal("淘汰后 EarliestTime 应可解析")
	}
	if !est2.After(first) {
		t.Fatalf("淘汰推进后估计 %v 应晚于首批锚点时刻 %v（存活字节属于第二批写入）", est2, first)
	}
	// 环内只剩 'b'：内容断言锚定「floor 确已越过第一批」的前提
	if got := small.Snapshot(0); !bytes.Equal(got, bytes.Repeat([]byte("b"), 1000)) {
		t.Fatalf("前置失效：环内应为纯第二批内容，得到 %d 字节首字符 %q", len(got), got[0])
	}

	// 锚点环翻转（>环容量次采样）不 panic、仍可解析且估计单调不回退
	rot := NewScrollbackWithCapacity(1 << 20) // 1MB 环 → 锚点环 40 槽
	rot.Write(bytes.Repeat([]byte("x"), anchorOffInterval))
	prev, okPrev := rot.EarliestTime()
	if !okPrev {
		t.Fatal("翻转前 EarliestTime 应可解析")
	}
	for i := 0; i < 50; i++ {
		rot.Write(bytes.Repeat([]byte("y"), anchorOffInterval)) // 50 枚新锚点，环翻转
	}
	est3, ok3 := rot.EarliestTime()
	if !ok3 {
		t.Fatal("锚点环翻转后 EarliestTime 应可解析（窗口起点之前必有存留锚点）")
	}
	if est3.Before(prev) {
		t.Fatalf("翻转后估计 %v 不应早于翻转前 %v", est3, prev)
	}

	// 零值构造（测试直改字段形态）：无锚点容量，写入与查询都不 panic
	zero := &ScrollbackBuffer{ring: make([]byte, 16)}
	zero.Write([]byte("z"))
	if _, ok := zero.EarliestTime(); ok {
		t.Fatal("零值构造缓冲（无锚点环）应诚实返回 false")
	}
}
