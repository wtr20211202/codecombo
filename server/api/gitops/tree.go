package gitops

import (
	files "codecombo/server/api/files"
	shared "codecombo/server/api/shared"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// ListFileTree 列出项目工作区文件树
func ListFileTree(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 本端点是工作区目录列表（os.ReadDir），不支持提交快照语义——
	// ref 参数曾静默被忽略，调用方会误以为拿到的是指定 ref 的树。
	// 显式 400 提示走 blob 端点（ShowFileAtRef）按 ref 读取
	if c.Query("ref") != "" {
		shared.Error(c, http.StatusBadRequest, "tree endpoint lists the working directory; ref is not supported", nil)
		return
	}

	subPath := c.Query("path")
	rootPath := p.Path

	if subPath != "" {
		// 与文件读写端点同标准的路径边界校验：filepath.Join 会把 `..` 规范化
		// 掉，裸 Join 后 ReadDir 可列出仓库外任意目录（A4 类目录结构泄露）
		anchored, err := files.SafeJoinProject(p.Path, subPath)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Tree operation failed", err)
			return
		}
		rootPath = anchored
	}

	type FileEntry struct {
		Name      string `json:"name"`
		Path      string `json:"path"`
		IsDir     bool   `json:"isDir"`
		Status    string `json:"status,omitempty"`
		IsIgnored bool   `json:"isIgnored"`
	}

	entries, err := os.ReadDir(rootPath)
	if err != nil {
		// 项目路径已失效（目录被删/换机器）：空列表静默降级——UI 已有「路径
		// 无效」徽章兜底；每次会话首拉都会走到这里，500+ERROR 只会反复污染
		// 错误日志（真实实例 3 天 ×11 次）
		if os.IsNotExist(err) {
			c.JSON(http.StatusOK, gin.H{"data": []FileEntry{}})
			return
		}
		respondGitError(c, "Tree operation failed", err)
		return
	}

	// 获取状态映射（带 3s TTL 缓存：文件树逐层导航时每层都会触发 git 子进程，
	// 大仓库开销显著；短暂陈旧对"文件树着色"场景可接受，暂存/提交等写操作不受影响）
	statusMap, ignoredMap := cachedGitMaps(p.Path)

	var result []FileEntry
	for _, entry := range entries {
		name := entry.Name()
		// 跳过 .git 目录
		if name == ".git" {
			continue
		}
		// 跳过隐藏文件/目录
		// skip hidden files - removed to show all files

		relPath := name
		if subPath != "" {
			relPath = filepath.Join(subPath, name)
		}
		// 统一使用正斜杠
		relPath = filepath.ToSlash(relPath)

		isDir := entry.IsDir()
		fe := FileEntry{
			Name:      name,
			Path:      relPath,
			IsDir:     isDir,
			IsIgnored: ignoredMap[relPath],
		}

		// 文件状态
		if !isDir {
			if st, ok := statusMap[relPath]; ok {
				fe.Status = st
			}
		}

		result = append(result, fe)
	}

	// 目录优先，然后按名称排序
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})

	c.JSON(http.StatusOK, gin.H{"data": result})
}

// flatFileItem 扁平文件列表条目（Quick Open / 命令面板用）
type flatFileItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// skipDirNames 快速跳过目录：依赖产物/构建产物/版本控制目录（与前端 Quick Open 原有一致）
var skipDirNames = map[string]struct{}{
	"node_modules": {}, ".git": {}, "dist": {}, "build": {}, ".next": {},
	".nuxt": {}, "target": {}, "vendor": {}, ".cache": {},
}

// ListFlatFiles 一次请求返回全项目扁平文件列表（Quick Open 专用性能端点）。
// 旧前端实现按目录逐层 BFS 拉取 file-tree——每层都触发 git status/check-ignore 子进程，
// 大仓库首次打开要数十次串行请求。此端点单请求完成遍历；git 采集仅文件树既有
// 的 3s TTL 缓存一份（cachedGitMaps，status+ignored 一次采集多方复用）。
// 隐藏文件（. 开头）与 .github/.vscode 等隐藏目录纳入索引（对齐 VS Code Quick Open）；
// 仅 skipDirNames 清单（依赖产物/构建产物/.git）整体跳过；
// .gitignore 命中的未跟踪文件/目录不入索引（对齐 git ls-files 语义）。
// 路由：GET /api/projects/:id/file-list?max=5000
func ListFlatFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	max := 5000
	if v := c.Query("max"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 20000 {
			max = n
		}
	}

	// gitignore 语义：ignored 集复用文件树的 3s TTL 缓存（cachedGitMaps，与
	// ListFileTree 同源同成本，项目打开时文件树已预热）。不理会会漏掉「仓库内
	// 跑导出器/e2e 就新增一批 .golangci.yml」式的未跟踪残留物——索引持续膨胀
	// 且同名歧义（e2e 实证：Quick Open .golangci.yml 命中 4 条、「移动到…」
	// 目录清单被 .sc-tmp/results-* 冲爆前端 RENDER_CAP 截断）。非 git 目录
	// 采集失败 → ignored 集为空 → 语义自动退化为全量索引，行为不变
	_, ignoredMap := cachedGitMaps(p.Path)

	result := make([]flatFileItem, 0, 256)
	root := p.Path
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 单个不可读路径跳过，不中断遍历
		}
		name := d.Name()
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return nil
		}
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			// 目录跳过仅认 skipDirNames 清单（.github/.vscode/.husky 等隐藏目录
			// 不再被一网打尽，其内容随隐藏文件一起进索引）
			if _, skip := skipDirNames[name]; skip {
				return filepath.SkipDir
			}
			// gitignore 命中的目录整枝剪掉（GetIgnoredFiles --directory 把整目录
			// 折叠成单条目，目录级在此剪、目录内散点被忽略的文件走下方文件级）
			if ignoredMap[filepath.ToSlash(rel)] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(result) >= max {
			return filepath.SkipAll
		}
		// .git 在 worktree/子模块布局下是 gitdir 指针文件而非目录——同样不进索引
		if name == ".git" {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if ignoredMap[relSlash] {
			return nil
		}
		result = append(result, flatFileItem{
			Name: name,
			Path: relSlash,
		})
		return nil
	})

	c.JSON(http.StatusOK, gin.H{"data": result})
}
