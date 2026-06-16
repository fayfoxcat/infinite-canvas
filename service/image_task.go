package service

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// 图片生成异步任务状态
const (
	ImageTaskStatusPending   = "pending"
	ImageTaskStatusCompleted = "completed"
	ImageTaskStatusFailed    = "failed"
)

// imageTaskTTL 任务最长保留时间，超时未领取则清理，防止内存泄漏。
const imageTaskTTL = 10 * time.Minute

// ImageTask 表示一个异步图片生成任务。Body 保存上游成功响应原文。
type ImageTask struct {
	ID        string
	Status    string
	Body      []byte
	Error     string
	CreatedAt time.Time
}

var imageTasks sync.Map // taskID -> *ImageTask

func init() {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			cutoff := time.Now().Add(-imageTaskTTL)
			imageTasks.Range(func(key, value any) bool {
				task, ok := value.(*ImageTask)
				if ok && task.CreatedAt.Before(cutoff) {
					imageTasks.Delete(key)
				}
				return true
			})
		}
	}()
}

// CreateImageTask 创建一个 pending 任务并返回任务 ID。
func CreateImageTask() string {
	id := uuid.NewString()
	imageTasks.Store(id, &ImageTask{ID: id, Status: ImageTaskStatusPending, CreatedAt: time.Now()})
	return id
}

// CompleteImageTask 标记任务完成并保存上游响应原文。
func CompleteImageTask(id string, body []byte) {
	if value, ok := imageTasks.Load(id); ok {
		if task, ok := value.(*ImageTask); ok {
			task.Body = body
			task.Status = ImageTaskStatusCompleted
		}
	}
}

// FailImageTask 标记任务失败并记录错误信息。
func FailImageTask(id string, message string) {
	if value, ok := imageTasks.Load(id); ok {
		if task, ok := value.(*ImageTask); ok {
			task.Error = message
			task.Status = ImageTaskStatusFailed
		}
	}
}

// TakeImageTask 读取任务。若任务已完成或失败，读取后立即删除（一次性领取）。
func TakeImageTask(id string) (*ImageTask, bool) {
	value, ok := imageTasks.Load(id)
	if !ok {
		return nil, false
	}
	task, ok := value.(*ImageTask)
	if !ok {
		return nil, false
	}
	if task.Status != ImageTaskStatusPending {
		imageTasks.Delete(id)
	}
	return task, true
}
