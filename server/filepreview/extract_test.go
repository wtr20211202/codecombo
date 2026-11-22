package filepreview

// ── 嵌入字节面抽取测试（P-20261118-10 体量守卫拆分：自 office_test.go /
// service_test.go 按子系统边界迁入；P-20261119-4 随渲染面抽包下沉本包，
// 端点级测试迁回 share/embedendpoint_test.go）──
//
// 本文件对应 extract.go（CFB 最小读 + Ole10Native 抽取 + 嵌入字节面/文本
// 规范化）：抽取链单测（BuildCFB 夹具族/名仲裁/正文扫描/锚点回退/诊断
// 枚举/分族闸/规范化四级序）+ 真实容器字节轨（testdata 双容器 SHA 双锚）。
// docx 渲染面测试在 office_test.go，嵌入端点端到端测试在 share

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	fx "codecombo/server/filepreview/fixtures"
)

// ---- CFB 最小读 + Ole10Native 抽取（P-20261116-7） ----
//
// 夹具构造器（cfbTestSig/BuildCFB/Ole10* 家族）下沉 fixtures 子包导出，
// 供 share 端点测试共用。

// ole10RealWordHead 2026-11-18 真实分享下载解包的 Ole10Native 流头取证字节
// （本提案定位标本——临时探针测试以真实文件字节过产品抽取链，验后即删、
// 字节固化于此作回归夹具）：总长 cc5b0000 + 标志 0200 + GBK 名
// 「根据IP关联组织.html」ASCIZ（= fx.GbkSampleName+ 结尾 NUL）+ GBK 源路径
// 「D:/xls/」前缀。旧解析在此产出 rawName="\x02"（命中标志高位 0x00）
var ole10RealWordHead = []byte{
	0xCC, 0x5B, 0x00, 0x00, // 总长
	0x02, 0x00, // 标志字段（真实 Word 写入器恒有）
	0xB8, 0xF9, 0xBE, 0xDD, 'I', 'P', 0xB9, 0xD8, 0xC1, 0xAA, 0xD7, 0xE9, 0xD6, 0xAF,
	'.', 'h', 't', 'm', 'l', 0x00,
	'D', ':', '/', 'x', 'l', 's', '/',
}

func TestCFBReadStreamHead(t *testing.T) {
	// 双扇区规格 × 双链路径全覆盖：512+mini / 512+常规 / 4096+mini / 4096+常规
	// + 真实 Word 有标志布局（P-20261118-2：CFB 链读头后解析在标志字段上
	// 不再产出 "\x02" 伪名）
	for _, tc := range []struct {
		name     string
		sectSize int
		payload  []byte
		mini     bool
		want     string
	}{
		{"512-mini", 512, fx.Ole10Payload("report.html", 600), true, "report.html"},
		{"512-regular", 512, fx.Ole10Payload("spec.pdf", 4200), false, "spec.pdf"}, // ≥4KB 走常规链
		{"4k-mini", 4096, fx.Ole10Payload("report.html", 600), true, "report.html"},
		{"4k-regular", 4096, fx.Ole10Payload("big.zip", 5000), false, "big.zip"},
		{"512-mini-flagged", 512, fx.Ole10FlaggedPayload("flag.doc", 600), true, "flag.doc"},
	} {
		data := fx.BuildCFB(t, tc.sectSize, tc.payload, tc.mini, nil)
		head := cfbReadStreamHead(data, ole10NativeStreamName, ole10NativeHeadBytes)
		if head == nil {
			t.Fatalf("%s: stream head not found", tc.name)
		}
		if got := ole10NativeFileName(head); got != tc.want {
			t.Fatalf("%s: name = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestCFBReadStreamHeadBadStructures(t *testing.T) {
	// 坏魔数 / 截断 / 坏扇区规格 / 坏迷你扇区规格 / FAT 环 / 非流类型——
	// 全部回落 nil（红线：绝不产出错误页，端点侧落 .bin 直供名）
	good := fx.BuildCFB(t, 512, fx.Ole10Payload("ok.html", 16), true, nil)
	breakMagic := append([]byte(nil), good...)
	breakMagic[3] ^= 0xFF
	if cfbReadStreamHead(breakMagic, ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("bad magic must fail closed")
	}
	if cfbReadStreamHead(good[:100], ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("truncated header must fail closed")
	}
	if cfbReadStreamHead(nil, ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("nil input must fail closed")
	}
	breakShift := append([]byte(nil), good...)
	binary.LittleEndian.PutUint16(breakShift[30:32], 10) // 非法扇区规格
	if cfbReadStreamHead(breakShift, ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("bad sector shift must fail closed")
	}
	breakMini := append([]byte(nil), good...)
	binary.LittleEndian.PutUint16(breakMini[32:34], 9) // 非法迷你扇区规格
	if cfbReadStreamHead(breakMini, ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("bad mini shift must fail closed")
	}
	// FAT 环：常规链路径上流首扇区（2 号）自指——walk 的 seen 集合必须识别
	loopFAT := fx.BuildCFB(t, 512, fx.Ole10Payload("loop.html", 4200), false, nil)
	binary.LittleEndian.PutUint32(loopFAT[512+4*2:], 2) // FAT 数组在 0 号扇区
	if cfbReadStreamHead(loopFAT, ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("FAT loop must fail closed")
	}
	// 目录项类型改 storage（非流）→ 找不到目标流
	noStream := fx.BuildCFB(t, 512, fx.Ole10Payload("x.html", 16), true, nil)
	noStream[2*512+128+66] = 1 // 第二个目录项（Ole10Native）的 typ 字段
	if cfbReadStreamHead(noStream, ole10NativeStreamName, ole10NativeHeadBytes) != nil {
		t.Fatal("missing stream must fail closed")
	}
}

func TestOle10NativeFileName(t *testing.T) {
	// 正常形态（总长口径不一：含头/不含头两种写法都要容忍）
	if got := ole10NativeFileName(fx.Ole10Payload("a.html", 4)); got != "a.html" {
		t.Fatalf("normal = %q", got)
	}
	noTotal := append([]byte{0, 0, 0, 0}, []byte("b.html\x00rest")...)
	if got := ole10NativeFileName(noTotal); got != "b.html" {
		t.Fatalf("zero-total variant = %q", got)
	}
	// 总长连文件名都装不下 = 结构撒谎
	lying := append([]byte{2, 0, 0, 0}, []byte("c.html\x00")...)
	if got := ole10NativeFileName(lying); got != "" {
		t.Fatalf("lying total must fail closed, got %q", got)
	}
	// 无 NUL / 过短
	if got := ole10NativeFileName([]byte("nonul")); got != "" {
		t.Fatalf("no NUL must fail closed, got %q", got)
	}
	if got := ole10NativeFileName([]byte{1, 2}); got != "" {
		t.Fatalf("too short must fail closed, got %q", got)
	}
}

// TestOle10NativeFileNameFlaggedLayout 双布局 × 双编码矩阵 + 真实取证字节
// （P-20261118-2 必改④/⑤）：P-1 的合成夹具按解析器假设（无标志字段）构造
// ——测试全绿而真实 Word 产物全灭的测试盲区，本测从夹具层钉死两种布局
func TestOle10NativeFileNameFlaggedLayout(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload []byte
		want    string
	}{
		// 有标志布局（真实 Word 形态）——旧解析在 GBK 名上恒产出 "\x02"
		{"flagged-gbk", fx.Ole10FlaggedPayload(fx.GbkSampleName, 600), "根据IP关联组织.html"},
		{"flagged-utf8", fx.Ole10FlaggedPayload("report.html", 600), "report.html"},
		// 无标志布局（旧写入器/合成形态）——解码链与布局正交
		{"plain-gbk", fx.Ole10Payload(fx.GbkSampleName, 600), "根据IP关联组织.html"},
		{"plain-utf8", fx.Ole10Payload("report.html", 600), "report.html"},
	} {
		if got := ole10NativeFileName(tc.payload); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
	// 本实证字节序列 fixture（真实分享下载解包取证，含源路径前缀）：
	// 候选 A 死于标志高位、候选 B（GBK 名）胜出——真实形态回归钉死
	if got := ole10NativeFileName(ole10RealWordHead); got != "根据IP关联组织.html" {
		t.Fatalf("real Word head bytes: got %q, want 根据IP关联组织.html", got)
	}
}

// TestOle10NativeArbitration 双候选仲裁语义（P-20261118-2 必改①/②/⑤）：
// 候选 A 控制字符伪名硬淘汰 + 两防回归（并列同分选 A / total 守卫候选联动）
func TestOle10NativeArbitration(t *testing.T) {
	// 仲裁淘汰：候选 A raw 命中标志高位 → "\x02" 净化空 → 硬淘汰，候选 B
	// （真名）胜出——最小字节构造单独钉死淘汰语义（total=20 装得下 B）
	minStream := append([]byte{0x14, 0x00, 0x00, 0x00, 0x02, 0x00}, []byte("ab.txt\x00junk")...)
	if got := ole10NativeFileName(minStream); got != "ab.txt" {
		t.Fatalf("candidate A control-raw must be eliminated, got %q", got)
	}
	// 防回归①：无标志布局双候选并列同分（"readme.md" 与 B 侧截断伪名
	// "adme.md" 同为 2 分）→ 必须取候选 A 整名，伪名不得胜出
	if got := ole10NativeFileName(fx.Ole10Payload("readme.md", 8)); got != "readme.md" {
		t.Fatalf("tie must keep candidate A, got %q (truncated pseudo-name leaked)", got)
	}
	// 防回归②：total 守卫候选联动——声明总长 5 装不下候选 B 的实际占用
	// （6+4=10）即拒；A 侧净化空、B 侧守卫拒 → 回落 ""。旧式与偏移解耦的
	// total < end 守卫（5 ≥ 4）会放 B 伪名 "html" 出头
	lying := append([]byte{0x05, 0x00, 0x00, 0x00, 0x02, 0x00}, []byte("html\x00")...)
	if got := ole10NativeFileName(lying); got != "" {
		t.Fatalf("candidate-linked total guard must reject lying B, got %q", got)
	}
}

// TestOle10NativeBody 正文抽取布局解析（P-20261118-3 主刀① + P-20261118-7
// 扫描式定位）：假设布局（有标志/无标志双候选）字节级等值抽出 + 逐字段
// 疑点即回落（缺 ASCIZ/零长度/撒谎长度/total 守卫/过短流）
func TestOle10NativeBody(t *testing.T) {
	body := []byte("<!DOCTYPE html><html><head><meta charset=\"UTF-8\"></head><body>需求文档</body></html>")

	// 有标志完整布局（假设写入器形态）：GBK 名+源/临时路径+正文，字节级等值
	full := fx.Ole10FullPayload(fx.GbkSampleName, "D:/xls/", "C:/tmp/x/", body)
	if got := ole10NativeBody(full, "html"); !bytes.Equal(got, body) {
		t.Fatalf("flagged full layout: got %d bytes, want exact body (%d)", len(got), len(body))
	}
	// 无标志完整布局（旧写入器形态）：候选 A 首个完整解析即返回
	noFlag := append([]byte{0, 0, 0, 0}, []byte("report.html\x00D:/src/\x00C:/tmp/\x00")...)
	noFlag = binary.LittleEndian.AppendUint32(noFlag, uint32(len(body)))
	noFlag = append(noFlag, body...)
	binary.LittleEndian.PutUint32(noFlag, uint32(len(noFlag)-4))
	if got := ole10NativeBody(noFlag, "html"); !bytes.Equal(got, body) {
		t.Fatalf("plain full layout: got %d bytes, want exact body (%d)", len(got), len(body))
	}
	// total=0 变体（声明缺席）：物理守卫独立成立（低置信采纳路径）
	zero := append([]byte{0, 0, 0, 0}, []byte("a.html\x00s\x00t\x00")...)
	zero = binary.LittleEndian.AppendUint32(zero, uint32(len(body)))
	zero = append(zero, body...)
	if got := ole10NativeBody(zero, "html"); !bytes.Equal(got, body) {
		t.Fatalf("zero-total variant: got %d bytes, want exact body", len(got))
	}

	// 疑点回落族：
	// 名字-only（P-20261118-2 夹具形态——junk 零字节被当空源/临时路径，
	// 数据长度 0）→ nil
	if got := ole10NativeBody(fx.Ole10FlaggedPayload(fx.GbkSampleName, 600), "html"); got != nil {
		t.Fatalf("name-only stream must extract nothing, got %d bytes", len(got))
	}
	// 数据长度撒谎（声明超出流尾）→ nil
	lyingLen := fx.Ole10FullPayload("x.html", "s", "t", body)
	binary.LittleEndian.PutUint32(lyingLen[len(lyingLen)-len(body)-4:], uint32(len(body)+100))
	if got := ole10NativeBody(lyingLen, "html"); got != nil {
		t.Fatalf("lying data length must fall back, got %d bytes", len(got))
	}
	// total 撒谎（声明装不下正文）→ nil
	lyingTotal := fx.Ole10FullPayload("x.html", "s", "t", body)
	binary.LittleEndian.PutUint32(lyingTotal[:4], 4) // 名字仲裁 total 守卫先拒
	if got := ole10NativeBody(lyingTotal, "html"); got != nil {
		t.Fatalf("lying total must fall back, got %d bytes", len(got))
	}
	// total 膨胀（声明比实际大 100B 的「口径漂移」写入器）——html 锚强族
	// **语义翻转显式声明（P-20261118-10 评审必改1）**：本例在 P-7 ±16 双侧
	// 对齐门下是拒绝断言，锚强族 total 门降格「body 不越声明流尾」后翻转
	// 为采纳。声明：total 与 dataLen 同为流内攻击者可控字段，±16 对齐门
	// 从来不是安全门、只防诚实写入器的口径漂移；锚强族的内容锚（doctype
	// 在首部窗）是更强判别，采纳诚实 dataLen 的正文是正确行为——真实
	// 写入器「total 计入载荷后尾随元数据块」形态恰是 total>body 的诚实
	// 分支，旧门把唯一正确的 dataLen 候选误拒（线上实证 diff=-240）=预览
	// 全灭根因。本正例钉住新语义
	offTotal := fx.Ole10FullPayload("x.html", "s", "t", body)
	binary.LittleEndian.PutUint32(offTotal[:4], uint32(len(offTotal)-4+100))
	if got := ole10NativeBody(offTotal, "html"); !bytes.Equal(got, body) {
		t.Fatalf("anchor-strong family must adopt honest dataLen despite inflated total, got %d bytes", len(got))
	}
	// 同型 total 膨胀在 text 族仍拒（严格三联门维持不动——无内容锚背书，
	// 双侧对齐门是唯一防假手段，P-20261118-10 不放宽；负例收窄到 text 族）
	offTotalTxt := fx.Ole10FullPayload("x.txt", "s", "t", body)
	binary.LittleEndian.PutUint32(offTotalTxt[:4], uint32(len(offTotalTxt)-4+100))
	if got := ole10NativeBody(offTotalTxt, "txt"); got != nil {
		t.Fatalf("text family strict total gate must reject inflated total, got %d bytes", len(got))
	}
	// 锚强族单侧上界负例（P-20261118-10 放宽后的新边界）：dataLen 虚胖使
	// body 越过声明流尾、但仍在物理流内（流尾续 junk 后撒谎长度恰够到
	// 新流尾）——物理门放行、内容门放行，单侧上界是唯一拒绝点，钉住
	//「放宽只去下界、上界仍在」半边语义
	overEnd := fx.Ole10RealLayoutPayload(fx.GbkSampleName, "D:\\xls\\", nil, fx.GbkRealTempPath, body)
	overEnd = append(overEnd, bytes.Repeat([]byte{'z'}, 64)...)
	dlPos := len(overEnd) - len(body) - 4 - 64
	binary.LittleEndian.PutUint32(overEnd[dlPos:], uint32(len(body)+64))
	if got := ole10NativeBody(overEnd, "html"); got != nil {
		t.Fatalf("dataLen crossing declared stream end must be rejected, got %d bytes", len(got))
	}
	// 零长度数据 → nil
	empty := fx.Ole10FullPayload("x.html", "s", "t", nil)
	if got := ole10NativeBody(empty, "html"); got != nil {
		t.Fatalf("zero-length body must fall back, got %d bytes", len(got))
	}
	// 截断流（尾部切在数据长度字段中间——CFB 目录尺寸谎报小于实际时的
	// 读取形态）→ nil
	trunc := fx.Ole10FullPayload("x.html", "s", "t", body)
	if got := ole10NativeBody(trunc[:len(trunc)-len(body)-1], "html"); got != nil {
		t.Fatalf("truncated stream must fall back, got %d bytes", len(got))
	}
	// 过短流 → nil
	if got := ole10NativeBody([]byte{1, 2}, "html"); got != nil {
		t.Fatalf("short stream must fall back, got %d bytes", len(got))
	}
}

// TestOle10NativeBodyRealLayout 真实布局扫描式定位（P-20261118-7 评审必改1）：
// 逐字节复刻 2026-11-18 取证形态（源路径后含空 ASCIZ + [03 00] + 0x36 长度
// 前缀），旧刚性「恰 2 个 ASCIZ」解析在此产出 dataLen=0x00360003≈3.4MB 越界
// 拒——扫描式按偏移递增首个通过全部校验者采纳，正文字节级等值抽出
func TestOle10NativeBodyRealLayout(t *testing.T) {
	body := []byte("<!doctype html><html><body>需求文档——真实布局</body></html>")

	// 取证基准形态：真实临时路径（0x36 前缀自洽）+ 正文抽出
	real := fx.Ole10RealLayoutPayload(fx.GbkSampleName, "D:\\xls\\", nil, fx.GbkRealTempPath, body)
	if got := ole10NativeBody(real, "html"); !bytes.Equal(got, body) {
		t.Fatalf("real Word layout: got %d bytes, want exact body (%d)", len(got), len(body))
	}

	// 0x36 长度前缀误判负例（评审必改1 核心）：对齐门+ext 内容门双重拒绝
	// 前缀位假 dataLen——把正文换到恰使前缀位候选通过对齐门的形态
	//（diff = 4+len(body) ≤ 16 ⇒ len(body)=10），此时对齐门放行、统计门
	// （前缀候选切出的「正文」=临时路径 ASCIZ 含结尾 NUL）是决定性拒绝，
	// 扫描继续走到真数据长度位才采纳
	txtBody := []byte("hello txt!")
	txt := fx.Ole10RealLayoutPayload("notes.txt", "D:\\src\\", nil, fx.GbkRealTempPath, txtBody)
	if got := ole10NativeBody(txt, "txt"); !bytes.Equal(got, txtBody) {
		t.Fatalf("prefix-position fake dataLen must be rejected by content gate, got %.60q", got)
	}

	// 额外 ASCIZ 变体矩阵 0/1/2/3（评审必改3 变体轨）：布局再变体也抽得出
	for n := 0; n <= 3; n++ {
		extras := make([]string, n)
		v := fx.Ole10RealLayoutPayload(fx.GbkSampleName, "D:\\xls\\", extras, fx.GbkRealTempPath, body)
		if got := ole10NativeBody(v, "html"); !bytes.Equal(got, body) {
			t.Fatalf("extras=%d variant: got %d bytes, want exact body", n, len(got))
		}
	}

	// 双侧 total 对齐正例（P-20261118-10 起锚强族语义=单侧上界内自由）：
	// total 膨胀 +8（body 不越声明流尾）仍采纳——容差语义放宽为上界，
	// 与线上「total 计入尾随元数据块」形态（diff=-240）同向
	tol := fx.Ole10RealLayoutPayload(fx.GbkSampleName, "D:\\xls\\", nil, fx.GbkRealTempPath, body)
	binary.LittleEndian.PutUint32(tol[:4], uint32(len(tol)-4+8)) // 偏差 +8
	if got := ole10NativeBody(tol, "html"); !bytes.Equal(got, body) {
		t.Fatalf("total within alignment tolerance must be adopted, got %d bytes", len(got))
	}
	// 负例：total 缩水 -100（bodyEnd 越声明流尾 +100）→ 拒——P-20261118-10
	// 锚强族拒绝理由从「超容差」精确为「越声明流尾」（单侧上界），裁定
	// 不变
	bad := fx.Ole10RealLayoutPayload(fx.GbkSampleName, "D:\\xls\\", nil, fx.GbkRealTempPath, body)
	binary.LittleEndian.PutUint32(bad[:4], uint32(len(bad)-4-100))
	if got := ole10NativeBody(bad, "html"); got != nil {
		t.Fatalf("total misaligned by -100 must be rejected, got %d bytes", len(got))
	}
}

// TestOle10AnchorBody 锚点回退（P-20261118-7 提案③）：字段遍历全灭的流上
// 按 ext 扫内容锚点，从锚点供给至声明流长（截掉链读扇区 padding）；锚点
// 未命中/不适用 ext → nil（诚实回落，绝不产出容器半截）
func TestOle10AnchorBody(t *testing.T) {
	junk := fx.Ole10FlaggedPayload(fx.GbkSampleName, 64) // 名-only + NUL 填充（无数据长度字段）
	htmlBody := []byte("<!doctype html><html><body>锚点回退</body></html>")
	stream := append(append([]byte{}, junk...), htmlBody...)
	// 总长声明为整条流（不含自身 4B）——锚点回退按声明截尾
	binary.LittleEndian.PutUint32(stream[:4], uint32(len(stream)-4))
	if got := ole10AnchorBody(stream, "html"); !bytes.Equal(got, htmlBody) {
		t.Fatalf("html anchor fallback: got %.80q, want exact body", got)
	}
	// 大小写不敏感：<HTML 大写形态也命中
	upper := append(append([]byte{}, junk...), []byte("<HTML><body>x</body></html>")...)
	if got := ole10AnchorBody(upper, "htm"); got == nil || !bytes.HasPrefix(got, []byte("<HTML>")) {
		t.Fatalf("case-insensitive anchor must hit, got %.40q", got)
	}
	// pdf 锚点
	pdfStream := append(append([]byte{}, junk...), []byte("%PDF-1.7 rest")...)
	if got := ole10AnchorBody(pdfStream, "pdf"); !bytes.HasPrefix(got, []byte("%PDF")) {
		t.Fatalf("pdf anchor fallback: got %.40q", got)
	}
	// text 族不适用锚点回退 → nil
	if got := ole10AnchorBody(stream, "txt"); got != nil {
		t.Fatalf("anchor fallback must not apply to txt, got %.40q", got)
	}
	// 锚点未命中 → nil
	noAnchor := append(append([]byte{}, junk...), []byte("plain bytes without anchors")...)
	if got := ole10AnchorBody(noAnchor, "html"); got != nil {
		t.Fatalf("anchor miss must return nil, got %.40q", got)
	}

	// ── P-20261118-10 截尾（修因 B：锚点回退的独立救回层） ──
	// 正例：total 计入载荷后尾随元数据块（真实写入器形态，线上实证
	// </html> 之后即 UTF-16LE 尾块起点）——截到 </html> 末现其后，尾块
	// 不得进入供给（进了会被 normalizeTextBytes 的 GB18030 兜底判死）
	trail := append([]byte{0x10, 0x00, 0x00, 0x00}, fx.Utf16Bytes("C:\\Users\\admin\\AppData\\Local\\Temp\\x.html", binary.LittleEndian, false)...)
	streamTrail := append(append([]byte{}, junk...), htmlBody...)
	streamTrail = append(streamTrail, trail...)
	binary.LittleEndian.PutUint32(streamTrail[:4], uint32(len(streamTrail)-4))
	if got := ole10AnchorBody(streamTrail, "html"); !bytes.Equal(got, htmlBody) {
		t.Fatalf("trailing utf-16 metadata block must be truncated at last </html>, got %.80q", got)
	}
	// 负例：无闭合锚 → 维持供给至声明流尾（best-effort 不劣化——截尾只在
	// 闭合锚在场时生效，不引入新的失败面）
	openBody := []byte("<!doctype html><html><body>no close")
	streamOpen := append(append([]byte{}, junk...), openBody...)
	streamOpen = append(streamOpen, trail...)
	binary.LittleEndian.PutUint32(streamOpen[:4], uint32(len(streamOpen)-4))
	got := ole10AnchorBody(streamOpen, "html")
	if got == nil || !bytes.HasSuffix(got, trail) {
		t.Fatalf("no-close anchor must keep supply-to-declared-end, got %.80q", got)
	}
	// 闭合锚后歧义（评审建议4）：尾块内嵌 ASCII </html> → 截到**末现**
	//（≥真闭合位置，不劣于现状供给至声明流尾——末现语义显式钉住）
	streamAdv := append(append([]byte{}, junk...), htmlBody...)
	streamAdv = append(streamAdv, []byte("junk</html>tail")...)
	binary.LittleEndian.PutUint32(streamAdv[:4], uint32(len(streamAdv)-4))
	wantAdv := append(append([]byte{}, htmlBody...), []byte("junk</html>")...)
	if got := ole10AnchorBody(streamAdv, "html"); !bytes.Equal(got, wantAdv) {
		t.Fatalf("close anchor must cut at LAST occurrence, got %.80q", got)
	}
}

// TestEmbedExtractPayloadDiag 抽取器层诊断枚举（P-20261118-7 提案⑤）：
// 容器坏结构 no-stream / 字段遍历+锚点双败 field-scan（text 族）/ html 族
// anchor-miss / 成功 none；非容器字节直通 diag none
func TestEmbedExtractPayloadDiag(t *testing.T) {
	// 非容器：原样直通
	raw := []byte("<html>direct</html>")
	if got, diag := embedExtractPayload(raw, "html"); !bytes.Equal(got, raw) || diag != EmbedDiagNone {
		t.Fatalf("non-CFB passthrough changed: diag=%q", diag)
	}
	// CFB 魔数 + 坏结构 → no-stream
	badCFB := append([]byte{}, CFBMagic...)
	badCFB = append(badCFB, make([]byte, 600)...)
	if got, diag := embedExtractPayload(badCFB, "html"); got != nil || diag != EmbedDiagNoStream {
		t.Fatalf("broken CFB must be no-stream, got %d bytes diag=%q", len(got), diag)
	}
	// 名-only 容器（无正文无锚点）：html 族 → anchor-miss；txt 族 → field-scan
	nameOnly := fx.BuildCFB(t, 512, fx.Ole10FlaggedPayload(fx.GbkSampleName, 600), true, nil)
	if _, diag := embedExtractPayload(nameOnly, "txt"); diag != EmbedDiagFieldScan {
		t.Fatalf("txt name-only must be field-scan, got %q", diag)
	}
	if _, diag := embedExtractPayload(nameOnly, "html"); diag != EmbedDiagAnchorMiss {
		t.Fatalf("html name-only must be anchor-miss, got %q", diag)
	}
	// 锚点回退成功：名-only 流 + html 正文（无数据长度字段）→ 锚点救回
	anchored := fx.BuildCFB(t, 512,
		append(append([]byte{}, fx.Ole10FlaggedPayload(fx.GbkSampleName, 64)...),
			[]byte("<html><body>anchored</body></html>")...), true, nil)
	got, diag := embedExtractPayload(anchored, "html")
	if diag != EmbedDiagNone || got == nil || !bytes.Contains(got, []byte("anchored")) {
		t.Fatalf("anchor fallback via CFB failed: diag=%q got %.60q", diag, got)
	}
}

// TestEmbedPreviewPayloadFamilies 统一抽取判定分族闸（P-20261118-7 评审
// 必改2）：pdf 递 %PDF 头（非容器伪装条目同闸）、image 递 sniffImageMime、
// 文本族过规范化+md 上限——nil 即该 ext 的 preview 面将回落 attachment
func TestEmbedPreviewPayloadFamilies(t *testing.T) {
	stream := fx.BuildCFB(t, 512, fx.Ole10FullPayload("doc.pdf", "D:/", "C:/", []byte("%PDF-1.7 fake body")), true, nil)
	got, diag := EmbedPreviewPayload(stream, "pdf")
	if diag != EmbedDiagNone || got == nil || !bytes.HasPrefix(got, []byte("%PDF")) {
		t.Fatalf("CFB-wrapped pdf must extract to %%PDF body, diag=%q", diag)
	}
	// 非 CFB 伪装 pdf（字节非 %PDF）→ binary-guard（原直供坏页行为收敛为拒绝）
	if _, diag := EmbedPreviewPayload([]byte("not a pdf"), "pdf"); diag != EmbedDiagBinary {
		t.Fatalf("fake pdf passthrough must be binary-guard, got %q", diag)
	}
	// 伪装图字节（ext png 非图字节）→ binary-guard
	if _, diag := EmbedPreviewPayload([]byte("<html>fake</html>"), "png"); diag != EmbedDiagBinary {
		t.Fatalf("fake png must be binary-guard, got %q", diag)
	}
	// 文本族：GBK txt 经规范化转码
	gbkBody := []byte(fx.GbkSampleName)
	txt := fx.BuildCFB(t, 512, fx.Ole10FullPayload("notes.txt", "D:/", "C:/", gbkBody), true, nil)
	got, diag = EmbedPreviewPayload(txt, "txt")
	if diag != EmbedDiagNone || got == nil || !bytes.Contains(got, []byte("根据IP关联组织")) {
		t.Fatalf("CFB GBK txt must normalize, diag=%q got %.60q", diag, got)
	}
	// md 上限：超 MaxRenderBytes → oversize（施加在净化后输入上；净化工
	// 厂面用直通字节验证——buildCFB 单 FAT 扇区造不动 20MB 容器，闸位置
	// 在抽取产物之后，与容器形态无关）
	big := bytes.Repeat([]byte("a"), MaxRenderBytes+1)
	if _, diag := EmbedPreviewPayload(big, "md"); diag != EmbedDiagOversize {
		t.Fatalf("oversize md must be oversize, got %q", diag)
	}
}

// TestNormalizeTextBytes 文本编码规范化四级序 + 二进制守卫双道（P-20261118-3
// 主刀②）：UTF-8 原样 / FF FE→UTF-16LE / FE FF→UTF-16BE / GB18030 兜底，
// 魔数反向排除优先于一切文本假设（zip 头部恰是合法 UTF-8 的反例钉死），
// NUL 密度/控制字符门拦在 GB18030 恒成功面之前
func TestNormalizeTextBytes(t *testing.T) {
	// UTF-8 valid 原样（第一级）
	u8 := []byte("<html>需求文档</html>")
	if got := normalizeTextBytes(u8); !bytes.Equal(got, u8) {
		t.Fatalf("utf-8 passthrough changed bytes")
	}
	// UTF-16LE BOM（第二级，中文 Windows 记事本「Unicode」形态）
	le := fx.Utf16Bytes("需求文档", binary.LittleEndian, true)
	got := normalizeTextBytes(le)
	if got == nil || !strings.Contains(string(got), "需求文档") {
		t.Fatalf("utf-16le bom must decode, got %.40q", got)
	}
	// UTF-16BE BOM（第三级）
	be := fx.Utf16Bytes("需求文档", binary.BigEndian, true)
	got = normalizeTextBytes(be)
	if got == nil || !strings.Contains(string(got), "需求文档") {
		t.Fatalf("utf-16be bom must decode, got %.40q", got)
	}
	// GB18030 兜底（第四级）：GBK 字节（BOM 缺、UTF-8 invalid）解码还原
	if got := normalizeTextBytes([]byte(fx.GbkSampleName)); got == nil ||
		!strings.Contains(string(got), "根据IP关联组织") {
		t.Fatalf("gbk bytes must decode, got %.40q", got)
	}
	// 未配对代理 → 替换符噪声拒绝（诚实回落）
	bad := fx.Utf16Bytes("ab", binary.LittleEndian, true)
	bad = append(bad, 0x00, 0xD8, 0x00, 0x00) // 高代理 D800 无配对
	if got := normalizeTextBytes(bad); got != nil {
		t.Fatalf("unpaired surrogate must fall back, got %.20q", got)
	}

	// 魔数反向排除（优先于 UTF-8 判定——PK 头部字节恰是合法 UTF-8 反例）：
	for _, magic := range [][]byte{
		{'P', 'K', 0x03, 0x04, 'h', 'e', 'l', 'l', 'o'},
		{'M', 'Z', 'h', 'e', 'l', 'l', 'o'},
		{'%', 'P', 'D', 'F', '-', '1', '.'},
		append(CFBMagic, 'a', 'b'),
		{0x7F, 'E', 'L', 'F', 0x02},
	} {
		if got := normalizeTextBytes(magic); got != nil {
			t.Fatalf("magic bytes %.8q must be refused, got %.20q", magic, got)
		}
	}
	// BOM 缺失的 CJK UTF-16LE（NUL 密度门）——GB18030 兜底前拦截：这族
	// 字节按 GB18030 解码恒「成功」出 CJK 乱码，NUL 门是唯一拦点。
	// 边界注记：纯 ASCII 的 BOM 缺失 UTF-16 字节面恰是合法 UTF-8（NUL 是
	// 合法码位），走第一级原样直出（带 NUL 噪声的劣化显示而非乱码灾难
	// ——四级序的诚实边界，GB18030 兜底门按必改2 口径只拦解码分支）
	noBom := fx.Utf16Bytes("根据IP关联组织文档", binary.LittleEndian, false)
	if got := normalizeTextBytes(noBom); got != nil {
		t.Fatalf("bom-less cjk utf-16 (NUL density) must fall back, got %.20q", got)
	}
	// 二进制垃圾（NUL 门）：0x00/0xFF 交替——0xFF 使 UTF-8 判定失守落入
	// GB18030 兜底分支，恒成功解码面前 NUL 门拦截（必改2 主案例形态：
	// 容器字节被误当 GBK 的旁路变体）
	junk := make([]byte, 512)
	for i := range junk {
		if i%2 == 0 {
			junk[i] = 0x00
		} else {
			junk[i] = 0xFF
		}
	}
	if got := normalizeTextBytes(junk); got != nil {
		t.Fatalf("binary junk must fall back, got %.20q", got)
	}
	// 空输入
	if got := normalizeTextBytes(nil); got != nil {
		t.Fatalf("empty input must fall back, got %q", got)
	}
}

func TestSanitizeEmbedName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"report.html", "report.html"},
		{`C:\Users\e2e-host\需求文档.html`, "需求文档.html"}, // 源路径形态 + 中文
		{"dir1/dir2/x.zip", "x.zip"},                 // Unix 源路径
		{"a\x00b.txt", "ab.txt"},                     // 控制字符剔除
		{"  spaced.bin  ", "spaced.bin"},             // 空白修剪
		{"..", ""},                                   // 纯点
		{"", ""},                                     // 空
		{"\x01\x02", ""},                             // 全控制字符
	}
	for _, c := range cases {
		if got := sanitizeEmbedName(c.in); got != c.want {
			t.Errorf("sanitizeEmbedName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// 非 UTF-8（ANSI 代码页文件名）→ 回落 ""（不给 Content-Disposition 塞乱码）
	if got := sanitizeEmbedName(string([]byte{0xD6, 0xD0, 0xCE, 0xC4})); got != "" { // GBK「中文」
		t.Errorf("non-UTF-8 name must fall back, got %q", got)
	}
}

// ---- 嵌入对象原始文件名还原 + 可预览类型直览（P-20261118-1） ----

func TestDecodeEmbedName(t *testing.T) {
	// GBK 实证样本还原（本提案主诉：P-7 时回落 .bin 的字节序列）
	if got := decodeEmbedName(fx.GbkSampleName); got != "根据IP关联组织.html" {
		t.Fatalf("GBK sample = %q", got)
	}
	// 全链：GBK 抽名经净化后可出头（P-7 链在此断，现接通）
	if got := sanitizeEmbedName(decodeEmbedName(fx.GbkSampleName)); got != "根据IP关联组织.html" {
		t.Fatalf("GBK full chain = %q", got)
	}
	// UTF-8 valid 原样直通（两级序第一级）
	if got := decodeEmbedName("report.html"); got != "report.html" {
		t.Fatalf("UTF-8 passthrough = %q", got)
	}
	// 解码错配噪声回落：含替换符（非法序列映 U+FFFD 的 GB18030 恒成功面）
	if got := decodeEmbedName(string([]byte{0xE9, 0x00})); got != "" {
		t.Fatalf("replacement-char noise must fall back, got %q", got)
	}
	if got := decodeEmbedName(string([]byte{0xFF, 0xFE, 0xFF, 0xFE})); got != "" {
		t.Fatalf("replacement-char noise must fall back, got %q", got)
	}
	// 合法 GB18030 双字节区照常解码（0x8140 → 「丂」）——采纳门槛只拒
	// 替换符/净化为空，不误拒真实 ANSI 名里的生僻码位
	if got := decodeEmbedName(string([]byte{0x81, 0x40})); got != "丂" {
		t.Fatalf("legal GB18030 pair must decode, got %q", got)
	}
}

// ── 真实容器字节轨（P-20261118-7 评审必改3 硬验收；P-20261118-10 夹具
// 保真纪律——字节级精确捕获） ──
//
// testdata/oleobject{1,2}-real-layout.bin：真实 Word 写入器 docx 内
// word/embeddings/oleObject{1,2}.bin 的**字节级精确捕获**（P-20261118-10
// 夹具保真纪律：P-7 的「按取证形态逐字节复刻」夹具与线上容器字节不一致
// ——流长 54784 vs 53334、doctype 位 106 vs 179、尾部文本 padding vs
// UTF-16 元数据块——测试绿而真实文件全灭的**第四次夹具盲区**，新形态=
// 夹具与线上字节不一致，根治面=capture-from-live+SHA 钉住）：
//
//	捕获来源：真实分享 docx（分级管理授权需求 V1，2026-11-19 经 /raw 下载
//	解包 word/embeddings/ 条目；正文 UTF-8 原型页、控制字段 GBK、尾随
//	元数据块 UTF-16LE——真实写入器全貌）
//	保真核对：sha256sum 比对下方双锚（改夹具必先重取证）；本测内嵌
//	SHA-256+容器尺寸双锚断言，夹具漂移即红
//	ole2 分歧点注记（本案教训压缩表达）：ole2 复刻夹具当时流布局与线上
//	几乎一致、total 同为 23500，分歧仅在容器 padding 与「total 是否计入
//	尾随元数据」语义——形似不等于字节等值，保真只能靠捕获
//	GBK 转码轨注记（评审建议2）：两真实容器正文均 UTF-8，本表失去 GBK 轨
//	——GBK 转码由 TestEmbedPreviewPayloadFamilies 与
//	TestDocxEmbedPreviewTextEncoding 既有覆盖，此处不重复
func TestDocxEmbedRealFixtureBytes(t *testing.T) {
	for _, tc := range []struct {
		file      string
		size      int    // 容器尺寸（双锚之一）
		sha256    string // 容器 SHA-256（双锚之二，钉住捕获面防再漂移）
		name      string // GBK 还原名（ole10NativeFileName 链）
		total     uint32 // Ole10Native 流头声明总长（不含自身 4B）
		bodyStart int64  // 扫描采纳候选的正文起点（=doctype 起点）
		dataLen   int64  // 扫描采纳候选的声明数据长度
		title     string // 正文 <title> 可读标记（经全链后应可见）
		trail     int64  // total+4-bodyEnd：载荷后尾随元数据块字节数
	}{
		{"oleobject1-real-layout.bin", 56320,
			"1f104e2fec680dcd440335f72dd22838ea2af07074cc610ade59551bf7e8a3f5",
			"分级授权管理-界面原型.html", 53330, 179, 52915, "分级授权管理 - 界面原型", 240},
		{"oleobject2-real-layout.bin", 26112,
			"25c0987c0b3328825fd3e3eb257cbf581100333fcb8955b0989a09fbbb846b68",
			"根据IP关联组织.html", 23500, 141, 23159, "根据IP关联组织", 204},
	} {
		bin, err := os.ReadFile(filepath.Join("testdata", tc.file))
		if err != nil {
			t.Fatalf("read %s: %v", tc.file, err)
		}
		// 双锚 1：容器尺寸
		if len(bin) != tc.size {
			t.Fatalf("%s: container size = %d, want %d (fixture drifted from capture)", tc.file, len(bin), tc.size)
		}
		// 双锚 2：SHA-256（字节级保真钉死）
		if got := sha256.Sum256(bin); hex.EncodeToString(got[:]) != tc.sha256 {
			t.Fatalf("%s: sha256 = %x, want %s (fixture drifted from capture)", tc.file, got[:], tc.sha256)
		}
		if !bytes.HasPrefix(bin, CFBMagic) {
			t.Fatalf("%s must be a CFB container", tc.file)
		}
		stream := cfbReadStreamHead(bin, ole10NativeStreamName, ole10BodyMaxBytes)
		if stream == nil {
			t.Fatalf("%s: Ole10Native stream unreadable", tc.file)
		}
		// 取证口径 1：流头声明总长（ole1 53330 含尾随元数据块；ole2 23500）
		if got := binary.LittleEndian.Uint32(stream[:4]); got != tc.total {
			t.Fatalf("%s: stream total = %d, want %d", tc.file, got, tc.total)
		}
		// 名抽取（P-2 链）与正文抽取（P-7 扫描式 + P-10 锚强族单侧上界）
		// 都须在真实布局上成立
		if got := ole10NativeFileName(stream); got != tc.name {
			t.Fatalf("%s: name = %q, want %q", tc.file, got, tc.name)
		}
		body := ole10NativeBody(stream, "html")
		if body == nil {
			t.Fatalf("%s: body extraction must succeed on the real layout", tc.file)
		}
		// 扫描采纳候选钉死：正文=stream[bodyStart:bodyStart+dataLen]（线上
		// 实证 doctype 起点=bodyStart、长度前缀位 0x3D/0x36 假候选由内容
		// 门拒——扫描必须命中唯一正确候选而非更早垃圾）
		if int64(len(body)) != tc.dataLen || !bytes.Equal(body, stream[tc.bodyStart:tc.bodyStart+tc.dataLen]) {
			t.Fatalf("%s: body = %dB at wrong slice, want stream[%d:%d] (%dB)",
				tc.file, len(body), tc.bodyStart, tc.bodyStart+tc.dataLen, tc.dataLen)
		}
		if !bytes.HasPrefix(body, []byte("<!DOCTYPE")) || !bytes.HasSuffix(body, []byte("</html>\n")) {
			t.Fatalf("%s: body must start at doctype and end at </html>, got head %.24q tail %.24q",
				tc.file, body[:24], body[len(body)-24:])
		}
		// 新布局语义钉死（第四次盲区的取证签名）：bodyEnd **严格小于**
		// 声明流尾——total 计入载荷后尾随元数据块（复刻夹具当时是
		// bodyEnd==total+4 的等号形态，正是两处失真之一）
		bodyEnd := tc.bodyStart + tc.dataLen
		if gap := int64(tc.total) + 4 - bodyEnd; gap != tc.trail {
			t.Fatalf("%s: trailing gap = %d, want %d (total must count trailing metadata block)",
				tc.file, gap, tc.trail)
		}
		// 编码规范化放行（修前锚点回退把尾块带进 payload → GB18030 兜底
		// RuneError 门判死 binary-guard；干净切片必须过）
		if normalizeTextBytes(body) == nil {
			t.Fatalf("%s: clean body must pass normalizeTextBytes", tc.file)
		}
		// 统一抽取判定全链（P-7 embedPreviewPayload）：diag 无 + 净本字节
		// 等值（UTF-8 四级序第一级原样直出）+ 内容可读
		payload, diag := EmbedPreviewPayload(bin, "html")
		if diag != EmbedDiagNone || payload == nil {
			t.Fatalf("%s: preview payload failed, diag=%q", tc.file, diag)
		}
		if !bytes.Equal(payload, body) {
			t.Fatalf("%s: preview payload %dB must equal scan body %dB", tc.file, len(payload), len(body))
		}
		if !utf8.Valid(payload) || !bytes.Contains(payload, []byte(tc.title)) {
			t.Fatalf("%s: payload must be readable utf-8 with %q visible", tc.file, tc.title)
		}
	}
}

// TestDocxEmbedPreviewRealLayoutAndPdf 真实布局端到端 + pdf 接线补齐
//（P-20261118-7 评审必改2/必改3 服务端到端半边，testdata 字节轨见
// TestDocxEmbedRealFixtureBytes）：①真实 Word 取证布局容器（源路径后含
// 空 ASCIZ+[03 00]+0x36 长度前缀+临时路径）preview=1 供给抽取出的正文
// ——旧刚性解析在此全灭弹下载框；②CFB 包裹的 pdf 不再按 application/pdf
// inline 容器原始字节出坏页——抽取产物（%PDF 正文）供给；③ui=1 壳页
// iframe 指向 preview=1 的供给面与壳页准入同链
