package repository

import (
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListModelInfos 查询模型列表，支持 keyword / type 筛选和分页。
func ListModelInfos(keyword, modelType string, page, pageSize int) ([]model.ModelInfo, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q := db.Model(&model.ModelInfo{})
	keyword = strings.TrimSpace(keyword)
	if keyword != "" {
		like := "%" + keyword + "%"
		q = q.Where("provider LIKE ? OR model LIKE ? OR display_name LIKE ?", like, like, like)
	}
	modelType = strings.ToLower(strings.TrimSpace(modelType))
	if modelType != "" {
		normalizedType := "LOWER(REPLACE(type, ' ', ''))"
		q = q.Where(normalizedType+" = ? OR "+normalizedType+" LIKE ? OR "+normalizedType+" LIKE ? OR "+normalizedType+" LIKE ?", modelType, modelType+",%", "%,"+modelType, "%,"+modelType+",%")
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

func ListModelInfosByModels(models []string) ([]model.ModelInfo, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	models = compactModelInfoNames(models)
	if len(models) == 0 {
		return []model.ModelInfo{}, nil
	}
	var items []model.ModelInfo
	if err := db.Where("model IN ?", models).Order("sort_order ASC, id ASC").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

func GetModelInfoByProviderModel(provider string, modelName string) (model.ModelInfo, bool, error) {
	db, err := DB()
	if err != nil {
		return model.ModelInfo{}, false, err
	}
	var item model.ModelInfo
	if err := db.Where("provider = ? AND model = ?", strings.TrimSpace(provider), strings.TrimSpace(modelName)).Limit(1).Find(&item).Error; err != nil {
		return model.ModelInfo{}, false, err
	}
	return item, item.ID > 0, nil
}

// UpsertModelInfo 按 provider + model 字段 upsert。
func UpsertModelInfo(info *model.ModelInfo) error {
	db, err := DB()
	if err != nil {
		return err
	}
	normalizeModelInfo(info)
	if info.Provider == "" {
		return errors.New("服务商不能为空")
	}
	if info.Model == "" {
		return errors.New("模型名称不能为空")
	}
	var existing model.ModelInfo
	if info.ID > 0 {
		if err := db.Where("provider = ? AND model = ? AND id <> ?", info.Provider, info.Model, info.ID).Limit(1).Find(&existing).Error; err != nil {
			return err
		}
		if existing.ID > 0 {
			return errors.New("同一服务商下模型名称不能重复")
		}
	} else {
		if err := db.Where("provider = ? AND model = ?", info.Provider, info.Model).Limit(1).Find(&existing).Error; err != nil {
			return err
		}
		if existing.ID > 0 {
			info.ID = existing.ID
			info.CreatedAt = existing.CreatedAt
		}
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

// AllModelInfoKeys 返回所有模型的 provider + model 集合（用于去重同步）。
func AllModelInfoKeys() (map[string]bool, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var models []model.ModelInfo
	if err := db.Select("provider", "model").Find(&models).Error; err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(models))
	for _, m := range models {
		result[modelInfoKey(m.Provider, m.Model)] = true
	}
	return result, nil
}

func MinModelInfoSortOrder() (int, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var minSort int
	if err := db.Model(&model.ModelInfo{}).Select("COALESCE(MIN(sort_order), 0)").Scan(&minSort).Error; err != nil {
		return 0, err
	}
	return minSort, nil
}

func compactModelInfoNames(models []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, item := range models {
		name := strings.TrimSpace(item)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, name)
	}
	return result
}

func normalizeModelInfo(info *model.ModelInfo) {
	info.Provider = strings.TrimSpace(info.Provider)
	info.Model = strings.TrimSpace(info.Model)
	info.DisplayName = strings.TrimSpace(info.DisplayName)
	if info.DisplayName == "" {
		info.DisplayName = info.Model
	}
	info.Type = normalizeModelInfoTypes(info.Type)
	info.MaxSize = strings.TrimSpace(info.MaxSize)
}

func modelInfoKey(provider string, modelName string) string {
	return strings.TrimSpace(provider) + "\x00" + strings.TrimSpace(modelName)
}

func normalizeModelInfoTypes(value string) string {
	result := []string{}
	for _, item := range strings.Split(strings.ToLower(value), ",") {
		item = strings.TrimSpace(item)
		if item == "" || (item != "text" && item != "image" && item != "video" && item != "audio") {
			continue
		}
		exists := false
		for _, current := range result {
			if current == item {
				exists = true
				break
			}
		}
		if !exists {
			result = append(result, item)
		}
	}
	if len(result) == 0 {
		return "text"
	}
	return strings.Join(result, ",")
}

// IncrementModelStats 递增模型的调用次数，成功时也递增成功次数。
func IncrementModelStats(modelName string, success bool) error {
	db, err := DB()
	if err != nil {
		return err
	}
	modelName = strings.TrimSpace(modelName)
	if modelName == "" {
		return nil
	}
	updates := map[string]interface{}{
		"call_count": gorm.Expr("call_count + 1"),
	}
	if success {
		updates["success_count"] = gorm.Expr("success_count + 1")
	}
	result := db.Model(&model.ModelInfo{}).Where("model = ?", modelName).UpdateColumns(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		// modelName 可能是 "provider::model" 格式，尝试提取纯模型名
		if _, rawName := parseModelSelection(modelName); rawName != modelName {
			return db.Model(&model.ModelInfo{}).Where("model = ?", rawName).UpdateColumns(updates).Error
		}
	}
	return nil
}

// parseModelSelection 分离 provider::model 格式。
func parseModelSelection(value string) (string, string) {
	value = strings.TrimSpace(value)
	const sep = "::"
	index := strings.Index(value, sep)
	if index <= 0 || index+len(sep) >= len(value) {
		return "", value
	}
	return strings.TrimSpace(value[:index]), strings.TrimSpace(value[index+len(sep):])
}
