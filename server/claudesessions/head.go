package claudesessions

import (
	"bufio"
	"os"
	"time"
)

// TranscriptHead 读取 transcript 头部窗口，返回（首个时间戳, 首条可作标题的
// 用户消息文本）（P-20261111-6 S1 会话自动命名的数据面）。
//
// 复用 scanFile/parseHead 的同一解析链（isUserLine/extractUserText/isTitleWorthy
// 逐行语义零分叉——meta 信息块跳过、sidechain 跳过、纯噪声不配作标题），但读法
// 不同：scanFile 全量读文件（列表扫描要行数/用量/搜索），本函数增量读头部窗口
// （titleSearchBytes 上限）——自动命名观察器周期轮询调用，只关心头部首条用户
// 消息，全量读会把数百 MB transcript 变成周期性 IO 放大。
//
// 行读取走 64KB 缓冲：单行超缓冲按 ErrBufferFull 分段读尽（分段无法整行解析
// JSON，自然不构成标题候选——粘贴大段文本的首条消息本就不宜作标题）；窗口
// 耗尽或 EOF 即止。首个时间戳（firstAt）同时返回：自动命名用它做「transcript
// 是否晚于终端创建」的候选归属过滤，一次头部读同时完成两件事。
//
// 返回值：firstAt 零值 = 头部窗口内无时间戳（空文件/纯不可解析行）；title
// 空串 = 尚无可作标题的用户消息（只有 caveat 等元信息块，或首条消息还没写）。
// 打不开/读失败一律零值降级（调用方静默跳过，下轮重试——「解析失败不命名
// 好过错命名」）
func TranscriptHead(path string) (firstAt time.Time, title string) {
	f, err := os.Open(path)
	if err != nil {
		return time.Time{}, ""
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	var s Session
	read := 0
	for read < titleSearchBytes {
		line, err := r.ReadSlice('\n')
		read += len(line)
		parseHead(line, &s)
		if !s.FirstAt.IsZero() && s.Title != "" {
			return s.FirstAt, s.Title
		}
		if err != nil {
			if err == bufio.ErrBufferFull {
				continue // 超长行后续分段：读到行尾为止，分段不构成候选
			}
			return s.FirstAt, s.Title // EOF（或罕见读错误）：已解析出的部分如实带回
		}
	}
	return s.FirstAt, s.Title
}
