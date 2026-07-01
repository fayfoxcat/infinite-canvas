package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

var adminModelHTTPClient = &http.Client{Timeout: 30 * time.Second}

const modelSelectionSeparator = "::"

func PublicSettings() (model.PublicSetting, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.PublicSetting{}, err
	}
	return applyModelInfos(normalizeSettings(settings)).Public, nil
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.Settings{}, err
	}
	return hidePrivateAPIKeys(applyModelInfos(normalizeSettings(settings))), nil
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	saved, err := repository.GetSettings()
	if err != nil {
		return model.Settings{}, err
	}
	settings = normalizeSettings(settings)
	keepPrivateAPIKeys(&settings, normalizeSettings(saved))
	keepPrivateAuthSecrets(&settings, normalizeSettings(saved))
	totalChannels, enabledChannels, enabledModels := modelChannelLogStats(settings.Private.Channels)
	log.Printf("admin settings save: channels=%d enabledChannels=%d enabledModels=%d", totalChannels, enabledChannels, enabledModels)
	result, err := repository.SaveSettings(settings, now())
	if err == nil {
		RefreshPromptSyncScheduler()
		// 同步写回模型类型规则文件
		_ = saveModelTypeRulesToFile(settings.Public.ModelChannel.ModelTypeRules)
	}
	if err != nil {
		return hidePrivateAPIKeys(result), err
	}
	return hidePrivateAPIKeys(applyModelInfos(normalizeSettings(result))), nil
}

func AdminChannelModels(index *int, channel model.ModelChannel) ([]string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return nil, err
	}
	return fetchAdminChannelModels(resolved)
}

var modelTypeRulesSeeded bool

func normalizeSettings(settings model.Settings) model.Settings {
	settings.Private = normalizePrivateSetting(settings.Private)
	settings.Public = normalizePublicSettingWithChannels(settings.Public, settings.Private.Channels)

	// 首次从文件种入默认规则后，自动持久化到 DB
	if !modelTypeRulesSeeded && hasModelTypeRules(settings.Public.ModelChannel.ModelTypeRules) {
		modelTypeRulesSeeded = true
		go func(rules model.ModelTypeRules) {
			if s, err := repository.GetSettings(); err == nil {
				s.Public.ModelChannel.ModelTypeRules = rules
				if _, err := repository.SaveSettings(s, now()); err == nil {
					log.Println("model type rules seeded from file into database")
				}
			}
		}(settings.Public.ModelChannel.ModelTypeRules)
	}

	return settings
}

func hasModelTypeRules(rules model.ModelTypeRules) bool {
	return rules.TextModels != "" || rules.ImageModels != "" || rules.VideoModels != "" || rules.AudioModels != ""
}

func normalizePublicSetting(setting model.PublicSetting) model.PublicSetting {
	return normalizePublicSettingWithChannels(setting, nil)
}

func normalizePublicSettingWithChannels(setting model.PublicSetting, channels []model.ModelChannel) model.PublicSetting {
	if setting.ModelChannel.AvailableModels == nil {
		setting.ModelChannel.AvailableModels = []string{}
	}
	if setting.ModelChannel.ModelInfos == nil {
		setting.ModelChannel.ModelInfos = []model.PublicModelInfo{}
	}
	if setting.ModelChannel.ModelCosts == nil {
		setting.ModelChannel.ModelCosts = []model.ModelCost{}
	}
	for i := range setting.ModelChannel.ModelCosts {
		setting.ModelChannel.ModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.ModelCosts[i].Model)
		if setting.ModelChannel.ModelCosts[i].Credits < 0 {
			setting.ModelChannel.ModelCosts[i].Credits = 0
		}
	}
	if setting.ModelChannel.AllowCustomChannel == nil {
		enabled := true
		setting.ModelChannel.AllowCustomChannel = &enabled
	}
	if setting.Auth.AllowRegister == nil {
		enabled := true
		setting.Auth.AllowRegister = &enabled
	}
	// 若 DB 中规则为空且配置文件存在，则从文件种入默认规则
	seedModelTypeRulesFromFile(&setting.ModelChannel.ModelTypeRules)

	// 刷新全局模型类型规则缓存
	refreshModelTypeRulesCache(setting.ModelChannel.ModelTypeRules)

	enabledModels := enabledChannelModels(channels)
	if len(enabledModels) > 0 {
		setting.ModelChannel.AvailableModels = enabledModels
	} else {
		setting.ModelChannel.AvailableModels = uniqueModelNames(setting.ModelChannel.AvailableModels)
	}
	imageModels := collectChannelModelsByCapability(channels, "image")
	videoModels := collectChannelModelsByCapability(channels, "video")
	textModels := collectChannelModelsByCapability(channels, "text")
	audioModels := collectChannelModelsByCapability(channels, "audio")

	// 暴露分类结果给前端
	setting.ModelChannel.TextModels = textModels
	setting.ModelChannel.ImageModels = imageModels
	setting.ModelChannel.VideoModels = videoModels
	setting.ModelChannel.AudioModels = audioModels

	setting.ModelChannel.DefaultImageModel = repairDefaultModel(setting.ModelChannel.DefaultImageModel, imageModels, nil)
	setting.ModelChannel.DefaultVideoModel = repairDefaultModel(setting.ModelChannel.DefaultVideoModel, videoModels, nil)
	setting.ModelChannel.DefaultTextModel = repairDefaultModel(setting.ModelChannel.DefaultTextModel, textModels, nil)
	setting.ModelChannel.DefaultAudioModel = repairDefaultModel(setting.ModelChannel.DefaultAudioModel, audioModels, nil)
	setting.ModelChannel.DefaultModel = repairDefaultModel(setting.ModelChannel.DefaultModel, setting.ModelChannel.AvailableModels, func(modelName string) bool {
		return containsString(setting.ModelChannel.TextModels, modelName)
	})
	return setting
}

func applyModelInfos(settings model.Settings) model.Settings {
	settings.Public = applyModelInfosToPublicSetting(settings.Public, settings.Private.Channels)
	return settings
}

type publicModelOption struct {
	Value    string
	Provider string
	Model    string
	Info     model.ModelInfo
	HasInfo  bool
	Types    []string
}

func applyModelInfosToPublicSetting(setting model.PublicSetting, channels []model.ModelChannel) model.PublicSetting {
	channelModels := enabledChannelModels(channels)
	if len(channelModels) == 0 {
		setting.ModelChannel.ModelInfos = []model.PublicModelInfo{}
		return setting
	}
	infos, err := repository.ListModelInfosByModels(channelModels)
	if err != nil {
		log.Printf("load model infos failed: %v", err)
		return setting
	}

	infoByKey := modelInfoByProviderModel(infos)
	options := []publicModelOption{}
	seenOptions := map[string]bool{}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		provider := modelChannelProvider(channel)
		for _, item := range channel.Models {
			modelName := strings.TrimSpace(item)
			if modelName == "" {
				continue
			}
			info, hasInfo := infoByKey[modelInfoKey(provider, modelName)]
			if hasInfo && !info.Enabled {
				continue
			}
			value := ModelSelectionValue(provider, modelName)
			if seenOptions[value] {
				continue
			}
			seenOptions[value] = true
			types := modelInfoTypes(info)
			if len(types) == 0 {
				types = classifyModelByChannel(modelName, channel)
			}
			if len(types) == 0 {
				types = []string{heuristicModelType(modelName)}
			}
			options = append(options, publicModelOption{
				Value:    value,
				Provider: provider,
				Model:    modelName,
				Info:     info,
				HasInfo:  hasInfo,
				Types:    types,
			})
		}
	}
	sort.SliceStable(options, func(i, j int) bool {
		left, right := options[i], options[j]
		if left.HasInfo && right.HasInfo {
			if left.Info.SortOrder != right.Info.SortOrder {
				return left.Info.SortOrder < right.Info.SortOrder
			}
			return left.Info.ID < right.Info.ID
		}
		return left.HasInfo && !right.HasInfo
	})

	setting.ModelChannel.AvailableModels = publicModelOptionValues(options)
	setting.ModelChannel.ModelInfos = publicModelInfosFromOptions(options)
	setting.ModelChannel.TextModels = collectPublicModelOptionsByCapability(options, "text")
	setting.ModelChannel.ImageModels = collectPublicModelOptionsByCapability(options, "image")
	setting.ModelChannel.VideoModels = collectPublicModelOptionsByCapability(options, "video")
	setting.ModelChannel.AudioModels = collectPublicModelOptionsByCapability(options, "audio")
	setting.ModelChannel.DefaultImageModel = repairDefaultModel(setting.ModelChannel.DefaultImageModel, setting.ModelChannel.ImageModels, nil)
	setting.ModelChannel.DefaultVideoModel = repairDefaultModel(setting.ModelChannel.DefaultVideoModel, setting.ModelChannel.VideoModels, nil)
	setting.ModelChannel.DefaultTextModel = repairDefaultModel(setting.ModelChannel.DefaultTextModel, setting.ModelChannel.TextModels, nil)
	setting.ModelChannel.DefaultAudioModel = repairDefaultModel(setting.ModelChannel.DefaultAudioModel, setting.ModelChannel.AudioModels, nil)
	setting.ModelChannel.DefaultModel = repairDefaultModel(setting.ModelChannel.DefaultModel, setting.ModelChannel.AvailableModels, func(modelName string) bool {
		return containsString(setting.ModelChannel.TextModels, modelName)
	})
	return setting
}

func ModelCost(modelSelection string) (int, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, err
	}
	modelSelection = strings.TrimSpace(modelSelection)
	rawModelName := ModelNameFromSelection(modelSelection)
	modelCosts := normalizePublicSetting(settings.Public).ModelChannel.ModelCosts
	for _, item := range modelCosts {
		if item.Model == modelSelection {
			return item.Credits, nil
		}
	}
	if rawModelName != modelSelection {
		for _, item := range modelCosts {
			if item.Model == rawModelName {
				return item.Credits, nil
			}
		}
	}
	return 0, nil
}

func normalizePrivateSetting(setting model.PrivateSetting) model.PrivateSetting {
	if setting.Channels == nil {
		setting.Channels = []model.ModelChannel{}
	}
	setting.PromptSync = normalizePromptSyncSetting(setting.PromptSync)
	for i := range setting.Channels {
		if setting.Channels[i].Protocol == "" {
			setting.Channels[i].Protocol = "openai"
		}
		if setting.Channels[i].Models == nil {
			setting.Channels[i].Models = []string{}
		}
		if setting.Channels[i].Weight <= 0 {
			setting.Channels[i].Weight = 1
		}
		// 校验 Type 值，非法值清空走自动检测
		t := strings.ToLower(strings.TrimSpace(setting.Channels[i].Type))
		if t != "" && t != "text" && t != "image" && t != "video" && t != "audio" {
			setting.Channels[i].Type = ""
		}
	}
	return setting
}

func hidePrivateAPIKeys(settings model.Settings) model.Settings {
	for i := range settings.Private.Channels {
		settings.Private.Channels[i].APIKey = ""
	}
	settings.Private.Auth.LinuxDo.ClientSecret = ""
	return settings
}

func keepPrivateAPIKeys(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Channels {
		if strings.TrimSpace(settings.Private.Channels[i].APIKey) != "" {
			continue
		}
		if channel, ok := findSavedChannel(settings.Private.Channels[i], saved.Private.Channels, i); ok {
			settings.Private.Channels[i].APIKey = channel.APIKey
		}
	}
}

func keepPrivateAuthSecrets(settings *model.Settings, saved model.Settings) {
	if strings.TrimSpace(settings.Private.Auth.LinuxDo.ClientSecret) == "" {
		settings.Private.Auth.LinuxDo.ClientSecret = saved.Private.Auth.LinuxDo.ClientSecret
	}
}

func findSavedChannel(channel model.ModelChannel, saved []model.ModelChannel, index int) (model.ModelChannel, bool) {
	for _, item := range saved {
		if item.Name == channel.Name && item.BaseURL == channel.BaseURL {
			return item, true
		}
	}
	if index >= 0 && index < len(saved) {
		return saved[index], true
	}
	return model.ModelChannel{}, false
}

func SelectModelChannel(modelSelection string) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	channels, err := modelChannelsForModel(normalizePrivateSetting(settings.Private).Channels, modelSelection)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if len(channels) == 0 {
		providerFilter, modelName := ParseModelSelection(modelSelection)
		if providerFilter != "" {
			return model.ModelChannel{}, safeMessageError{message: fmt.Sprintf("未找到服务商 %q 的模型 %q，请确认已配置该服务商的渠道且渠道包含此模型", providerFilter, modelName)}
		}
		return model.ModelChannel{}, safeMessageError{message: fmt.Sprintf("未找到可用模型渠道：模型 %q 不属于任何已启用的渠道", modelSelection)}
	}
	total := 0
	for _, channel := range channels {
		total += channel.Weight
	}
	hit := rand.Intn(total)
	for _, channel := range channels {
		hit -= channel.Weight
		if hit < 0 {
			return channel, nil
		}
	}
	return channels[0], nil
}

func BuildModelChannelURL(channel model.ModelChannel, path string) string {
	baseURL := normalizeModelChannelBaseURL(channel.BaseURL)
	lowerBaseURL := strings.ToLower(baseURL)
	if !strings.HasSuffix(lowerBaseURL, "/v1") && !strings.HasSuffix(lowerBaseURL, "/api/v3") && !strings.HasSuffix(lowerBaseURL, "/api/plan/v3") {
		baseURL += "/v1"
	}
	return baseURL + path
}

func normalizeModelChannelBaseURL(baseURL string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		path := strings.TrimRight(parsed.Path, "/")
		lowerPath := strings.ToLower(path)
		if index := strings.Index(lowerPath, "/api/plan/v3"); index >= 0 {
			end := index + len("/api/plan/v3")
			if len(lowerPath) == end || lowerPath[end] == '/' {
				parsed.Path = path[:end]
				parsed.RawPath = ""
				parsed.RawQuery = ""
				parsed.Fragment = ""
				return strings.TrimRight(parsed.String(), "/")
			}
		}
	}
	return baseURL
}

func isArkAgentPlanChannel(channel model.ModelChannel) bool {
	baseURL := strings.ToLower(normalizeModelChannelBaseURL(channel.BaseURL))
	return strings.HasSuffix(baseURL, "/api/plan/v3")
}

func enabledChannelModels(channels []model.ModelChannel) []string {
	models := []string{}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		models = append(models, channel.Models...)
	}
	return uniqueModelNames(models)
}

func uniqueModelNames(models []string) []string {
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

func repairDefaultModel(current string, models []string, preferred func(string) bool) string {
	current = strings.TrimSpace(current)
	for _, item := range models {
		if item == current {
			return current
		}
	}
	if preferred != nil {
		for _, item := range models {
			if preferred(item) {
				return item
			}
		}
	}
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

func isVideoModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "seedance") || strings.Contains(name, "video")
}

func isImageModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "seedream") || strings.Contains(name, "gpt-image") || strings.Contains(name, "image")
}

func isTextModelName(modelName string) bool {
	return !isImageModelName(modelName) && !isVideoModelName(modelName) && !isAudioModelName(modelName)
}

func isAudioModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "audio") ||
		strings.Contains(name, "tts") ||
		strings.Contains(name, "speech") ||
		strings.Contains(name, "voice") ||
		strings.Contains(name, "music") ||
		strings.Contains(name, "sound")
}

// classifyModelByChannel 根据渠道 Type、全局规则和启发式确定模型支持的类型列表。
// 返回多个类型表示多模态模型（如 gpt-4o 既是 text 也是 image）。
func classifyModelByChannel(modelName string, channel model.ModelChannel) []string {
	// 1. 渠道显式 Type 优先级最高
	if ct := channelModelType(channel); ct != "" {
		return []string{ct}
	}
	// 2. 全局模型类型规则
	cachedRulesMu.RLock()
	rules := cachedModelTypeRules
	cachedRulesMu.RUnlock()
	if types := matchModelTypeRules(modelName, rules); len(types) > 0 {
		return types
	}
	// 3. 关键词启发式兜底
	return []string{heuristicModelType(modelName)}
}

// heuristicModelType 根据模型名关键词推断单一类型。
func heuristicModelType(modelName string) string {
	if isImageModelName(modelName) {
		return "image"
	}
	if isVideoModelName(modelName) {
		return "video"
	}
	if isAudioModelName(modelName) {
		return "audio"
	}
	return "text"
}

// channelModelType 返回渠道的显式类型（空字符串表示未设置）。
func channelModelType(channel model.ModelChannel) string {
	switch strings.ToLower(strings.TrimSpace(channel.Type)) {
	case "text", "image", "video", "audio":
		return strings.ToLower(strings.TrimSpace(channel.Type))
	default:
		return ""
	}
}

// collectChannelModelsByCapability 从渠道列表中收集指定能力类型的模型名。
func collectChannelModelsByCapability(channels []model.ModelChannel, capability string) []string {
	result := []string{}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		for _, modelName := range channel.Models {
			for _, t := range classifyModelByChannel(modelName, channel) {
				if t == capability {
					result = append(result, strings.TrimSpace(modelName))
					break
				}
			}
		}
	}
	return uniqueModelNames(result)
}

func modelInfoByProviderModel(infos []model.ModelInfo) map[string]model.ModelInfo {
	result := map[string]model.ModelInfo{}
	for _, info := range infos {
		result[modelInfoKey(info.Provider, info.Model)] = info
	}
	return result
}

func modelChannelProvider(channel model.ModelChannel) string {
	provider := strings.TrimSpace(channel.Name)
	if provider == "" {
		provider = strings.TrimSpace(channel.BaseURL)
	}
	return provider
}

func modelInfoKey(provider string, modelName string) string {
	return strings.TrimSpace(provider) + "\x00" + strings.TrimSpace(modelName)
}

func ModelSelectionValue(provider string, modelName string) string {
	provider = strings.TrimSpace(provider)
	modelName = strings.TrimSpace(modelName)
	if provider == "" {
		return modelName
	}
	return provider + modelSelectionSeparator + modelName
}

func ParseModelSelection(value string) (string, string) {
	value = strings.TrimSpace(value)
	index := strings.Index(value, modelSelectionSeparator)
	if index <= 0 || index+len(modelSelectionSeparator) >= len(value) {
		return "", value
	}
	return strings.TrimSpace(value[:index]), strings.TrimSpace(value[index+len(modelSelectionSeparator):])
}

func ModelNameFromSelection(value string) string {
	_, modelName := ParseModelSelection(value)
	return modelName
}

func publicModelOptionValues(options []publicModelOption) []string {
	result := make([]string, 0, len(options))
	for _, item := range options {
		result = append(result, item.Value)
	}
	return result
}

func publicModelInfosFromOptions(options []publicModelOption) []model.PublicModelInfo {
	result := make([]model.PublicModelInfo, 0, len(options))
	for _, item := range options {
		displayName := item.Model
		maxSize := ""
		if item.HasInfo {
			displayName = strings.TrimSpace(item.Info.DisplayName)
			maxSize = strings.TrimSpace(item.Info.MaxSize)
			if displayName == "" {
				displayName = item.Model
			}
		}
		result = append(result, model.PublicModelInfo{
			Value:       item.Value,
			Provider:    item.Provider,
			Model:       item.Model,
			DisplayName: displayName,
			Type:        strings.Join(item.Types, ","),
			MaxSize:     maxSize,
		})
	}
	return result
}

func collectPublicModelOptionsByCapability(options []publicModelOption, capability string) []string {
	result := []string{}
	for _, item := range options {
		if containsString(item.Types, capability) {
			result = append(result, item.Value)
		}
	}
	return result
}

func modelInfoTypes(info model.ModelInfo) []string {
	result := []string{}
	for _, item := range strings.Split(info.Type, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if (item == "text" || item == "image" || item == "video" || item == "audio") && !containsString(result, item) {
			result = append(result, item)
		}
	}
	return result
}

func containsString(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

// --- 全局模型类型规则匹配 ---

var (
	cachedModelTypeRules model.ModelTypeRules
	cachedRulesMu        sync.RWMutex
)

// refreshModelTypeRulesCache 在加载 settings 后刷新缓存的类型规则。
func refreshModelTypeRulesCache(rules model.ModelTypeRules) {
	cachedRulesMu.Lock()
	cachedModelTypeRules = rules
	cachedRulesMu.Unlock()
}

// --- 模型类型规则文件持久化 ---

// seedModelTypeRulesFromFile 若 DB 中规则全空，从配置文件种入默认值。
func seedModelTypeRulesFromFile(rules *model.ModelTypeRules) {
	if rules.TextModels != "" || rules.ImageModels != "" || rules.VideoModels != "" || rules.AudioModels != "" {
		return // 已有用户配置，不覆盖
	}
	fromFile, err := loadModelTypeRulesFromFile()
	if err != nil {
		return
	}
	*rules = fromFile
}

// loadModelTypeRulesFromFile 从配置文件中读取模型类型规则。
func loadModelTypeRulesFromFile() (model.ModelTypeRules, error) {
	path := config.Cfg.ModelTypeRulesFile
	if path == "" {
		return model.ModelTypeRules{}, errors.New("MODEL_TYPE_RULES_FILE not configured")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return model.ModelTypeRules{}, err
	}
	var rules model.ModelTypeRules
	if err := json.Unmarshal(data, &rules); err != nil {
		return model.ModelTypeRules{}, err
	}
	return rules, nil
}

// saveModelTypeRulesToFile 将模型类型规则持久化到配置文件。
func saveModelTypeRulesToFile(rules model.ModelTypeRules) error {
	path := config.Cfg.ModelTypeRulesFile
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(rules, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

// matchModelTypeRules 检查模型名是否匹配全局类型规则，返回所有匹配的类型。
func matchModelTypeRules(modelName string, rules model.ModelTypeRules) []string {
	var types []string
	if matchAnyPattern(modelName, rules.TextModels) {
		types = append(types, "text")
	}
	if matchAnyPattern(modelName, rules.ImageModels) {
		types = append(types, "image")
	}
	if matchAnyPattern(modelName, rules.VideoModels) {
		types = append(types, "video")
	}
	if matchAnyPattern(modelName, rules.AudioModels) {
		types = append(types, "audio")
	}
	return types
}

// matchAnyPattern 检查模型名是否匹配任意一行模式。
// 支持：精确匹配、glob (* ?)、/regex/ 语法。
func matchAnyPattern(modelName string, patternsText string) bool {
	modelName = strings.TrimSpace(modelName)
	if modelName == "" || strings.TrimSpace(patternsText) == "" {
		return false
	}
	for _, pattern := range strings.Split(patternsText, "\n") {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" {
			continue
		}
		if matchSinglePattern(modelName, pattern) {
			return true
		}
	}
	return false
}

// matchSinglePattern 检查模型名是否匹配单个模式。
func matchSinglePattern(modelName string, pattern string) bool {
	// /regex/ 语法
	if len(pattern) >= 2 && pattern[0] == '/' && pattern[len(pattern)-1] == '/' {
		re, err := regexp.Compile(pattern[1 : len(pattern)-1])
		if err != nil {
			return false
		}
		return re.MatchString(modelName)
	}
	// glob (* → .* , ? → .) 或精确匹配
	return globMatch(modelName, pattern)
}

// globMatch 简易 glob 匹配，支持 * 和 ? 通配符。
func globMatch(s, pattern string) bool {
	// 无通配符 → 精确匹配
	if !strings.ContainsAny(pattern, "*?") {
		return strings.EqualFold(s, pattern)
	}
	// 转义正则特殊字符，然后把 * → .* 和 ? → .
	escaped := regexp.QuoteMeta(pattern)
	escaped = strings.ReplaceAll(escaped, `\*`, ".*")
	escaped = strings.ReplaceAll(escaped, `\?`, ".")
	re, err := regexp.Compile("(?i)^" + escaped + "$")
	if err != nil {
		return false
	}
	return re.MatchString(s)
}

func normalizeModelChannel(channel model.ModelChannel) model.ModelChannel {
	if channel.Protocol == "" {
		channel.Protocol = "openai"
	}
	if channel.Models == nil {
		channel.Models = []string{}
	}
	if channel.Weight <= 0 {
		channel.Weight = 1
	}
	return channel
}

func resolveAdminChannel(index *int, channel model.ModelChannel) (model.ModelChannel, error) {
	resolved := normalizeModelChannel(channel)
	if strings.TrimSpace(resolved.APIKey) == "" {
		settings, err := repository.GetSettings()
		if err != nil {
			return model.ModelChannel{}, err
		}
		saved := normalizePrivateSetting(settings.Private).Channels
		if index != nil && *index >= 0 && *index < len(saved) {
			if resolved.APIKey == "" {
				resolved.APIKey = saved[*index].APIKey
			}
			if resolved.BaseURL == "" {
				resolved.BaseURL = saved[*index].BaseURL
			}
			if resolved.Name == "" {
				resolved.Name = saved[*index].Name
			}
		}
		if resolved.APIKey == "" {
			if savedChannel, ok := findSavedChannel(resolved, saved, -1); ok {
				resolved.APIKey = savedChannel.APIKey
			}
		}
	}
	if strings.TrimSpace(resolved.BaseURL) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(resolved.APIKey) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少 API Key"}
	}
	return resolved, nil
}

func fetchAdminChannelModels(channel model.ModelChannel) ([]string, error) {
	request, err := http.NewRequest(http.MethodGet, BuildModelChannelURL(channel, "/models"), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "读取模型失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		if response.StatusCode == http.StatusNotFound && isArkAgentPlanChannel(channel) {
			return nil, safeMessageError{message: "火山方舟 Agent Plan 未提供 OpenAI /models 模型列表接口，请手动填写模型名称，例如 doubao-seedance-2.0。"}
		}
		return nil, readAdminChannelError(body, response.StatusCode, "读取模型失败")
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &payload)
	result := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if strings.TrimSpace(item.ID) != "" {
			result = append(result, item.ID)
		}
	}
	sort.Strings(result)
	return result, nil
}

func readAdminChannelError(body []byte, statusCode int, fallback string) error {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return safeMessageError{message: payload.Error.Message}
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return safeMessageError{message: payload.Msg}
		}
	}
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return safeMessageError{message: fmt.Sprintf("上游接口鉴权失败（%d），请检查 API Key、套餐权限或模型权限", statusCode)}
	}
	if statusCode == http.StatusTooManyRequests {
		return safeMessageError{message: "上游接口限流或额度不足（429），请稍后重试或检查额度"}
	}
	if statusCode > 0 {
		return safeMessageError{message: fmt.Sprintf("%s：%d", fallback, statusCode)}
	}
	return safeMessageError{message: fallback}
}

type safeMessageError struct {
	message string
}

func (err safeMessageError) Error() string {
	return err.message
}

func (err safeMessageError) SafeMessage() string {
	return err.message
}

func modelChannelsForModel(channels []model.ModelChannel, modelSelection string) ([]model.ModelChannel, error) {
	providerFilter, modelName := ParseModelSelection(modelSelection)
	infos, err := repository.ListModelInfosByModels([]string{modelName})
	if err != nil {
		return nil, err
	}
	infoByKey := modelInfoByProviderModel(infos)
	result := []model.ModelChannel{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" || channel.APIKey == "" {
			continue
		}
		provider := modelChannelProvider(channel)
		if providerFilter != "" && provider != providerFilter {
			continue
		}
		for _, item := range channel.Models {
			if strings.TrimSpace(item) == modelName {
				if info, ok := infoByKey[modelInfoKey(provider, modelName)]; ok && !info.Enabled {
					break
				}
				result = append(result, channel)
				break
			}
		}
	}
	return result, nil
}

// SyncModelInfos 从渠道模型列表同步到 model_infos 表。
// 新模型自动创建，已存在的模型保留用户编辑的元数据。
func SyncModelInfos(channels []model.ModelChannel) (int, error) {
	existingModels, err := repository.AllModelInfoKeys()
	if err != nil {
		return 0, err
	}
	minSortOrder, err := repository.MinModelInfoSortOrder()
	if err != nil {
		return 0, err
	}
	totalChannels, enabledChannels, enabledModels := modelChannelLogStats(channels)
	log.Printf("admin model sync start: channels=%d enabledChannels=%d enabledModels=%d existingModels=%d minSortOrder=%d", totalChannels, enabledChannels, enabledModels, len(existingModels), minSortOrder)

	synced := 0
	skippedDisabledChannels := 0
	skippedExisting := 0
	skippedEmpty := 0
	createdModels := []string{}
	existingPreview := []string{}
	nextSortOrder := minSortOrder
	for _, ch := range channels {
		if !ch.Enabled {
			skippedDisabledChannels++
			continue
		}
		provider := modelChannelProvider(ch)
		for _, modelName := range ch.Models {
			modelName = strings.TrimSpace(modelName)
			if modelName == "" {
				skippedEmpty++
				continue
			}
			key := modelInfoKey(provider, modelName)
			if existingModels[key] {
				skippedExisting++
				if len(existingPreview) < 8 {
					existingPreview = append(existingPreview, provider+"/"+modelName)
				}
				continue // 已存在，保留用户编辑
			}
			nextSortOrder--
			types := classifyModelByChannel(modelName, ch)
			modelType := "text"
			if len(types) > 0 {
				modelType = strings.Join(types, ",")
			}
			info := model.ModelInfo{
				Provider:    provider,
				Model:       modelName,
				DisplayName: modelName,
				Type:        modelType,
				MaxSize:     "",
				SortOrder:   nextSortOrder,
				Enabled:     true,
			}
			if err := repository.UpsertModelInfo(&info); err != nil {
				return synced, err
			}
			existingModels[key] = true
			createdModels = append(createdModels, provider+"/"+modelName)
			synced++
		}
	}
	log.Printf("admin model sync done: created=%d skippedExisting=%d skippedEmpty=%d skippedDisabledChannels=%d createdModels=%v existingPreview=%v", synced, skippedExisting, skippedEmpty, skippedDisabledChannels, previewStrings(createdModels, 8), existingPreview)
	return synced, nil
}

func modelChannelLogStats(channels []model.ModelChannel) (int, int, int) {
	enabledChannels := 0
	enabledModels := 0
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		enabledChannels++
		for _, modelName := range channel.Models {
			if strings.TrimSpace(modelName) != "" {
				enabledModels++
			}
		}
	}
	return len(channels), enabledChannels, enabledModels
}

func previewStrings(items []string, limit int) []string {
	if len(items) <= limit {
		return items
	}
	result := append([]string{}, items[:limit]...)
	result = append(result, fmt.Sprintf("... +%d", len(items)-limit))
	return result
}
