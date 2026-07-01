package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

const (
	maxConcurrentImageTasks  = 10
	imageTaskTimeout         = 5 * time.Minute
	imageTaskCleanupAge      = 24 * time.Hour
	imageTaskCleanupInterval = 1 * time.Hour
)

// 并发控制信号量。
var imageTaskSem = make(chan struct{}, maxConcurrentImageTasks)

// imageTaskHTTPClient 使用独立 DNS resolver 直连 119.29.29.29（腾讯 DNSPod），
// 避免容器继承宿主机路由器 DNS 时遭遇域名劫持（如返回 198.18.1.39 测试网段 IP）。
var imageTaskHTTPClient = &http.Client{
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
			Resolver: &net.Resolver{
				PreferGo: true,
				Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
					d := net.Dialer{Timeout: 10 * time.Second}
					// 直连 DNSPod 权威递归 DNS，不走路由器
					return d.DialContext(ctx, "udp", "119.29.29.29:53")
				},
			},
		}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 5 * time.Minute,
		IdleConnTimeout:       90 * time.Second,
	},
	Timeout: imageTaskTimeout,
}

// SubmitImageTask 创建异步图片生成任务，扣费后返回 task ID。
func SubmitImageTask(userID, modelName string, body []byte, contentType string, credits int) (string, error) {
	// 扣费
	if err := ConsumeUserCredits(userID, modelName, credits, "/images/generations"); err != nil {
		return "", err
	}

	// 创建数据库任务
	task := model.ImageTask{
		ID:          uuid.New().String(),
		UserID:      userID,
		ModelName:   modelName,
		Status:      model.ImageTaskStatusPending,
		RequestBody: string(body),
		ContentType: contentType,
		Credits:     credits,
		CreatedAt:   now(),
		UpdatedAt:   now(),
	}
	if err := repository.CreateImageTask(&task); err != nil {
		// 扣费成功但入库失败，退款
		_ = RefundUserCredits(userID, modelName, credits, "/images/generations")
		return "", err
	}

	// 由 executeImageTask 内部控制并发，避免在提交路径上抢占槽位导致泄漏。
	go executeImageTask(task.ID)

	return task.ID, nil
}

// GetImageTask 查询任务状态。
func GetImageTask(id string) (model.ImageTask, error) {
	task, ok, err := repository.GetImageTaskByID(id)
	if err != nil {
		return model.ImageTask{}, err
	}
	if !ok {
		return model.ImageTask{}, &safeMessageError{message: "任务不存在"}
	}
	return task, nil
}

// executeImageTask 在后台 goroutine 中执行图片生成。
func executeImageTask(taskID string) {
	// 获取并发槽位；池满时阻塞等待。
	select {
	case imageTaskSem <- struct{}{}:
	default:
		log.Printf("image task waiting for slot: taskID=%s", taskID)
		imageTaskSem <- struct{}{}
	}

	defer func() {
		<-imageTaskSem
		if r := recover(); r != nil {
			log.Printf("image task panic: taskID=%s panic=%v", taskID, r)
		}
	}()

	// 加载任务
	task, ok, err := repository.GetImageTaskByID(taskID)
	if err != nil || !ok {
		log.Printf("image task load failed: taskID=%s err=%v found=%v", taskID, err, ok)
		return
	}

	// 标记为运行中
	task.Status = model.ImageTaskStatusRunning
	task.UpdatedAt = now()
	_ = repository.UpdateImageTask(&task)

	t0 := time.Now()

	// 选择模型渠道
	channel, err := SelectModelChannel(task.ModelName)
	if err != nil {
		failImageTask(&task, "没有可用模型渠道", true)
		return
	}

	// 构建上游 URL
	url := BuildModelChannelURL(channel, "/images/generations")

	// 带超时的上游请求
	ctx, cancel := context.WithTimeout(context.Background(), imageTaskTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader([]byte(task.RequestBody)))
	if err != nil {
		failImageTask(&task, "构建请求失败", true)
		return
	}
	req.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if task.ContentType != "" {
		req.Header.Set("Content-Type", task.ContentType)
	}

	log.Printf("image task http start: taskID=%s url=%s", taskID, url)
	resp, err := imageTaskHTTPClient.Do(req)
	httpElapsed := time.Since(t0)
	if err != nil {
		log.Printf("image task http error: taskID=%s elapsed=%v err=%v", taskID, httpElapsed, err)
		repository.IncrementModelStats(task.ModelName, false)
		failImageTask(&task, "上游接口无响应或网络不可达", true)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	readElapsed := time.Since(t0)
	log.Printf("image task http done: taskID=%s http=%v read=%v status=%d bodyBytes=%d", taskID, httpElapsed, readElapsed, resp.StatusCode, len(body))

	if resp.StatusCode >= http.StatusBadRequest {
		detail := readUpstreamErrorDetail(body)
		msg := aiStatusMessageForCode(resp.StatusCode)
		if detail != "" {
			msg = msg + "：" + detail
		}
		repository.IncrementModelStats(task.ModelName, false)
		failImageTask(&task, msg, true)
		return
	}

	repository.IncrementModelStats(task.ModelName, true)

	// 成功：保存图片到文件系统
	resultFiles, saveErr := saveResultImages(task.ID, task.UserID, body)
	saveElapsed := time.Since(t0)
	if saveErr != nil {
		log.Printf("image task save files failed: taskID=%s elapsed=%v err=%v body=%s", taskID, saveElapsed, saveErr, logTruncateBytes(body))
		// JSON 解析失败 = 上游返回的不是有效图片响应，应视为失败
		if isJSONParseError(saveErr) {
			failImageTask(&task, "上游返回无效响应："+logTruncateBytes(body), true)
			return
		}
		// 文件写入失败：兜底存 DB
		log.Printf("image task save files failed, falling back to DB: taskID=%s elapsed=%v err=%v", taskID, saveElapsed, saveErr)
		task.ResultData = string(body)
	} else {
		filesJSON, _ := json.Marshal(resultFiles)
		task.ResultFiles = string(filesJSON)
	}
	task.Status = model.ImageTaskStatusCompleted
	task.UpdatedAt = now()
	_ = repository.UpdateImageTask(&task)
	totalElapsed := time.Since(t0)
	log.Printf("image task completed: taskID=%s total=%v http=%v save=%v db=%v", taskID, totalElapsed, httpElapsed, saveElapsed, totalElapsed-saveElapsed)
}

func failImageTask(task *model.ImageTask, errMsg string, refund bool) {
	task.Status = model.ImageTaskStatusFailed
	task.ErrorMsg = errMsg
	task.UpdatedAt = now()
	_ = repository.UpdateImageTask(task)
	if refund && task.Credits > 0 {
		_ = RefundUserCredits(task.UserID, task.ModelName, task.Credits, "/images/generations")
	}
}

const imageStorageDir = "data/images"

// saveResultImages 将上游返回的图片数据写入文件系统。
// 返回相对于 imageStorageDir 的文件路径列表。
func saveResultImages(taskID, userID string, responseBody []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return nil, err
	}
	if len(payload.Data) == 0 {
		return nil, errors.New("response contains no image data")
	}

	now := time.Now()
	dir := filepath.Join(imageStorageDir, now.Format("2006/01"), userID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}

	var files []string
	for i, item := range payload.Data {
		var imgBytes []byte

		if item.B64JSON != "" {
			var err error
			imgBytes, err = base64.StdEncoding.DecodeString(item.B64JSON)
			if err != nil {
				log.Printf("image task decode base64 failed: taskID=%s index=%d err=%v", taskID, i, err)
				continue
			}
		} else if item.URL != "" {
			resp, err := imageTaskHTTPClient.Get(item.URL)
			if err != nil {
				log.Printf("image task download url failed: taskID=%s index=%d url=%s err=%v", taskID, i, item.URL, err)
				continue
			}
			imgBytes, _ = io.ReadAll(io.LimitReader(resp.Body, 32<<20))
			resp.Body.Close()
		}

		if len(imgBytes) == 0 {
			continue
		}

		filename := fmt.Sprintf("%s-%d.png", taskID, i)
		fullPath := filepath.Join(dir, filename)
		if err := os.WriteFile(fullPath, imgBytes, 0644); err != nil {
			log.Printf("image task write file failed: path=%s err=%v", fullPath, err)
			continue
		}
		relPath := filepath.ToSlash(filepath.Join(now.Format("2006/01"), userID, filename))
		files = append(files, relPath)
	}

	if len(files) == 0 {
		return nil, errors.New("failed to save any image")
	}
	return files, nil
}

// deleteResultImageFiles 删除任务关联的图片文件。
func deleteResultImageFiles(task model.ImageTask) {
	if task.ResultFiles == "" {
		return
	}
	var paths []string
	if err := json.Unmarshal([]byte(task.ResultFiles), &paths); err != nil {
		return
	}
	for _, p := range paths {
		fullPath := filepath.Join(imageStorageDir, p)
		if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
			log.Printf("image task cleanup remove file failed: path=%s err=%v", fullPath, err)
		}
	}
}

// StartImageTaskCleaner 启动定时清理过期任务的后台协程。
func StartImageTaskCleaner() {
	go func() {
		ticker := time.NewTicker(imageTaskCleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			cutoff := time.Now().Add(-imageTaskCleanupAge)
			// 先删除过期任务的图片文件
			cleanupStaleImageFiles(cutoff)
			// 再删除数据库记录
			deleted, err := repository.DeleteStaleImageTasks(cutoff)
			if err != nil {
				log.Printf("image task cleaner error: %v", err)
			} else if deleted > 0 {
				log.Printf("image task cleaner: deleted %d stale tasks", deleted)
			}
		}
	}()
}

// cleanupStaleImageFiles 删除过期任务关联的图片文件。
func cleanupStaleImageFiles(cutoff time.Time) {
	db, err := repository.DB()
	if err != nil {
		return
	}
	var tasks []model.ImageTask
	db.Where("created_at < ? AND result_files != ''", cutoff.Format(time.RFC3339)).Find(&tasks)
	for _, task := range tasks {
		deleteResultImageFiles(task)
	}
}

func aiStatusMessageForCode(statusCode int) string {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "AI 接口鉴权失败，请检查 API Key、套餐权限或模型权限"
	case http.StatusTooManyRequests:
		return "AI 接口限流或额度不足，请稍后重试或检查额度"
	default:
		return "AI 接口请求失败"
	}
}

func logTruncateBytes(body []byte) string {
	text := strings.Join(strings.Fields(strings.TrimSpace(string(body))), " ")
	runes := []rune(text)
	if len(runes) > 200 {
		return string(runes[:200]) + "..."
	}
	return text
}

func isJSONParseError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "json") || strings.Contains(msg, "JSON") || strings.Contains(msg, "unexpected end")
}

func readUpstreamErrorDetail(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var payload struct {
		Msg     string `json:"msg"`
		Message string `json:"message"`
		Error   struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		if payload.Error.Message != "" {
			if payload.Error.Code != "" {
				return strings.Join(strings.Fields(payload.Error.Code+" "+payload.Error.Message), " ")
			}
			return strings.Join(strings.Fields(payload.Error.Message), " ")
		}
		if payload.Msg != "" {
			return strings.Join(strings.Fields(payload.Msg), " ")
		}
		if payload.Message != "" {
			return strings.Join(strings.Fields(payload.Message), " ")
		}
	}
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300]) + "..."
	}
	return text
}
