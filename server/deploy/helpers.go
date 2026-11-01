package deploy

import (
	"context"
	"fmt"

	"codecombo/server/sshclient"
)

// execOpts 简化 ExecOptions 构造
func execOpts(cmd string) sshclient.ExecOptions {
	return sshclient.ExecOptions{Cmd: cmd}
}

// execOrFail 执行 SSH 命令；失败时记录 FAIL 日志并返回带 wrapPrefix 的 error
// step 用于日志分类，handler 可选用于实时流式输出
func execOrFail(
	ctx context.Context,
	p DeployParams,
	step, wrapPrefix string,
	opts sshclient.ExecOptions,
	handler sshclient.LineHandler,
) (*sshclient.ExecOutput, error) {
	out, err := p.SSH.Exec(ctx, opts, handler)
	if err != nil {
		// ctx 取消：不记 FAIL，交由 manager.run 判定 cancelled
		if ctx.Err() != nil {
			return out, fmt.Errorf("%s: %w", wrapPrefix, err)
		}
		p.Log.LogKV(step, LevelFail, "deploy.log.commandFailed",
			map[string]any{"step": wrapPrefix, "error": err.Error()})
		return out, fmt.Errorf("%s: %w", wrapPrefix, err)
	}
	return out, nil
}
