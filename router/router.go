package router

import (
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/middleware"
	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)

	// CORS middleware
	router.Use(func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin == "" {
			origin = "*"
		}

		// Handle OPTIONS preflight
		if c.Request.Method == "OPTIONS" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization,Content-Type,access-token,x-webdav-target,x-webdav-method,x-webdav-authorization,x-webdav-depth,x-webdav-destination,x-webdav-overwrite,x-webdav-content-type")
			c.Header("Access-Control-Expose-Headers", "Content-Type,ETag,Last-Modified,DAV")
			c.AbortWithStatus(204)
			return
		}

		// Set CORS headers before request processing
		// This ensures headers are present even if upstream One API fails to add them
		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		c.Header("Access-Control-Expose-Headers", "Content-Type,ETag,Last-Modified,DAV")

		c.Next()

		// For /api/v1/* routes, the upstream (One API) copies its own CORS
		// headers into the response. If a duplicate Access-Control-Allow-Origin
		// is detected, keep only Go's specific origin (first value) — "*" from
		// the upstream is invalid for credentialed requests with Authorization.
		if strings.HasPrefix(c.Request.URL.Path, "/api/v1/") {
			headers := c.Writer.Header()
			allowOriginValues := headers.Values("Access-Control-Allow-Origin")
			if len(allowOriginValues) > 1 {
				headers.Del("Access-Control-Allow-Origin")
				headers.Set("Access-Control-Allow-Origin", allowOriginValues[0])
			}
		}
	})

	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", gin.WrapF(handler.Register))
	api.POST("/auth/login", gin.WrapF(handler.Login))
	api.GET("/auth/linux-do/authorize", gin.WrapF(handler.LinuxDoAuthorize))
	api.GET("/auth/linux-do/callback", gin.WrapF(handler.LinuxDoCallback))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", gin.WrapF(handler.Settings))
	api.GET("/media/references/:id", func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	api.HEAD("/media/references/:id", func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	// 图片生成结果文件下载（无需认证，路径含 UUID 不可猜测）
	api.GET("/media/generations/*filepath", func(c *gin.Context) {
		handler.ServeGenerationImage(c.Writer, c.Request)
	})
	v1 := api.Group("/v1", middleware.UserAuth)
	v1.POST("/images/generations", gin.WrapF(handler.AIImagesGenerations))
	v1.GET("/images/generations/:id", func(c *gin.Context) {
		handler.AIImageGenerationTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/images/generations/:id/result", func(c *gin.Context) {
		handler.AIImageGenerationResult(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/images/edits", gin.WrapF(handler.AIImagesEdits))
	v1.POST("/chat/completions", gin.WrapF(handler.AIChatCompletions))
	v1.POST("/audio/speech", gin.WrapF(handler.AIAudioSpeech))
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.POST("/media/references", gin.WrapF(handler.UploadReferenceMedia))
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.POST("/admin/login", gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/settings/channel-models", gin.WrapF(handler.AdminChannelModels))
	admin.POST("/settings/channel-test", gin.WrapF(handler.AdminTestChannelModel))
		admin.GET("/models", gin.WrapF(handler.AdminModels))
		admin.POST("/models", gin.WrapF(handler.AdminSaveModel))
		admin.PUT("/models/sort", gin.WrapF(handler.AdminUpdateModelSort))
		admin.PUT("/models/:id/toggle", func(c *gin.Context) {
			handler.AdminToggleModel(c.Writer, c.Request, c.Param("id"))
		})
		admin.DELETE("/models/:id", func(c *gin.Context) {
			handler.AdminDeleteModel(c.Writer, c.Request, c.Param("id"))
		})
		admin.POST("/models/sync", gin.WrapF(handler.AdminSyncModels))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})

	// WebDAV proxy
	router.POST("/webdav-proxy", gin.WrapF(handler.WebDAVProxy))

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
