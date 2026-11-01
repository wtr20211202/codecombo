package filepolicy

import (
	"io"
	"os"
)

// 本文件承载策略包自带的文件 IO 原语：调用方（handler）只做路径校验与 Stat，
// 嗅探与头读统一走这里，保证「部分读取只碰头部、绝不整读大文件」的实现
// 收敛在一处。

// SniffHasNUL 读取文件前 maxRead 字节，判断是否含 NUL 字节（二进制特征）。
// 大文件只读头部，不会整读进内存
func SniffHasNUL(path string, maxRead int64) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	buf := make([]byte, 4096)
	var read int64
	for read < maxRead {
		n, rerr := f.Read(buf)
		for _, b := range buf[:n] {
			if b == 0 {
				return true, nil
			}
		}
		read += int64(n)
		if rerr != nil || n == 0 {
			break
		}
	}
	return false, nil
}

// HasUTF16BOM 文件头两字节是否为 UTF-16 BOM（FF FE / FE FF）。
// UTF-16 文本（Windows 记事本/PowerShell 脚本常见）合法含大量 NUL 字节，
// 二进制嗅探（sniff:nul-byte）必须先排除此情形，否则文本文件被拦成 binary
func HasUTF16BOM(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var bom [2]byte
	if _, err := io.ReadFull(f, bom[:]); err != nil {
		return false
	}
	return (bom[0] == 0xFF && bom[1] == 0xFE) || (bom[0] == 0xFE && bom[1] == 0xFF)
}

// ReadHead 全读（maxBytes<=0 或 ≥ 文件实际大小）或按 maxBytes 读头部。
// 返回 (内容, 是否截断, 错误)。部分读取可能截断多字节 UTF-8，由调用方按需修复
func ReadHead(path string, fileSize, maxBytes int64) ([]byte, bool, error) {
	if maxBytes <= 0 || maxBytes >= fileSize {
		data, err := os.ReadFile(path)
		return data, false, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	buf := make([]byte, maxBytes)
	n, rerr := io.ReadFull(f, buf)
	if rerr != nil && rerr != io.ErrUnexpectedEOF && rerr != io.EOF {
		return nil, false, rerr
	}
	return buf[:n], true, nil
}
