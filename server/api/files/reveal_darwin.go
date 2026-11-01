//go:build darwin

package files

import (
	"context"
	"os/exec"
	"time"
)

// revealExec darwin 分支：open -R <path>（Finder 显示并选中）。
// open 命令系统自带且退出码可靠（成功 0），失败如实上抛。
// var 而非 func：headless 501 映射的可注入测试缝（reveal_test.go 按平台替换）
var revealExec = func(name string, args []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Run()
}
