package share

import (
	"archive/zip"
	"io"
	"io/fs"
	"os"
	"time"
)

// writeZip 把 root 下 rel 目录整棵递归打包写入 w（流式，不落临时盘）。
// 供目录分享的"打包下载"；调用方已写好响应头，这里只负责 zip 体
func writeZip(w io.Writer, root *os.Root, rel string) error {
	zw := zip.NewWriter(w)
	defer zw.Close()

	fsys := root.FS()
	return fs.WalkDir(fsys, rel, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// WalkDir 从 rel 本身开始；rel 条目跳过（zip 根不再包一层目录名）
		if p == rel {
			return nil
		}
		// 符号链接不打包（与列表/定位同策略）：包内符号链接条目在解压侧
		// 可能被还原为指向包外任意路径的链接（zip-slip 变体）
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		// zip 内路径去掉分享根本身前缀，让包结构以所选目录为根
		hdr.Name = zipEntryName(p, rel, d.IsDir())
		hdr.Modified = info.ModTime().Truncate(time.Second)
		if d.IsDir() {
			hdr.Method = zip.Store
			if _, err := zw.CreateHeader(hdr); err != nil {
				return err
			}
			return nil
		}
		hdr.Method = zip.Deflate
		out, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := fsys.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(out, f)
		return err
	})
}

// zipEntryName 分享根内 fs 路径 → zip 条目名（目录补尾斜杠）
func zipEntryName(p, rel string, isDir bool) string {
	name := p
	if rel != "." {
		name = p[len(rel)+1:]
	}
	if isDir {
		name += "/"
	}
	return name
}
