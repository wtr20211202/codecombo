package remote

import (
	"strings"
	"testing"
)

// TestBuildTmuxWrapper 远端 tmux 启动命令链断言（P-20261109-7 A③）：wrapper 是
// 远端拖选复制死源治理的第三处（托管 conf 与专属 socket 运行同步都到不了远端
// 用户自有默认 socket server）。步骤序是协议约束——new -A -d 先确保 server+session
// 存在，server 级 set-option / unbind-key 次之，attach 收尾（不带 -d 的 new 会
// 阻塞命令链，后续步骤永远执行不到），顺序回归即真实故障。
func TestBuildTmuxWrapper(t *testing.T) {
	w := buildTmuxWrapper("sc_rtm_ab12cd34-9x8y7z")

	// A③：set-clipboard on 在位且带 2>/dev/null 护栏（旧 tmux <3.2 无此键，
	// unknown option 静默跳过不阻断命令链）
	if !strings.Contains(w, "tmux set-option -s set-clipboard on 2>/dev/null") {
		t.Fatalf("wrapper missing `set-option -s set-clipboard on 2>/dev/null`:\n%s", w)
	}
	// 步骤序：new -A -d < set-option set-clipboard < unbind < attach
	idxNew := strings.Index(w, "tmux new -A -d -s sc_rtm_ab12cd34-9x8y7z")
	idxClip := strings.Index(w, "tmux set-option -s set-clipboard on")
	idxUnbind := strings.Index(w, "tmux unbind-key -n MouseDown3Pane")
	idxAttach := strings.Index(w, "exec tmux attach -t sc_rtm_ab12cd34-9x8y7z")
	if idxNew < 0 || idxClip < 0 || idxUnbind < 0 || idxAttach < 0 {
		t.Fatalf("wrapper missing steps: new=%d clip=%d unbind=%d attach=%d", idxNew, idxClip, idxUnbind, idxAttach)
	}
	if !(idxNew < idxClip && idxClip < idxUnbind && idxUnbind < idxAttach) {
		t.Fatalf("wrapper step order broken: new=%d clip=%d unbind=%d attach=%d\n%s", idxNew, idxClip, idxUnbind, idxAttach, w)
	}
	// tmuxName 内嵌两处（new 与 attach）——字符集由 resolveTmuxName 白名单保证，
	// 这里钉内嵌无二次转义（防有人把校验挪走后 wrapper 直拼裸值）
	if strings.Count(w, "sc_rtm_ab12cd34-9x8y7z") != 2 {
		t.Fatalf("wrapper should embed tmuxName exactly twice:\n%s", w)
	}
	// 缺 tmux 守卫在位：远端无 tmux 时整链短路回退原生 shell
	if !strings.Contains(w, "command -v tmux >/dev/null 2>&1") {
		t.Fatalf("wrapper missing tmux presence guard:\n%s", w)
	}
}
