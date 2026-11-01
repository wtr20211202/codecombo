package files

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/filepolicy"

	"github.com/gin-gonic/gin"
)

// maxStatEntries 目录递归统计的条目上限：删除确认是同步路径，node_modules/
// 构建产物级别的超大目录不应在确认弹窗前无限走盘（慢查询即界面卡顿）；
// 触顶即收尾并置 Truncated，前端以「N+」下界呈现。恰好等于上限不置位
// ——确有未扫条目时才报截断（P-26 分享扫描 maxScanEntries 同语义）
const maxStatEntries = 2000

// DirStat 删除确认的递归规模（知情确认面：递归删除从盲确认变知情确认，
// 隐藏文件一并计入——它们恰是「以为只有几个文件」的误删盲区）
type DirStat struct {
	IsDir     bool   `json:"isDir"`
	Files     int64  `json:"files"`     // 将随删除消失的文件条目数（含隐藏文件与符号链接本身）
	Dirs      int64  `json:"dirs"`      // 目标目录内的子目录数（目标本身已由确认文案点名，不计）
	Bytes     int64  `json:"bytes"`     // 文件内容字节总量（目录 inode 尺寸不计）
	SizeHuman string `json:"sizeHuman"` // HumanBytes 格式化后的展示值（前端直显，不重复实现）
	Truncated bool   `json:"truncated"` // 条目达上限提前收尾：以上字段均为下界
}

// StatFile GET /api/projects/:id/file/stat?path= — 删除确认前的递归规模统计。
// 单文件直接返回（不递归）；目录 os.Root 锚定 + WalkDir 统计，符号链接不
// 深入（沿 P-26 分享扫描同策略）。路径边界与删除端点同标准（SafeJoinProject
// 三道闸），项目根本身同款拒绝。本端点是确认弹层的增强面而非删除的准入
// 闸——前端取不到规模时退化为既有盲确认，删除主链路不依赖它
func StatFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	filePath := c.Query("path")
	if filePath == "" {
		shared.Error(c, http.StatusBadRequest, "path is required", nil)
		return
	}
	absPath, err := SafeJoinProject(p.Path, filePath)
	if err != nil {
		shared.Error(c, http.StatusForbidden, err.Error(), nil)
		return
	}
	// 与删除端点同款根守护：删除必被拒绝的路径统计无意义
	if absPath == mustAbsRoot(p.Path) {
		shared.Error(c, http.StatusForbidden, "cannot delete project root", nil)
		return
	}

	d, err := statTarget(p.Path, absPath, maxStatEntries)
	if err != nil {
		if os.IsNotExist(err) {
			shared.Error(c, http.StatusNotFound, "file not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": d})
}

// statTarget 统计 absPath 的递归规模，limit 独立成参供单测用小上限验证截断
// 语义（scan.go scanSensitive 同款）。rootPath 仅作 os.Root 锚定基准。
func statTarget(rootPath, absPath string, limit int) (DirStat, error) {
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return DirStat{}, err
	}
	defer root.Close()

	// absPath 出自 SafeJoinProject（Abs(Join(root, req))，已拒绝 .. 段与
	// 越界），必以 abs(root)+分隔符 为前缀；折回根内 / 分隔相对路径供
	// os.Root 操作（Root API 契约只认 / 分隔）
	rel := ""
	if trimmed := strings.TrimPrefix(absPath, mustAbsRoot(rootPath)); trimmed != "" {
		rel = filepath.ToSlash(strings.TrimPrefix(trimmed, string(filepath.Separator)))
	}

	info, err := root.Lstat(rel)
	if err != nil {
		return DirStat{}, err
	}
	st := DirStat{IsDir: info.IsDir()}
	if !st.IsDir {
		// 单文件直接返回：链接（含指向根内的符号链接）与文件同形态，
		// RemoveAll 对两者的语义都是移除条目本身，规模即自身大小
		st.Files, st.Bytes = 1, info.Size()
		st.SizeHuman = filepolicy.HumanBytes(st.Bytes)
		return st, nil
	}

	// 目录：收紧到目标目录再递归走（os.Root 双层锚定，分享扫描同源）。
	// WalkDir 只读元数据不读内容；单个条目不可读不阻断统计
	dir, err := root.OpenRoot(rel)
	if err != nil {
		return DirStat{}, err
	}
	defer dir.Close()

	visited := 0
	_ = fs.WalkDir(dir.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p == "." {
			return nil
		}
		// 符号链接不深入（P-26 分享扫描同策略）：不沿链进入目标子树，
		// 但链接条目本身计入文件数——RemoveAll 会移除链接本身，跳过计
		// 数将低报规模，重蹈「以为只有几个文件」的盲区（扫描场景跳过是
		// 因为访客不可见，删除场景条目会真实消失，取向相反）
		if d.Type()&fs.ModeSymlink != 0 {
			st.Files++
			if li, e := d.Info(); e == nil {
				st.Bytes += li.Size()
			}
			return nil
		}
		visited++
		// 先计数后上限：第 limit+1 个条目触发收尾（不再参与统计）——
		// 由此 Truncated=true 当且仅当确有未统计条目
		if visited > limit {
			st.Truncated = true
			return fs.SkipAll
		}
		if d.IsDir() {
			st.Dirs++
			return nil
		}
		st.Files++
		if fi, e := d.Info(); e == nil {
			st.Bytes += fi.Size()
		}
		return nil
	})
	st.SizeHuman = filepolicy.HumanBytes(st.Bytes)
	return st, nil
}
