package config

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// 用户偏好层服务端漫游（P-20261007-1 Settings Sync）：分轨原则——
//   - 用户偏好（肌肉记忆/个人习惯，跨设备应一致：键位覆盖/通知三件/终端习性
//     开关）→ 服务端漫游（本字段）；
//   - 设备偏好（屏幕/外设差异：字号/缩放/光标形态等 per-device 立场）→ 仍留
//     浏览器 localStorage，不进服务端。
//
// UserPrefs 是单键 JSON 对象：schema 前端自治（后续新增偏好键零 Go 改动），
// 服务端仅两道校验（合法 JSON + 大小上限，见 ValidateUserPrefs）。nil/缺字段 =
// 服务端无漫游偏好（前端回落本地镜像并播种上传），存量配置升级零迁移。
const (
	// MaxUserPrefsBytes 单键体积上限：keymap 覆盖表仅存 ≠ 默认项、通知三件与
	// 终端习性开关是稀疏偏差集，正常体量在 KB 量级；64KB 封顶防误写超大对象
	//（粘贴失误/agent 失控循环）撑爆 config.json
	MaxUserPrefsBytes = 64 * 1024
)

// ValidateUserPrefs 用户偏好单键写入端校验（PUT /api/settings 调用）：
// 合法 JSON + ≤MaxUserPrefsBytes。不校验内部 schema——键域由前端自治，
// 服务端只保证「可原样存取、不撑爆落盘」。
func ValidateUserPrefs(raw json.RawMessage) error {
	if len(raw) > MaxUserPrefsBytes {
		return fmt.Errorf("userPrefs too large: %d bytes (max %d)", len(raw), MaxUserPrefsBytes)
	}
	if !json.Valid(raw) {
		return fmt.Errorf("userPrefs is not valid JSON (%d bytes)", len(raw))
	}
	return nil
}

// NormalizeUserPrefs 归一化存储形态：trim 首尾空白 + compact（去内部冗余空白），
// config.json 落盘整洁、重复 PUT 不因格式化差异膨胀。调用方先 ValidateUserPrefs。
func NormalizeUserPrefs(raw json.RawMessage) json.RawMessage {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return raw // Compact 失败（理论不可达：Validate 已过）原样返回
	}
	return json.RawMessage(buf.Bytes())
}
