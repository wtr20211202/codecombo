// 出域路径相对化（P-20261003-113）：transcript 正文嵌着本机绝对路径（含用户
// 名与目录结构），导出/分享等出域口把它们原样带出去——泄露主机布局。本文件
// 提供出域前最后一跳的改写原语：仅精确匹配会话工作目录（项目 root）的前缀，
// 改写为项目相对形态；不可识别的路径一律原样保留（宁可不改写，不可改错）。
//
// 改写口径（root 须为完整路径段前缀——root 是别的目录名前缀时不命中，如
// root=`D:\p` 不动 `D:\project`）：
//   - root + 路径分隔符 → 整段剥除（剩余即相对路径）
//   - root（边界处裸出现）→ "."（项目根的相对形态）
//
// 反斜杠与正斜杠两种分隔形态同场匹配（Windows 下 claude 两种都写）；大小写
// 敏感精确匹配——Windows 大小写不敏感变体不进改写界内，误判面最小化。
package claudesessions

import (
	"bufio"
	"bytes"
	"io"
	"strings"
)

// relRoot 归一化的改写根：去尾分隔符；为空或只剩盘根级形态（`C:`、单段目录）
// 返回空串——过泛的前缀会误伤盘内所有路径（`C:\` 级），放弃改写。会话 cwd
// 是项目目录，实际不会命中此闸
func relRoot(root string) string {
	root = strings.TrimRight(root, `\/`)
	if root == "" || !strings.ContainsAny(root, `\/`) {
		return ""
	}
	return root
}

// RelativizeText 把文本中项目根绝对路径改写为项目相对形态（出域口共用原语：
// md 导出的条目正文/工具输入，未来会话分享形态同此）。root 为会话 cwd
// （transcript 头部携带的宿主真实路径）；root 不可用或未命中时原样返回。
// 边界 = 路径分隔符或串尾：后随分隔符按 root+分隔符剥除，串尾裸 root 收敛
// "."，其余（root 后随普通字符）原样保留命中段继续向后扫
func RelativizeText(s, root string) string {
	root = relRoot(root)
	if s == "" || root == "" {
		return s
	}
	s = stripRoot(s, root)
	// Windows root 的正斜杠书写形态（D:/p/...）与反斜杠形态并存，二次扫描；
	// Unix root 两形态同串，跳过
	if fwd := strings.ReplaceAll(root, `\`, `/`); fwd != root {
		s = stripRoot(s, fwd)
	}
	return s
}

// stripRoot 单一根形态（原文）的改写扫描。每次迭代至少消费一个命中段，无环
func stripRoot(s, root string) string {
	var b strings.Builder
	for {
		i := strings.Index(s, root)
		if i < 0 {
			b.WriteString(s)
			return b.String()
		}
		b.WriteString(s[:i])
		rest := s[i+len(root):]
		switch {
		case rest != "" && (rest[0] == '\\' || rest[0] == '/'):
			s = rest[1:] // root+分隔符整段剥除，剩余即相对路径
		case rest == "":
			b.WriteByte('.')
			return b.String()
		default:
			b.WriteString(root) // 非完整路径段前缀：原样保留，从命中段后继续
			s = rest
		}
	}
}

// CopyRelativizedJSONL 把原始 transcript JSONL 逐行按项目 root 相对化改写后
// 拷贝到 dst（JSONL 出域口）。JSON 串内的路径以转义形态出现（反斜杠加倍），
// 改写按转义字节口径进行：边界 = 转义分隔符 `\\` / 正斜杠 `/` / JSON 串界 `"`
// /流尾——`"` 是每行 cwd 字段值的收尾（`"cwd":"<root>"`），是裸 root 在
// JSONL 里最普遍的出场形态。root 不可用时退化为直通拷贝（出域不因锚点缺失
// 而失败）。逐行处理内存有界：单行驻留 = 最长行（消息级；含大载荷的行可达
// 数 MB，与 md 渲染侧 32MB 尾窗同量级）
func CopyRelativizedJSONL(dst io.Writer, src io.Reader, root string) (int64, error) {
	rel := newJSONLRelativizer(root)
	if rel == nil {
		return io.Copy(dst, src)
	}
	r := bufio.NewReader(src)
	var written int64
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			line = rel.line(line)
			if _, werr := dst.Write(line); werr != nil {
				return written, werr
			}
			written += int64(len(line))
		}
		if err != nil {
			if err == io.EOF {
				return written, nil
			}
			return written, err
		}
	}
}

// ScanRelativizedJSONL 逐行回吐「相对化改写后」的字节给 onLine（出域敏感
// 扫描挂点，P-20261004-113）：扫描必须发生在改写链下游——扫的是最终出域
// 内容，路径前缀剥除后再判定（改写与拷贝共用 jsonlRelativizer.line，防
// 两套实现漂移）。只读不写；调用方负责扫完回绕 reader（文件句柄 Seek(0)）
// 再走 CopyRelativizedJSONL 出流。root 不可用时按原样直通（与拷贝链同口径）
func ScanRelativizedJSONL(src io.Reader, root string, onLine func(line []byte)) error {
	rel := newJSONLRelativizer(root)
	r := bufio.NewReader(src)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			if rel != nil {
				line = rel.line(line)
			}
			onLine(line)
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// jsonlRelativizer 单次改写会话的预编译根形态（转义反斜杠 / 正斜杠两态）。
// nil = root 不可用（直通）
type jsonlRelativizer struct {
	esc []byte
	fwd []byte
}

func newJSONLRelativizer(root string) *jsonlRelativizer {
	root = relRoot(root)
	if root == "" {
		return nil
	}
	rel := &jsonlRelativizer{esc: []byte(strings.ReplaceAll(root, `\`, `\\`))}
	if fwd := strings.ReplaceAll(root, `\`, `/`); fwd != root {
		rel.fwd = []byte(fwd)
	}
	return rel
}

// line 单行改写（拷贝链与扫描链同一实现）
func (r *jsonlRelativizer) line(line []byte) []byte {
	line = stripRootJSONL(line, r.esc)
	if r.fwd != nil {
		line = stripRootJSONL(line, r.fwd)
	}
	return line
}

// stripRootJSONL 单一根形态（JSON 转义后）的改写扫描。正斜杠在 JSON 串内无
// 转义原样出现；反斜杠分隔符以 `\\` 双字节出场（单 `\` 必是其他转义序列的
// 起点，如 `\"`，不属分隔符）
func stripRootJSONL(line, root []byte) []byte {
	var b bytes.Buffer
	for {
		i := bytes.Index(line, root)
		if i < 0 {
			b.Write(line)
			return b.Bytes()
		}
		b.Write(line[:i])
		rest := line[i+len(root):]
		switch {
		case bytes.HasPrefix(rest, []byte(`\\`)):
			line = rest[2:] // 转义的分隔符 \：连转义对一并剥除，JSON 转义保持配对
		case len(rest) > 0 && rest[0] == '/':
			line = rest[1:]
		case len(rest) == 0 || rest[0] == '"':
			b.WriteByte('.') // 裸 root 到 JSON 串界/流尾
			line = rest
		default:
			b.Write(root) // 非完整路径段前缀：原样保留
			line = rest
		}
	}
}
