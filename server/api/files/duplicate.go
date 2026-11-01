package files

// 文件/目录「创建副本」服务端端点（P-20261004-135）：变体文件「配置改一版留一版、
// 脚本变体」的高频小操作从「读内容→新建→写回」三步（旧前端编排，固定 _copy 后缀
// 二次复制即静默覆盖、目录与二进制不可用）收口为一次服务端调用。
//
//	POST /api/projects/:id/files/duplicate
//	{"path":"src/config.ts"}
//	→ 201 {"message":"duplicated","path":"src/config-copy1.ts","isDir":false}
//
// 命名 = 同目录 <stem>-copy<N>.<ext>，N 自 1 起取首个不冲突值（响应 path 是唯一
// 权威——前端据它刷新树并选中新文件，不自行拼名）。文件形态字节级复制（跟随
// 符号链接拷内容，O_EXCL 创建绝不覆盖既有条目）；目录形态递归整树复制（复用
// trash 的 copyTree：Lstat 语义，符号链接重建链接本身不吸外部子树，权限保留）。
// 护栏沿写族既有口径不引第二套：SafeJoinProject 边界、validateNameCompat（P-132）、
// GuardSensitiveWritePath 敏感写入路径闸（P-235，目标命中窄表 428 零副作用）。

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

const (
	// dupNameMaxTries 副本名自增上限：-copy1 … -copy1000 全被占（对同一目录连点
	// 千次副本的病态形态）才放弃——正常使用永远到不了，纯防御自增无界
	dupNameMaxTries = 1000
	// duplicateBodyMaxBytes 请求体上限：单体 path 字段的富余量级（batch 同族考量）
	duplicateBodyMaxBytes = int64(64) << 10
)

// dupMaxEntries 目录副本条目上限（运行时值）：与 dir-archive 打包护栏同值
// （dirZipMaxEntries，remotehost_zip zipMaxEntries 同族）。副本是磁盘双倍占用的
// 写面（不同于打包的流式出域），条目规模封顶后超限整单拒绝；字节面单文件自限
// （副本 ≤ 源大小）。var 而非 const 直读，为「超限拒绝」分支留注入小档位的
// 测试缝（trashMaxTotalBytes 同惯例）
var dupMaxEntries = 20000

var (
	errDupTooLarge = errors.New("directory too large to duplicate")
	// errDupNameExhausted 副本名自增至上限仍无空位（dupNameMaxTries 连占）——稳定
	// 原文随 409 透传，agent/前端按 conflict 语义处置
	errDupNameExhausted = errors.New("no available copy name")
)

// splitNameExt 叶子名拆主干/扩展名（末个点分段）。点开头的隐藏文件（.env、
// .gitignore：Ext 与名字全等）整体作主干——产出 .env-copy1 而非「-copy1.env」
func splitNameExt(name string) (stem, ext string) {
	ext = filepath.Ext(name)
	if ext == name {
		return name, ""
	}
	return strings.TrimSuffix(name, ext), ext
}

// dupCandidate 第 n 个候选名：<stem>-copy<N>.<ext>
func dupCandidate(stem, ext string, n int) string {
	return stem + "-copy" + strconv.Itoa(n) + ext
}

// createDuplicate 挑首个不冲突的副本名（<stem>-copy<N>.<ext>）并以 EXCL 语义
// 创建。create 必须在目标已存在时返回 os.ErrExist 族错误（文件 O_EXCL / 目录
// os.Mkdir 原生满足）——名字预检（Lstat）与创建之间的并发撞名由创建原子性
// 兜底，绝不覆盖既有条目。返回创建成功的绝对路径
func createDuplicate(parentAbs, stem, ext string, create func(absDst string) error) (string, error) {
	return createWithCandidates(parentAbs, func(n int) string {
		return dupCandidate(stem, ext, n)
	}, create)
}

// createWithCandidates 按候选名序列以 EXCL 语义创建的通用步进循环（-copyN 与
// batch copy 的 -副本N 共用）：candidate(n) 生成第 n 个候选叶子名，create 在目标
// 已存在时返回 os.ErrExist 族错误即换下一个候选。名字预检（Lstat）与创建之间的
// 并发撞名由创建原子性兜底，绝不覆盖既有条目
func createWithCandidates(parentAbs string, candidate func(n int) string, create func(absDst string) error) (string, error) {
	for n := 1; n <= dupNameMaxTries; n++ {
		absDst := filepath.Join(parentAbs, candidate(n))
		err := create(absDst)
		if err == nil {
			return absDst, nil
		}
		if !os.IsExist(err) {
			return "", err
		}
	}
	return "", errDupNameExhausted
}

// countEntriesLimited 条目计数（含根自身），超 limit 提前收尾返回 errDupTooLarge。
// WalkDir 不跟随符号链接（链接条目 IsDir()=false），链接环不会挂死计数
func countEntriesLimited(root string, limit int) error {
	count := 0
	return filepath.WalkDir(root, func(_ string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		if count > limit {
			return errDupTooLarge
		}
		return nil
	})
}

// DuplicateFile POST /api/projects/:id/files/duplicate — 创建文件/目录副本
func DuplicateFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, duplicateBodyMaxBytes)

	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}
	if req.Path == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}

	absSrc, err := SafeJoinProject(p.Path, req.Path)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}
	if absSrc == mustAbsRoot(p.Path) {
		shared.Error(c, http.StatusForbidden, "cannot duplicate project root", nil)
		return
	}
	srcInfo, err := os.Lstat(absSrc)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	isDir := srcInfo.IsDir()

	// 副本名与目标相对路径（正斜杠形态，响应 path 与树/API 全链同尺）
	rel := NormalizeRelPath(req.Path)
	dirRel, name := path.Split(rel)
	dirRel = path.Clean(dirRel) // "a/b/" → "a/b"；根级文件 → "."
	stem, ext := splitNameExt(name)

	// 名校验与敏感写入路径闸按首个候选名（-copy1）预检一次：-copyN 后缀不改变
	// 路径的目录形态（P-235 窄表按 glob 段匹配、P-132 按段尾点/空格判定，尾缀
	// 数字两者皆不影响），任一候选命中即全体命中——闸在循环外判一次，428 保持
	// 零副作用（任何候选都尚未落盘）
	firstRel := path.Join(dirRel, dupCandidate(stem, ext, 1))
	if err := validateNameCompat(firstRel); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNameInvalid, err.Error(), nil)
		return
	}
	if !middleware.GuardSensitiveWritePath(c, firstRel) {
		return
	}

	// 目录形态先做条目规模预检（元数据走读，不复制任何字节——超限整单拒绝零落盘）
	if isDir {
		if err := countEntriesLimited(absSrc, dupMaxEntries); err != nil {
			if errors.Is(err, errDupTooLarge) {
				shared.Error(c, http.StatusBadRequest,
					fmt.Sprintf("directory too large to duplicate (max %d entries)", dupMaxEntries), nil)
				return
			}
			shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
			return
		}
	}

	parentAbs := filepath.Dir(absSrc)
	var create func(absDst string) error
	if isDir {
		// 根目录 EXCL 占位（并发撞名在 Mkdir 即败），子树交 copyTree（trash 同款：
		// Lstat 语义重建链接本身、权限保留、不吸项目外子树）
		create = func(absDst string) error {
			if err := os.Mkdir(absDst, srcInfo.Mode().Perm()); err != nil {
				return err
			}
			return copyTree(absSrc, absDst)
		}
	} else {
		// 文件形态字节级复制：跟随符号链接拷内容（副本 = 内容拷贝的用户预期），
		// 权限随源。O_EXCL 创建，EEXIST（并发撞名）交 createDuplicate 换下一个 N
		create = func(absDst string) error {
			in, err := os.Open(absSrc)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(absDst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, srcInfo.Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
	}

	absDst, err := createDuplicate(parentAbs, stem, ext, create)
	if err != nil {
		if errors.Is(err, errDupNameExhausted) {
			shared.ErrorWithCode(c, shared.CodeFilesConflict, errDupNameExhausted.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	newRel := path.Join(dirRel, path.Base(filepath.ToSlash(absDst)))
	// 审计入账：与 rename/delete 同粒度（只记项目与相对路径，不记内容）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileDuplicate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s → %s", p.Name, rel, newRel),
	})

	c.JSON(http.StatusCreated, gin.H{
		"message": "duplicated",
		"path":    newRel,
		"isDir":   isDir,
	})
}
