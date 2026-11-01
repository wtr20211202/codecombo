//go:build !windows && !darwin

package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"

	"codecombo/server/errmarkers"
)

// revealExec 其余 unix（Linux 为承诺平台）分支：xdg-open <目录>。
// 无选中支持（文件已在 revealCmd 退化为所在目录），两道前置语义：
//  1. headless 探测（DISPLAY/WAYLAND_DISPLAY 全缺）→ errRevealNoDisplay，
//     handler 映射 501——无显示环境时 xdg-open 必败，先给明确语义不空转
//  2. xdg-open 缺失/无关联文件管理器 → 可行动错误提示（原文为前端
//     KNOWN_ERROR_I18N 匹配契约，勿改措辞）
var revealExec = func(name string, args []string) error {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return errRevealNoDisplay
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if err := cmd.Run(); err != nil {
		var ee *exec.Error
		if errors.As(err, &ee) {
			// 稳定原文收口 errmarkers 注册表（P-20261004-29），勿改措辞
			return errors.New(errmarkers.RevealXdgMissing)
		}
		var exee *exec.ExitError
		if errors.As(err, &exee) {
			return fmt.Errorf(errmarkers.RevealXdgExitTemplate, exee.ExitCode())
		}
		return err
	}
	return nil
}
