package git

// git 执行失败的下一步指引分类器（P-20261005-194）。
//
// push/pull 失败是新手最高频卡点，每类失败有标准修法；错误码（P-305）管「注册
// 文案的程序化分支」，本分类器管「恢复语义」——两者正交：同一个 hint.kind 可以
// 出现在无 code 的失败上，也可以与 code 同体（如 index.lock 遗留锁既有
// git.index_lock_stale 码又有 kind=lock）。分类结果是结构化 hint 随错误响应
// 返回，agent 据此编程自愈（fleet 巡检 push 拒=pull-再-push 重试策略），
// 前端据此渲染「原因一句话 + 建议动作 + 直达按钮」。
//
// 保守匹配纪律：只收 git 自身稳定英文原文的强特征（ 子串、小写比较），宁可漏
// 分类（前端保持裸 toast 零降级）不可误分类（把文件权限失败当认证失败会误导
// 用户改凭据）。表序即优先序——同一段输出可能同时命中多类特征（如 push 拒绝
// 输出同时含 "non-fast-forward" 与 "diverge"），具体类别排在前者胜，见各组
// 注释的排序依据。

import (
	"regexp"
	"strings"

	"codecombo/server/errmarkers"
)

// 失败类别（对外稳定契约，ops 手册 error-codes 分节登记恢复动作映射，改值须同步）
const (
	FailNonFastForward   = "non-fast-forward"  // push 被拒：远端有本地没有的提交 → 先拉取
	FailDiverged         = "diverged"          // 本地与远端历史分叉 → 合并/变基二选
	FailConflict         = "conflict"          // 合并冲突 → 冲突视图
	FailAuthentication   = "authentication"    // 认证失败 → 凭据面
	FailLock             = "lock"              // index.lock 残留 → 清理指引（Detail=锁文件路径）
	FailDubiousOwnership = "dubious-ownership" // safe.directory 拦截 → 信任目录指引
	FailHookRejected     = "hook-rejected"     // 钩子拒绝（pre-receive/pre-rebase）→ 查看钩子
	FailNetwork          = "network"           // 网络不可达 → 检查网络/代理后重试
)

// FailHint 结构化恢复提示载荷：错误响应体 hint 字段（与 code 正交，可单独出现）
type FailHint struct {
	// Kind 失败类别（上方常量枚举）
	Kind string `json:"kind"`
	// Detail 类别补充（lock 类=锁文件绝对路径，取自 git 原文；其余类别空）
	Detail string `json:"detail,omitempty"`
}

// failPatterns 有序特征表：组间按优先序（见各组注释），组内任一特征命中即归该类。
// 特征全部小写，匹配时对输入做 ToLower（git 原文稳定，大小写折叠只为容忍
// "CONFLICT" 与个别工具包装层的大小写差异）
var failPatterns = []struct {
	kind     string
	patterns []string
}{
	// ① dubious ownership：git 2.35.2+ 的仓库所有权安全拦截，原文唯一且具体
	{FailDubiousOwnership, []string{
		"dubious ownership in repository",
	}},
	// ② lock：index.lock 残留/活锁。git 自身原文（Unable to create '...': File
	// exists / Another git process）与服务端升级标记（errmarkers.IndexLockStale，
	// 追加形态里 "index lock" 带空格）都收，单特征即可覆盖；须排在 conflict 前
	// ——写队列忙等错误文本不含这些串，无误报面
	{FailLock, []string{
		"index.lock",
		errmarkers.IndexLockStale,
	}},
	// ③ conflict：merge/rebase/cherry-pick 冲突态。git 把 CONFLICT 行与
	// "Automatic merge failed" 写 stdout——exec 路径失败即弃 stdout，故 merge/
	// rebase 类端点（错误文本即全部载体）只收带括号/固定句式的强特征；pull 冲突
	// 在 PullRemote 另有仓库冲突态兜底（见 remote.go，文本特征判不中时按工作区
	// 未合并条目分类）。小写折叠后 "conflict file was modified externally"
	//（ConflictStale 标记）与 "hunk no longer applies" 均不含这些句式，零误报
	{FailConflict, []string{
		"conflict (",             // CONFLICT (content): Merge conflict in <file> / (modify/delete) 等全族
		"automatic merge failed", // Automatic merge failed; fix conflicts and then commit the result.
		"fix conflicts",          // hint: Fix them up in the work tree...（merge 收尾提示）
		"unmerged files",         // error: Committing is not possible because you have unmerged files.
		"could not apply",        // rebase/cherry-pick 停在冲突提交：error: could not apply <sha>...
	}},
	// ④ diverged：排在 non-fast-forward 前——push 分叉拒绝的输出同时含
	// "non-fast-forward"（rejected 行）与 "diverge"（hint 行），分叉语义更具体应胜出
	{FailDiverged, []string{
		"diverge from each other",      // push 拒 hint：...and its remote counterpart diverge from each other
		"divergent branches",           // pull：fatal: Need to specify how to reconcile divergent branches
		"not possible to fast-forward", // pull --ff-only 语义：Not possible to fast-forward, aborting
	}},
	// ⑤ non-fast-forward：push 被拒的基础形态（fetch first / behind its remote）
	{FailNonFastForward, []string{
		"non-fast-forward",
		"updates were rejected", // push 拒 hint 固定句式（fetch first 变体的 rejected 行不带 nf-f 字样）
		"fetch first",           // ! [rejected]  main -> main (fetch first)
	}},
	// ⑥ hook-rejected：pre-receive/pre-rebase 钩子拒绝（服务端推拒/本地变基拦截）
	{FailHookRejected, []string{
		"hook declined",
		"hook refused",
	}},
	// ⑦ authentication：凭据/权限失败。只收 git 认证语境的强特征——OS 文件权限
	// 错误（fatal: ...: Permission denied，无 publickey 括号后缀）不在此列
	{FailAuthentication, []string{
		"authentication failed",
		"could not read username",
		"could not read password",
		"permission denied (publickey",
		"invalid username or password",
		"access denied",
		"returned error: 403",
	}},
	// ⑧ network：网络不可达族。不收裸 "unable to access"——它同时出现在 403/404
	// 等非网络失败里，误分类面大；网络失败的浏览器式原文（resolve/connect/timeout）
	// 才是强特征
	{FailNetwork, []string{
		"could not resolve host",
		"failed to connect",
		"connection timed out",
		"connection refused",
		"connection reset by peer",
		"no route to host",
		"network is unreachable",
		"i/o timeout",
	}},
}

// lockPathRe 从 git 原文提取锁文件路径（fatal: Unable to create '<path>': File exists.）。
// 在保持原大小写的文本上运行（路径大小写敏感），取第一处
var lockPathRe = regexp.MustCompile(`'([^']*index\.lock)'`)

// ClassifyFailHint 按错误原文（+ 可选的部分命令输出）特征匹配 git 失败类别。
// extraOutput 供「失败详情可能落在 stdout」的调用方并入（exec 层失败即弃
// stdout，文本特征不中时由调用方按仓库事实源兜底，见 PullRemote 的冲突态查证）。
// 未命中返回 (零值, false)——调用方保持无 hint 旧形态，前端裸 toast 零降级。
// 量级注记：~30 次 strings.Contains 作用于 KB 级错误文本，仅失败路径触发，零缓存必要
func ClassifyFailHint(err error, extraOutput ...string) (FailHint, bool) {
	if err == nil {
		return FailHint{}, false
	}
	parts := make([]string, 0, 1+len(extraOutput))
	parts = append(parts, err.Error())
	for _, s := range extraOutput {
		if s != "" {
			parts = append(parts, s)
		}
	}
	joined := strings.Join(parts, "\n")
	haystack := strings.ToLower(joined)
	for _, grp := range failPatterns {
		for _, p := range grp.patterns {
			if strings.Contains(haystack, p) {
				hint := FailHint{Kind: grp.kind}
				if grp.kind == FailLock {
					// 锁路径取自原文（保持大小写）；服务端升级标记形态（原文不含
					// quoted 路径，如 "[stale git index lock detected: 61s old]"）
					// 提取不到就留空——前端回退到通用清理指引文案
					if m := lockPathRe.FindStringSubmatch(joined); len(m) > 1 {
						hint.Detail = m[1]
					}
				}
				return hint, true
			}
		}
	}
	return FailHint{}, false
}
