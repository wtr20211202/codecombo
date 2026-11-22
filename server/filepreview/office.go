package filepreview

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"html"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/EndFirstCorp/doc2txt"
)

// Word 文档（docx/doc）→ HTML 片段的抽取边界（P-20261119-4 自 server/share
// office.go 渲染半边抽包下沉，share/api 两侧共用）：
// 目标是"文本级排版预览"（标题/段落/列表/表格/粗斜体）+ 图片内联——
// 图片属"内容"不属于"样式"（P-20261116-4：与 md 预览同权渲染）。
// P-20261116-6 起图片供给形态从 data: URL 内联切换为同源 media 端点按需
// 流式（img src 只含端点 URL，图片字节不进 HTML——真实照片文档不再挤占
// HTML 预算）；字体/颜色/页眉页脚等样式还原仍交给下载。docx 用 stdlib
// zip+xml 流式解析（零新依赖）；doc 老格式经 doc2txt best-effort 抽纯文本
// （OLE 复合文档解析失败时上层降级为错误卡 + 下载）。所有文本经
// html.EscapeString 转义后才进输出，img 结构完全由本文件生成（src 只含
// MediaURLs 构造器产出的端点 URL，查询值经 url.QueryEscape）——注入面为零。

const (
	// docxZipMaxBytes document.xml 解压侧上限（防 zip 炸弹）
	docxZipMaxBytes = 64 << 20
	// officeHTMLMaxBytes 生成 HTML 的字节上限（纯文本结构闸：文本/占位块
	// 发射前验剩余、不足整块放弃——杜绝截半标签。P-20261116-6 起图片字节
	// 不再进 HTML，img 只占端点 URL 的常数体积，此闸不再承担图片预算）
	officeHTMLMaxBytes = 4 << 20
	// DocxMediaMaxBytes media 端点单部件解压侧上限（渲染侧不解压
	// 媒体，闸随供给形态迁到端点并从 8MB 放宽到 20MB——手机照片 2-5MB/
	// 张的现实量级）。zip 元数据声明的尺寸可伪造（声小实大），所以闸
	// 施加在解压流上而非元数据
	DocxMediaMaxBytes = 20 << 20
	// DocxEmbedMaxBytes embed 端点单部件解压侧上限（P-20261116-7）。
	// 嵌入附件承载完整文件字节、可比照片大（需求文档高频嵌入 html/zip/
	// pdf），取与 document.xml 解压闸同量级；闸同样施加在解压流上。字节
	// 需进内存（Ole10Native 文件名抽取要按名定位流 + ServeContent Range
	// 需 ReadSeeker），闸封顶内存量级
	DocxEmbedMaxBytes = 64 << 20
	// docxRelsMaxBytes rels 部件解压侧上限（正常 <10KB，防畸形包）
	docxRelsMaxBytes = 1 << 20
	// docxParaMaxBytes 单段文本累积闸（潜伏点修复：charData/br/tab 累积
	// 原本不经预算闸，超长单段无界增长；64KB 文本 ≈ 数十字页，足够宽裕）
	docxParaMaxBytes = 64 << 10
)

// isDocx 嗅探 zip 魔数（部分 .doc 实为 docx 改名）
func isDocx(b []byte) bool { return len(b) > 1 && b[0] == 'P' && b[1] == 'K' }

// MediaURLs docx 渲染的子资源 URL 构造器（P-20261119-4 评审建议1：token/
// docPath 系参数穿透换成两字段闭包注入——share/api 两侧各自包装端点形态，
// 渲染面不再硬编码 /s/{token} 前缀）。share 侧产 /s/{token}/docx-media|embed
// 查询形态、api 侧产 /api/projects/:id/file/media|embed 形态。
type MediaURLs struct {
	// Media docx-media 图片取数端点：入参 = zip 内 media 条目名
	Media func(mediaName string) string
	// Embed docx-embed 嵌入对象端点：入参 = zip 内 embeddings 条目名。
	// 返回值须为「裸端点 + path/e 查询」形态——发射侧在其上追加
	// &preview=1 / &ui=1 派生预览 URL（两侧端点均支持同款参数词表）
	Embed func(entry string) string
}

// RenderDocHTML Word 文档入口：按魔数分流 docx/doc，失败返回错误。
// lang 用于图片占位块文案（zh/en，词典见 lang.go）；urls 供图片 src 与嵌入
// 链接产 media/embed 端点 URL（docPath 由构造器闭包捕获——share 侧
// rewriteRelativeAssets 同款线程化先例）
func RenderDocHTML(content []byte, lang string, urls *MediaURLs) (string, error) {
	if isDocx(content) {
		return RenderDocxHTML(content, lang, urls)
	}
	return renderLegacyDocHTML(content)
}

// renderLegacyDocHTML 老 .doc（OLE 复合文档）best-effort 抽纯文本
func renderLegacyDocHTML(content []byte) (string, error) {
	text, err := doc2txt.ParseDoc(bytes.NewReader(content))
	if err != nil {
		return "", err
	}
	raw, err := io.ReadAll(text)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString(`<div class="sc-doc-text">`)
	writeEscapedParagraphs(&b, string(raw))
	return b.String(), nil
}

// RenderDocxHTML 解析 word/document.xml 抽文本结构 + 图片端点引用。
// media 部件不再解压（P-20261116-6）：渲染只建 rels→部件名映射簿，
// 图片字节由 media 端点按需供给——没被引用的 media 零成本
func RenderDocxHTML(content []byte, lang string, urls *MediaURLs) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", err
	}
	var docXML, relsXML *zip.File
	for _, f := range zr.File {
		switch f.Name {
		case "word/document.xml":
			docXML = f
		case "word/_rels/document.xml.rels":
			relsXML = f
		}
	}
	if docXML == nil {
		return "", errDocxNoDocument
	}
	rc, err := docXML.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()

	p := newDocxBuilder(lang, urls, newDocxMedia(relsXML, zr))
	if err := p.parse(io.LimitReader(rc, docxZipMaxBytes)); err != nil {
		return "", err
	}
	return p.html(), nil
}

// errDocxNoDocument docx 包内缺主文档部件
var errDocxNoDocument = errors.New("filepreview: word/document.xml not found")

// ── docx 图片资产链路（rels 映射簿 + docx-media 端点供给） ──
// 引用链 = document.xml 的 a:blip@r:embed（新形态 w:drawing）或
// v:imagedata@r:id（老形态 w:pict）→ rels 的 rId→Target → zip 内
// word/media/* 条目。安全红线：媒体只认同一 docx zip 内部条目，
// 绝不透传任意路径参数。P-20261116-6 起渲染侧零解压（原 cache/total/
// over/decompress/load 与累计闸随 data: 内联形态拆除）——解压闸与魔数
// 嗅探随供给形态迁到下方 docx-media 端点侧。

// docxMedia 单次渲染的图片资产簿：rels 映射与 zip 部件查找表。簿只承担
// 「引用在哪」的定位——rels 供 emitImage 产端点 URL，embeds 供 emitEmbed
// 产嵌入下载链接，parts 供占位块报声明大小（UncompressedSize64 是 zip
// 元数据，零解压可得）。extracted 是嵌入对象的「原始文件名还原」信号通道
// （P-20261118-1）：条目名 → Ole10Native 抽出+GB18030 解码后的原名，与
// names[rID] 的 rels 展示名通道刻意分存——评审必改④：rels 展示名是「文档
// 引用了什么」（越界/外部也登记），原名是「嵌入物本体叫什么」（仅包内
// 可解压头抽得出），语义与失败态都不同，混存会让降级分支误用
type docxMedia struct {
	rels      map[string]string    // rId → zip 条目名（仅合法命中项，word/media/*）
	embeds    map[string]string    // rId → zip 条目名（word/embeddings/*，P-20261116-7 嵌入通道）
	names     map[string]string    // rId → 展示名（含被过滤关系，仅供占位块报名）
	parts     map[string]*zip.File // 条目名 → 部件
	extracted map[string]string    // embeddings 条目名 → 还原的原始文件名（抽不出的条目缺席 = 回落条目名）
	// extractTried 抽名尝试记账（簿构建期局部态）：失败也占 docxEmbedNameMax
	// 额度——病态包全失败嵌入逐条解压的放大面与成功态同闸
	extractTried map[string]bool
}

// newDocxMedia 建资产簿：rels 缺失/损坏/超限时映射为空（图片全部降级
// 占位），不影响文本预览——rels 损坏容错在解析循环的 err 即断里
func newDocxMedia(relsXML *zip.File, zr *zip.Reader) *docxMedia {
	m := &docxMedia{
		rels:      map[string]string{},
		embeds:    map[string]string{},
		names:     map[string]string{},
		parts:     map[string]*zip.File{},
		extracted: map[string]string{},
	}
	for _, f := range zr.File {
		m.parts[f.Name] = f
	}
	if relsXML == nil {
		return m
	}
	rc, err := relsXML.Open()
	if err != nil {
		return m
	}
	defer rc.Close()
	dec := xml.NewDecoder(io.LimitReader(rc, docxRelsMaxBytes))
	for {
		tok, err := dec.Token()
		if err != nil {
			break // 预览语义优先于完整性：已解析的映射照用
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "Relationship" {
			continue
		}
		id := attrLocal(se, "Id")
		target := attrLocal(se, "Target")
		if id == "" || target == "" {
			continue
		}
		// 只认 image 类关系与嵌入对象关系（oleObject/package——附件的两种
		// Type 形态，P-20261116-7；超链接/样式/字体等一律忽略）
		typ := attrLocal(se, "Type")
		isEmbed := strings.HasSuffix(typ, "/oleObject") || strings.HasSuffix(typ, "/package")
		if !isEmbed && !strings.HasSuffix(typ, "/image") {
			continue
		}
		// 展示名登记在过滤之前：被过滤的关系（越界/外部/悬空）也让占位块
		// 报得出文档引用了什么。截到 80 字节防超长 target 撑爆占位块
		if dn := mediaDisplayName(target); dn != "image" {
			m.names[id] = utf8Cut(dn, 80)
		}
		// 外部链接（TargetMode="External"）不取——媒体与嵌入物只来自包内
		//（OLE Link 型外链关系不入簿）
		if strings.EqualFold(attrLocal(se, "TargetMode"), "External") {
			continue
		}
		name := resolveMediaTarget(target)
		if isEmbed {
			name = resolveEmbedTarget(target)
		}
		if name == "" {
			continue
		}
		// 同一 zip 内不存在该条目 = 悬空映射，忽略（发射侧降级占位）
		if _, ok := m.parts[name]; !ok {
			continue
		}
		if isEmbed {
			m.embeds[id] = name
			m.maybeExtractEmbedName(name)
		} else {
			m.rels[id] = name
		}
	}
	return m
}

// docxEmbedNameMax 渲染侧抽名的条目尝试上限（P-20261118-1 评审必改③簿级
// 有界化）：抽名只为观感（块上显示原始文件名，超限回落 .bin 条目名——
// 观感降级红线不变），堵「rels 病态包声明数千嵌入 × docx-media/docx-embed
// 端点逐请求重建簿」的放大面。每次抽名只解压条目头 ole10NameScanBytes
// （4KB zip 侧解压读头；其内的 CFB 链读头另封顶 ole10NameHeadBytes 512B
// 单扇区），16 次 ≈ 64KB 总解压预算，与读头上限天然对齐；同条目多 rId 引用
// 去重（只抽一次，失败态也记账防重复解压）
const docxEmbedNameMax = 16

// maybeExtractEmbedName 对单个 embeddings 部件做「解压头 → Ole10Native →
// GB18030 解码 → 净化」全链抽名（P-20261118-1 渲染侧名字还原——P-7 只在
// 下载端点抽，渲染块恒显 oleObjectN.bin）。任何一步疑点即跳过（extracted
// 缺席 = 发射侧回落条目名），绝不影响文本预览与可下载性。抽名尝试总量由
// docxEmbedNameMax 封顶（含失败——失败也占额度，病态包逐条解压的放大面
// 一样被闸住）
func (m *docxMedia) maybeExtractEmbedName(entry string) {
	if m.extractTried == nil {
		m.extractTried = map[string]bool{}
	}
	if m.extractTried[entry] || len(m.extractTried) >= docxEmbedNameMax {
		return
	}
	m.extractTried[entry] = true
	f := m.parts[entry]
	if f == nil {
		return
	}
	rc, err := f.Open()
	if err != nil {
		return
	}
	defer rc.Close()
	head, err := io.ReadAll(io.LimitReader(rc, ole10NameScanBytes))
	if err != nil || len(head) == 0 {
		return
	}
	if n := sanitizeEmbedName(decodeEmbedName(ole10NativeFileName(
		cfbReadStreamHead(head, ole10NativeStreamName, ole10NameHeadBytes)))); n != "" {
		m.extracted[entry] = n
	}
}

// resolveTargetUnder rels Target → zip 条目名（限定条目名前缀）。相对
// Target 按 rels 语义以 word/ 为基准解析（rels 驻留 word/_rels/，基部件
// 在 word/）；OPC 包根绝对形态（/word/media/x.png）按包根解析。结果必须
// 落在 prefix 形态内——越界（../ 逃出 word/）、反斜杠、盘符一律忽略
func resolveTargetUnder(target, prefix string) string {
	if strings.ContainsAny(target, "\\\x00") {
		return ""
	}
	var name string
	if strings.HasPrefix(target, "/") {
		name = path.Clean("/" + target)
	} else {
		name = path.Clean("word/" + target)
	}
	name = strings.TrimPrefix(name, "/")
	if !strings.HasPrefix(name, prefix) {
		return ""
	}
	return name
}

// resolveMediaTarget 图片关系 Target → word/media/* 条目名
func resolveMediaTarget(target string) string {
	return resolveTargetUnder(target, "word/media/")
}

// resolveEmbedTarget 嵌入对象关系 Target → word/embeddings/* 条目名
// （与 media 同款合并判定：越界/外部/悬空在簿侧一律不入）
func resolveEmbedTarget(target string) string {
	return resolveTargetUnder(target, "word/embeddings/")
}

// DocxMediaURL media 端点 URL 构造器（share/api 两侧同构查询形态的唯一
// 落字点）。endpoint = 裸端点路径（如 /s/{token}/docx-media 或
// /api/projects/:id/file/media）；查询值经 url.QueryEscape：docPath 是
// 项目/分享内路径（可含中文/空格），media 是 zip 条目名（OPC 规范之外
// 生成器可能写任意字节）——两处都不构成注入面（端点侧对 m= 做映射簿
// 等值匹配白名单），转义只为 URL 与 HTML 属性边界完整
func DocxMediaURL(endpoint, docPath, media string) string {
	return endpoint + "?path=" + url.QueryEscape(docPath) +
		"&m=" + url.QueryEscape(media)
}

// DocxEmbedURL embed 端点 URL 构造器（嵌入对象下载/预览链接）。转义与
// 白名单语义与 DocxMediaURL 同轨——e= 在端点侧做 embeddings 映射簿等值
// 匹配，查询值转义只为 URL 与 HTML 属性边界完整
func DocxEmbedURL(endpoint, docPath, entry string) string {
	return endpoint + "?path=" + url.QueryEscape(docPath) +
		"&e=" + url.QueryEscape(entry)
}

// SniffImageMime 图片魔数嗅探：img 供给只接受真实图片字节
func SniffImageMime(b []byte) string {
	switch {
	case len(b) >= 8 && bytes.Equal(b[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png"
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 6 && (bytes.HasPrefix(b, []byte("GIF87a")) || bytes.HasPrefix(b, []byte("GIF89a"))):
		return "image/gif"
	case len(b) >= 12 && bytes.HasPrefix(b, []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	case len(b) >= 2 && bytes.HasPrefix(b, []byte("BM")):
		return "image/bmp"
	}
	return ""
}

// ── docx 流式解析 ──
// 事件模型（只关心呈现所需的最小子集）：
//   w:p 段落（pPr/pStyle 判标题、pPr/numPr 判列表项；w:br/w:tab 换行缩进）
//   w:tbl 表格（w:tr 行 / w:tc 单元格，单元格内段落只保内容）
//   w:r 内 w:t 文本、w:b/w:i 粗斜体
//   w:drawing 内 a:blip@r:embed、w:pict 内 v:imagedata@r:id → 图片发射
//   （emitImage 产 docx-media 端点 src，P-20261116-6 端点供给形态）
//   mc:AlternateContent：Choice 中选即整棵抑制 Fallback（兼容模式文档把
//   同图同文本同时写进两分支，不抑制会双份）

type docxBuilder struct {
	b strings.Builder

	para      strings.Builder // 当前段落累积
	paraText  int             // 当前段落文本累积量（docxParaMaxBytes 闸）
	paraFull  bool            // 段文本闸触顶（后续文本丢弃，段尾补 …）
	paraMedia bool            // 本段已发射图片/占位块（纯图段不可丢）
	inP       bool
	inT       bool // 当前位于 w:t 文本内
	inCell    bool
	inList    bool // 当前段落带 numPr
	listOpen  bool
	tableOpen bool
	styleID   string
	bold      bool
	italic    bool

	// 嵌入对象（P-20261116-7）：w:object 是嵌入对象的壳（图标 v:imagedata
	// 在前、o:OLEObject 在后）。图元格式的图标与嵌入块合并为单块：图标
	// 发射时若在 object 内且是 EMF/WMF 等浏览器不渲染的格式，先记账不发射
	//（metaPendingEntry = 图标条目名）；随后 o:OLEObject 的嵌入块天然代表
	// 两者，把记账清掉；直到 </w:object> 仍无人认领才补发图元占位块——
	// 避免「破图占位+嵌入占位」双块堆叠
	inObject         bool
	metaPendingEntry string

	// mc:AlternateContent 去重：altStack 逐层记当前 AC 是否已见 Choice，
	// suppressAt 是被抑制 Fallback 子树的根深度（-1 = 未抑制）
	depth      int
	altStack   []bool
	suppressAt int

	media *docxMedia // 图片资产簿（rels 映射/部件表——渲染侧零解压）
	lang  string     // 占位块文案语言（zh/en）
	urls  *MediaURLs // 端点 URL 构造器（P-20261119-4 注入形态，share/api 各自包装）

	outLen int
}

func newDocxBuilder(lang string, urls *MediaURLs, media *docxMedia) *docxBuilder {
	return &docxBuilder{lang: lang, urls: urls, media: media, suppressAt: -1}
}

// mediaURL/embedURL 构造器空安全包装：urls 未注入（降级路径）或字段缺席
// 时返回空串——emitImage/emitEmbed 对空 URL 走既有降级占位块分支，
// 绝不 panic、绝不产出危险 URL
func (p *docxBuilder) mediaURL(entry string) string {
	if p.urls == nil || p.urls.Media == nil {
		return ""
	}
	return p.urls.Media(entry)
}

func (p *docxBuilder) embedURL(entry string) string {
	if p.urls == nil || p.urls.Embed == nil {
		return ""
	}
	return p.urls.Embed(entry)
}

func (p *docxBuilder) write(s string) {
	if p.outLen >= officeHTMLMaxBytes {
		return
	}
	p.b.WriteString(s)
	p.outLen += len(s)
}

// parse 流式消费 document.xml。XML 局部损坏时返回已抽取内容
// （预览语义优先于完整性）
func (p *docxBuilder) parse(r io.Reader) error {
	dec := xml.NewDecoder(r)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil
		}
		switch t := tok.(type) {
		case xml.StartElement:
			p.start(t)
		case xml.EndElement:
			p.end(t.Name.Local)
		case xml.CharData:
			if p.inT && p.suppressAt < 0 {
				p.charData(string(t))
			}
		}
	}
	p.flushParagraph()
	p.closeList()
	p.closeTable()
	return nil
}

func (p *docxBuilder) start(t xml.StartElement) {
	if p.suppressAt >= 0 {
		// mc:Fallback 抑制区：只记账深度，零内容产出
		p.depth++
		return
	}
	switch t.Name.Local {
	case "AlternateContent":
		p.altStack = append(p.altStack, false)
	case "Choice":
		if len(p.altStack) > 0 {
			p.altStack[len(p.altStack)-1] = true
		}
	case "Fallback":
		// 同一 AC 已见 Choice：整棵 Fallback 抑制（同图/同文本双份的源头）
		if len(p.altStack) > 0 && p.altStack[len(p.altStack)-1] {
			p.suppressAt = p.depth
		}
	case "p":
		p.flushParagraph()
		p.inP = true
		p.styleID = ""
	case "tbl":
		p.flushParagraph()
		p.closeList()
		p.tableOpen = true
		p.write("<table>")
	case "tr":
		p.write("<tr>")
	case "tc":
		p.inCell = true
		p.write("<td>")
	case "pStyle":
		p.styleID = attrVal(t)
	case "numPr":
		p.inList = true
	case "r":
		// 新运行：重置上一运行的粗斜体。w:b/w:i 是自闭合属性标记，
		// 只能在 run 边界复位——靠自身的 EndElement 复位会在文本
		// 到达前就被清掉
		p.bold = false
		p.italic = false
	case "b":
		p.bold = flagOn(t)
	case "i":
		p.italic = flagOn(t)
	case "br":
		if p.inP {
			p.paraWrite("<br>")
		}
	case "tab":
		if p.inP {
			p.paraWrite("  ")
		}
	case "t":
		p.inT = true
	case "blip":
		// w:drawing → a:blip@r:embed（新形态图片引用）
		if rid := attrLocal(t, "embed"); rid != "" {
			p.emitImage(rid)
		}
	case "imagedata":
		// w:pict → v:imagedata@r:id（老形态图片引用）
		if rid := attrLocal(t, "id"); rid != "" {
			p.emitImage(rid)
		}
	case "object":
		// w:object 嵌入对象壳（文档序：图标 v:shape 在前、o:OLEObject 在后）
		p.inObject = true
		p.metaPendingEntry = ""
	case "OLEObject":
		// w:object → o:OLEObject（嵌入对象正文，Type="Embed"；r:id 属性
		// local name=id 与 ProgID 经 attrLocal 取值）
		p.emitEmbed(attrLocal(t, "id"), attrLocal(t, "ProgID"))
	}
	p.depth++
}

func (p *docxBuilder) end(name string) {
	p.depth--
	if p.suppressAt >= 0 {
		if p.suppressAt == p.depth {
			p.suppressAt = -1 // 抑制子树收口
		}
		return
	}
	switch name {
	case "p":
		p.flushParagraph()
	case "tbl":
		p.closeTable()
	case "tr":
		p.write("</tr>")
	case "tc":
		p.flushParagraph()
		p.write("</td>")
		p.inCell = false
	case "t":
		p.inT = false
	case "object":
		p.inObject = false
		// 图元图标记账无人认领（object 内无 o:OLEObject——部分生成器把普通
		// VML 图也包进 w:object）：补发图元占位块，不留破图
		if entry := p.metaPendingEntry; entry != "" {
			p.metaPendingEntry = ""
			p.emitMetafilePlaceholder(entry)
		}
	case "AlternateContent":
		if len(p.altStack) > 0 {
			p.altStack = p.altStack[:len(p.altStack)-1]
		}
	}
}

// paraWrite 段落文本累积（过 docxParaMaxBytes 单段闸与总闸真预算）。
// 触闸后丢弃后续文本并在段尾补一次 …（段粒度丢弃，标签保持配对——
// 丢弃粒度是完整 seg，不会截半 <strong> 等 wrap）
func (p *docxBuilder) paraWrite(s string) {
	if p.paraFull {
		return
	}
	if p.paraText+len(s) > docxParaMaxBytes ||
		p.outLen+p.para.Len()+len(s) > officeHTMLMaxBytes {
		p.paraFull = true
		p.para.WriteString("…") // 截断指示（常数 3 字节，闸外）
		return
	}
	p.para.WriteString(s)
	p.paraText += len(s)
}

// charData 累积 w:t 文本（转义在此处完成）。超长单段先按 rune 边界
// 预裁原始字节再转义，并补 … 指示（预留 3 字节给指示位）——单段文本
// 不再无界累积（既有潜伏点）
func (p *docxBuilder) charData(text string) {
	if p.paraFull {
		return
	}
	if room := docxParaMaxBytes - p.paraText - 3; len(text) > room {
		text = utf8Cut(text, room) + "…"
	}
	seg := html.EscapeString(text)
	if p.bold {
		seg = "<strong>" + seg + "</strong>"
	}
	if p.italic {
		seg = "<em>" + seg + "</em>"
	}
	p.paraWrite(seg)
}

// emitImage 图片发射（P-20261116-6 端点供给形态）：命中 rels 映射 →
// <img src="/s/{token}/docx-media?path=…&m=…">（URL 恒为常数体积，图片
// 字节由端点流式供给，HTML 预算不再被 base64 膨胀消耗；src 属性值经
// html.EscapeString、查询值经 url.QueryEscape）；未命中（悬空 rId/越界/
// 外部/非 image 关系）或 HTML 残量不足整标签 → 占位提示块（图片名+声明
// 大小+下载可见语义）。发射进当前段（行内图），预算验算含段内未落盘
// 字节。端点侧拒收（超限/非图字节）表现为该 img 加载失败——真实 docx
// 的 media 部件几乎恒为图片，占位留给映射层就能判定的失败。
// P-20261116-7：图元格式（EMF/WMF 等）浏览器渲染不了，img 注定 404 破图
// ——按条目扩展名判 known-non-renderable 不发射 img，改图元占位块（在
// w:object 内则是嵌入对象图标，先记账待 o:OLEObject 合并）
func (p *docxBuilder) emitImage(rID string) {
	remaining := officeHTMLMaxBytes - p.outLen - p.para.Len()
	entry, relOK := p.media.rels[rID]
	if relOK && isMetafileEntry(entry) {
		// 图元图标：object 内 = 嵌入对象代理，记账合并（oleObject 在后）；
		// 独立图片 = 直接给诚实占位（不发射注定 404 的 img）
		if p.inObject {
			p.metaPendingEntry = entry
			return
		}
		p.emitMetafilePlaceholder(entry)
		return
	}
	if relOK && remaining > 0 {
		img := `<img src="` + html.EscapeString(p.mediaURL(entry)) +
			`" alt="` + html.EscapeString(mediaDisplayName(entry)) + `">`
		if len(img) <= remaining {
			p.para.WriteString(img)
			p.paraMedia = true
			return
		}
	}
	// 降级占位：HTML 残量不足整 img / 映射未命中。占位自身也要原子
	//（预算残量极小时整块放弃，绝不截半标签）。名字优先取 rels 登记的
	// 展示名（含被过滤关系），完全无登记（悬空 rId）泛称 image
	name := p.media.names[rID]
	if name == "" && relOK {
		name = mediaDisplayName(entry)
	}
	ph := `<span class="doc-img-missing">🖼 ` + html.EscapeString(name)
	if relOK {
		if f := p.media.parts[entry]; f != nil {
			ph += " · " + fmtSize(int64(f.UncompressedSize64))
		}
	}
	ph += " · " + html.EscapeString(dictFor(p.lang)["docImgMissing"]) + `</span>`
	if len(ph) <= remaining {
		p.para.WriteString(ph)
		p.paraMedia = true
	}
}

// emitMetafilePlaceholder 图元格式占位块（P-20261116-7）：EMF/WMF/压缩
// 图元/TIFF 浏览器不渲染，与其发射注定 404 的破图不如诚实告知。样式与
// 原子发射语义复用 doc-img-missing 占位形态（虚线框+双语提示）
func (p *docxBuilder) emitMetafilePlaceholder(entry string) {
	remaining := officeHTMLMaxBytes - p.outLen - p.para.Len()
	ph := `<span class="doc-img-missing">🖼 ` + html.EscapeString(mediaDisplayName(entry))
	if f := p.media.parts[entry]; f != nil {
		ph += " · " + fmtSize(int64(f.UncompressedSize64))
	}
	ph += " · " + html.EscapeString(dictFor(p.lang)["docImgMetafile"]) + `</span>`
	if len(ph) <= remaining {
		p.para.WriteString(ph)
		p.paraMedia = true
	}
}

// emitEmbed 嵌入对象发射（P-20261116-7，P-20261118-1 名字还原+预览分型，
// P-20261118-3 单行链接形态）：
// o:OLEObject 命中 embeddings 映射 → 嵌入块。可预览型 = 单行 span 双动作
// 「📎 名 · 大小 · 预览 | 下载」——预览一律新标签 <a target=_blank
// rel=noopener> 零 JS：html/htm 进预览器壳页 URL（&ui=1，P-20261118-3 起
// 页内 iframe 形态整体退役——文档阅读列恢复干净，用户实测主诉），其余
// 类型直连 preview=1（md 自带轻量壳/text 纯文本/pdf·image 原生查看器）；
// 其余 = <a class="doc-embed"> 单链接。名字还原链：
// 簿级抽取的原始文件名（GBK 经 GB18030 解码）优先 → rels 展示名 → 条目名
// （.bin）。ProgID 语义钉死（评审必改④）：抽名成功不显（Package 等恒显
// 噪声，类型信息由还原名扩展名承载）；抽名失败照显（ProgID 是 .bin 唯一
// 身份线索）。ext 白名单判定在服务端 embedPreviewFor（评审建议b：前端
// data 标记随页内 iframe 分支一并退役，零 JS 挂点）。
// 发射形态与 emitImage 同款：直接写当前段 + remaining 原子验算 + paraMedia
// 置位保纯媒体段不丢；ProgID/展示名一律 html.EscapeString、URL 值
// url.QueryEscape。未命中（无 r:id/悬空/越界/外部）→ 无链接占位块（诚实
// 告知不可从预览取回，不破坏文本预览）；无 r:id 的 ProgID-only 形态静默
// 跳过（死引用，图标已足够）。同时清掉 object 内图元图标记账——嵌入块
// 天然代表「图标+本体」两者，不再单独发图元占位（单块不堆叠）
func (p *docxBuilder) emitEmbed(rID, progID string) {
	if rID == "" {
		return // 无 r:id：死引用静默跳过（不破坏文本预览）；图元图标记账
		// 不动，交回 </w:object> 补发——图标自身仍是真实内容
	}
	remaining := officeHTMLMaxBytes - p.outLen - p.para.Len()
	entry, relOK := p.media.embeds[rID]
	if relOK && remaining > 0 {
		orig := p.media.extracted[entry]
		name := orig
		if name == "" {
			name = p.media.names[rID]
		}
		if name == "" {
			name = mediaDisplayName(entry)
		}
		dlURL := p.embedURL(entry)
		blk := ""
		if _, ext, ok := EmbedPreviewFor(name); ok {
			// 可预览块（P-20261118-3 单行链接形态）：预览一律新标签
			// <a target=_blank rel=noopener> 零 JS——html/htm 进预览器壳页
			// URL（&ui=1：开关/风险提示/全幅 iframe 各自就位，文档阅读列
			// 不再被页内 iframe 撑乱），其余类型直连 preview=1（md 自带
			// 轻量壳/text 纯文本/pdf·image 原生查看器）。data-embed-ext/
			// data-embed-url 标记随 enhanceArticle 页内 iframe 分支一并
			// 退役（评审建议b：ext 白名单判定在服务端 embedPreviewFor，
			// 零 JS 挂点）
			pvURL := dlURL + "&preview=1"
			if ext == "html" || ext == "htm" {
				pvURL = dlURL + "&ui=1"
			}
			blk = `<span class="doc-embed"><span class="doc-embed-name">📎 ` + html.EscapeString(name)
			if f := p.media.parts[entry]; f != nil {
				blk += " · " + fmtSize(int64(f.UncompressedSize64))
			}
			blk += `</span><span class="doc-embed-acts"><a href="` + html.EscapeString(pvURL) +
				`" target="_blank" rel="noopener">` + html.EscapeString(dictFor(p.lang)["docEmbedPreview"]) +
				`</a> · <a href="` + html.EscapeString(dlURL) + `" data-embed-dl="1">` +
				html.EscapeString(dictFor(p.lang)["download"]) + `</a></span></span>`
		} else {
			// 不可预览维持单链接形态（P-7 现貌）：svg 可携脚本/图元/压缩包/
			// 抽名失败回落名等——恒 attachment 红线不因 preview 参数松动
			blk = `<a class="doc-embed" href="` + html.EscapeString(dlURL) + `">📎 ` + html.EscapeString(name)
			if orig == "" && progID != "" && progID != name {
				blk += " · " + html.EscapeString(progID)
			}
			if f := p.media.parts[entry]; f != nil {
				blk += " · " + fmtSize(int64(f.UncompressedSize64))
			}
			blk += " · " + html.EscapeString(dictFor(p.lang)["docEmbedFile"]) + `</a>`
		}
		if len(blk) <= remaining {
			p.para.WriteString(blk)
			p.paraMedia = true
			p.metaPendingEntry = "" // 嵌入块已代表 object 内图元图标
			return
		}
	}
	// 降级占位（悬空/越界/外部/预算不足）：无链接诚实块——名字优先渲染侧
	// 还原名（必改④降级分支同步），再 rels 登记展示名（含被过滤关系——
	// names 登记在簿侧过滤之前，悬空关系也报得出引用了什么），完全无登记
	//（悬空 rId）用 ProgID 泛称，再兜底泛称 embed
	name := ""
	if relOK {
		name = p.media.extracted[entry]
	}
	if name == "" {
		name = p.media.names[rID]
	}
	if name == "" {
		name = progID
	}
	if name == "" {
		name = "embed"
	}
	ph := `<span class="doc-img-missing">📎 ` + html.EscapeString(name) +
		" · " + html.EscapeString(dictFor(p.lang)["docEmbedMissing"]) + `</span>`
	if len(ph) <= remaining {
		p.para.WriteString(ph)
		p.paraMedia = true
		p.metaPendingEntry = ""
		return
	}
	// 预算连无链接占位都放不下：图元图标记账交回 </w:object>——更小的
	// 图元占位还有机会整块放下，绝不双块截半
}

// isMetafileEntry 图元格式判定（P-20261116-7，按 zip 条目扩展名）：
// EMF/WMF 原生与 .emz/.wmz 压缩变体（Windows 粘贴图高频）+ TIFF（扫描件
// 高频）——浏览器均不渲染。端点侧魔数嗅探白名单不变（图元直访仍 404），
// 本判定只决定「渲染侧要不要发射注定失败的 img」。按扩展名的 best-effort：
// 改名伪装的图元仍走 img→404 破图路径，与图片伪装同理（端点拒收兜底）
func isMetafileEntry(entry string) bool {
	switch strings.ToLower(path.Ext(entry)) {
	case ".emf", ".wmf", ".emz", ".wmz", ".tif", ".tiff":
		return true
	}
	return false
}

// mediaDisplayName 展示用媒体名（zip 条目名取文件名部分；空名泛称）
func mediaDisplayName(name string) string {
	if base := path.Base(name); base != "" && base != "." && base != "/" {
		return base
	}
	return "image"
}

// ── 嵌入对象可预览类型直览（P-20261118-1 ③preview 分型） ──

// embedPreviewMimes preview=1 的显式扩展名白名单（评审必改①：禁 Kind→MIME
// 整体映射）——svg 是 KindImage 但可携脚本必须留在外面；text 族一律
// text/plain（registry 的 js/css MIME 是 HTML 子资源消费面，嵌入预览按
// registry 直出 text/javascript 违背「预览=文档」语义）。值=preview 响应的
// Content-Type。md/markdown → text/html（修订一「md 支持渲染」：bluemonday
// 管线渲染出 HTML 壳——渲染器本就是不信任输入的设计，嵌入 md 与分享 .md
// 同构；text/plain 是范围 YAGNI 取舍而非安全墙）。html/htm 的交互面在
// 新标签预览器壳页（&ui=1，embedshell.go——P-20261118-3 起页内 iframe
// 形态退役）。白名单外（svg/emf/wmf/tiff/压缩包/可执行/未知扩展名/抽名
// 失败回落名 .bin）preview=1/ui=1 一律忽略回归 attachment——ext 从还原名
// path.Ext 判定，回落条目名 ext=.bin 天然白名单外
var embedPreviewMimes = map[string]string{
	"html": "text/html", "htm": "text/html",
	"pdf": "application/pdf",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
	"gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
	"md": "text/html", "markdown": "text/html",
	"txt": "text/plain", "log": "text/plain", "text": "text/plain",
	"json": "text/plain", "yaml": "text/plain", "yml": "text/plain",
	"toml": "text/plain", "ini": "text/plain", "conf": "text/plain",
	"xml": "text/plain", "sql": "text/plain",
	"csv": "text/plain", "tsv": "text/plain",
}

// EmbedPreviewFor 嵌入还原名的 preview 分型：返回 MIME 与白名单键（小写
// 无点 ext）。未命中 = preview 参数忽略回归 attachment
func EmbedPreviewFor(name string) (mime, ext string, ok bool) {
	ext = strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	mime, ok = embedPreviewMimes[ext]
	return mime, ext, ok
}

// embedSandboxTokens iframe sandbox 属性的 token 组装（P-20261118-3 起
// 壳页与 CSP 两侧共用本表——两层取交集、互斥规则一致，handleHTMLDoc
// 同款纪律）。硬红线构造性成立：token 全集={allow-scripts, allow-forms,
// allow-popups, allow-fullscreen, allow-modals}——由下表固定映射产出，
// allow-same-origin（同源即还原应用凭据读取能力）与 allow-top-navigation
// （原型带跑整个分享页=钓鱼逃逸面；原型的页内链接本就只导航 iframe 自身）
// 不在任何映射项，任何参数组合恒不含（构造性保证+e2e 断言双保险）。
// scripts=1 同加 allow-fullscreen（复审增强c：原型演示高频、纯呈现无凭据
// 风险、opaque origin 无逃逸面）；forms=1 同加 allow-modals（复审增强d：
// sandbox 默认禁 alert/confirm/prompt——原型 JS 弹窗静默 no-op 与「交互
// 全支持」口径有落差，开关文档注记含 modals）。参数语义=访客显式 opt-in、
// 无定时、不自动回落（开关在壳页 form GET，常驻风险提示随级切换）
func embedSandboxTokens(r *http.Request) string {
	q := r.URL.Query()
	return EmbedSandboxTokensFor(
		q.Get("scripts") == "1", q.Get("forms") == "1", q.Get("popups") == "1")
}

// EmbedSandboxTokensFor token 表的参数化形态（壳页侧以 UI 推导态取
// token——「允许表单与弹窗」单开关的 popups 联动由壳页推导，直连
// preview URL 仍走 embedSandboxTokens 原样 8 组合面）
func EmbedSandboxTokensFor(scripts, forms, popups bool) string {
	tokens := ""
	if scripts {
		tokens += " allow-scripts allow-fullscreen"
	}
	if forms {
		tokens += " allow-forms allow-modals"
	}
	if popups {
		tokens += " allow-popups"
	}
	return strings.TrimPrefix(tokens, " ")
}

// EmbedSandboxCSP html 档 preview 的 CSP sandbox 头组装（修订二/三）：
// 「sandbox」+ 上表 token（无参数时裸 sandbox，8 组合表断言锚定）
func EmbedSandboxCSP(r *http.Request) string {
	if tokens := embedSandboxTokens(r); tokens != "" {
		return "sandbox " + tokens
	}
	return "sandbox"
}

// embedMDShellCSS md 预览壳的自包含内联样式（复审采纳：精简 .md-article
// 子集勿引整份页面 CSS）——排版骨架+深浅双态（prefers-color-scheme 跟随
// 系统；访客预览独立页无页面主题系统可挂）
const embedMDShellCSS = `body{margin:0;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;` +
	`background:#fff;color:#1f2328}` +
	`@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}` +
	`.md-article{max-width:860px;margin:0 auto;padding:32px 20px;overflow-wrap:break-word}` +
	`.md-article h1,.md-article h2,.md-article h3,.md-article h4,.md-article h5,.md-article h6{line-height:1.3;margin:1.6em 0 .6em}` +
	`.md-article h1{font-size:1.9em}.md-article h2{font-size:1.5em}` +
	`.md-article h1,.md-article h2{border-bottom:1px solid #d0d7de;padding-bottom:.3em}` +
	`@media (prefers-color-scheme:dark){.md-article h1,.md-article h2{border-color:#30363d}}` +
	`.md-article pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}` +
	`@media (prefers-color-scheme:dark){.md-article pre{background:#161b22}}` +
	`.md-article code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}` +
	`.md-article table{border-collapse:collapse;max-width:100%}` +
	`.md-article th,.md-article td{border:1px solid #d0d7de;padding:6px 12px}` +
	`@media (prefers-color-scheme:dark){.md-article th,.md-article td{border-color:#30363d}}` +
	`.md-article img{max-width:100%}` +
	`.md-article blockquote{margin:0;padding:0 1em;color:#656d76;border-left:3px solid #d0d7de}` +
	`@media (prefers-color-scheme:dark){.md-article blockquote{color:#8b949e;border-color:#30363d}}` +
	`.md-article a{color:#0969da}` +
	`@media (prefers-color-scheme:dark){.md-article a{color:#58a6ff}}`

// MDShell md 预览的轻量完整 HTML 壳（修订一「md 支持渲染」）：bluemonday
// 管线产物为 HTML 片段，壳供新标签/页内直开。title=还原文件名（测试断言锚）。
// rewriteRelativeAssets 不做——嵌入 md 无分享内兄弟文件语境，相对图片/链接
// 解析到 /s/{t}/ 根 404，与 html 档「诚实 404」同构（复审建议e）
func MDShell(name, body string) []byte {
	var b strings.Builder
	b.WriteString(`<!doctype html><html><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	b.WriteString(`<title>` + html.EscapeString(name) + `</title>`)
	b.WriteString(`<style>` + embedMDShellCSS + `</style></head>`)
	b.WriteString(`<body><article class="md-article">` + body + `</article></body></html>`)
	return []byte(b.String())
}

// flushParagraph 段落收口：按样式/列表语境映射为 h1-h6/li/p
func (p *docxBuilder) flushParagraph() {
	body := p.para.String()
	hasMedia := p.paraMedia
	p.para.Reset()
	p.inP = false
	p.inT = false
	p.paraText = 0
	p.paraFull = false
	p.paraMedia = false
	if p.inCell {
		// 单元格内段落不套 p（td 已有盒模型），仅保内容
		p.write(body)
		return
	}
	trimmed := strings.TrimSpace(strings.ReplaceAll(body, "<br>", ""))
	if trimmed == "" && !hasMedia {
		p.closeList()
		return
	}
	if trimmed == "" {
		// 纯图段：只含 img/占位块的段落不可丢，按普通段输出
		p.closeList()
		p.write("<p>" + body + "</p>")
		p.inList = false
		return
	}

	level := headingLevel(p.styleID)
	switch {
	case level > 0:
		p.closeList()
		if level > 6 {
			level = 6
		}
		p.write("<h" + digit(level) + ">" + body + "</h" + digit(level) + ">")
	case p.inList:
		if !p.listOpen {
			p.write("<ul>")
			p.listOpen = true
		}
		p.write("<li>" + body + "</li>")
	default:
		p.closeList()
		p.write("<p>" + body + "</p>")
	}
	p.inList = false
}

func (p *docxBuilder) closeList() {
	if p.listOpen {
		p.write("</ul>")
		p.listOpen = false
	}
}

func (p *docxBuilder) closeTable() {
	if p.tableOpen {
		p.write("</table>")
		p.tableOpen = false
	}
}

func (p *docxBuilder) html() string { return p.b.String() }

// attrLocal 按属性 local name 取值（命名空间 URI 不统一，只认局部名）。
// 评审必改④：原 attrVal 只认 val——a:blip 的 r:embed、v:imagedata 的
// r:id、rels 的 Id/Target/Type/TargetMode 都不是 val
func attrLocal(t xml.StartElement, local string) string {
	for _, a := range t.Attr {
		if a.Name.Local == local {
			return a.Value
		}
	}
	return ""
}

// attrVal 取 w:val 属性（pStyle/b/i 等的取值形态）
func attrVal(t xml.StartElement) string { return attrLocal(t, "val") }

// flagOn 布尔属性语义：无 val = 开（<w:b/>）；val="0"/"false"/"off" = 关
func flagOn(t xml.StartElement) bool {
	switch strings.ToLower(attrVal(t)) {
	case "0", "false", "off":
		return false
	}
	return true
}

// headingLevel 样式 ID → 标题级别（Title/Subtitle/Heading1..9；docx 模板
// 的样式 ID 与界面语言无关，中文模板同样使用这些英文 ID）
func headingLevel(styleID string) int {
	s := strings.ToLower(styleID)
	switch {
	case s == "title":
		return 1
	case s == "subtitle":
		return 2
	case len(s) > 7 && strings.HasPrefix(s, "heading"):
		if n := atoi(s[7:]); n > 0 {
			return clamp(n, 1, 9)
		}
	}
	return 0
}

func clamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func digit(n int) string { return string(rune('0' + n)) }

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// utf8Cut 按 rune 边界截到至多 n 字节（不破开多字节字符——尾部残缺
// rune 整个丢弃，回退到上一个完整边界）
func utf8Cut(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	for n > 0 {
		if r, size := utf8.DecodeLastRuneInString(s[:n]); r != utf8.RuneError || size > 1 {
			break // 尾部是完整 rune，边界合法
		}
		n-- // 残缺 rune 尾巴，丢弃回退
	}
	return s[:n]
}

// writeEscapedParagraphs 纯文本按行分段输出（doc 老格式抽取路径）
func writeEscapedParagraphs(b *strings.Builder, text string) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	for _, para := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(para)
		if trimmed == "" {
			continue
		}
		b.WriteString("<p>" + html.EscapeString(trimmed) + "</p>")
	}
	b.WriteString("</div>")
}
