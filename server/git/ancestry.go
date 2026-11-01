package git

import (
	"strconv"
	"strings"
)

// AheadBehindBetween 计量本地仓库内两个提交间的双向差集（P-20261004-34
// 本地-远端 git 对照的 behind 推算基元）：一次
// `rev-list --left-right --count <refA>...<refB>` 同时返回「仅 refA 可达 /
// 仅 refB 可达」的提交数——比两次单向 rev-list 少一个子进程，且对称差
// 语义天然覆盖 diverged 形态。
//
// ok=false 表示不可判定（任一侧对象本地不存在——典型：远端 HEAD 含本地
// 未 fetch 过的提交），调用方据此诚实降级而非当作 0 差集。
// 探测语义走 execGitProbe：失败是合法结果，不向前端命令台广播。
func AheadBehindBetween(repoPath, refA, refB string) (aOnly, bOnly int, ok bool) {
	out, err := execGitProbe(repoPath, "rev-list", "--left-right", "--count", refA+"..."+refB)
	if err != nil {
		return 0, 0, false
	}
	// 输出形如 "12\t3"（TAB 分隔）；Fields 兼容多空白形态
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) != 2 {
		return 0, 0, false
	}
	a, errA := strconv.Atoi(fields[0])
	b, errB := strconv.Atoi(fields[1])
	if errA != nil || errB != nil {
		return 0, 0, false
	}
	return a, b, true
}
