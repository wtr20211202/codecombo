package compareexp

// 对比数据面（P-20261003-46 ③）：双侧会话产出的并集逐文件归属三分类。
// 归属 = 各侧会话自身的 startHead 快照面（terminalapi.SessionActivity，与 B3
// 产出视图同一实现）——同目录双侧基线一致时全部落「双方」，基线错开
//（发起间隙目录被改 / 分目录 worktree 竞写）时自然区分出仅 A / 仅 B。
// 分类是纯函数：不触 git，单测钉死归属语义。

import (
	"sort"

	terminalapi "codecombo/server/api/terminal"
)

// CompareFileRow 对比文件行（前端三态渲染的最小形状）：
// InA/InB = 归属侧，双真 = 双方、单真 = 仅该侧；StatusA/StatusB 为对应侧的
// git 短状态（M/A/D/…/?，未归属侧为空串）
type CompareFileRow struct {
	Path    string `json:"path"`
	InA     bool   `json:"inA"`
	InB     bool   `json:"inB"`
	StatusA string `json:"statusA,omitempty"`
	StatusB string `json:"statusB,omitempty"`
}

// ClassifyCompareFiles 并集逐文件归属三分类（纯函数，单测锚点）：
//   - 路径并集为行集（双侧任一出现即入列），路径按字典序稳定输出
//   - 同路径双侧都改：双方（StatusA/StatusB 各带各的状态——基线错开时
//     同路径的状态可能不同，如 A 视角 M、B 视角 A）
//   - 空清单容忍：任一侧无产出（非 git 目录/无基线退化）时另一侧全落「仅」
func ClassifyCompareFiles(filesA, filesB []terminalapi.ActivityFile) []CompareFileRow {
	byPath := make(map[string]*CompareFileRow)
	add := func(files []terminalapi.ActivityFile, inA bool) {
		for _, f := range files {
			row, ok := byPath[f.Path]
			if !ok {
				row = &CompareFileRow{Path: f.Path}
				byPath[f.Path] = row
			}
			if inA {
				row.InA, row.StatusA = true, f.Status
			} else {
				row.InB, row.StatusB = true, f.Status
			}
		}
	}
	add(filesA, true)
	add(filesB, false)

	rows := make([]CompareFileRow, 0, len(byPath))
	for _, r := range byPath {
		rows = append(rows, *r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Path < rows[j].Path })
	return rows
}
