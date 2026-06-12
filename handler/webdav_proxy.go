package handler

import (
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const webdavProxyTimeout = 120 * time.Second

// WebDAVProxy 代理 WebDAV 请求，用于绕过浏览器 CORS 限制。
// 前端通过 POST /webdav-proxy 传入目标地址和方法，由后端转发 WebDAV 请求。
func WebDAVProxy(w http.ResponseWriter, r *http.Request) {
	target := r.Header.Get("X-Webdav-Target")
	method := strings.ToUpper(r.Header.Get("X-Webdav-Method"))
	if target == "" {
		http.Error(w, "Missing X-Webdav-Target", http.StatusBadRequest)
		return
	}
	if method == "" {
		method = "GET"
	}

	client := &http.Client{Timeout: webdavProxyTimeout}

	var body io.Reader
	if method != "GET" && method != "HEAD" {
		body = r.Body
	}

	req, err := http.NewRequestWithContext(r.Context(), method, target, body)
	if err != nil {
		http.Error(w, "Invalid WebDAV target", http.StatusBadRequest)
		return
	}

	copyProxyHeader(r.Header, req.Header, "X-Webdav-Authorization", "Authorization")
	copyProxyHeader(r.Header, req.Header, "X-Webdav-Depth", "Depth")
	copyProxyHeader(r.Header, req.Header, "X-Webdav-Destination", "Destination")
	copyProxyHeader(r.Header, req.Header, "X-Webdav-Overwrite", "Overwrite")
	copyProxyHeader(r.Header, req.Header, "X-Webdav-Content-Type", "Content-Type")

	log.Printf("[webdav-proxy] %s %s", method, target)

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[webdav-proxy] %s %s -> error: %v", method, target, err)
		http.Error(w, "WebDAV proxy error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	log.Printf("[webdav-proxy] %s %s -> %d", method, target, resp.StatusCode)

	dest := w.Header()
	for _, key := range []string{"Content-Type", "ETag", "Last-Modified", "DAV"} {
		if values := resp.Header.Values(key); len(values) > 0 {
			for _, v := range values {
				dest.Add(key, v)
			}
		}
	}
	w.WriteHeader(resp.StatusCode)
	if method != "HEAD" {
		io.Copy(w, resp.Body)
	}
}

func copyProxyHeader(src http.Header, dst http.Header, srcKey string, dstKey string) {
	if value := src.Get(srcKey); value != "" {
		dst.Set(dstKey, value)
	}
}
