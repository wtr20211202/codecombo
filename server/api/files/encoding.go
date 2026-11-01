package files

import "codecombo/server/filepolicy"

// 编码探测/回编的实现收敛在 filepolicy 包（git 展示边界也要用同一套），
// 此处保留本包历史别名：ReadFile/WriteFile 与既有测试按原名调用

const (
	EncodingGBK     = filepolicy.EncodingGBK
	EncodingBig5    = filepolicy.EncodingBig5
	EncodingUTF16LE = filepolicy.EncodingUTF16LE
	EncodingUTF16BE = filepolicy.EncodingUTF16BE
)

func decodeText(raw []byte) (text, encoding string) {
	return filepolicy.DecodeText(raw)
}

func encodeText(text, encoding string) ([]byte, error) {
	return filepolicy.EncodeText(text, encoding)
}
