package sync

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 非项目目录/文件轻投递（方案④）与落位完成通知。

// deliverToPeer 把本端项目子树投递到对端（不注册项目，纯落位）：打包子树 zip
// → 对端 POST land（Dest 显式声明，对端按 syncDestRoot 白名单校验）
func deliverToPeer(ctx context.Context, inst config.InstanceConfig, p *config.ProjectConfig, relPath, dest string) (*LandResult, error) {
	relPath = strings.TrimSpace(relPath)
	// 源路径安全：项目内相对路径，拒 ".."（源侧边界；包内条目名落位侧还有
	// sanitizeZipName 第二道）
	relPath = normalizeSlashes(strings.Trim(relPath, "/"))
	if relPath == "" || strings.Contains(relPath, "..") {
		return nil, errf("invalid relPath")
	}
	dest = normalizeSlashes(strings.TrimSpace(dest))
	if dest == "" || strings.Contains(dest, "..") {
		return nil, errf("invalid dest")
	}
	absSource := filepath.Join(p.Path, filepath.FromSlash(relPath))
	info, err := os.Stat(absSource)
	if err != nil {
		return nil, errf("source not found")
	}

	key := UnitKey(UnitDeliver, fmt.Sprintf("%s-%s", rootBasename(p.Path), rootBasename(relPath)))
	release, ok := tryUnitLock(key)
	if !ok {
		return nil, errf("unit busy")
	}
	defer release()

	unit := TransferUnit{
		Key: key, Kind: UnitDeliver, Name: relPath,
		DirName: rootBasename(relPath), Dest: dest,
	}
	// Entries/Size 上传前主 goroutine 预扫定形（元数据随请求头先行）：打包协程
	// 只读载荷不再回写 meta——修复头序列化（postPeerDeliver 的 mustJSON）与
	// 打包协程补账的并发读写（race 门禁口径）。预扫枚举成本远小于逐文件读包，
	// 且截断护栏从传输中失败前移到上传前失败（fail fast）
	var scan unitScan
	if info.IsDir() {
		var err error
		scan, err = enumerateRelTree(absSource)
		if err != nil {
			return nil, err
		}
		if scan.truncated {
			return nil, errf("deliver tree exceeds %d entries", maxUnitEntries)
		}
		unit.Entries = len(scan.files)
		unit.Size = sumSizes(scan.files)
	} else {
		unit.Entries = 1
		unit.Size = fileSizeOf(absSource)
	}
	meta := &TransferMeta{Units: []TransferUnit{unit}}
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		if err := packDeliverStream(ctx, pw, absSource, relPath, info.IsDir(), scan); err != nil {
			pw.CloseWithError(err)
		}
	}()
	return postPeerDeliver(ctx, inst, meta, pr)
}

// packDeliverStream 投递打包：目录树（scan 由调用方预扫传入，本函数只读不回写
// 元数据——meta 归主 goroutine 所有）或单文件。包内条目名 =
// u0/<子树内相对路径|文件名>（对端按 Dest+相对路径落位）
func packDeliverStream(ctx context.Context, w io.Writer, absSource, relPath string, isDir bool, scan unitScan) error {
	zw := zip.NewWriter(w)
	if isDir {
		for _, f := range scan.files {
			if err := ctx.Err(); err != nil {
				return err
			}
			// 包内条目名 = 子树内相对路径（f.rel 前缀即 relPath）
			inTree := strings.TrimPrefix(strings.TrimPrefix(f.rel, relPath), "/")
			if inTree == "" {
				continue
			}
			if err := zipAddFile(zw, "u0/"+inTree, filepath.Join(absSource, filepath.FromSlash(inTree))); err != nil {
				return err
			}
		}
	} else {
		if err := zipAddFile(zw, "u0/"+filepath.Base(absSource), absSource); err != nil {
			return err
		}
	}
	return zw.Close()
}

// zipAddFile 单文件入包（秒级精度时间戳跨平台口径，dir-archive 同）
func zipAddFile(zw *zip.Writer, name, abs string) error {
	info, err := os.Lstat(abs)
	if err != nil {
		return err
	}
	if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	src, err := os.Open(abs)
	if err != nil {
		return nil // 打不开跳过（权限/竞态），不阻断整包
	}
	defer src.Close()
	hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
	hdr.Modified = info.ModTime()
	out, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, src)
	return err
}

func fileSizeOf(abs string) int64 {
	info, err := os.Stat(abs)
	if err != nil {
		return 0
	}
	return info.Size()
}

// enumerateRelTree 子树枚举（deliver 档：默认排除清单感知）
func enumerateRelTree(absRoot string) (unitScan, error) {
	var scan unitScan
	err := filepath.WalkDir(absRoot, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		relToSub, rerr := filepath.Rel(absRoot, p)
		if rerr != nil {
			return nil
		}
		relToSub = normalizeSlashes(relToSub)
		if relToSub == "." {
			return nil
		}
		if d.IsDir() {
			if matchExclude(relToSub, defaultExcludes) {
				scan.excluded++
				return filepath.SkipDir
			}
			return nil
		}
		if matchExclude(relToSub, defaultExcludes) {
			scan.excluded++
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if len(scan.files) >= maxUnitEntries {
			scan.truncated = true
			return filepath.SkipAll
		}
		scan.files = append(scan.files, fileEntry{rel: relToSub, size: info.Size()})
		return nil
	})
	return scan, err
}

// postPeerDeliver 投递上传 + 对端落位回执（dest 经 meta.Units[0].Dest 声明）
func postPeerDeliver(ctx context.Context, inst config.InstanceConfig, meta *TransferMeta, body io.Reader) (*LandResult, error) {
	hdr := http.Header{}
	hdr.Set(syncMetaHeader, mustJSON(meta))
	resp, err := peerDo(ctx, http.MethodPost, inst.URL, inst.Token, "/api/sync/units?mode=deliver", body, hdr)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, peerRemoteUnreachable(err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errf("peer landing failed: status=%d %s", resp.StatusCode, truncateErrBody(raw))
	}
	var parsed struct {
		Data LandResult `json:"data"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errf("peer landing result not parseable")
	}
	return &parsed.Data, nil
}

// notifyLanded 落位完成通知入账（对端侧）：通知中心条目 Action=sync-landed，
// 前端据此广播 OPS_FILES_EXTERNAL_CHANGE 让已打开编辑器自动重读（对端 watcher
// 对已注册项目走 fsnotify → file.changed 自动刷新文件树/git，编辑器缓冲重读
// 靠本条补齐）
func notifyLanded(lr *LandResult) {
	if lr == nil {
		return
	}
	var landed, failed, projects int
	for _, u := range lr.Units {
		if u.Error != "" {
			failed++
			continue
		}
		landed++
		if u.Registered {
			projects++
		}
	}
	if landed == 0 && failed == 0 {
		return
	}
	note := fmt.Sprintf("destRoot=%s projects=%d", lr.DestRoot, projects)
	store.Get().Notification.Add(notification.Notification{
		Type:     "success",
		Category: notification.CategoryTask,
		TitleKey: "sync.landed.notify.title",
		Title:    fmt.Sprintf("同步落位完成：%d 项成功%s", landed, failedSuffix(failed)),
		Body:     note,
		MsgParams: map[string]any{
			"landed":   landed,
			"failed":   failed,
			"destRoot": lr.DestRoot,
		},
		Action:        "sync-landed",
		ActionPayload: "",
	})
	// 已注册项目落位即触发 project.added/watcher 注册链（组合根既有）；
	// 通知 WS 广播 notification.new 由 store 出站口异步派发
}

func failedSuffix(failed int) string {
	if failed > 0 {
		return fmt.Sprintf("、%d 项失败", failed)
	}
	return ""
}
