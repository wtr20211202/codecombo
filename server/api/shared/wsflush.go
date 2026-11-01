package shared

import (
	"time"
)

// ============== 终端输出合帧（P-20261004-26） ==============
//
// 终端 WS 写侧原本逐块成帧：readLoop 每 4KB Read → 写循环每 chunk 一条
// WriteMessage。高输出场景（npm install/测试刷屏/进度条）每秒数千帧——每帧
// 一次系统调用 + write deadline 刷新 + 对端 goroutine 唤醒，远程访问还叠加
// TCP 帧头，感知为整页卡顿。VS Code/Hyper 均做 flush 窗口聚合（8~16ms），
// 这里同思路：首块到达开窗口，窗口内排空 outputChan 拼成单帧一次写出。

const (
	// WSOutputFlushWindow 首块输出到达后的合帧窗口。8ms 与 VS Code 同档：
	// 交互回显最坏 +8ms 远低于人眼感知阈（~50ms），burst 合并率 90%+
	WSOutputFlushWindow = 8 * time.Millisecond

	// WSOutputFlushMaxBytes 单帧聚合字节上限，先于窗口触发（burst 高流量时
	// 按尺寸及时落帧，写延迟不随流量增长）。128KB + 末块（readLoop 32KB 读
	// 缓冲）仍远低于代理透传帧上限 WSReadLimitProxy（8MB），浏览器 WS 收帧
	// 亦无压力；scrollback 重放单帧本就有 MB 级先例
	WSOutputFlushMaxBytes = 128 << 10
)

// WSOutputAggregator 终端输出写侧合帧器：把 readLoop 逐块喂来的 PTY 输出在
// flush 窗口内拼接成单帧。窗口 + 字节上限双门限，先到先触发。
//
// 用法（WS 写循环唯一消费位，terminal 与 remotehost_terminal 两处共用）：
//
//	agg := shared.NewWSOutputAggregator()
//	for {
//		select {
//		case data := <-outputChan:
//			frame, ok := agg.Collect(data, outputChan, clientGone)
//			if !ok {
//				return // 客户端断开（窗口期内 clientGone）
//			}
//			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
//			_ = conn.WriteMessage(websocket.BinaryMessage, frame)
//		case <-clientGone:
//			return
//		}
//	}
//
// 反压语义不变：outputChan 满 → OnOutput handler 阻塞 → readLoop 阻塞 →
// PTY/SSH 缓冲满 → shell stdout 自然反压；合帧只是加快排空，不改满载行为。
//
// 内存有界：内部缓冲跨调用复用（稳态零分配），稳态占用 ≤ maxBytes + 末块
// ≈ 160KB/连接；会话数受 MaxSessions（可配，缺省 50）约束。
//
// 非并发安全：Collect 只能被单个写循环 goroutine 串行调用（与 wssafe.Conn
// 的单写者串行化约定一致）。
type WSOutputAggregator struct {
	window   time.Duration
	maxBytes int
	buf      []byte
}

// NewWSOutputAggregator 生产默认门限（8ms 窗口 / 128KB 上限）。
// 测试同包可直接构造 &WSOutputAggregator{...} 注入自定义门限
func NewWSOutputAggregator() *WSOutputAggregator {
	return &WSOutputAggregator{window: WSOutputFlushWindow, maxBytes: WSOutputFlushMaxBytes}
}

// Collect 以 first 为首块开合帧窗口：窗口内排空 more 通道拼进内部缓冲，
// 窗口到点或缓冲达 maxBytes（先到先触发）返回聚合帧；done 关闭（客户端断开）
// 提前放弃，ok=false。done 触发时通道内未消费块原样保留（连接已死，数据
// 随主循环退出自然丢弃）。返回帧复用内部缓冲，调用方须在下一次 Collect
// 之前用完（WriteMessage 同步写完即释放，当前两处调用位均满足）。
func (a *WSOutputAggregator) Collect(first []byte, more <-chan []byte, done <-chan struct{}) (frame []byte, ok bool) {
	a.buf = append(a.buf[:0], first...)
	if len(a.buf) >= a.maxBytes {
		return a.buf, true
	}
	timer := time.NewTimer(a.window)
	defer timer.Stop()
	for {
		select {
		case chunk := <-more:
			a.buf = append(a.buf, chunk...)
			if len(a.buf) >= a.maxBytes {
				return a.buf, true
			}
		case <-timer.C:
			return a.buf, true
		case <-done:
			return nil, false
		}
	}
}
