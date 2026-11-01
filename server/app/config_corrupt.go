package app

import (
	"codecombo/server/config"
	"codecombo/server/notification"
)

// configCorruptNotification 配置损坏降级告知卡（P-20261006-10）：
// warning/system——真实配置事故（设置回默认），进入 webhook important 默认外发
// 集合。模板键与文案单一事实源在 config 包（与 selfcheck 配置完整性项共享同
// 一份降级态）；Title/Body 明文是无模板消费方（webhook 外发、API 直读）的
// 回退，claims 双开通知同款惯例。入账点在 Run 的启动序列晚期（store 就绪后）
// ——config 是叶子包不反向依赖 store，且 Load 期出站口尚未装配
func configCorruptNotification(rep *config.ConfigCorruption) notification.Notification {
	// 语言中立明细指向坏文件所在：保全成功 = 副本路径；失败 = 原文件留原地
	detail := rep.Path
	bodyKey := config.ConfigCorruptBodyUnpreserved
	if rep.Preserved() {
		detail = rep.PreservedPath
		bodyKey = config.ConfigCorruptBodyKey
	}
	return notification.Notification{
		Type:     "warning",
		Category: notification.CategorySystem,
		TitleKey: config.ConfigCorruptTitleKey,
		BodyKey:  bodyKey,
		Title:    "配置文件损坏，已用默认配置启动",
		Body:     detail,
		MsgParams: map[string]any{
			"err":  rep.Err,
			"file": detail,
		},
	}
}
