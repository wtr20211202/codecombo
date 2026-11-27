// Package pastetmp 粘贴上传临时文件的命名、落盘与**限额值类型**（P-20261123-6）。
//
// 本文件（limits.go）：限额值类型与推导——Limit{FileMB,ImageMB} 是「单端一对」
// 的纯值（MB 语义 = MiB），BodyMax 按 per-context 信封余量推导（owner file+4MB、
// share/remote file+2MB，multipart 编码开销是每段固定头+边界，与文件大小线性无关；
// 不暴露给用户）。三端默认值与可调范围常量在 server/config（唯一事实源），本包
// 只保留默认常量供 config 缺省引用与测试锚定——config→pastetmp 单向依赖，
// pastetmp 保持纯标准库叶子无环。
//
// 消费方：terminal_paste_image.go（owner）/ pasteupload.go（share）/
// remotehost_terminal.go（remote）每次上传请求现读 settings 生效值（设置页保存
// 即按请求热生效），经本包 MBText 生成可读错误文案。
package pastetmp

import "strconv"

// MB 字节换算（整 MiB）。
const mb = int64(1) << 20

// Limit 单端粘贴上传限额（MB，生效值）：FileMB/ImageMB 为用户可见口径，
// BodyMax 由 PerEndpointBodyMax 按 P-5 信封余量推导（owner +4、share/remote +2）。
type Limit struct {
	FileMB  int64 `json:"fileMB"`
	ImageMB int64 `json:"imageMB"`
}

// 默认值常量（= P-20261123-5 定稿；config 缺省引用与测试锚定。真正的范围钳制
// 在 config.pastePairEffective——本包不做范围知识，保持叶子）
const (
	DefaultOwnerFileMB   = int64(100)
	DefaultOwnerImageMB  = int64(20)
	DefaultShareFileMB   = int64(20)
	DefaultShareImageMB  = int64(10)
	DefaultRemoteFileMB  = int64(20)
	DefaultRemoteImageMB = int64(10)
)

// Owner/Share/Remote P-5 时代的默认值实例（config 缺省种子与 body 推导引用；
// 生效值一律经 config.EffectivePasteLimits 现读，不再有包级可变全局）
var (
	Owner  = Limit{FileMB: DefaultOwnerFileMB, ImageMB: DefaultOwnerImageMB}
	Share  = Limit{FileMB: DefaultShareFileMB, ImageMB: DefaultShareImageMB}
	Remote = Limit{FileMB: DefaultRemoteFileMB, ImageMB: DefaultRemoteImageMB}
)

// OwnerBodyMax owner 端请求体上限：file 100MB + 4MB multipart 余量（P-5 定稿
// 104MB；余量保守——慢链路/多 part 表单字段）
func OwnerBodyMax() int64 { return DefaultOwnerFileMB*mb + 4*mb }

// ShareBodyMax share 端请求体上限：file 20MB + 2MB 余量（22MB 既有口径）
func ShareBodyMax() int64 { return DefaultShareFileMB*mb + 2*mb }

// RemoteBodyMax remote 端请求体上限：file 20MB + 2MB 余量（22MB，P-5 新增）
func RemoteBodyMax() int64 { return DefaultRemoteFileMB*mb + 2*mb }

// MBText 人类可读 MB 文案（内层 fmt.Errorf 用）：「123.4 MB」一位小数——
// 前端 KNOWN_ERROR_I18N 正则（[\d.]+ MB）按此形态匹配，改口径须两侧同步。
func MBText(n int64) string {
	return strconv.FormatFloat(float64(n)/float64(mb), 'f', 1, 64) + " MB"
}

// BodyMaxForMB 由 file 上限（MB）推导请求体上限（字节）：owner 形态 +4MB、
// share/remote 形态 +2MB 由调用方按端选择余量——这里提供统一算式避免漂移
func BodyMaxForMB(fileMB int64, overheadMB int64) int64 {
	return fileMB*mb + overheadMB*mb
}
