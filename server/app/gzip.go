package app

import (
	"compress/gzip"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

// 静态资源 gzip 响应（R4 前端性能）：
// 嵌入的前端资产单文件最大近 1MB（naive-ui vendor ~900KB），局域网裸传是
// 首屏加载的主要瓶颈；gzip 后传输量约为 1/3。仅对静态资源路径生效
// （NoRoute 已把 /api/、/ws/ 排除），按需压缩 + 写完即弃（资产本身会被
// 浏览器缓存，重复压缩成本可忽略，不引入内存缓存复杂度）。

// gzipMinSize 低于该字节数不压缩（压缩比差还占 CPU）
const gzipMinSize = 1024

// gzipPool gzip.Writer 复用池（BestSpeed：压缩耗时可忽略，收益已足够）
var gzipPool = sync.Pool{
	New: func() any { return gzip.NewWriter(nil) },
}

// acceptsGzip 请求是否接受 gzip 编码
func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

// gzipEligible 路径是否值得压缩（文本类静态资产）
func gzipEligible(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".css", ".html", ".svg", ".json", ".txt", ".xml", ".map", ".woff", ".woff2":
		return true
	}
	return false
}

// gzipResponseWriter 包装 gin 的 ResponseWriter：首个 Write 时协商 gzip，
// 透传 Flush/WriteHeader/头部设置；小文件（< gzipMinSize）自动放弃压缩
type gzipResponseWriter struct {
	gin.ResponseWriter
	gz       *gzip.Writer
	decided  bool
	skipGzip bool
}

// decide 在真正写 body 前决策：Content-Length 小于阈值则不压缩
// （http.FileServer 会先设 Content-Length，正好用来判断）
func (w *gzipResponseWriter) decide() {
	w.decided = true
	if cl, err := strconv.ParseInt(w.Header().Get("Content-Length"), 10, 64); err == nil && cl > 0 && cl < gzipMinSize {
		w.skipGzip = true
		return
	}
	w.Header().Del("Content-Length") // 压缩后长度变化，交给 chunked
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Add("Vary", "Accept-Encoding")
	w.gz = gzipPool.Get().(*gzip.Writer)
	w.gz.Reset(w.ResponseWriter)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	if !w.decided {
		w.decide()
	}
	if w.skipGzip {
		return w.ResponseWriter.Write(b)
	}
	return w.gz.Write(b)
}

// close 收尾：flush 并归还池（defer 调用；skipGzip 时为 no-op）
func (w *gzipResponseWriter) close() {
	if w.gz == nil {
		return
	}
	_ = w.gz.Close()
	gzipPool.Put(w.gz)
	w.gz = nil
}
