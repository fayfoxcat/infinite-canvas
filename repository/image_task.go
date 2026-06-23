package repository

import (
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

// CreateImageTask 创建图片生成任务。
func CreateImageTask(task *model.ImageTask) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(task).Error
}

// GetImageTaskByID 按主键查询任务。返回 (task, found, error)。
func GetImageTaskByID(id string) (model.ImageTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.ImageTask{}, false, err
	}
	var task model.ImageTask
	if err := db.Where("id = ?", id).First(&task).Error; err != nil {
		return model.ImageTask{}, false, nil
	}
	return task, true, nil
}

// UpdateImageTask 更新任务（状态、结果等）。
func UpdateImageTask(task *model.ImageTask) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Save(task).Error
}

// DeleteStaleImageTasks 删除创建时间早于 cutoff 的任务。
func DeleteStaleImageTasks(before time.Time) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	result := db.Where("created_at < ?", before.Format(time.RFC3339)).Delete(&model.ImageTask{})
	return result.RowsAffected, result.Error
}
