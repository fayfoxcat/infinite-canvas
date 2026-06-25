package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

type adminChannelActionRequest struct {
	Index   *int               `json:"index"`
	Channel model.ModelChannel `json:"channel"`
	Model   string             `json:"model"`
}

func Settings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.PublicSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.Settings
	_ = json.NewDecoder(r.Body).Decode(&settings)
	result, err := service.SaveSettings(settings)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminChannelModels(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	models, err := service.AdminChannelModels(request.Index, request.Channel)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, models)
}

func AdminTestChannelModel(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	result, err := service.AdminTestChannelModel(request.Index, request.Channel, request.Model)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// --- 模型管理 ---

type modelListQuery struct {
	Keyword  string `json:"keyword"`
	Type     string `json:"type"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

type modelSortRequest struct {
	Orders []struct {
		ID        uint `json:"id"`
		SortOrder int  `json:"sortOrder"`
	} `json:"orders"`
}

func AdminModels(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	keyword := q.Get("keyword")
	modelType := q.Get("type")
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 50
	}
	items, total, err := repository.ListModelInfos(keyword, modelType, page, pageSize)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": items, "total": total})
}

func AdminSaveModel(w http.ResponseWriter, r *http.Request) {
	var info model.ModelInfo
	if err := json.NewDecoder(r.Body).Decode(&info); err != nil {
		Fail(w, "请求格式错误")
		return
	}
	if err := repository.UpsertModelInfo(&info); err != nil {
		FailError(w, err)
		return
	}
	OK(w, info)
}

func AdminUpdateModelSort(w http.ResponseWriter, r *http.Request) {
	var req modelSortRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, "请求格式错误")
		return
	}
	if err := repository.UpdateModelInfoSort(req.Orders); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminToggleModel(w http.ResponseWriter, r *http.Request, id string) {
	uid, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		Fail(w, "ID 格式错误")
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := repository.ToggleModelInfo(uint(uid), body.Enabled); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminDeleteModel(w http.ResponseWriter, r *http.Request, id string) {
	uid, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		Fail(w, "ID 格式错误")
		return
	}
	if err := repository.DeleteModelInfo(uint(uid)); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminSyncModels(w http.ResponseWriter, r *http.Request) {
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	syncCount, err := service.SyncModelInfos(settings.Private.Channels)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]int{"synced": syncCount})
}
