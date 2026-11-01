package recording

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"codecombo/server/config"
	"codecombo/server/mask"
)

// castWriter asciinema v2 cast 格式追加写（车道 2 artifacts）：
//
//	首行 header：{"version":2,"width":..,"height":..,"timestamp":..,"env":{..}}
//	事件行：    [<相对秒>.<6位小数>, "o", "<输出文本>"]
//
// 数据行在写盘前经 mask.Masker 遮蔽（安全修正硬性：敏感值不留证据）。
// 非法 UTF-8 字节序列由 json.Marshal 以 U+FFFD 替换——终端内容在
// TERM=xterm-256color/COLORTERM=truecolor 环境下实际恒为 UTF-8。
type castWriter struct {
	f     *os.File
	start time.Time
	size  int64
}

// ArtifactsDir cast 文件落盘目录（车道 2：<DataDir>/artifacts/recordings/；
// 测试经 SC_DATA_DIR 重定向）
func ArtifactsDir() string {
	return filepath.Join(config.DataDir(), "artifacts", "recordings")
}

// CastPath 录制 ID → cast 文件路径
func CastPath(id string) string {
	return filepath.Join(ArtifactsDir(), id+".cast")
}

// newCastWriter 创建 cast 文件并写 header。cols/rows 取自会话当前 PTY 尺寸
// （从未 resize 过的会话回落 80x24）
func newCastWriter(id string, cols, rows uint16, start time.Time) (*castWriter, error) {
	if err := os.MkdirAll(ArtifactsDir(), 0o700); err != nil {
		return nil, fmt.Errorf("create recordings dir: %w", err)
	}
	f, err := os.OpenFile(CastPath(id), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create cast file: %w", err)
	}
	w := &castWriter{f: f, start: start}
	header := map[string]any{
		"version":   2,
		"width":     cols,
		"height":    rows,
		"timestamp": start.Unix(),
		"env":       map[string]string{"TERM": "xterm-256color"},
	}
	b, _ := json.Marshal(header)
	if err := w.writeln(b); err != nil {
		_ = f.Close()
		return nil, err
	}
	return w, nil
}

// writeOutput 追加一条输出事件（data 先经流式遮蔽器；非法 UTF-8 由
// json.Marshal 以 U+FFFD 替换）
func (w *castWriter) writeOutput(data []byte, m *mask.Masker) error {
	masked := m.Write(data)
	if len(masked) == 0 {
		return nil
	}
	return w.writeEvent(string(masked))
}

// flushTail 收尾：放行遮蔽器滞留的未定界字节后刷盘
func (w *castWriter) flushTail(m *mask.Masker) error {
	tail := m.Flush()
	if len(tail) > 0 {
		if err := w.writeEvent(string(tail)); err != nil {
			return err
		}
	}
	return w.f.Sync()
}

func (w *castWriter) writeEvent(text string) error {
	b, err := json.Marshal([]any{elapsedSec(w.start), "o", text})
	if err != nil {
		return err
	}
	return w.writeln(b)
}

func (w *castWriter) close() error { return w.f.Close() }

func (w *castWriter) writeln(line []byte) error {
	line = append(line, '\n')
	if _, err := w.f.Write(line); err != nil {
		return err
	}
	w.size += int64(len(line))
	return nil
}

func elapsedSec(start time.Time) float64 {
	return time.Since(start).Seconds()
}
