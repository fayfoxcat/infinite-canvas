package model

// ImageTask 异步图片生成任务。后端接收请求后立即创建任务并返回 task ID，
// 由后台 goroutine 调用上游 AI 接口，客户端轮询 GET 接口获取状态和结果。
// 用于绕过 Cloudflare 100 秒代理超时限制。
type ImageTask struct {
	ID          string `json:"id" gorm:"primaryKey"`
	UserID      string `json:"userId" gorm:"index"`
	ModelName   string `json:"modelName"`
	Status      string `json:"status"` // pending, running, completed, failed
	RequestBody string `json:"-" gorm:"type:text"`
	ContentType string `json:"-"`
	ResultData  string `json:"resultData,omitempty" gorm:"type:text"`
	ResultFiles string `json:"resultFiles,omitempty" gorm:"type:text"` // JSON array of relative file paths under data/images/
	ErrorMsg    string `json:"errorMsg,omitempty" gorm:"type:text"`
	Credits     int    `json:"credits"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

const (
	ImageTaskStatusPending   = "pending"
	ImageTaskStatusRunning   = "running"
	ImageTaskStatusCompleted = "completed"
	ImageTaskStatusFailed    = "failed"
)
