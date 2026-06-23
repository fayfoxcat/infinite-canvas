package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
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

// SubmitImageTask 创建异步图片生成任务，扣费后返回 task ID。
// 如果并发池已满则返回错误。
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

	// 尝试获取并发槽位
	select {
	case imageTaskSem <- struct{}{}:
		go executeImageTask(task.ID)
	default:
		// 并发池满，不是严重错误，任务已创建为 pending
		// 后续轮询会发现任务仍在 pending 并重试
		go executeImageTask(task.ID)
	}

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
	// 确保信号量槽位释放
	acquired := false
	select {
	case imageTaskSem <- struct{}{}:
		acquired = true
	default:
		// 未获取到槽位，等待
		imageTaskSem <- struct{}{}
		acquired = true
	}
	if !acquired {
		return
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
		return
	}

	// 标记为运行中
	task.Status = model.ImageTaskStatusRunning
	task.UpdatedAt = now()
	_ = repository.UpdateImageTask(&task)

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

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		failImageTask(&task, "上游接口无响应或网络不可达", true)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= http.StatusBadRequest {
		detail := readUpstreamErrorDetail(body)
		msg := aiStatusMessageForCode(resp.StatusCode)
		if detail != "" {
			msg = msg + "：" + detail
		}
		failImageTask(&task, msg, true)
		return
	}

	// 成功：存储结果
	task.Status = model.ImageTaskStatusCompleted
	task.ResultData = string(body)
	task.UpdatedAt = now()
	_ = repository.UpdateImageTask(&task)
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

// StartImageTaskCleaner 启动定时清理过期任务的后台协程。
func StartImageTaskCleaner() {
	go func() {
		ticker := time.NewTicker(imageTaskCleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			cutoff := time.Now().Add(-imageTaskCleanupAge)
			deleted, err := repository.DeleteStaleImageTasks(cutoff)
			if err != nil {
				log.Printf("image task cleaner error: %v", err)
			} else if deleted > 0 {
				log.Printf("image task cleaner: deleted %d stale tasks", deleted)
			}
		}
	}()
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
