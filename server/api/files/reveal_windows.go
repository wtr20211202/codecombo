//go:build windows

package files

import (
	"context"
	"errors"
	"os/exec"
	"time"
)

// revealExec Windows 分支：explorer /select,<path>。
// 退出码不判——explorer.exe 定位成功也常返回 exit status 1（Windows 平台
// 众所周知怪癖，无可靠退出码契约），只要进程成功拉起即视为已打开。
// var 而非 func：headless 501 映射的可注入测试缝（reveal_test.go 按平台替换）
var revealExec = func(name string, args []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, name, args...).Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return nil
		}
		return err
	}
	return nil
}
