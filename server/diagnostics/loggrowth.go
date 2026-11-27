package diagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 大文件/日志增长面（P-20261124-1 S2⑤）：state/large-files.json 回答「是不是
// 日志在长、轮转到底有没有生效」。数据源复用 collectStorage 的同一次
// WalkDir（绝不新增 walk），Top20 按体积降序。
//
// 红线：
//   - data/ 是凭据库：只报文件数与总字节，不列任何文件名；
//   - >100MB 的日志文件标 rotation=missing（同目录找不到 .1 轮转副本）——
//     2026-11-24 复盘里 dsh-web.log 350MB 单文件就是增长失控的直接证据；
//   - 路径一律过 Redactor（$DATA_DIR / ~），不写盘符/用户名。

const (
	// largeFileTopN Top 大文件条数
	largeFileTopN = 20
	// largeFileRotateThreshold 判「轮转缺失」的体积阈值
	largeFileRotateThreshold = 100 << 20
)

// LargeFileSample 单条大文件
type LargeFileSample struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	// Rotation missing = >100MB 且无 .1 轮转副本
	Rotation string `json:"rotation,omitempty"`
	// rel 采集内相对路径（不落盘；轮转判定的 stat 锚点）
	rel string
}

// LargeFilesReport state/large-files.json 的结构（walk 侧填充）
type LargeFilesReport struct {
	GeneratedAt string            `json:"generatedAt"`
	Top         []LargeFileSample `json:"top"`
	DataFiles   int64             `json:"dataDirFiles"`
	DataBytes   int64             `json:"dataDirBytes"`
	Notes       []string          `json:"notes,omitempty"`
}

// add 维护 TopN（插入排序，N=20；walk 热路径上每条文件一次比较，量级可忽略）
func (r *LargeFilesReport) add(abs, rel string, size int64, red *Redactor) {
	if size <= 0 {
		return
	}
	s := LargeFileSample{Path: red.Path(abs), Bytes: size, rel: rel}
	if len(r.Top) < largeFileTopN {
		r.Top = append(r.Top, s)
		sort.Slice(r.Top, func(i, j int) bool { return r.Top[i].Bytes > r.Top[j].Bytes })
		return
	}
	if size <= r.Top[len(r.Top)-1].Bytes {
		return
	}
	r.Top[len(r.Top)-1] = s
	sort.Slice(r.Top, func(i, j int) bool { return r.Top[i].Bytes > r.Top[j].Bytes })
}

// isLogLike 日志类路径（轮转结论只对日志有意义）
func isLogLike(rel string) bool {
	base := strings.ToLower(filepath.Base(rel))
	return strings.HasSuffix(base, ".log") || strings.HasSuffix(base, ".log.1") ||
		strings.HasSuffix(base, ".out")
}

// renderLargeFilesJSON 落 state/large-files.json；轮转判定在这里做（walk 之后
// 至多 TopN 次 stat，不进热路径）
func renderLargeFilesJSON(r LargeFilesReport, dataDir string, red *Redactor) string {
	doc := r
	if doc.Top == nil {
		doc.Top = []LargeFileSample{}
	}
	doc.DataFiles = r.DataFiles
	doc.DataBytes = r.DataBytes
	if r.DataFiles > 0 {
		doc.Notes = append(doc.Notes,
			"data/ is the credential store — file count and total bytes only, no file names are ever listed")
	}
	for i := range doc.Top {
		f := &doc.Top[i]
		if f.Bytes < largeFileRotateThreshold || !isLogLike(f.rel) {
			continue
		}
		if _, serr := os.Stat(filepath.Join(dataDir, f.rel) + ".1"); serr != nil {
			f.Rotation = "missing"
			doc.Notes = append(doc.Notes,
				f.Path+" is >=100MB with no .1 rotation copy — growth is unbounded; check log level / retention / the writer that owns it")
		}
	}
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// rotationNote 单文件轮转结论（dsh-summary 等复用的同一判据）
func rotationNote(path string, size int64) string {
	if size < largeFileRotateThreshold {
		return ""
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		return "size>=100MB and no .1 rotation copy (rotation=missing)"
	}
	return "rotation copy present (.1)"
}
