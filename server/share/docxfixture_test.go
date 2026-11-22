package share

// ── 嵌入端点测试夹具的短名别名（P-20261119-4） ──
//
// docx zip / CFB / Ole10Native 容器夹具构造器随渲染面下沉 filepreview
// （filepreview/fixtures 包单一落字点）后，本包端点测试（service_test.go /
// embedendpoint_test.go）以历史短名继续消费——跨包测试文件无法共享非导出
// 标识，别名是零改动的结构桥，不是第二份实现（夹具字节面单一来源仍是
// filepreview/fixtures 导出构造器）。

import (
	"encoding/binary"
	"testing"

	fx "codecombo/server/filepreview/fixtures"
)

// docx zip 包夹具（短名别名只保留本包端点测试实际消费的子集——unused
// 门禁；未用到的构造器由 filepreview/fixtures 导出面直接按需取用）
var pngBytes = fx.PNGTestBytes

func buildDocxFull(t *testing.T, documentXML, relsXML string, media map[string][]byte) []byte {
	return fx.BuildDocxFull(t, documentXML, relsXML, media)
}

const relsShell = fx.RelsShell

func imgRel(id, target string) string        { return fx.ImgRel(id, target) }
func blipXML(rid string) string              { return fx.BlipXML(rid) }
func embedRel(id, typ, target string) string { return fx.EmbedRel(id, typ, target) }
func objectXML(iconRID, oleRID, progID string) string {
	return fx.ObjectXML(iconRID, oleRID, progID)
}

// CFB / Ole10Native 容器夹具
func buildCFB(t *testing.T, sectSize int, payload []byte, mini bool, mutate func(header []byte, fat []uint32)) []byte {
	return fx.BuildCFB(t, sectSize, payload, mini, mutate)
}

func ole10Payload(name string, junk int) []byte { return fx.Ole10Payload(name, junk) }

func ole10FlaggedPayload(name string, junk int) []byte {
	return fx.Ole10FlaggedPayload(name, junk)
}

func ole10FullPayload(name, src, tmp string, body []byte) []byte {
	return fx.Ole10FullPayload(name, src, tmp, body)
}

func ole10RealLayoutPayload(name, src string, extras []string, tmp string, body []byte) []byte {
	return fx.Ole10RealLayoutPayload(name, src, extras, tmp, body)
}

var gbkSampleName = fx.GbkSampleName

var gbkRealTempPath = fx.GbkRealTempPath

// utf16Bytes UTF-16 编码字节构造（文本族抽取测试夹具；实现随抽取测试
// 下沉 filepreview，此处短名别名）
func utf16Bytes(s string, bo binary.ByteOrder, bom bool) []byte {
	return fx.Utf16Bytes(s, bo, bom)
}
