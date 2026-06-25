package repository

import (
	"github.com/basketikun/infinite-canvas/model"
)

// ListModelInfos 查询模型列表，支持 keyword / type 筛选和分页。
func ListModelInfos(keyword, modelType string, page, pageSize int) ([]model.ModelInfo, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q := db.Model(&model.ModelInfo{})
	if keyword != "" {
		like := "%" + keyword + "%"
		q = q.Where("provider LIKE ? OR model LIKE ? OR display_name LIKE ?", like, like, like)
	}
	if modelType != "" {
		q = q.Where("type = ?", modelType)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 50
	}
	var items []model.ModelInfo
	if err := q.Order("sort_order ASC, id ASC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&items).Error; err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

// UpsertModelInfo 按 model 字段 upsert。model 字段是唯一索引。
func UpsertModelInfo(info *model.ModelInfo) error {
	db, err := DB()
	if err != nil {
		return err
	}
	var existing model.ModelInfo
	if db.Where("model = ?", info.Model).First(&existing).Error == nil {
		info.ID = existing.ID
		info.CreatedAt = existing.CreatedAt
	}
	return db.Save(info).Error
}

// UpdateModelInfoSort 批量更新排序值。
func UpdateModelInfoSort(orders []struct {
	ID        uint `json:"id"`
	SortOrder int  `json:"sortOrder"`
}) error {
	db, err := DB()
	if err != nil {
		return err
	}
	tx := db.Begin()
	for _, o := range orders {
		if err := tx.Model(&model.ModelInfo{}).Where("id = ?", o.ID).Update("sort_order", o.SortOrder).Error; err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit().Error
}

// ToggleModelInfo 切换模型启用状态。
func ToggleModelInfo(id uint, enabled bool) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.ModelInfo{}).Where("id = ?", id).Update("enabled", enabled).Error
}

// DeleteModelInfo 删除模型。
func DeleteModelInfo(id uint) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.ModelInfo{}, id).Error
}

// AllModelInfoModels 返回所有模型的 model 名称集合（用于去重同步）。
func AllModelInfoModels() (map[string]bool, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var models []model.ModelInfo
	if err := db.Select("model").Find(&models).Error; err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(models))
	for _, m := range models {
		result[m.Model] = true
	}
	return result, nil
}
