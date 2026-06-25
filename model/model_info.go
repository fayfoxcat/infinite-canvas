package model

// ModelInfo 模型元数据，从渠道模型聚合而来，支持独立编辑显示名称、类型、尺寸限制等。
type ModelInfo struct {
	ID           uint   `json:"id" gorm:"primaryKey;autoIncrement"`
	Provider     string `json:"provider"`                    // 服务商
	Model        string `json:"model" gorm:"uniqueIndex"`    // 模型名（唯一）
	DisplayName  string `json:"displayName"`                 // 显示名称
	Type         string `json:"type"`                        // text / image / video / audio
	MaxSize      string `json:"maxSize"`                     // 图片模型最大尺寸，非图片为 "-"
	CallCount    int64  `json:"callCount"`                   // 调用次数
	SuccessCount int64  `json:"successCount"`                // 成功次数
	SortOrder    int    `json:"sortOrder" gorm:"default:0"`  // 排序
	Enabled      bool   `json:"enabled" gorm:"default:true"` // 启用
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}
