// Package pastetmp 粘贴上传临时文件的命名与落盘（主人端终端粘贴链与访客
// 分享粘贴上传链共用的微包）：
//
//   - 命名 sc-paste-<unixms>.<ext>：前缀是粘贴临时文件的事实标识，终端包
//     的 paste-cleaner（terminal.CleanupStalePasteImages，24h 龄 6h tick）
//     按前缀匹配清理——两个消费方落同一系统临时目录、同一前缀，即共享同
//     一套生命周期，零新清理机制；
//   - O_EXCL 独占创建：同毫秒并发上传不互相覆盖（批量粘贴逐个请求的现实
//     形态），且不跟随符号链接（多用户 Linux 的共享 /tmp 上预埋 sc-paste-*
//     symlink 可劫持写入路径）。
//
// 抽包缘由（P-20261122-1 评审）：server/api/terminal 与 server/share 两处
// 各写一份 O_EXCL 逻辑必然漂移——share 侧曾按旧实现裸 os.Create，同毫秒
// 碰撞与 symlink 劫持两面回归；叶子包（纯标准库）让两消费侧单一事实源。
package pastetmp

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Prefix 粘贴临时文件名前缀（paste-cleaner 的清理匹配面；改前缀必须同步
// terminal.CleanupStalePasteImages 的 HasPrefix 判据）
const Prefix = "sc-paste-"

// Name 生成 sc-paste-<unixms>.<ext> 文件名（ext 含点；毫秒时间戳取自调用
// 时刻——碰撞由 Create 的 O_EXCL 步进兜底，不在此加随机性）
func Name(ext string) string {
	return fmt.Sprintf("%s%d%s", Prefix, time.Now().UnixNano()/int64(time.Millisecond), ext)
}

// Create 在 dir 下以 name 创建独占新文件：O_EXCL 两重保障——① 同毫秒多次
// 上传的命名碰撞不互相覆盖；② 不跟随符号链接（共享 /tmp 劫持面）。0600：
// 粘贴载荷可能含敏感内容，收敛到本用户可读。碰撞时按 <base>-<n>.<ext> 步进
// （cleaner 前缀匹配不受影响）。100 次步进上限防御极端并发（真实场景同毫秒
// 并发上传个位数，个位数即够）
func Create(dir, name string) (*os.File, string, error) {
	full := filepath.Join(dir, name)
	base := strings.TrimSuffix(name, filepath.Ext(name))
	ext := filepath.Ext(name)
	for i := 0; i < 100; i++ {
		f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			return f, full, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, "", err
		}
		full = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i+1, ext))
	}
	return nil, "", fmt.Errorf("cannot create unique paste file in %s", dir)
}
