package fixtures

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

// 夹具复刻的 CFB/OPC 形态常量（与 filepreview 内部实现取值同源，但夹具
// 不得依赖被测包的非导出标识——夹具包与生产包的唯一联系是「构造出的字节」。
// 值来自格式规范：Ole10Native 流目录名带 \x01 前缀；CFB 规范流尺寸 < 4096
// 落 mini-stream）
const (
	ole10NativeStreamName = "\x01Ole10Native"
	cfbMiniCutoff         = 4096
)

// ── 跨包测试夹具构造器（P-20261119-4 抽包下沉的配套面） ──
//
// 本文件导出的构造器**仅供测试消费**（docx 渲染面/嵌入端点测试的 zip 与
// CFB/Ole10Native 容器夹具）：生产链不调用、语义以各测试注释为准。导出的
// 原因是结构性而非风格：夹具随渲染面下沉本包后，share 侧端点测试与主应用
// api 侧端点测试仍需构造同形容器——跨包测试文件无法共享非导出标识，多处
// 手抄夹具是漂移面（夹具保真纪律 P-20261118-10：字节面必须单一落字点），
// 故单一导出 + 消费侧短名别名（见 share/docxfixture_test.go）。

// BuildDocx 构造最小 docx 包（zip + word/document.xml）。
// 内容含标题/列表/粗体/XSS 探针/表格，覆盖解析器的主要映射分支
func BuildDocx(t *testing.T, documentXML string) []byte {
	t.Helper()
	return BuildDocxFull(t, documentXML, "", nil)
}

// BuildDocxFull 构造带 rels 与 media 部件的 docx 包（图片链路用例）。
// media 键 = zip 条目名（如 word/media/image1.png）
func BuildDocxFull(t *testing.T, documentXML, relsXML string, media map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(documentXML)); err != nil {
		t.Fatal(err)
	}
	if relsXML != "" {
		r, err := zw.Create("word/_rels/document.xml.rels")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.Write([]byte(relsXML)); err != nil {
			t.Fatal(err)
		}
	}
	for name, data := range media {
		m, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := m.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// PNGTestBytes PNG 魔数 + 伪载荷（嗅探只认头 8 字节，本套不解码图片）
var PNGTestBytes = append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, []byte("fake-png-payload")...)

// relsShell 最小 rels 包裹（命名空间与 Word 实包同形）
const RelsShell = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>`

func ImgRel(id, target string) string {
	return `<Relationship Id="` + id + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="` + target + `"/>`
}

// blipXML 新形态图片引用（w:drawing/a:blip）
func BlipXML(rid string) string {
	return `<w:p><w:r><w:drawing><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="` + rid + `" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></a:graphic></w:drawing></w:r></w:p>`
}

// pictXML 老形态图片引用（w:pict/v:imagedata）
func PictXML(rid string) string {
	return `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:imagedata r:id="` + rid + `" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></v:shape></w:pict></w:r></w:p>`
}

func EmbedRel(id, typ, target string) string {
	return `<Relationship Id="` + id + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/` + typ + `" Target="` + target + `"/>`
}

// objectXML 嵌入对象正文形态（老 Word 实包同构）：w:object 内图标
// v:shape/v:imagedata 在前、o:OLEObject 在后（文档序天然「图标在前、
// 嵌入块在后」）；iconRID/oleRID 为空时省略对应元素（裸 OLEObject /
// 纯图标 object 形态）
func ObjectXML(iconRID, oleRID, progID string) string {
	s := `<w:p><w:r><w:object>`
	if iconRID != "" {
		s += `<v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:20pt"><v:imagedata r:id="` + iconRID + `" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></v:shape>`
	}
	s += `<o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Embed" ProgID="` + progID + `"`
	if oleRID != "" {
		s += ` r:id="` + oleRID + `" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	}
	return s + `/></w:object></w:r></w:p>`
}

// ---- CFB 最小读 + Ole10Native 抽取（P-20261116-7） ----

// cfbTestSig CFB 头部魔数（BuildCFB 夹具与真实容器共用锚）
const cfbTestSig = "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"

// BuildCFB 构造最小 CFB 复合文档夹具（与真实 Word 嵌入的 oleObject*.bin
// 同构）：512/4096 双扇区规格、Ole10Native 流 mini/常规双链路径可配、
// FAT 可注入环、头部字段可破坏（坏结构回落路径用）
func BuildCFB(t *testing.T, sectSize int, payload []byte, mini bool, mutate func(header []byte, fat []uint32)) []byte {
	t.Helper()
	put32 := func(b []byte, off int, v uint32) { binary.LittleEndian.PutUint32(b[off:], v) }
	var shift uint16
	switch sectSize {
	case 512:
		shift = 9
	case 4096:
		shift = 12
	default:
		t.Fatalf("unsupported sect size %d", sectSize)
	}
	endOfChain := uint32(0xFFFFFFFE)
	free := uint32(0xFFFFFFFF)
	fatSect := uint32(0xFFFFFFFD)

	// 扇区规划：0=FAT 1=目录 2..=流数据（常规链）或 mini 容器，末位 miniFAT
	next := uint32(2)
	fatTab := make([]uint32, 2) // 0=FAT 1=目录，下面逐项填
	fatTab[0], fatTab[1] = fatSect, endOfChain
	var streamSectors, miniFATSectors []uint32
	if mini {
		n := (len(payload) + sectSize - 1) / sectSize
		if n < 1 {
			n = 1
		}
		for i := 0; i < n; i++ {
			streamSectors = append(streamSectors, next)
			fatTab = append(fatTab, free) // 占位后填
			if i < n-1 {
				fatTab[len(fatTab)-1] = next + 1
			} else {
				fatTab[len(fatTab)-1] = endOfChain
			}
			next++
		}
		miniFATSectors = append(miniFATSectors, next)
		fatTab = append(fatTab, endOfChain)
		next++
	} else {
		n := (len(payload) + sectSize - 1) / sectSize
		if n < 1 {
			n = 1
		}
		for i := 0; i < n; i++ {
			streamSectors = append(streamSectors, next)
			fatTab = append(fatTab, free)
			if i < n-1 {
				fatTab[len(fatTab)-1] = next + 1
			} else {
				fatTab[len(fatTab)-1] = endOfChain
			}
			next++
		}
	}

	buf := make([]byte, sectSize*(int(next)+1)) // 头部占满第一物理扇区
	copy(buf, cfbTestSig)
	binary.LittleEndian.PutUint16(buf[30:32], shift) // 扇区规格
	binary.LittleEndian.PutUint16(buf[32:34], 6)     // 迷你扇区 64B（恒定）
	put32(buf, 44, 1)                                // 0x2C FAT 扇区数
	put32(buf, 48, 1)                                // 0x30 首目录扇区
	put32(buf, 56, cfbMiniCutoff)                    // 0x38 mini 截断值
	if mini {
		put32(buf, 60, miniFATSectors[0])           // 0x3C 首 miniFAT 扇区
		put32(buf, 64, uint32(len(miniFATSectors))) // 0x40
	} else {
		put32(buf, 60, endOfChain)
		put32(buf, 64, 0)
	}
	put32(buf, 68, endOfChain) // 0x44 首扩展 DIFAT 扇区（无链）
	put32(buf, 72, 0)          // 0x48 扩展 DIFAT 扇区数
	put32(buf, 76, 0)          // DIFAT[0] = FAT 在 0 号扇区
	for i := 1; i < 109; i++ {
		put32(buf, 76+4*i, free)
	}

	// FAT 扇区
	sec := buf[sectSize : 2*sectSize]
	for i, v := range fatTab {
		binary.LittleEndian.PutUint32(sec[4*i:], v)
	}
	// 目录扇区：根项（root，承载 mini-stream 定位）+ Ole10Native 流项
	dir := buf[2*sectSize : 3*sectSize]
	dirEntry := func(name string, typ byte, start uint32, size uint64) {
		nl := 0
		for _, r := range name {
			binary.LittleEndian.PutUint16(dir[nl:], uint16(r))
			nl += 2
		}
		binary.LittleEndian.PutUint16(dir[nl:], 0)
		nl += 2
		binary.LittleEndian.PutUint16(dir[64:], uint16(nl))
		dir[66] = typ
		binary.LittleEndian.PutUint32(dir[116:], start)
		binary.LittleEndian.PutUint64(dir[120:], size)
		dir = dir[128:]
	}
	if mini {
		rootSize := uint64((len(payload) + 63) / 64 * 64)
		dirEntry("Root Entry", 5, streamSectors[0], rootSize)
		dirEntry(ole10NativeStreamName, 2, 0, uint64(len(payload))) // mini 链从 miniFAT[0] 起
	} else {
		dirEntry("Root Entry", 5, endOfChain, 0)
		dirEntry(ole10NativeStreamName, 2, streamSectors[0], uint64(len(payload)))
	}
	// 流数据 / mini 容器扇区（扇区 n 的文件偏移 = (n+1)*sectSize，头部占满
	// 第一物理扇区——与读取侧 sectorAt 同一口径）
	if mini {
		per := sectSize / 64 // 每容器扇区承载的迷你扇区数
		for i := 0; i*64 < len(payload)+63; i++ {
			sn := int(streamSectors[0]) + i/per
			off := (sn+1)*sectSize + (i%per)*64
			end := i*64 + 64
			if end > len(payload) {
				end = len(payload)
			}
			if i*64 < len(payload) {
				copy(buf[off:off+(end-i*64)], payload[i*64:end])
			}
		}
		// miniFAT 扇区：迷你扇区链 [0..k-2]→next，[k-1]→ENDOFCHAIN
		k := (len(payload) + 63) / 64
		if k < 1 {
			k = 1
		}
		mf := buf[(int(miniFATSectors[0])+1)*sectSize:][:sectSize]
		for i := 0; i < sectSize/4; i++ {
			switch {
			case i < k-1:
				binary.LittleEndian.PutUint32(mf[4*i:], uint32(i+1))
			case i == k-1:
				binary.LittleEndian.PutUint32(mf[4*i:], endOfChain)
			default:
				binary.LittleEndian.PutUint32(mf[4*i:], free)
			}
		}
	} else {
		copy(buf[(int(streamSectors[0])+1)*sectSize:], payload)
	}
	if mutate != nil {
		mutate(buf, fatTab)
	}
	return buf
}

// Ole10Payload 合法 Ole10Native 流头（无标志布局）：u32 总长 + ASCIZ 文件名
// + 变体余量。P-20261118-2 之前这是唯一夹具——按解析器自身假设构造（无
// 标志字段、文件名直接起于偏移 4），测试全绿而真实 Word 产物全灭的测试
// 盲区根因；与 ole10FlaggedPayload 双轨并存
func Ole10Payload(name string, junk int) []byte {
	b := make([]byte, 4+len(name)+1+junk)
	binary.LittleEndian.PutUint32(b, uint32(len(name)+1+junk))
	copy(b[4:], name)
	return b
}

// Ole10FlaggedPayload 真实 Word 写入器布局（P-20261118-2 必改④夹具双轨）：
// u32 总长 + 2B 标志字段（实证恒 0x0002）+ ASCIZ 文件名 + 变体余量
func Ole10FlaggedPayload(name string, junk int) []byte {
	b := make([]byte, 4+2+len(name)+1+junk)
	binary.LittleEndian.PutUint32(b, uint32(2+len(name)+1+junk))
	binary.LittleEndian.PutUint16(b[4:], 0x0002)
	copy(b[6:], name)
	return b
}

// Ole10FullPayload 完整布局流头（P-20261118-3 正文抽取夹具，有标志形态）：
// u32 总长（不含自身 4B——与真实取证字节 0x5BCC 口径一致）+ 2B 标志 +
// ASCIZ 名 + ASCIZ 源路径 + ASCIZ 临时路径 + u32 数据长度 + 正文——
// ole10NativeBody 布局解析与乱码根除端到端的全字段夹具
func Ole10FullPayload(name, src, tmp string, body []byte) []byte {
	b := make([]byte, 0, 4+2+len(name)+1+len(src)+1+len(tmp)+1+4+len(body))
	var u32 [4]byte
	binary.LittleEndian.PutUint32(u32[:], uint32(2+len(name)+1+len(src)+1+len(tmp)+1+4+len(body)))
	b = append(b, u32[:]...)
	b = append(b, 0x02, 0x00)
	b = append(b, name...)
	b = append(b, 0)
	b = append(b, src...)
	b = append(b, 0)
	b = append(b, tmp...)
	b = append(b, 0)
	binary.LittleEndian.PutUint32(u32[:], uint32(len(body)))
	b = append(b, u32[:]...)
	return append(b, body...)
}

// Ole10RealLayoutPayload 真实 Word 写入器完整布局（P-20261118-7 字节级取证
// 形态，假设布局 ole10FullPayload 的真实对照轨）：u32 总长（不含自身 4B）
// + 2B 标志 0x0002 + ASCIZ 名 + ASCIZ 源路径 + 空 ASCIZ + [03 00] + u32
// 临时路径长度前缀（含结尾 NUL——2026-11-18 取证 0x36=54 与 53 字节 GBK
// 临时路径+NUL 自洽）+ ASCIZ 临时路径 + u32 数据长度 + 正文。extras 为源
// 路径之后的额外 ASCIZ 字段变体（0/1/2/3 变体矩阵；空串=空 ASCIZ）。
// 真实取证里 [03 00] 使旧刚性解析在源路径后把「03 00 36 00」读成
// 0x00360003≈3.4MB 而越界拒——本 builder 逐字节复刻该形态
func Ole10RealLayoutPayload(name, src string, extras []string, tmp string, body []byte) []byte {
	prefix := uint32(len(tmp) + 1) // 临时路径长度前缀：含结尾 NUL（0x36 取证口径）
	b := make([]byte, 0, 4+2+len(name)+1+len(src)+1+len(extras)+2+4+len(tmp)+1+4+len(body))
	var u32 [4]byte
	total := 2 + len(name) + 1 + len(src) + 1 + len(extras) + 1 + 2 + 4 + len(tmp) + 1 + 4 + len(body) // +1=空 ASCIZ
	binary.LittleEndian.PutUint32(u32[:], uint32(total))
	b = append(b, u32[:]...)
	b = append(b, 0x02, 0x00) // 标志字段（真实 Word 写入器恒有）
	b = append(b, name...)
	b = append(b, 0)
	b = append(b, src...)
	b = append(b, 0)
	for _, x := range extras { // 额外 ASCIZ 变体字段
		b = append(b, x...)
		b = append(b, 0)
	}
	b = append(b, 0x00)       // 空 ASCIZ（取证控制字段）
	b = append(b, 0x03, 0x00) // [03 00]（取证控制字段）
	binary.LittleEndian.PutUint32(u32[:], prefix)
	b = append(b, u32[:]...) // 长度前缀（取证 0x36=54 形态）
	b = append(b, tmp...)
	b = append(b, 0)
	binary.LittleEndian.PutUint32(u32[:], uint32(len(body)))
	b = append(b, u32[:]...)
	return append(b, body...)
}

// GbkRealTempPath 真实取证临时路径形态（53 字节 GBK + NUL = 前缀 0x36=54
// 自洽；「admin」系任务书字节级取证的原文，Windows 缺省占位形态非个人路径）
var GbkRealTempPath = "C:\\Users\\admin\\AppData\\Local\\Temp\\" + GbkSampleName

// ---- 嵌入对象原始文件名还原 + 可预览类型直览（P-20261118-1） ----

// GbkSampleName 任务书字节级取证的实证样本：Ole10Native 流头 GBK 编码的
// 「根据IP关联组织.html」（b8f9=根 bedd=据 4950="IP" b9d8=关 c1aa=联
// d7e9=组 d6af=织 2e="." 68746d6c="html"）——中文 Windows OLE Package 的
// ANSI 代码页形态
var GbkSampleName = string([]byte{
	0xB8, 0xF9, 0xBE, 0xDD, 'I', 'P', 0xB9, 0xD8, 0xC1, 0xAA, 0xD7, 0xE9, 0xD6, 0xAF,
	'.', 'h', 't', 'm', 'l',
})

// Utf16Bytes 测试夹具（跨包端点测试共用）：字符串 → UTF-16 字节（可选 BOM、可指定端序）
func Utf16Bytes(s string, bo binary.ByteOrder, bom bool) []byte {
	u := utf16.Encode([]rune(s))
	var b []byte
	if bom {
		if bo == binary.LittleEndian {
			b = append(b, 0xFF, 0xFE)
		} else {
			b = append(b, 0xFE, 0xFF)
		}
	}
	for _, v := range u {
		var pair [2]byte
		bo.PutUint16(pair[:], v)
		b = append(b, pair[:]...)
	}
	return b
}
