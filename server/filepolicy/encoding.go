package filepolicy

import (
	"bytes"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
)

// 文件文本编码的探测/回编原语。设计约束：
//   - 探测必须保守：只认「能证明自己」的编码（BOM 声明、round-trip 逐字节
//     还原），宁可不解码不可错解码；
//   - 保存字节安全是比标签正确更硬的保证：按返回标签回编必须能还原原始
//     字节（round-trip 语义），用户保存永不损毁原文件；
//   - 供两个消费方：files（编辑器读写，带标签往返）与 gitops/git（展示
//     边界解码，diff/log/blame 的原始字节转可读文本）。

// 非 UTF-8 文本的探测/回写标签。探测与编解码的实际实现：
//   - gbk：GB18030（GBK 超集，向下兼容；Windows 记事本 ANSI 中文默认即此家族）
//   - big5：traditionalchinese.Big5
//   - utf16le / utf16be：BOM 声明式识别（FF FE / FE FF），stdlib unicode/utf16
//
// 不做 Shift-JIS / EUC-KR 自动探测（实证：其二字节空间几乎被 GB18030 完全
// 吞掉，候选永远落空且只会误标 gbk）；正确区分需要统计式 chardet，如真有
// 日/韩文件诉求再引入。这类文件维持历史行为（乱码展示、不改写）
const (
	EncodingGBK     = "gbk"
	EncodingBig5    = "big5"
	EncodingUTF16LE = "utf16le"
	EncodingUTF16BE = "utf16be"
)

// encodingCandidates 多字节编码候选，按误判代价排序：产品主场景是中文
// Windows，GBK 最优先。各候选都用「解码 → 回编逐字节还原」的 round-trip
// 校验把关——解码器对非法序列普遍宽容，仅凭解码成功会大面积误判。
// 局限（无统计式 chardet 的固有代价）：Big5 与 GB18030 字节空间部分重叠，
// 恰好重叠的 Big5 文本会被标 gbk 显示成「通顺但错误」的中文；即便如此
// 保存仍然字节安全——round-trip 保证按返回标签回编可还原原始字节
var encodingCandidates = []struct {
	label string
	enc   encoding.Encoding
}{
	{EncodingGBK, simplifiedchinese.GB18030},
	{EncodingBig5, traditionalchinese.Big5},
}

// DecodeText 把磁盘原始字节转成可安全进 JSON 的 UTF-8 文本，并回报探测到的
// 编码（空串 = UTF-8，调用方无需回传标签）。
//
// 判定顺序：
//  1. UTF-16 BOM（FF FE / FE FF）→ 声明式解码 + round-trip 校验，零误判
//  2. 合法 UTF-8 → 原样返回（编码标签空；UTF-8 BOM 属合法 UTF-8，
//     维持历史行为原样保留）
//  3. 多字节编码候选逐个 round-trip 验证（见 encodingCandidates）
//  4. 全部不中（拉丁系单字节、截断的多字节尾部等）→ 原样返回维持历史行为
//
// 注意：截断输入（部分预览等）的尾部会破坏 round-trip，自然落到「维持
// 现状」，全文读路径（编辑器主路径）不受影响
func DecodeText(raw []byte) (text, encoding string) {
	if len(raw) >= 2 {
		switch {
		case raw[0] == 0xFF && raw[1] == 0xFE:
			if s, ok := decodeUTF16Body(raw[2:], true); ok {
				return s, EncodingUTF16LE
			}
		case raw[0] == 0xFE && raw[1] == 0xFF:
			if s, ok := decodeUTF16Body(raw[2:], false); ok {
				return s, EncodingUTF16BE
			}
		}
	}
	if utf8.Valid(raw) {
		return string(raw), ""
	}
	for _, cand := range encodingCandidates {
		decoded, err := cand.enc.NewDecoder().Bytes(raw)
		if err != nil {
			continue
		}
		encoded, err := cand.enc.NewEncoder().Bytes(decoded)
		if err != nil || !bytes.Equal(encoded, raw) {
			continue
		}
		return string(decoded), cand.label
	}
	return string(raw), ""
}

// DecodeDisplay 展示边界用的逐行解码：合法 UTF-8 的行原样保留，非 UTF-8 的
// 行尝试 DecodeText 解码。专治混合编码文本（如整树 diff 同时含 UTF-8 与
// GBK 文件的内容行）——整段解码会把合法 UTF-8 部分错转成 GBK 乱码，逐行
// 处理则各归各位。GBK/Big5 字节不含 \n，逐行 round-trip 语义与整段一致；
// 仅用于展示（diff/blame/log 回显），产物不回写磁盘
func DecodeDisplay(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	lines := bytes.Split([]byte(s), []byte("\n"))
	for i, line := range lines {
		if !utf8.Valid(line) {
			decoded, _ := DecodeText(line)
			lines[i] = []byte(decoded)
		}
	}
	return string(bytes.Join(lines, []byte("\n")))
}

// EncodeText 把前端回传的 UTF-8 文本按探测到的编码写回磁盘前的逆变换。
// 未知编码值按 UTF-8 兜底（向后兼容，前端原样回传服务端标签不会出现未知值）。
// GBK 家族用 GB18030 编码器：覆盖全部 Unicode 码位不会失败，GBK 文件里
// 新敲的生僻字/emoji 落成 4 字节 GB18030 序列（记事本仍可读）
func EncodeText(text, encoding string) ([]byte, error) {
	switch encoding {
	case "":
		return []byte(text), nil
	case EncodingUTF16LE:
		return encodeUTF16(text, true), nil
	case EncodingUTF16BE:
		return encodeUTF16(text, false), nil
	}
	if enc := encodingByLabel(encoding); enc != nil {
		return enc.NewEncoder().Bytes([]byte(text))
	}
	return []byte(text), nil
}

// encodingByLabel 按标签取多字节编码器（未注册返回 nil）
func encodingByLabel(label string) encoding.Encoding {
	for _, cand := range encodingCandidates {
		if cand.label == label {
			return cand.enc
		}
	}
	return nil
}

// decodeUTF16Body 解码 BOM 之后的 UTF-16 正文（little = 小端）。
// 奇数长度（截断）或含未配对代理项时 round-trip 失败返回 false——
// 只认能逐字节还原的内容，宁可不解码不可错解码
func decodeUTF16Body(body []byte, little bool) (string, bool) {
	if len(body)%2 != 0 {
		return "", false
	}
	units := make([]uint16, len(body)/2)
	for i := range units {
		if little {
			units[i] = uint16(body[2*i]) | uint16(body[2*i+1])<<8
		} else {
			units[i] = uint16(body[2*i])<<8 | uint16(body[2*i+1])
		}
	}
	decoded := string(utf16.Decode(units))
	// round-trip：重编码必须逐字节还原（含 BOM），否则（未配对代理项 →
	// U+FFFD 等）不认定
	reencoded := encodeUTF16(decoded, little)
	if !bytes.Equal(reencoded[2:], body) {
		return "", false
	}
	return decoded, true
}

// encodeUTF16 编码为带 BOM 的 UTF-16 字节（探测到 BOM 的文件按原形态写回）
func encodeUTF16(text string, little bool) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 2+len(units)*2)
	if little {
		out[0], out[1] = 0xFF, 0xFE
	} else {
		out[0], out[1] = 0xFE, 0xFF
	}
	for i, v := range units {
		if little {
			out[2+2*i], out[3+2*i] = byte(v), byte(v>>8)
		} else {
			out[2+2*i], out[3+2*i] = byte(v>>8), byte(v)
		}
	}
	return out
}
