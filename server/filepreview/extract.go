package filepreview

import (
	"bytes"
	"encoding/binary"
	"path"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// ── CFB 最小读 + Ole10Native 文件名抽取（P-20261116-7 best-effort） ──
//
// 目标只有一件事：从 legacy OLE 容器（word/embeddings/*.bin，CFB 复合
// 文档）读出 "\x01Ole10Native" 流头部的原始文件名，让下载名诚实
//（oleObject1.bin → 需求文档.html）。红线：魔数/结构/长度任何疑点即
// 回落 .bin 直供，绝不产出错误页——抽取失败只影响文件名观感。零新依赖
// 自研：512/4096 双扇区规格、DIFAT/FAT/miniFAT 双链（<4KB 流落
// mini-stream，双链不可省）、128 字节目录项；只读流头不读正文（文件名
// 在前 256 字节内），正文字节仍由端点整体供给。

const (
	// ole10NativeStreamName Ole10Native 流的目录名（\x01 前缀是 OLE
	// 内部流约定；以 UTF-16LE 编码进目录项）
	ole10NativeStreamName = "\x01Ole10Native"
	// ole10NativeHeadBytes 流头读取上限：4 字节总长 + ASCIZ 文件名（255
	// 字节内）+ 变体余量；4KB 封顶，嵌入正文不因此多进内存
	ole10NativeHeadBytes = 4096
	// ole10NameHeadBytes 渲染侧抽名的流头封顶（P-20261118-1）：文件名在流
	// 首 ≤256 字节，单扇区封顶即够——链读不追流尾，避开「读满 4KB 撞 zip
	// 读头物理边界」的 fail-closed 误伤（见 ole10NameScanBytes）
	ole10NameHeadBytes = 512
	// ole10NameScanBytes 渲染侧抽名的 zip 解压读头：CFB 512B 规格的物理
	// 布局（头+FAT+目录+流首扇区）= 4 扇区 2KB，4KB 封顶全覆盖。4096B
	// 规格的 CFB 头部即占满 4KB（目录在 8KB+），读头不可及 → fail-closed
	// 回落 .bin（观感降级红线不变；该规格罕见——中文 Windows OLE Package
	// 实证为 512 规格）。16 嵌入 × 4KB = 64KB 总解压头预算（评审必改③口径）
	ole10NameScanBytes = 4096
	// cfbMiniCutoff CFB 规范：流尺寸 < 4096 落 mini-stream（64B 迷你扇区）
	cfbMiniCutoff = 4096
	// cfbMaxChainSteps 链步上限（防环兜底；合法链长以文件扇区数为上界，
	// 远小于此值）
	cfbMaxChainSteps = 1 << 16
)

// CFB 特殊链值（MS-CFB §2.3）
const (
	cfbFreeSect   = 0xFFFFFFFF
	cfbEndOfChain = 0xFFFFFFFE
)

// cfbDirEntry 目录项的抽取所需子集（兄弟/child 索引与时间戳无关紧要）
type cfbDirEntry struct {
	name  string
	typ   byte // 1=storage 2=stream 5=root（0=未用/4=保留）
	start uint32
	size  uint64
}

// parseCFBDirEntry 128 字节目录项：0h UTF-16LE 名、40h 名长（含结尾
// NUL，字节）、42h 类型、74h 起始扇区、78h 流尺寸（64 位）
func parseCFBDirEntry(b []byte) *cfbDirEntry {
	nlen := int(binary.LittleEndian.Uint16(b[64:66]))
	if nlen < 2 || nlen > 64 || nlen%2 != 0 {
		return nil
	}
	raw := b[:nlen-2] // 去掉结尾 UTF-16 NUL
	runes := make([]rune, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		runes = append(runes, rune(binary.LittleEndian.Uint16(raw[i:i+2])))
	}
	return &cfbDirEntry{
		name:  string(runes),
		typ:   b[66],
		start: binary.LittleEndian.Uint32(b[116:120]),
		size:  binary.LittleEndian.Uint64(b[120:128]),
	}
}

// cfbReadStreamHead 在 CFB 复合文档字节里按名定位流并返回流头（至多
// head 字节）。魔数/结构/长度任何疑点返回 nil——调用方回落 .bin 直供名
func cfbReadStreamHead(data []byte, streamName string, head int) []byte {
	// 头部：8 字节魔数 + 扇区规格（9→512B / 12→4096B）+ 迷你扇区规格
	//（6→64B，恒定）
	if len(data) < 512 || !bytes.Equal(data[:8], CFBMagic) {
		return nil
	}
	var sectSize int
	switch binary.LittleEndian.Uint16(data[30:32]) {
	case 9:
		sectSize = 512
	case 12:
		sectSize = 4096
	default:
		return nil
	}
	if binary.LittleEndian.Uint16(data[32:34]) != 6 {
		return nil
	}
	// 扇区 n 的文件偏移：头部占满第一个物理扇区（512B 规格即 512B 头；
	// 4096B 规格头后 padding 到 4096），扇区 0 紧随其后
	sectorAt := func(n uint32) ([]byte, bool) {
		off := int64(sectSize) * (int64(n) + 1)
		if off+int64(sectSize) > int64(len(data)) {
			return nil, false
		}
		return data[off : off+int64(sectSize)], true
	}
	// FAT 扇区表 = 头部 DIFAT（109 项）+ DIFAT 链（>109 FAT 扇区的大文件；
	// 每个链扇区 (sectSize/4-1) 项 + 末项 = 下一 DIFAT 扇区）
	fatSects := make([]uint32, 0, 109)
	for i := 0; i < 109; i++ {
		if v := binary.LittleEndian.Uint32(data[76+4*i : 80+4*i]); v != cfbFreeSect {
			fatSects = append(fatSects, v)
		}
	}
	if n := binary.LittleEndian.Uint32(data[72:76]); n > 0 {
		cur := binary.LittleEndian.Uint32(data[68:72])
		for step := 0; step < int(n) && step < cfbMaxChainSteps && cur != cfbEndOfChain; step++ {
			sec, ok := sectorAt(cur)
			if !ok {
				return nil
			}
			for j := 0; j < sectSize/4-1; j++ {
				if v := binary.LittleEndian.Uint32(sec[4*j : 4*j+4]); v != cfbFreeSect {
					fatSects = append(fatSects, v)
				}
			}
			cur = binary.LittleEndian.Uint32(sec[sectSize-4 : sectSize])
		}
	}
	// FAT 扇区数超过文件物理扇区数 = 结构撒谎
	if len(fatSects) == 0 || len(fatSects) > len(data)/sectSize {
		return nil
	}
	// FAT 数组：DIFAT 登记的 FAT 扇区按序覆盖各自的条目区间（规范语义）
	readTable := func(sectList []uint32) []uint32 {
		tab := make([]uint32, 0, len(sectList)*sectSize/4)
		for _, sn := range sectList {
			sec, ok := sectorAt(sn)
			if !ok {
				return nil
			}
			for j := 0; j < sectSize/4; j++ {
				tab = append(tab, binary.LittleEndian.Uint32(sec[4*j:4*j+4]))
			}
		}
		return tab
	}
	fat := readTable(fatSects)
	if fat == nil {
		return nil
	}
	// 链游标：从 start 沿表走到 ENDOFCHAIN，步数与读量双封顶
	walk := func(tab []uint32, start uint32, maxSectors int) []uint32 {
		chain := make([]uint32, 0, 4)
		seen := make(map[uint32]bool, 4)
		for cur := start; cur != cfbEndOfChain && len(chain) < maxSectors; {
			if seen[cur] || int(cur) >= len(tab) {
				return nil // 环/越界：结构疑点
			}
			seen[cur] = true
			chain = append(chain, cur)
			cur = tab[cur]
		}
		if len(chain) == 0 {
			return nil
		}
		return chain
	}
	// 链读：每扇区 sectSize 字节顺序累计，到 head 封顶（只读流头不读正文）
	readChain := func(chain []uint32, locate func(uint32) ([]byte, bool)) []byte {
		var out []byte
		for _, n := range chain {
			sec, ok := locate(n)
			if !ok {
				return nil
			}
			out = append(out, sec...)
			if len(out) >= head {
				break
			}
		}
		if len(out) == 0 {
			return nil
		}
		if len(out) > head {
			out = out[:head]
		}
		return out
	}
	// 目录：firstDirSector 沿 FAT 链逐扇区、扇区内逐 128B 目录项，找目标
	// 流与根项（根项承载 mini-stream 定位；两项齐了提前收口）
	firstDir := binary.LittleEndian.Uint32(data[48:52])
	maxSectors := len(data)/sectSize + 1
	var target, rootEntry *cfbDirEntry
	for _, n := range walk(fat, firstDir, maxSectors) {
		sec, ok := sectorAt(n)
		if !ok {
			return nil
		}
		for j := 0; j+128 <= sectSize; j += 128 {
			e := parseCFBDirEntry(sec[j : j+128])
			if e == nil {
				continue
			}
			if e.typ == 5 && rootEntry == nil {
				rootEntry = e
			}
			if e.typ == 2 && e.name == streamName && target == nil {
				target = e
			}
		}
		if target != nil && rootEntry != nil {
			break
		}
	}
	if target == nil {
		return nil
	}
	// 流头读取：尺寸 < 4096 走 mini 链（miniFAT 定位迷你扇区、迷你扇区
	// 落在根项的 mini-stream 内），否则走常规 FAT 链——双链缺一即疑点
	if target.size < cfbMiniCutoff {
		if rootEntry == nil {
			return nil
		}
		miniFAT := readTable(walk(fat, binary.LittleEndian.Uint32(data[60:64]), maxSectors))
		if miniFAT == nil {
			return nil
		}
		// mini-stream 本体 = 根项的常规链；只需前若干迷你扇区
		need := ((head + 63) / 64) * 64 // 64B 迷你扇区对齐的读取上限
		var mini []byte
		for _, n := range walk(fat, rootEntry.start, need/sectSize+1) {
			sec, ok := sectorAt(n)
			if !ok {
				return nil
			}
			mini = append(mini, sec...)
			if len(mini) >= need {
				break
			}
		}
		miniAt := func(n uint32) ([]byte, bool) {
			off := int64(n) * 64
			if off+64 > int64(len(mini)) {
				return nil, false
			}
			return mini[off : off+64], true
		}
		return readChain(walk(miniFAT, target.start, head/64+1), miniAt)
	}
	return readChain(walk(fat, target.start, head/sectSize+1), sectorAt)
}

// ole10NativeFileName Ole10Native 流头 → 原始文件名（已过 decodeEmbedName
// → sanitizeEmbedName 全链的 UTF-8 名；调用方外层再跑同链幂等直通）。
//
// 布局事实（启发式属性入码：Ole10Native 无权威规范文档，[MS-OLEDS] 的
// 描述与真实写入器存在差异——本函数是启发式，误选代价=名字错，可下载性
// 与安全面不受影响，回落链有底）：前 4 字节声明总长（是否含自身口径不一），
// 其后两种互斥布局：
//
//	无标志写入器：偏移 4 直接起 ASCIZ 文件名（部分写入器/合成夹具形态）；
//	有标志写入器：偏移 4-5 是 2 字节标志字段（真实 Word OLE Package 恒有，
//	2026-11-18 真实分享实证 0x0002），偏移 6 起 ASCIZ GBK 文件名，随后
//	源路径/临时名/尺寸/正文——与抽取无关不解析。
//
// P-20261118-2 缺陷：单候选 IndexByte(stream[4:]) 在有标志布局命中标志
// 高位 0x00 → 名字恒 "\x02" → 净化空回落 .bin（真实产物全灭、按解析器
// 假设构造的合成夹具却全绿的测试盲区）。修复=双候选仲裁：
//
//	候选 A=偏移 4、候选 B=偏移 6，逐候选跑既有解码+净化全链打分（GBK
//	双字节尾字节合法域含 0x5C，raw 字节上打分会撞假分隔符误切——必须
//	解码+净化后打分）；净化空=唯一硬淘汰；「含扩展名点」「长度≥3」为
//	加分项非硬条件（README/Makefile 等无扩展名嵌入不得误杀）；同分取
//	候选 A——两布局互斥下安全：无标志布局 B 是截断后缀伪名，有标志布局
//	A 恒死于标志高位 0x00。
//
// total 守卫候选联动（撒谎探测器）：total != 0 && total < off+end-4 拒该
// 候选——声明总长连该候选的实际占用都装不下即结构撒谎。口径注记
// （P-20261118-3 与正文抽取 ole10NativeBody 对齐）：夹具与真实取证字节
// （0x5BCC 总长 vs 23504B 实际流长）一致表明 total 不含自身 4B 长度字段
// ——守卫按同一口径换算（旧式与偏移解耦的 total < end 在候选 B 上语义
// 漂移；±4 内的宽松边缘对启发式探测器无害，拒绝面只对准公然撒谎）
func ole10NativeFileName(stream []byte) string {
	if len(stream) < 6 {
		return ""
	}
	total := binary.LittleEndian.Uint32(stream[:4])
	best, bestScore := "", -1
	for _, off := range [...]int{4, 6} { // A=4（无标志布局）、B=6（有标志布局）
		end := bytes.IndexByte(stream[off:], 0)
		if end <= 0 {
			continue
		}
		if total != 0 && total < uint32(off+end-4) {
			continue // 结构撒谎：声明总长装不下该候选的实际占用
		}
		name := sanitizeEmbedName(decodeEmbedName(string(stream[off : off+end])))
		if name == "" {
			continue // 唯一硬淘汰：解码+净化后为空（标志高位伪名等）
		}
		score := 0
		if strings.Contains(name, ".") {
			score++ // 含扩展名点（加分项：无扩展名嵌入不得误杀）
		}
		if len(name) >= 3 {
			score++
		}
		if score > bestScore { // 严格大于=同分保持先入的候选 A
			bestScore, best = score, name
		}
	}
	return best
}

// ole10BodyMaxBytes 端点侧正文抽取的全流读取上限（P-20261118-3 主刀①）：
// cfbReadStreamHead 的 head 参数化即全流有界读——data 已被端点
// io.LimitReader(DocxEmbedMaxBytes+1) 整体读入内存，本上限与其对齐，
// 零新增放大面（正文 ⊆ 容器本体，至多一份流内拷贝）
const ole10BodyMaxBytes = DocxEmbedMaxBytes

// 数据长度扫描式定位的封顶参数（P-20261118-7 评审必改1）。刚性「恰 2 个
// ASCIZ」计数在真实 Word 写入器上系统性失效——2026-11-18 字节级取证：源
// 路径之后还有控制字段（空 ASCIZ + 03 00 + 0x36 长度前缀）才轮到临时路径，
// 旧解析把「03 00 36 00」当数据长度=0x00360003≈3.4MB 越界拒，两候选全灭
// →「预览点击弹下载框」。
const (
	// ole10ScanFieldsMax 名终点之后数据长度扫描的非空 ASCIZ 字段数封顶
	//（防病态包把扫描变成无界游走）。只计非空字段：空 ASCIZ 是写入器的
	// 填充与长度前缀的高位零字节，逐字节空转不得耗尽字段预算——真实头
	// 的 0x36 长度前缀（36 00 00 00）按字节走会白吃 3 个空字段
	ole10ScanFieldsMax = 8
	// ole10ScanWindow 字段扫描窗（名终点之后的字节距离封顶）：真实写入器
	// 的头字段区（源/临时路径+控制字段）在 KB 量级，窗外即非头字段区，
	// 试之无益（防全 NUL 流的逐字节走到底）
	ole10ScanWindow = 4 << 10
	// ole10AlignTol 双侧 total 对齐容差（字节）：诚实写入器下
	// bodyStart+dataLen 与 total+4 精确相等（真实取证 0x5BCC+4=流长），
	// 容差只吸收写入器间字段口径零头；0x36 长度前缀类假 dataLen 在此撞墙
	//（偏差 = 4+真实正文的长度，远超容差）。P-20261118-10 起本门只作用
	// text 族（无内容锚背书，对齐门是唯一防假手段）；锚强族降格单侧
	// 上界（ole10BodyAt），真实写入器「total 计入载荷后尾随元数据块」
	// 形态（bodyEnd < total+4，线上实证 diff=-240）不再误拒
	ole10AlignTol = 16
	// ole10HTMLHeadProbe html/htm 采纳门的「首部」窗：真文档偶有 BOM/
	// 前导空白/注释横幅再进 doctype，窗内命中 <!doctype/<html 即认
	ole10HTMLHeadProbe = 256
)

// ole10NativeBody Ole10Native 流 → 嵌入正文（真正的 html/text 字节，
// P-20261118-3 主刀①乱码根除）。P-20261118-1/-2 只抽了文件名——还原名
// ext=.html 命中 preview 白名单后 serveEmbedPreview 把容器二进制整体按
// text/html 供给（响应首 4 字节 D0CF11E0），正文从未被抽出：这就是
// 「预览窗口乱码」的根因（评审根因重锚——立案时 FF FE/UTF-16LE 取证系
// CFB 魔数被 GB18030 误解码成「邢唷」的误读）。
//
// 流布局（P-2 双候选仲裁的延伸面）：总长(4B) + [标志(2B，偏移6布局)] +
// 名(ASCIZ) + 之后的头字段区因写入器而异（源路径/临时路径/控制字段/长度
// 前缀的个数与顺序无权威规范），最终以 4B 数据长度 + 正文收尾。
//
// P-20261118-7 数据长度定位从「恰 2 个 ASCIZ」刚性计数改**扫描式**：
// 名终点之后按偏移递增逐 ASCIZ 字段边界尝试把该位置的 4 字节当数据长度
// 字段，**首个通过全部校验者采纳**（评审必改1 钉死的扫描序）。采纳校验
// 三层：① dataLen>0 且 bodyStart+dataLen ≤ 流尾（单侧物理守卫）；②
// total 门**按 ext 分族**（P-20261118-10）——text 族双侧对齐（±
// ole10AlignTol；「total 不含自身 4B」口径与名字仲裁/真实取证一致），
// 锚强族单侧上界「body 不越声明流尾」（真实写入器 total 计入载荷后
// 尾随元数据块，±16 双侧对齐把唯一正确候选误拒；细节见 ole10BodyAt）；
// total=0 两族同退单侧守卫=低置信；③ **正文内容与还原名扩展名自洽**
// （ole10BodyMatchesExt——text 族三联门之统计门在此，0x36 前缀类假
// dataLen 切出的「正文」含路径 NUL 必拒）。候选仲裁与 ole10NativeFileName
// 同源：名字段先过既有解码+净化链，空名=唯一硬淘汰。任何疑点返回 nil
// ——调用方走锚点回退（ole10AnchorBody）再落容器守卫（诚实下载下限），
// 绝不产出错误页或把容器半截当文本
func ole10NativeBody(stream []byte, ext string) []byte {
	if len(stream) < 6 {
		return nil
	}
	total := binary.LittleEndian.Uint32(stream[:4])
	for _, off := range [...]int{4, 6} { // A=无标志布局、B=有标志布局
		end := bytes.IndexByte(stream[off:], 0)
		if end <= 0 {
			continue
		}
		if total != 0 && total < uint32(off+end-4) {
			continue // 结构撒谎：声明总长装不下名字段（total 不含自身 4B）
		}
		if sanitizeEmbedName(decodeEmbedName(string(stream[off:off+end]))) == "" {
			continue // 名字段硬淘汰：标志高位伪名等（两布局判别器与名字仲裁同源）
		}
		// 名终点 → 扫描式数据长度定位：按偏移递增逐 ASCIZ 字段边界试
		//（评审必改1），非空字段数封顶+窗口封顶双闸防病态包
		pos := off + end + 1
		limit := pos + ole10ScanWindow
		if limit > len(stream) {
			limit = len(stream)
		}
		fields := 0
		for pos+4 <= limit {
			if body := ole10BodyAt(stream, pos, total, ext); body != nil {
				return body
			}
			e := bytes.IndexByte(stream[pos:limit], 0)
			if e < 0 {
				break // 窗内再无 ASCIZ 边界
			}
			if e > 0 { // 非空字段才计预算（空 ASCIZ=填充/前缀高位零字节）
				fields++
				if fields >= ole10ScanFieldsMax {
					break
				}
			}
			pos += e + 1
		}
	}
	return nil
}

// ole10BodyAt 把 stream[pos:] 前 4 字节当数据长度字段尝试采纳正文
// （评审必改1 的采纳校验三层）。dataLen 按 int32 有符号读——长度为负
// （高位回绕）与 0 一并拒绝。
//
// total 门按 ext 分族（P-20261118-10 修因 A）：锚强族（内容锚背书：
// html/htm 首部窗锚、pdf %PDF、图型魔数——ole10ExtFamilyOf 单一事实源）
// 从「≈total+4（±ole10AlignTol）」降格为**单侧上界「body 不越声明流尾」**
// ——真实写入器在正文之后还有尾随元数据块且 total 把它计入（2026-11-19
// 线上字节实证 bodyStart+dataLen=53094 vs total+4=53334，diff=-240），±16
// 双侧对齐把唯一正确的 dataLen 候选误拒 → 双对象全灭 → binary-guard 弹
// 下载框；内容锚是更强判别，对齐门防的 0x36 长度前缀类假候选由内容门拒
// （负例保持：前缀位切出的临时路径字节无 doctype 锚必拒、0x00360003 类
// 超流长由物理门拒、-100 偏差类 bodyEnd 越声明流尾由本门上界拒），对齐门
// 在锚强族属防御冗余。text 族（纯统计门）维持双侧对齐不动——无内容锚
// 背书，对齐门是唯一防假手段。total=0（声明缺席）两族同退单侧物理守卫
func ole10BodyAt(stream []byte, pos int, total uint32, ext string) []byte {
	dataLen := int64(int32(binary.LittleEndian.Uint32(stream[pos : pos+4])))
	bodyStart := int64(pos) + 4
	// 单侧物理守卫：零/负（int32 回绕）/超出流尾
	if dataLen <= 0 || bodyStart+dataLen > int64(len(stream)) {
		return nil
	}
	if ole10ExtFamilyOf(ext) == ole10FamilyText {
		// 双侧 total 对齐（评审必改1 核心强判别，text 族维持）：total 声明
		// 整条流（不含自身 4B），诚实写入器下 bodyStart+dataLen=total+4
		// 精确成立；total=0（声明缺席）退回单侧守卫——低置信采纳只多付
		// 日志面标注，不放宽内容门
		if total != 0 {
			diff := bodyStart + dataLen - (int64(total) + 4)
			if diff < -ole10AlignTol || diff > ole10AlignTol {
				return nil
			}
		}
	} else if total != 0 && bodyStart+dataLen > int64(total)+4 {
		// 锚强族单侧上界：body 越声明流尾即拒（诚实 dataLen 只会短于或
		// 恰等于声明流尾——长出部分是写入器自有控制块或撒谎）
		return nil
	}
	body := stream[bodyStart : bodyStart+dataLen]
	if !ole10BodyMatchesExt(body, ext) {
		return nil // ext 内容自洽门（评审必改1 三联门之内容半边）
	}
	return body
}

// ole10ExtFamily 还原名扩展名 → 内容判别族（P-20261118-10 分族 total 门
// 的单一事实源：内容门 ole10BodyMatchesExt 与 total 门 ole10BodyAt 同表
// 取族，两处判别不漂移）。锚强族=内容锚在字节面有强背书（doctype/%PDF/
// 图魔数），text 族=纯统计门（无锚）
type ole10ExtFamily uint8

const (
	ole10FamilyText  ole10ExtFamily = iota // 统计门（!looksBinaryStat）
	ole10FamilyHTML                        // doctype/<html 首部窗锚
	ole10FamilyPDF                         // %PDF 魔数
	ole10FamilyImage                       // sniffImageMime 魔数
)

// ole10ExtFamilyOf ext → 族。图型/ext 清单与 embedPreviewMimes 白名单对齐
// （preview 分型外名单外 ext 不会进入本链——embedPreviewFor 先行过滤）
func ole10ExtFamilyOf(ext string) ole10ExtFamily {
	switch ext {
	case "html", "htm":
		return ole10FamilyHTML
	case "pdf":
		return ole10FamilyPDF
	case "png", "jpg", "jpeg", "gif", "webp", "bmp":
		return ole10FamilyImage
	default:
		return ole10FamilyText
	}
}

// ole10BodyMatchesExt 正文内容与还原名扩展名自洽门（评审必改1）：字段落
// 在哪个位置当数据长度本是启发式，内容锚是最后一道判别——
//
//	html 族：  首部窗（ole10HTMLHeadProbe）内含 doctype/html 锚（大小写
//	            不敏感；Windows 保留字符集禁 <，GBK 路径含该 ASCII 序列
//	            概率≈0——锚点安全性同提案③）；
//	pdf 族：    %PDF 魔数；
//	图型族：    sniffImageMime 魔数复用（serveEmbedPreview image 分支同源）；
//	text 族：   **三联门之统计门**——可打印占比高+零 NUL 复用 looksBinaryStat
//	            （NUL 密度+控制字符），废弃「printable 单条件即采纳」的 OR
//	            弱锚：否则 0x36 长度前缀类假 dataLen 切出的临时路径字节
//	           （近全可打印但含 ASCIZ 结尾 NUL）在 .txt 族必误纳
func ole10BodyMatchesExt(body []byte, ext string) bool {
	switch ole10ExtFamilyOf(ext) {
	case ole10FamilyHTML:
		head := body
		if len(head) > ole10HTMLHeadProbe {
			head = head[:ole10HTMLHeadProbe]
		}
		return ole10IndexFold(head, []byte("<!doctype")) >= 0 ||
			ole10IndexFold(head, []byte("<html")) >= 0
	case ole10FamilyPDF:
		return bytes.HasPrefix(body, []byte("%PDF"))
	case ole10FamilyImage:
		return SniffImageMime(body) != ""
	default:
		return !looksBinaryStat(body)
	}
}

// ole10IndexFold ASCII 大小写不敏感子序列定位（锚点扫描专用：锚点
// <!doctype/<html/%PDF 全 ASCII，Unicode simple fold 语义用不上；逐
// '<'/'%' 首字节候选跳扫，零拷贝零全流小写化）
func ole10IndexFold(b, sep []byte) int {
	if len(sep) == 0 || len(b) < len(sep) {
		return -1
	}
	lower := func(c byte) byte {
		if c >= 'A' && c <= 'Z' {
			return c + 'a' - 'A'
		}
		return c
	}
	first := lower(sep[0])
	for i := 0; i < len(b); {
		j := bytes.IndexByte(b[i:], first)
		if j < 0 || i+j+len(sep) > len(b) {
			return -1
		}
		p := i + j
		match := true
		for k := 0; k < len(sep); k++ {
			if lower(b[p+k]) != lower(sep[k]) {
				match = false
				break
			}
		}
		if match {
			return p
		}
		i = p + 1
	}
	return -1
}

// ole10IndexFoldLast ole10IndexFold 的**末现**变体（P-20261118-10 html 截尾
// 锚专用）：闭合锚取末现——文档正文/脚本字符串里可能出现早于真闭合的
// </html> 字样，取首现会截半；末现 ≥ 真闭合位置（尾随元数据块内嵌
// ASCII </html> 的歧义形态也不劣于「供给至声明流尾」现状，best-effort
// 边界在调用点推演）
func ole10IndexFoldLast(b, sep []byte) int {
	last := -1
	for i := 0; i < len(b); {
		p := ole10IndexFold(b[i:], sep)
		if p < 0 {
			break
		}
		last = i + p
		i = last + 1
	}
	return last
}

// ole10AnchorBody 内容锚点回退（P-20261118-7 提案③，字段遍历之外的第二
// 保障）：扫描式定位再失败时不再依赖任何字段布局，在流字节内扫**内容
// 锚点**——.html/.htm 取大小写不敏感 <!doctype/<html 首现位置、.pdf 取
// %PDF 首现位置，从锚点供给至流尾（html 容忍尾部冗余：CSP sandbox 下
// 尾部冗余零脚本风险；pdf 查看器容忍）。锚点安全性：Windows 保留字符集
// 禁 <，GBK 路径含 <!doctype/<html ASCII 序列概率≈0；ext 白名单已限定
// .html/.pdf 族，其余 ext 不扫（白名单外维持 attachment）。**嵌在抽取
// 管线内部零旁路**（embedExtractPayload）：产物照走 normalizeTextBytes
// 与魔数守卫链——锚点回退只是「找到正文起点」的另一种方式，供给面判定
// 与字段遍历完全同链。声明 total 可用时把供给尾截到声明流长（去掉 CFB
// 链读的扇区 padding 零尾）；total 缺席/撒谎则原样到流尾（best-effort）。
//
// html/htm 截尾（P-20261118-10 修因 B，与扫描路径放宽**两条独立救回
// 路径**——扫描门放宽救回 dataLen 诚实的布局，本截尾救回 dataLen 撒谎/
// 缺席而 total 计入尾随元数据的布局变体，回归定位看谁先命中）：供给段
// 内大小写不敏感 `</html>` 末现在场则截到其后——真实写入器把载荷后的
// UTF-16LE 元数据块计入 total（线上实证 </html> 之后即尾块起点），不截
// 则尾随块随 payload 进入 normalizeTextBytes：utf8.Valid=false → GB18030
// 兜底解码 RuneError 门判死（binary-guard）。无闭合锚维持截到末现
// （≥真闭合位置，元数据块内嵌 ASCII </html> 的歧义形态也不劣于现状
// 供给至声明流尾）——pdf 族不动（查看器容忍尾冗余且无规范化门）
func ole10AnchorBody(stream []byte, ext string) []byte {
	var anchors [][]byte
	isHTML := false
	switch ext {
	case "html", "htm":
		anchors = [][]byte{[]byte("<!doctype"), []byte("<html")}
		isHTML = true
	case "pdf":
		anchors = [][]byte{[]byte("%PDF")}
	default:
		return nil
	}
	if len(stream) < 4 {
		return nil
	}
	at := -1
	for _, a := range anchors {
		if p := ole10IndexFold(stream, a); p >= 0 && (at < 0 || p < at) {
			at = p
		}
	}
	if at < 0 {
		return nil
	}
	end := len(stream)
	if total := binary.LittleEndian.Uint32(stream[:4]); total != 0 {
		if d := int64(total) + 4; d <= int64(len(stream)) && d > int64(at) {
			end = int(d)
		}
	}
	body := stream[at:end]
	if isHTML {
		// 截尾（修因 B）：闭合锚 </html> 末现在场即截到其后，吸收尾随
		// 元数据块；无闭合锚原样供给（best-effort 不劣化）
		if closeAt := ole10IndexFoldLast(body, []byte("</html>")); closeAt >= 0 {
			body = body[:closeAt+len("</html>")]
		}
	}
	return body
}

// decodeEmbedName Ole10Native 抽出的原始文件名 → UTF-8 化（P-20261118-1
// ①GBK 解码接入抽取链）。中文 Windows 时代 OLE Package 按 ANSI 代码页
// （GBK 家族）写流头文件名——GBK 字节过不了 utf8.ValidString，P-7 起被
// sanitizeEmbedName 回落 .bin 的根因（当时注释「转换需代码页表超出本案
// 边界」的前提已不成立：golang.org/x/text 是直接依赖，filepolicy
// encoding.go 同款 GB18030 超集选型在用）。两级序：UTF-8 valid 原样 →
// invalid 经 GB18030 解码。采纳门槛：解码结果不含 U+FFFD 且净化后非空
// ——GB18030 对任何字节序列几乎恒「成功」（非法序列映替换符），替换符/
// 全控制字符是错配噪声的信号，回落 "" 让上层维持 .bin（红线不变：抽取
// 失败只影响名字观感）。Ole10Native 的 UTF-16 变体维持不做（评审建议b：
// ASCIZ 主形态即 ANSI 代码页；变体留扩展注记）
func decodeEmbedName(raw string) string {
	if utf8.ValidString(raw) {
		return raw
	}
	decoded, err := simplifiedchinese.GB18030.NewDecoder().String(raw)
	if err != nil || !utf8.ValidString(decoded) || strings.ContainsRune(decoded, utf8.RuneError) {
		return ""
	}
	if sanitizeEmbedName(decoded) == "" {
		return "" // 剔控制字符后为空 = 解码噪声，不采纳
	}
	return decoded
}

// sanitizeEmbedName Ole10Native 抽出的原始文件名 → 可出头的下载名：路径
// Base 化（源路径形态 C:\dir\x.html 一并处理）+ 去控制字符 + rune 边界
// 截断；非 UTF-8 或净化后为空 → ""，调用方回落 .bin 直供名——不给
// Content-Disposition 塞乱码。非 UTF-8 字节应先过 decodeEmbedName
// （P-20261118-1 GB18030 解码链）——本函数只做边界拒绝，不做编码转换
func sanitizeEmbedName(name string) string {
	if !utf8.ValidString(name) {
		return ""
	}
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7F {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return ""
	}
	return utf8Cut(name, 200)
}

// ── 嵌入字节面抽取与文本族净化（P-20261118-3 主刀①②，
// P-20261118-7 拆「抽取器（ext 感知）/文本规范化」两层=评审必改2） ──
//
// serveEmbedPreview 文本族（html/htm/md/text）inline 供给前的统一入口：
// ① CFB 容器 → Ole10Native 正文抽取（主刀①——容器本体永不按文本供给；
//   P-20261118-7 起扫描式数据长度定位+锚点回退，对真实 Word 写入器的
//   字段变体鲁棒）；② 文本编码规范化四级序（主刀②——UTF-16LE/BE 双族
//   中文 Windows 高频形态与 GBK 文本的乱码根除补强）。pdf/图型族只过
//   抽取层（ext 内容自洽门已含魔数判别），不过文本规范化（%PDF 必被
//   looksBinaryMagic 拒 nil）。返回 nil = 二进制守卫命中/抽取失败，
//   调用方回落 attachment（诚实下载下限，绝不产出错误页）。
//   口径（评审建议c）：编码规范化是文本族供给的健壮性补强；乱码根除
//   靠正文抽取，规范化不宣称「修复一切编码」

// EmbedExtractDiag 嵌入抽取失败的粗粒度诊断枚举（P-20261118-7 提案⑤，
// 评审建议b）：**响应面只出枚举码级**（X-Embed-Extract-Diag 响应头），
// 路径/名字节等容器内部结构细节只进服务端日志——防向分享访客泄露容器
// 结构。值即响应头字面量（短横线小写，无任何字节细节）
type EmbedExtractDiag string

const (
	EmbedDiagNone       EmbedExtractDiag = ""             // 抽取成功
	EmbedDiagNoStream   EmbedExtractDiag = "no-stream"    // CFB 结构疑点/Ole10Native 流不可读
	EmbedDiagFieldScan  EmbedExtractDiag = "field-scan"   // 字段遍历：数据长度候选全灭
	EmbedDiagAnchorMiss EmbedExtractDiag = "anchor-miss"  // 锚点回退未命中
	EmbedDiagBinary     EmbedExtractDiag = "binary-guard" // 魔数/统计守卫拒绝
	EmbedDiagOversize   EmbedExtractDiag = "oversize"     // md 渲染上限（面策略非字节面）
)

// EmbedDiagHeader 诊断枚举的响应头（粗粒度枚举码级，评审建议b）
const EmbedDiagHeader = "X-Embed-Extract-Diag"

// embedExtractPayload ext 感知的抽取器层（评审必改2 拆层的抽取半边）：
// 非 CFB 字节原样直通（package 直存形态——pdf/图片/文本条目本体就是
// 原字节，抽取零成本）；CFB 容器 → cfbReadStreamHead 全流有界读
// （ole10BodyMaxBytes 封顶，data 已整体在内存零新增放大面）→ 扫描式
// ole10NativeBody → 锚点回退 ole10AnchorBody（字段遍历全灭时的第二保障，
// 管线内部零旁路）。与名字抽取链（maybeExtractEmbedName 的
// cfbReadStreamHead→ole10NativeFileName）同构，流/容器入口不混用。
// diag 供响应头与服务端日志（枚举码级）。
//
// P-20261118-10 起真实写入器「total 计入载荷后尾随元数据块」布局有两条
// **独立**救回路径：①扫描路径——锚强族 total 门降格单侧上界（ole10BodyAt，
// dataLen 诚实即采纳干净正文）；②锚点回退截尾——dataLen 撒谎/缺席而
// 锚点在场时，</html> 末现处截掉尾随块（ole10AnchorBody）。回归定位先看
// diag：扫描救回与锚救回都是 diag 无，仅布局探针可分辨命中层
func embedExtractPayload(data []byte, ext string) ([]byte, EmbedExtractDiag) {
	// 容器魔数 → 正文抽取（主刀①）：还原名 ext（Ole10Native 文件名）命中
	// 白名单不改变「字节是 CFB 容器」的事实——html 名 + 容器字节的组合
	// 恰是本案乱码的源头
	if !bytes.HasPrefix(data, CFBMagic) {
		return data, EmbedDiagNone
	}
	stream := cfbReadStreamHead(data, ole10NativeStreamName, ole10BodyMaxBytes)
	if len(stream) == 0 {
		return nil, EmbedDiagNoStream
	}
	if body := ole10NativeBody(stream, ext); len(body) > 0 {
		return body, EmbedDiagNone
	}
	// 字段遍历全灭 → 内容锚点回退（提案③）。锚点也未命中才真失败：
	// html/pdf 族报 anchor-miss（锚点存在而未命中），其余族报 field-scan
	//（锚点回退本就不适用——诊断枚举如实区分两类终态）
	if body := ole10AnchorBody(stream, ext); len(body) > 0 {
		return body, EmbedDiagNone
	}
	if ext == "html" || ext == "htm" || ext == "pdf" {
		return nil, EmbedDiagAnchorMiss
	}
	return nil, EmbedDiagFieldScan
}

// embedPreviewPayload preview=1 / ui=1 共用的统一抽取判定（评审必改2 的
// 防漂移关键：壳页准入守卫与 preview 供给面走同一条链，两侧判定天然
// 一致）。ext → 白名单 MIME 分族：pdf 递 %PDF 头、image 递 sniffImageMime
// （非容器伪装条目同闸——原来只拦 CFB 形态，现对 passthrough 字节同样
// 魔数自洽）、文本族过 normalizeTextBytes 编码规范化+md 渲染上限
// （必改⑦口径不变：施加在净化后的实际渲染输入上）。nil = 该 ext 的
// preview 面将回落 attachment，调用方同步回落/壳页转诚实回落模式
func EmbedPreviewPayload(data []byte, ext string) ([]byte, EmbedExtractDiag) {
	payload, diag := embedExtractPayload(data, ext)
	if payload == nil {
		return nil, diag
	}
	switch mime := embedPreviewMimes[ext]; {
	case mime == "application/pdf":
		if !bytes.HasPrefix(payload, []byte("%PDF")) {
			return nil, EmbedDiagBinary
		}
	case strings.HasPrefix(mime, "image/"):
		if SniffImageMime(payload) != mime {
			return nil, EmbedDiagBinary // 魔数不匹配 = 伪装条目（评审建议e）
		}
	default:
		// 文本族：编码规范化（UTF-16/GBK 转码；二进制守卫在链内）
		payload = normalizeTextBytes(payload)
		if payload == nil {
			return nil, EmbedDiagBinary
		}
		if (ext == "md" || ext == "markdown") && int64(len(payload)) > MaxRenderBytes {
			return nil, EmbedDiagOversize
		}
	}
	return payload, EmbedDiagNone
}

// CFBMagic OLE 复合文档（CFB）魔数——与 cfbReadStreamHead 头校验同源
var CFBMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

// looksBinaryMagic 容器/压缩包/可执行魔数反向排除（评审必改1b/必改2 的
// 魔数半边）：D0CF11E0（OLE 容器）、PK 系列（zip 空档/包尾形态）、MZ
// （PE/EXE）、ELF、7z、Rar、gzip、%PDF。命中即拒绝按文本 inline——这些
// 字节面浏览器没有任何文本渲染价值，诚实下载是唯一正确出口。清单取
// 「容器/压缩包/可执行」家族（评审口径「CFB/PK/MZ 等」），不含文本域
// 可能撞首的双字母短魔数（如 BMP 的 "BM"——文本文件以 BM 开头并非痴妄）
func looksBinaryMagic(b []byte) bool {
	switch {
	case bytes.HasPrefix(b, CFBMagic),
		bytes.HasPrefix(b, []byte("PK\x03\x04")),
		bytes.HasPrefix(b, []byte("PK\x05\x06")),
		bytes.HasPrefix(b, []byte("PK\x07\x08")),
		bytes.HasPrefix(b, []byte("MZ")),
		bytes.HasPrefix(b, []byte{0x7F, 'E', 'L', 'F'}),
		bytes.HasPrefix(b, []byte{'7', 'z', 0xBC, 0xAF, 0x27, 0x1C}),
		bytes.HasPrefix(b, []byte("Rar!\x1A\x07")),
		bytes.HasPrefix(b, []byte{0x1F, 0x8B}),
		bytes.HasPrefix(b, []byte("%PDF-")):
		return true
	}
	return false
}

const (
	// binaryProbeBytes 二进制统计守卫的采样窗口（必改2）：头部采样足以
	// 区分文本/二进制——二进制 NUL/控制字符在文件头密集，64KB 封顶避免
	// 64MB 嵌入的逐字节全量扫（线性一次也不贵，但预览热路径不必付）
	binaryProbeBytes = 64 << 10
	// binaryNulPermille NUL 字节密度门（千分比）：文本 ≈ 0，BOM 缺失的
	// UTF-16 双族与任意二进制 ≫ 此值——GB18030 兜底前拦截（GB18030 字节
	// 空间近全覆盖，U+FFFD 门拦不住二进制，本案容器字节即反例）
	binaryNulPermille = 10
	// binaryCtrlPermille 控制字符占比门（千分比，\t\n\r 除外）：文本里
	// 控制字符近乎只在行尾出现，二进制分布均匀且占比高
	binaryCtrlPermille = 20
)

// looksBinaryStat NUL 密度/控制字符占比统计门（必改2 的统计半边）：作用于
// GB18030 兜底分支之前——GB18030 对任何字节序列几乎恒「成功」，没有这
// 道门二进制会带着 CJK 乱码混过解码器
func looksBinaryStat(b []byte) bool {
	if len(b) > binaryProbeBytes {
		b = b[:binaryProbeBytes]
	}
	if len(b) == 0 {
		return false
	}
	nul, ctrl := 0, 0
	for _, c := range b {
		switch {
		case c == 0:
			nul++
		case c < 0x20 && c != '\t' && c != '\n' && c != '\r', c == 0x7F:
			ctrl++
		}
	}
	return nul*1000 > len(b)*binaryNulPermille || ctrl*1000 > len(b)*binaryCtrlPermille
}

// decodeUTF16Bytes UTF-16 字节（BOM 已剥）→ UTF-8。奇数尾字节丢弃
// （截断传输的标准容错）；未配对代理经 utf8.RuneError 显形，
// 调用方按替换符拒绝（与 decodeEmbedName 的错配噪声口径同源）
func decodeUTF16Bytes(b []byte, bo binary.ByteOrder) string {
	n := len(b) / 2
	u := make([]uint16, n)
	for i := 0; i < n; i++ {
		u[i] = bo.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u))
}

// normalizeTextBytes 文本编码规范化四级序（主刀②）：UTF-8 valid 原样 →
// FF FE BOM 按 UTF-16LE → FE FF 按 UTF-16BE → 其余 GB18030。二进制守卫
// 双道（必改2）：魔数反向排除优先于一切文本假设（置于 UTF-8 判定之前
// ——zip 头部字节恰是合法 UTF-8，utf8.Valid 不是二进制判别器），统计门
// 拦在 GB18030 兜底前（BOM 明示的 UTF-16 双族是高置信信号，不设统计门）。
// 解码含替换符/解码失败 = 既非 UTF-8 亦非 GBK 的错配噪声，nil 回落
// attachment（诚实边界：Big5 等其他 ANSI 代码页是 GB18030 的 best-effort
// 误读，留扩展注记不做探测）。HTTP 头 charset 恒优先于页面 meta 声明
// （评审建议d）：转码产物恒 UTF-8、响应头恒 charset=utf-8——声明与实际
// 对齐后，极罕见「自称 UTF-16LE 的 meta」残留无解码码影响
func normalizeTextBytes(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	if looksBinaryMagic(b) {
		return nil
	}
	if utf8.Valid(b) {
		return b
	}
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xFE}): // UTF-16LE BOM
		s := decodeUTF16Bytes(b[2:], binary.LittleEndian)
		if s == "" || strings.ContainsRune(s, utf8.RuneError) {
			return nil
		}
		return []byte(s)
	case bytes.HasPrefix(b, []byte{0xFE, 0xFF}): // UTF-16BE BOM
		s := decodeUTF16Bytes(b[2:], binary.BigEndian)
		if s == "" || strings.ContainsRune(s, utf8.RuneError) {
			return nil
		}
		return []byte(s)
	}
	if looksBinaryStat(b) {
		return nil // 二进制守卫（必改2）：GB18030 恒成功面拦不住二进制
	}
	decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(b)
	if err != nil || !utf8.Valid(decoded) || bytes.ContainsRune(decoded, utf8.RuneError) {
		return nil
	}
	return decoded
}
