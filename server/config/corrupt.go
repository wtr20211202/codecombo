// config.json 损坏显式降级（P-20261006-10）：历史上 ReadFile 与 json.Unmarshal
// 双 `_ =` 忽略——手改坏（尾逗号/截断/编码）后服务以默认配置静默启动且用户无
// 感知（端口/分享/代理全回默认）；更糟的是后续任意保存会覆写坏文件 = 原配置
// 永久丢。本文件把损坏分支显式化：保全（改名留证）+ warn + 降级态登记；通知
// 中心入账由组合根（server/app）在 store 就绪后消费降级态完成（config 是叶子
// 包不反向依赖 store），agent 程序化探测走 GET /api/selfcheck 配置完整性项。
//
// 与 filestore 损坏文档隔离（P-20261004-76，server/filestore/quarantine.go）
// 同款语义：读到非法 JSON 改名 .corrupt-<时间戳> 留证并按「文件不存在」回落
// 默认配置，后续保存自然写出新文件——写路径零改动。属自愈而非迁移（不转换
// 数据、无格式升级、单次幂等、失败可降级），不适用读路径禁写红线。
//
// 与 master-key 的语义区分（crypto.go getMasterKey 的 Fatal）：密钥坏 = 既有
// 加密数据全部不可解，无「默认值」可退，Fatal 合理；config.json 是可默认化的
// 普通配置，降级启动 + 显式告知才是正解——两处勿混同处理。
package config

import (
	"log/slog"
	"os"
	"sync/atomic"
	"time"
)

// 通知中心模板键（system.configCorrupt.*，前端按 titleKey/bodyKey 渲染；
// Title/Body 原文为无模板消费方——webhook 外发、API 直读——的回退）。
// 保全失败是独立 bodyKey：同一场事故两种处置面，文案必须如实区分
const (
	ConfigCorruptTitleKey        = "system.configCorrupt.title"
	ConfigCorruptBodyKey         = "system.configCorrupt.body"
	ConfigCorruptBodyUnpreserved = "system.configCorrupt.bodyUnpreserved"
)

// ConfigCorruption config.json 损坏降级态（Load 期登记，进程内一次写入此后
// 只读）：nil = 启动时配置正常或不存在（正常首启不算降级）
type ConfigCorruption struct {
	// Path 损坏文件原路径（DataDir/config.json）
	Path string
	// PreservedPath 保全副本路径（config.json.corrupt-<时间戳>）；保全改名
	// 失败（只读盘等）时为空——降级为仅 warn，坏文件留原地，启动不阻塞
	PreservedPath string
	// Err 解析错误原文（语言中立，日志/selfcheck 直出）
	Err string
}

// Preserved 保全是否成功（通知文案与 selfcheck hint 据此分两支）
func (r *ConfigCorruption) Preserved() bool { return r.PreservedPath != "" }

// corruptState Load 期登记的降级态。读多写一（进程生命周期只写一次），
// 原子指针免去读锁
var corruptState atomic.Pointer[ConfigCorruption]

// CorruptionReport 返回启动时登记的配置损坏降级态（无损坏返回 nil）。
// 消费方：组合根启动晚期入账通知中心；GET /api/selfcheck 配置完整性项
func CorruptionReport() *ConfigCorruption { return corruptState.Load() }

// quarantineCorruptConfig 损坏的 config.json 改名保全为
// config.json.corrupt-<纳秒时间戳>（唯一命名免存在性检查，与 filestore
// renameCorrupt 同款；Windows 杀软/索引器对刚关闭文件的短暂占用会令改名
// 失败——50ms 后重试一次）。成功返回保全路径；失败返回空串并留 warn（降级
// 链不引入新 Fatal：保全不成也照常默认启动，坏文件留原地待人工处置）
func quarantineCorruptConfig(path string) string {
	corrupt := path + ".corrupt-" + time.Now().Format("20060102-150405.000000000")
	if err := os.Rename(path, corrupt); err != nil {
		time.Sleep(50 * time.Millisecond)
		if err = os.Rename(path, corrupt); err != nil {
			slog.Warn("config.json corrupt and preservation rename failed; bad file left in place",
				"path", path, "err", err)
			return ""
		}
	}
	return corrupt
}
