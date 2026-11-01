package git

import (
	"fmt"
	"strings"
)

// 拆分建议逐组执行（P-20261003-278）：P-186 拆分建议的执行面——前端把智能体
// 产出的结构化分组方案（组名/文件清单/commit 主题）在确认弹层人工预览确认后
// 整包下发，这里按组序逐组 stage + commit；任一组失败立即中断并返回逐组报告
// （已落库组 / 失败组及步骤 / 未执行剩余数）。已落库的组不回滚（git 提交无
// 事务，报告即事后事实）；人工确认门槛在预览弹层，本函数是纯执行面。
//
// 组隔离（本功能的关键语义）：每组以 `commit -m <主题> -- <组内文件>` 的
// pathspec 提交收口——拆分建议的分组对象是**已暂存**的文件（P-186 清单口径），
// 裸 `git commit -m` 提交整个 index 会把后续组的已暂存文件卷进首组（e2e 实测
// 必踩）。pathspec 提交只落组内文件的（工作树）内容，组外已暂存内容原样保留
// 在暂存区，既不混入任何组、也不被吞掉——「确认范围 = 执行范围」由提交形态
// 本身保证，无需前置拒绝。组级错误（文件不存在/该组无差异可提交）由 git
// add/commit 自身报错兜底，经 Failed 如实上报，不做静默跳过。
//
// 写域：每组 add/commit 各自经 execGit 进按仓库写队列（writequeue.go）串行，
// 与手动 stage→commit 及 agent 自动 commit 并发同域互斥；组间不持跨命令槽位
// （写队列槽位语义是单命令粒度，长循环持槽会堵死并发写）。

// CommitSplitGroup 单个分组：组名（展示用）+ 文件清单 + commit 主题
type CommitSplitGroup struct {
	Name    string   `json:"name"`
	Files   []string `json:"files"`
	Subject string   `json:"subject"`
}

// CommitSplitExecuted 已落库的一组（Commit 为短哈希，取哈希失败留空——尽力
// 而为的展示字段，非落库事实的一部分）
type CommitSplitExecuted struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Subject string `json:"subject"`
	Commit  string `json:"commit"`
}

// CommitSplitFailure 中断的那组：Step 标记失败步骤（stage|commit），Error 为
// git 错误原文（含稳定标记时前端按既有标记机制可辨）
type CommitSplitFailure struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Subject string `json:"subject"`
	Step    string `json:"step"`
	Error   string `json:"error"`
}

// CommitSplitReport 逐组执行报告。中断语义：Failed 非空 ⇒ 其后 Remaining 个
// 组全部未执行
type CommitSplitReport struct {
	Total     int                   `json:"total"`
	Executed  []CommitSplitExecuted `json:"executed"`
	Failed    *CommitSplitFailure   `json:"failed"`
	Remaining int                   `json:"remaining"`
}

// 上限护栏（畸形/失控请求早拒）：正常分组建议远达不到，超限按请求级错误 400
const (
	CommitSplitMaxGroups     = 20
	CommitSplitMaxGroupFiles = 200
)

// ExecuteCommitSplit 逐组 stage+commit：返回报告不返回错误——组级失败是本
// 接口的正常产出（中断报告），只有请求级畸形（空/超限/字段缺失）走 error 让
// handler 映射 400
func ExecuteCommitSplit(repoPath string, groups []CommitSplitGroup) (*CommitSplitReport, error) {
	if len(groups) == 0 {
		return nil, fmt.Errorf("groups cannot be empty")
	}
	if len(groups) > CommitSplitMaxGroups {
		return nil, fmt.Errorf("too many groups: %d > %d", len(groups), CommitSplitMaxGroups)
	}
	// 规整与校验（trim 后主题必填、文件清单必非空；组名可缺省——展示面退化用主题）
	clean := make([]CommitSplitGroup, 0, len(groups))
	for i, g := range groups {
		g.Name = strings.TrimSpace(g.Name)
		g.Subject = strings.TrimSpace(g.Subject)
		files := make([]string, 0, len(g.Files))
		for _, f := range g.Files {
			if f = strings.TrimSpace(f); f != "" {
				files = append(files, f)
			}
		}
		if g.Subject == "" {
			return nil, fmt.Errorf("group[%d]: subject is required", i)
		}
		if len(files) == 0 {
			return nil, fmt.Errorf("group[%d]: files cannot be empty", i)
		}
		if len(files) > CommitSplitMaxGroupFiles {
			return nil, fmt.Errorf("group[%d]: too many files: %d > %d", i, len(files), CommitSplitMaxGroupFiles)
		}
		g.Files = files
		clean = append(clean, g)
	}

	report := &CommitSplitReport{Total: len(clean), Executed: []CommitSplitExecuted{}}
	for i, g := range clean {
		if err := Stage(repoPath, g.Files); err != nil {
			report.Failed = &CommitSplitFailure{Index: i, Name: g.Name, Subject: g.Subject, Step: "stage", Error: err.Error()}
			report.Remaining = len(clean) - i - 1
			return report, nil
		}
		// pathspec 提交（--only 语义）：只落本组文件的内容，组外已暂存内容留在
		// 暂存区——组间隔离见文件头
		args := append([]string{"commit", "-m", g.Subject, "--"}, g.Files...)
		if _, err := execGit(repoPath, args...); err != nil {
			report.Failed = &CommitSplitFailure{Index: i, Name: g.Name, Subject: g.Subject, Step: "commit", Error: err.Error()}
			report.Remaining = len(clean) - i - 1
			return report, nil
		}
		short := ""
		if out, err := execGit(repoPath, "rev-parse", "--short", "HEAD"); err == nil {
			short = strings.TrimSpace(out)
		}
		report.Executed = append(report.Executed, CommitSplitExecuted{Index: i, Name: g.Name, Subject: g.Subject, Commit: short})
	}
	return report, nil
}
