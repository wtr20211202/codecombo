//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// findPIDByPort 通过 lsof 反查监听指定端口的进程 PID（Unix 专用）
// 失败或未找到返回 (0, error)
func findPIDByPort(port int) (int, error) {
	out, err := exec.Command("lsof", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-t").Output()
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if pid, perr := strconv.Atoi(line); perr == nil {
				return pid, nil
			}
		}
	}
	// ss 兜底（部分 Linux 无 lsof）。`sport = :N` 过滤本身已是内核侧精确匹配；
	// 行内再按字段后缀 `:N` 精确核对（Contains(":9999") 会误中 :99990 串）
	out, err = exec.Command("ss", "-tlnp", fmt.Sprintf("sport = :%d", port)).Output()
	if err == nil {
		re := regexp.MustCompile(`pid=(\d+)`)
		portSuffix := ":" + strconv.Itoa(port)
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			line := scanner.Text()
			exact := false
			for _, f := range strings.Fields(line) {
				if strings.HasSuffix(f, portSuffix) {
					exact = true
					break
				}
			}
			if !exact {
				continue
			}
			m := re.FindStringSubmatch(line)
			if len(m) >= 2 {
				if pid, perr := strconv.Atoi(m[1]); perr == nil {
					return pid, nil
				}
			}
		}
	}
	return 0, fmt.Errorf("no process listening on port %d", port)
}
