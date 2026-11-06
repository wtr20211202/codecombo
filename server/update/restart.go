package update

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// 自更新子进程的服务重启与健康检查（从 do_update.go 拆出）。
// binary 为服务端自身二进制的绝对路径（LaunchUpdateSubprocess 校验链传递），
// argv 列式传参不经 shell。

// systemdUnit 探测当前进程是否由 systemd 托管：Linux 上读 /proc/self/cgroup，
// 服务实例的 cgroup 路径末段形如 <name>.service。返回单元名（含 .service 后缀，
// 如 simple-coding.service）；裸进程 / Windows / 容器等非 systemd 环境返回空串
func systemdUnit() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		// 形如 0::/system.slice/simple-coding.service
		idx := strings.LastIndex(line, "/")
		if idx < 0 {
			continue
		}
		unit := strings.TrimSpace(line[idx+1:])
		if strings.HasSuffix(unit, ".service") {
			return unit
		}
	}
	return ""
}

// systemdUnitOurs systemd 单元中「本产品部署器装的」那两类：codecombo.service
// 与旧名 simple-coding.service。canonicalizeBinaryName 只为这两类让位盘上改名
// ——unit ExecStart 钉着旧路径，换名会让 systemctl restart 落空；而泛化的
// .service 命中（宿主自身就是 systemd 服务的环境，如 GitHub Actions runner）
// 与本产品无关，不该拦改名（runner 上曾误判致单测挂，实锚）
//
// 经 systemdUnitOursFn 间接调用：测试注入可控值，摆脱对宿主 /proc/self/cgroup
// 实况的依赖（环境依赖探测的测试纪律——runner/容器/裸机各不相同）
func systemdUnitOurs() string {
	return systemdUnitOursFn()
}

var systemdUnitOursFn = func() string {
	unit := systemdUnit()
	if unit == "codecombo.service" || unit == "simple-coding.service" {
		return unit
	}
	return ""
}

// restartService 以新二进制拉起服务进程，保持更新前的监管方式：
//   - systemd 托管 → systemctl restart 交还 systemd（状态机、Restart= 策略、
//     日志归属不变，不孵化孤儿进程）。换包完成后磁盘上已是新二进制，
//     restart 即以新版本拉起；返回 PID 无意义（由 systemd 接管），恒为 0
//   - 裸进程 → os.StartProcess 脱离更新子进程独立常驻，父进程退出后由 init
//     接管（与历史语义一致），返回新进程 PID
//
// --serve 子命令：main.go 按 os.Args[1] 分发，只有 --serve 进入服务装配
// （历史缺陷只传 --port，落 default 分支打印 unknown command 后立即退出）
func restartService(binary string, port int) (int, error) {
	if unit := systemdUnit(); unit != "" {
		if err := exec.Command("systemctl", "restart", unit).Run(); err != nil {
			return 0, fmt.Errorf("systemctl restart %s: %w", unit, err)
		}
		return 0, nil
	}
	portArg := strconv.Itoa(port)
	argv := []string{binary, "--serve", "--port", portArg}
	attr := &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	}
	proc, err := os.StartProcess(binary, argv, attr)
	if err != nil {
		return 0, err
	}
	// 不等待退出：服务进程自负责生命周期，释放句柄避免僵尸
	if err := proc.Release(); err != nil {
		return proc.Pid, err
	}
	return proc.Pid, nil
}

// RestartViaSystemd systemd 托管实例的重启（P-20261106 页面重启链）：
// systemctl restart 停旧起新全托管（状态机、Restart= 策略、日志归属不变）。
// 返回 (false, nil)=非 systemd 环境由调用方走自 spawn 链；(true, err)=systemd
// 托管但 restart 失败（调用方留痕并保持存活——此时绝不能退出，退出即失联）
func RestartViaSystemd() (bool, error) {
	unit := systemdUnit()
	if unit == "" {
		return false, nil
	}
	if err := exec.Command("systemctl", "restart", unit).Run(); err != nil {
		return true, fmt.Errorf("systemctl restart %s: %w", unit, err)
	}
	return true, nil
}

// RestartSelfExe 前台/裸进程形态的自重启：以**当前进程原参数**（os.Args 全量，
// 含 --host/--data-dir 等——restartService 只传 --port 会丢参数）spawn 自身后
// 返回，调用方先释放监听再调本函数（新进程可即时绑定）。systemd/Windows 服务/
// launchd 形态不走此链（各自监管者接管）
func RestartSelfExe() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	argv := append([]string{exe}, os.Args[1:]...)
	attr := &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	}
	proc, err := os.StartProcess(exe, argv, attr)
	if err != nil {
		return err
	}
	// 不等待退出：服务进程自负责生命周期，释放句柄避免僵尸
	return proc.Release()
}

// killByPID 精确击杀（健康检查失败回滚路径）。按 PID 而非 pkill -f 名称匹配：
// 后者按完整命令行做正则匹配（`.` 通配任意字符），会误杀命令行里恰好包含
// 同名串的无关进程（如 tail -f simple-coding.log）
func killByPID(pid int) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

// waitForHealthy 等待新版本进程健康：
//  1. 读 PID 文件（新进程启动即重写）派生本机明文地址——
//     第三行回环辅助端口 > 0（TLS 模式）则探测回环口，否则探测主端口（明文模式）。
//     历史缺陷：固定探测主端口明文 /api/health，TLS 默认开启后自签 https 握手
//     必失败 → 更新健康检查必挂 → 误回滚
//  2. PID 文件不可读时回退主端口明文探测（旧文件同端口，语义不变）
func (c *updateContext) waitForHealthy(timeout time.Duration) error {
	client := &http.Client{Timeout: 3 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		url := fmt.Sprintf("http://localhost:%d/api/health", c.port)
		if loopback := readPIDLoopbackPort(c.dd); loopback > 0 {
			url = fmt.Sprintf("http://localhost:%d/api/health", loopback)
		}
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(1 * time.Second)
	}
	return fmt.Errorf("health check timeout after %v", timeout)
}

// readPIDLoopbackPort 从数据目录读明文回环辅助端口（pid 文件第三行）。
// 文件缺失/格式不符返回 0（明文模式或尚未写出）。
// 候选顺序覆盖更新链全矩阵（P-20261025-1）：
//  1. dd/codecombo.pid —— 本版正常形态
//  2. dd/simple-coding.pid —— 旧版写入的存量文件（更新子进程由旧代码下发
//     dd，而重启后的新版本进程已写新名——目录迁移会把旧名文件一并搬来）
//  3. config.DataDir()/codecombo.pid —— 数据目录迁移（旧默认目录整体改名）
//     发生在「旧二进制自更新换新」窗口内：env 下发的 dd 已随迁移消失，实际
//     pid 文件落在迁移后的新默认目录
func readPIDLoopbackPort(dd string) int {
	candidates := []string{
		filepath.Join(dd, "codecombo.pid"),
		filepath.Join(dd, "simple-coding.pid"),
	}
	if live := configDataDir(); live != dd {
		candidates = append(candidates, filepath.Join(live, "codecombo.pid"))
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) < 3 {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(lines[2]))
		if err != nil {
			continue
		}
		return n
	}
	return 0
}
