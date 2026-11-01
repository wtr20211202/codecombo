package share

import (
	"time"

	"codecombo/server/store"
)

// 溯源水印（P-20261005-193）：分享访客页叠加对角双标低透明水印，截图/拍照
// 外传后可归因到具体分享链接（「这张截图从哪漏的」——多链接并开场景按
// 尾号对账管理台账）。定位如实：水印是归因手段不是防泄密（可被遮挡/裁剪，
// 尽力而为），页面与文案不宣称截图防护；访客页消费者是人类，无 agent 操作面。
//
// 文案构造是三访客页（文件分享页/终端直播页/终端快照页）共享的单一事实源；
// DOM 与样式因「单文件页各自自包含」的零依赖契约在各页内实现（与
// termpage/termpagefrozen 双实现的既有取舍同构）。

const (
	// watermarkNameMax 水印里分享名的截取宽度（rune）：水印是低透明单行小字，
	// 过长名称只会堆成不可读的横条——截断不影响归因（尾号 + 日期才是对账键）
	watermarkNameMax = 48
	// watermarkTokenTail 水印携带的 token 尾号位数：归因对账的最小辨识度
	//（16 位 base36 的末 4 位在「个位数到十位数分享」的管理面量级下唯一性
	// 足够；只给尾号——完整短链进截图等于水印反向变成泄露面）
	watermarkTokenTail = 4
)

// WatermarkLabel 访客页水印文本：分享名 + token 尾号 + 日期。分享名缺省取
// token 前 6 位 + 日期（任务书口径）；分享名命中敏感模式（IsSensitiveName，
// 与分享创建扫描同表）时降级纯 token 尾号 + 日期——名称本身可能就是敏感词
// （.env/id_rsa 族），不该进会随截图二次外传的水印。
func WatermarkLabel(sh *store.Share, now time.Time) string {
	date := now.Format("2006-01-02")
	if sh.Name == "" {
		// 分享名缺省：token 前 6 位 + 日期（防御性分支——store 各创建路径
		// 都兜了非空名，这里保任务书语义不依赖该前提）
		prefix := sh.Token
		if len(prefix) > 6 {
			prefix = prefix[:6]
		}
		return prefix + " · " + date
	}
	if IsSensitiveName(sh.Name) {
		// 敏感分享名：降级纯 token 尾号 + 日期（名称不进外传件）
		return tokenTail(sh.Token) + " · " + date
	}
	name := []rune(sh.Name)
	if len(name) > watermarkNameMax {
		name = name[:watermarkNameMax]
	}
	return string(name) + " · " + tokenTail(sh.Token) + " · " + date
}

// tokenTail token 末 n 位（短于 n 原样返回——validToken 保证 16 位，此为
// 防御分支）
func tokenTail(token string) string {
	if len(token) <= watermarkTokenTail {
		return token
	}
	return "…" + token[len(token)-watermarkTokenTail:]
}
