package filepreview

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"time"
)

// ── docx media/embed 部件统一取件（P-20261119-4 端点无关取数半边） ──
//
// share /s/{token}/docx-media|docx-embed 与主应用 /api/projects/:id/file/
// media|embed 四个端点的共用取件链：zip 打开 → 簿构建（rels 映射 + 嵌入
// 名还原）→ m=/e= 白名单等值匹配 → 解压闸读取（→ media 魔数嗅探）。
// 端点侧只剩各自的源解析与守卫，取件判定不再有第二份实现。

// DocxPart 单个 media/embed 部件的取件结果。Name 是展示名链的产物
// （embed：还原名 → rels 展示名 → 条目名；media：条目文件名），
// ContentType 仅 media 查询携带嗅探结果（embed 恒 attachment 语义由端点定）
type DocxPart struct {
	Data        []byte
	Entry       string    // zip 条目名
	Name        string    // 展示名（下载/预览响应头与壳页标题）
	Size        int64     // zip 元数据声明尺寸（壳页展示；可伪造不作闸）
	ModTime     time.Time // zip 元数据修改时间（ServeContent 用）
	ContentType string    // media 查询：魔数嗅探 MIME；embed 查询恒空
}

// 取件失败哨兵（端点侧映射各自协议：share → errTargetMissing/errTooLarge，
// api → 404/413）
var (
	// ErrDocxPartMissing 条目未命中（坏 zip/悬空映射/白名单外参数/伪装
	// 非图字节）——一律按 404 语义处理，绝不透传任何字节
	ErrDocxPartMissing = errors.New("filepreview: docx part not found")
	// ErrDocxPartTooLarge 超单部件解压上限（解压炸弹面）——413 语义
	ErrDocxPartTooLarge = errors.New("filepreview: docx part too large")
)

// docxBookFrom 打开 docx zip 并构建资产簿（媒体/嵌入映射 + 抽名）。
// f 需为 *os.File（io.ReaderAt + Seek；os.Root.Open 产物天然满足）
func docxBookFrom(f *os.File, size int64) (*docxMedia, error) {
	zr, err := zip.NewReader(f, size)
	if err != nil {
		return nil, ErrDocxPartMissing
	}
	var relsXML *zip.File
	for _, zf := range zr.File {
		if zf.Name == "word/_rels/document.xml.rels" {
			relsXML = zf
			break
		}
	}
	return newDocxMedia(relsXML, zr), nil
}

// DocxMediaData media 端点取件：m= 白名单等值匹配 → 解压闸读取 →
// 图片魔数嗅探（非图条目按 Missing 回落——伪装条目绝不透传）
func DocxMediaData(f *os.File, size int64, m string) (*DocxPart, error) {
	book, err := docxBookFrom(f, size)
	if err != nil {
		return nil, err
	}
	entry := ""
	for _, name := range book.rels {
		if name == m {
			entry = name
			break
		}
	}
	part := book.parts[entry]
	if part == nil {
		return nil, ErrDocxPartMissing
	}
	rc, err := part.Open()
	if err != nil {
		return nil, ErrDocxPartMissing
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, DocxMediaMaxBytes+1))
	if err != nil || len(data) > DocxMediaMaxBytes {
		return nil, ErrDocxPartTooLarge
	}
	mime := SniffImageMime(data)
	if mime == "" {
		// 非图字节（伪装条目）：绝不透传，404 让 <img> 自然呈加载失败
		return nil, ErrDocxPartMissing
	}
	return &DocxPart{
		Data:        data,
		Entry:       entry,
		Name:        mediaDisplayName(entry),
		Size:        int64(part.UncompressedSize64),
		ModTime:     part.Modified,
		ContentType: mime,
	}, nil
}

// DocxEmbedData embed 端点取件：e= 白名单等值匹配 → 解压闸读取 →
// 展示名还原链（簿构建期抽出的原始文件名优先，任何疑点回落条目名——
// 抽取失败只影响文件名观感，绝不影响可下载性）
func DocxEmbedData(f *os.File, size int64, e string) (*DocxPart, error) {
	book, err := docxBookFrom(f, size)
	if err != nil {
		return nil, err
	}
	entry := ""
	for _, name := range book.embeds {
		if name == e {
			entry = name
			break
		}
	}
	part := book.parts[entry]
	if part == nil {
		return nil, ErrDocxPartMissing
	}
	rc, err := part.Open()
	if err != nil {
		return nil, ErrDocxPartMissing
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, DocxEmbedMaxBytes+1))
	if err != nil || len(data) > DocxEmbedMaxBytes {
		return nil, ErrDocxPartTooLarge
	}
	name := mediaDisplayName(entry)
	if extracted := book.extracted[entry]; extracted != "" {
		name = extracted
	}
	return &DocxPart{
		Data:    data,
		Entry:   entry,
		Name:    name,
		Size:    int64(part.UncompressedSize64),
		ModTime: part.Modified,
	}, nil
}
