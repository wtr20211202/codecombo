//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// findPIDByPort 通过 netstat -ano 反查监听指定端口的进程 PID（Windows 专用）
// 失败或未找到返回 (0, error)
func findPIDByPort(port int) (int, error) {
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return 0, fmt.Errorf("netstat failed: %w", err)
	}
	// netstat 行示例：
	//   TCP    0.0.0.0:9999     0.0.0.0:0     LISTENING     12345
	//   TCP    [::]:9999        [::]:0        LISTENING     12345
	// 状态列随系统区域语言本地化（如德语 ABHÖREN），不可依赖 "LISTENING"
	// 字面量——监听套接字的稳定特征是「远程地址为全零」
	want := fmt.Sprintf(":%d", port)
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 5 || !strings.EqualFold(fields[0], "TCP") {
			continue
		}
		// fields[1] = local address，需匹配 :PORT 末尾（避免 :9999 命中 :99990）
		localAddr := fields[1]
		if !strings.HasSuffix(localAddr, want) {
			continue
		}
		remoteAddr := fields[2]
		if remoteAddr != "0.0.0.0:0" && remoteAddr != "[::]:0" && remoteAddr != "*:*" {
			continue
		}
		pid, perr := strconv.Atoi(fields[len(fields)-1])
		if perr == nil {
			return pid, nil
		}
	}
	return 0, fmt.Errorf("no process listening on port %d", port)
}
