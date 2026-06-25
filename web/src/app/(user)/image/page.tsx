"use client";

import { BookOpen, CheckSquare, ChevronDown, Download, FolderPlus, History, ImagePlus, LoaderCircle, Minus, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Drawer, Image, Input, Modal, Popover, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { ImageSettingsPanel, imageResolutionLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import type { ReferenceImage } from "@/types/image";
import { inferImageResolutionFromSize } from "@/lib/image-size";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    startedAt?: number;
    image?: GeneratedImage;
    error?: string;
};

type ConversationTurn = {
    id: string;
    prompt: string;
    model: string;
    mode: GenerationMode;
    references: ReferenceImage[];
    results: GenerationResult[];
    createdAt: number;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    imageResolution: string;
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
    turns: ConversationTurn[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "imageResolution" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type GenerationMode = "text" | "image";
type LogFilter = "all" | GenerationMode;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
type ViewportSize = { width: number; height: number };

export default function ImagePage() {
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const conversationViewportRef = useRef<HTMLDivElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [generationMode, setGenerationMode] = useState<GenerationMode>("text");
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [nowTick, setNowTick] = useState(Date.now());
    const [conversationViewportSize, setConversationViewportSize] = useState<ViewportSize>({ width: 0, height: 0 });
    const [draggingReferenceId, setDraggingReferenceId] = useState<string | null>(null);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => {
        void refreshLogs(true);
    }, []);

    useEffect(() => {
        if (!conversationTurns.some((turn) => turn.results.some((result) => result.status === "pending"))) return;
        const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [conversationTurns]);

    useEffect(() => {
        const element = conversationViewportRef.current;
        if (!element) return;
        const updateSize = () => {
            const rect = element.getBoundingClientRect();
            setConversationViewportSize({ width: rect.width, height: rect.height });
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
        if (nextReferences.length) setGenerationMode("image");
    };

    const handlePromptPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const imageFiles = Array.from(event.clipboardData.files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        event.preventDefault();
        void addReferences(event.clipboardData.files);
    };

    const handlePromptDrop = (event: ReactDragEvent<HTMLElement>) => {
        event.preventDefault();
        void addReferences(event.dataTransfer.files);
    };

    const generate = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;

        setRunning(true);
        setPreviewLog(null);
        const conversationId = activeConversationId || previewLog?.id || nanoid();
        const baseTurns = conversationTurns;
        const turnId = nanoid();
        const pendingStartedAt = Date.now();
        const pendingResults = Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" as const, startedAt: pendingStartedAt }));
        const pendingTurn: ConversationTurn = {
            id: turnId,
            prompt: text,
            model,
            mode: generationMode,
            references: snapshot.references,
            results: pendingResults,
            createdAt: pendingStartedAt,
        };
        setActiveConversationId(conversationId);
        setConversationTurns([...baseTurns, pendingTurn]);
        setPrompt("");
        setReferences([]);
        const batchStartedAt = performance.now();

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(turnId, index, snapshot));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");

        try {
            const logImages = await Promise.all(
                successImages.map(async (image) => {
                    const stored = await uploadImage(image.dataUrl);
                    return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                }),
            );
            let successImageIndex = 0;
            const completedTurn: ConversationTurn = {
                ...pendingTurn,
                results: result.map((item, index) =>
                    item.status === "fulfilled"
                        ? { id: pendingResults[index].id, status: "success", image: logImages[successImageIndex++] }
                        : { id: pendingResults[index].id, status: "failed", error: item.reason instanceof Error ? item.reason.message : "生成失败" },
                ),
            };
            const nextTurns = [...baseTurns, completedTurn];
            setConversationTurns(nextTurns);
            saveLog(
                buildLog({
                    id: conversationId,
                    config: { ...snapshot.config, count: String(generationCount) },
                    fallbackDurationMs: performance.now() - batchStartedAt,
                    turns: nextTurns,
                }),
            );
            successCount ? message.success("图片已生成") : message.error(failed?.reason instanceof Error ? failed.reason.message : "生成失败");
        } finally {
            setRunning(false);
        }
    };

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        setGenerationMode("image");
        message.success("已加入参考图");
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number, promptText: string) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt: promptText },
        });
        message.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
            setGenerationMode("image");
        } else {
            message.warning("生图工作台只能使用文本或图片素材");
        }
        setAssetPickerOpen(false);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(() => refreshLogs());
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setConversationTurns([]);
        }
        if (activeConversationId && selectedLogIds.includes(activeConversationId)) {
            setActiveConversationId(null);
            setConversationTurns([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const startNewConversation = () => {
        setActiveConversationId(null);
        setPreviewLog(null);
        setConversationTurns([]);
        setPrompt("");
        setReferences([]);
        setGenerationMode("text");
        setSelectedLogIds([]);
        setLogsOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(() => refreshLogs());
    };

    const refreshLogs = async (restoreLatest = false) => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        if (restoreLatest && nextLogs[0]) restoreGenerationLog(nextLogs[0], false);
    };

    const restoreGenerationLog = (log: GenerationLog, refillPrompt: boolean) => {
        setPreviewLog(log);
        setActiveConversationId(log.id);
        setPrompt(refillPrompt ? log.prompt : "");
        const restoredReferences = refillPrompt ? log.references || [] : [];
        setReferences(restoredReferences);
        setGenerationMode(restoredReferences.length ? "image" : "text");
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.imageResolution) updateConfig("imageResolution", log.config.imageResolution);
        if (log.config.count) updateConfig("count", log.config.count);
        setConversationTurns(log.turns);
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        restoreGenerationLog(log, true);
        setLogsOpen(false);
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        if (generationMode === "image" && !references.length) {
            message.error("请先添加参考图");
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: generationMode === "image" ? [...references] : [] };
    };

    const runGenerationSlot = async (turnId: string, index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references) : await requestGeneration(snapshot.config, snapshot.text);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl) };
            setConversationTurns((value) => updateTurnResultAt(value, turnId, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            setConversationTurns((value) => updateTurnResultAt(value, turnId, index, { status: "failed", error: error instanceof Error ? error.message : "生成失败" }));
            throw error;
        }
    };

    const retryResult = (turnId: string, index: number) => {
        const turn = conversationTurns.find((item) => item.id === turnId);
        if (!turn) return;
        if (!isAiConfigReady(effectiveConfig, turn.model || model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }
        const snapshot = { text: turn.prompt, config: { ...effectiveConfig, model: turn.model || model, count: "1" }, references: turn.mode === "image" ? turn.references : [] };
        setPreviewLog(null);
        setConversationTurns((value) => updateTurnResultAt(value, turnId, index, { status: "pending", startedAt: Date.now(), error: undefined, image: undefined }));
        void runGenerationSlot(turnId, index, snapshot).catch(() => {});
    };

    const referencesScrollable = references.length > 6;
    const moveReferenceTo = (sourceId: string | null, targetId: string) => {
        if (!sourceId || sourceId === targetId) return;
        setReferences((value) => moveListItemTo(value, sourceId, targetId));
        setDraggingReferenceId(null);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background p-4 sm:p-5">
                <div className="grid h-full min-h-[720px] gap-4 xl:min-h-0 xl:grid-cols-[400px_minmax(0,1fr)]">
                    <aside className="hidden min-h-0 overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-sm xl:block">
                        <LogPanel
                            logs={logs}
                            selectedLogIds={selectedLogIds}
                            activeLogId={activeConversationId || previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onNewConversation={startNewConversation}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                        />
                    </aside>
                    <section className="flex min-h-0 flex-col gap-3">
                        <section className="flex min-h-[380px] flex-1 flex-col rounded-2xl border border-border bg-card p-3">
                            <div className="mb-2 flex justify-end">
                                <div className="flex shrink-0 gap-2 xl:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        记录
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        参数
                                    </Button>
                                </div>
                            </div>
                            <div ref={conversationViewportRef} className="min-h-0 flex-1 overflow-hidden">
                                {conversationTurns.length ? (
                                    <div className="thin-scrollbar flex h-full flex-col gap-4 overflow-y-auto p-4">
                                        {conversationTurns.map((turn) => (
                                            <ConversationTurnCard
                                                key={turn.id}
                                                turn={turn}
                                                onRetry={retryResult}
                                                onEdit={addResultToReferences}
                                                onDownload={downloadImage}
                                                onSaveAsset={saveResultToAssets}
                                                now={nowTick}
                                                viewportSize={conversationViewportSize}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                                        <ImagePlus className="size-8" />
                                        <span>发送要求后会在这里生成对话图片</span>
                                    </div>
                                )}
                            </div>
                        </section>

                        <section className="shrink-0 rounded-2xl border border-border bg-card p-3 shadow-sm" onDragOver={(event) => event.preventDefault()} onDrop={handlePromptDrop}>
                            <div className="flex gap-3">
                                <div className="relative h-28 w-28 shrink-0">
                                    <button
                                        type="button"
                                        className="absolute left-4 top-2 flex h-24 w-16 -rotate-3 items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-muted/40 text-muted-foreground transition hover:border-zinc-400 hover:bg-muted hover:text-foreground dark:hover:border-zinc-500"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        {references[0] ? <img src={references[0].dataUrl} alt={references[0].name} className="size-full object-cover" /> : <ImagePlus className="size-5" />}
                                    </button>
                                    {references.length ? <span className="absolute bottom-2 right-2 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">{references.length} 张</span> : null}
                                </div>
                                <Input.TextArea
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    onPaste={handlePromptPaste}
                                    rows={4}
                                    placeholder="描述、拖入、粘贴你想生成或编辑的图片，例如：一张电影感的人像海报，暖色霓虹灯，浅景深"
                                    className="!min-h-[112px] flex-1 resize-none !border-0 !bg-transparent !px-1 !py-1 !text-sm !text-foreground !shadow-none placeholder:!text-muted-foreground focus:!shadow-none"
                                />
                            </div>

                            {references.length ? (
                                <div
                                    className={`${referencesScrollable ? "hover-scrollbar hover-scrollbar-hint flex-nowrap overflow-x-auto" : "flex-wrap overflow-x-hidden"} mt-3 flex gap-2 pb-1`}
                                    onWheel={(event) => {
                                        if (!referencesScrollable || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    <Image.PreviewGroup>
                                        {references.map((item, index) => (
                                            <div
                                                key={item.id}
                                                draggable
                                                className={`group relative size-16 shrink-0 cursor-grab overflow-hidden rounded-lg border bg-muted/40 active:cursor-grabbing [&_.ant-image]:block [&_.ant-image]:overflow-hidden [&_.ant-image]:rounded-lg [&_.ant-image-img]:rounded-lg [&_.ant-image-mask]:rounded-lg ${draggingReferenceId === item.id ? "border-emerald-300 opacity-60" : "border-border"}`}
                                                onDragStart={(event) => {
                                                    setDraggingReferenceId(item.id);
                                                    event.dataTransfer.effectAllowed = "move";
                                                    event.dataTransfer.setData("text/plain", item.id);
                                                }}
                                                onDragOver={(event) => {
                                                    if (!draggingReferenceId || draggingReferenceId === item.id) return;
                                                    event.preventDefault();
                                                    event.dataTransfer.dropEffect = "move";
                                                }}
                                                onDrop={(event) => {
                                                    event.preventDefault();
                                                    moveReferenceTo(event.dataTransfer.getData("text/plain") || draggingReferenceId, item.id);
                                                }}
                                                onDragEnd={() => setDraggingReferenceId(null)}
                                            >
                                                <Image src={item.dataUrl} alt={item.name} width={64} height={64} className="!h-16 !w-16 !object-cover" />
                                                <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                                <button
                                                    type="button"
                                                    className="absolute right-1 top-1 z-20 hidden size-5 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        setReferences((value) => value.filter((ref) => ref.id !== item.id));
                                                    }}
                                                    aria-label="移除参考图"
                                                >
                                                    <Trash2 className="size-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </Image.PreviewGroup>
                                    <button type="button" className="grid size-16 shrink-0 place-items-center rounded-lg border border-dashed border-border bg-muted/40 text-muted-foreground transition hover:border-zinc-400 hover:bg-muted hover:text-foreground dark:hover:border-zinc-500" onClick={() => fileInputRef.current?.click()}>
                                        <Upload className="size-4" />
                                    </button>
                                </div>
                            ) : null}

                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                <ModeSwitch
                                    value={generationMode}
                                    onChange={(nextMode) => {
                                        setGenerationMode(nextMode);
                                        if (nextMode === "image" && !references.length) fileInputRef.current?.click();
                                    }}
                                />
                                <ModelPicker config={effectiveConfig} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" className="!h-9 min-w-[10rem] !rounded-xl !border-border !bg-muted/40 !text-xs !shadow-none" onMissingConfig={() => openConfigDialog(false)} />
                                <Button className="!h-9 !rounded-xl !border-border !bg-muted/40 !px-3 !text-xs !font-medium !text-foreground !shadow-none hover:!bg-muted" icon={<BookOpen className="size-4" />} onClick={() => setPromptDialogOpen(true)}>
                                    提示词库
                                </Button>
                                <Button className="!h-9 !rounded-xl !border-border !bg-muted/40 !px-3 !text-xs !font-medium !text-foreground !shadow-none hover:!bg-muted" icon={<FolderPlus className="size-4" />} onClick={() => setAssetPickerOpen(true)}>
                                    素材库
                                </Button>
                                <Popover
                                    trigger="click"
                                    placement="topLeft"
                                    content={
                                        <div className="w-[360px] max-w-[calc(100vw-40px)]">
                                            <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} showModel={false} />
                                        </div>
                                    }
                                >
                                    <Button className="!h-9 !rounded-xl !border-border !bg-muted/40 !px-3 !text-xs !font-medium !text-foreground !shadow-none hover:!bg-muted" icon={<SlidersHorizontal className="size-4" />}>
                                        {imageToolbarSizeLabel(effectiveConfig.size)}
                                        <span className="ml-1 text-muted-foreground">{imageResolutionLabel(effectiveConfig.imageResolution)}</span>
                                        <ChevronDown className="ml-1 size-3.5" />
                                    </Button>
                                </Popover>
                                <GenerationCountInput value={effectiveConfig.count} onChange={(value) => updateConfig("count", value)} />
                                <div className="ml-auto flex flex-wrap items-center gap-2">
                                    <Button className="!h-9 !rounded-xl !bg-foreground !px-4 !text-sm !font-medium !text-background disabled:!bg-muted disabled:!text-muted-foreground" icon={<Sparkles className="size-4" />} loading={running} disabled={running} onClick={() => void generate()}>
                                        {generationMode === "image" ? "编辑" : "生成"}
                                    </Button>
                                </div>
                            </div>
                        </section>
                    </section>

                </div>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={activeConversationId || previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onNewConversation={startNewConversation}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

function GenerationSettings({
    config,
    model,
    updateConfig,
    openConfigDialog,
    showModel = true,
}: {
    config: AiConfig;
    model: string;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    showModel?: boolean;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            {showModel ? (
                <label className="col-span-2 block min-w-0 sm:col-span-1">
                    <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                    <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
                </label>
            ) : null}
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} showCount={false} />
            </div>
        </>
    );
}

function ModeSwitch({ value, onChange }: { value: GenerationMode; onChange: (value: GenerationMode) => void }) {
    return (
        <div className="flex h-9 rounded-xl border border-border bg-muted/40 p-0.5">
            {[
                { value: "text" as const, label: "文生图" },
                { value: "image" as const, label: "图生图" },
            ].map((item) => (
                <button
                    key={item.value}
                    type="button"
                    className={`h-8 rounded-lg px-3 text-xs font-medium leading-8 transition ${value === item.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => onChange(item.value)}
                >
                    {item.label}
                </button>
            ))}
        </div>
    );
}

function GenerationCountInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const count = normalizeGenerationCount(value);
    const commit = (input: HTMLInputElement) => {
        const next = Math.max(1, Math.min(10, Math.floor(Number(input.value) || 1)));
        onChange(String(next));
    };
    const step = (offset: number) => onChange(String(Math.max(1, Math.min(10, count + offset))));

    return (
        <div className="inline-flex h-9 items-center overflow-hidden rounded-xl border border-border bg-muted/40 text-xs font-medium leading-none text-foreground shadow-none">
            <button type="button" className="grid h-full w-8 place-items-center text-muted-foreground transition hover:bg-card hover:text-foreground disabled:opacity-35" disabled={count <= 1} onClick={() => step(-1)} aria-label="减少生成张数">
                <Minus className="size-3.5" />
            </button>
            <label className="flex h-full items-center gap-1 border-x border-border px-2">
                <span className="shrink-0 text-muted-foreground">张数</span>
                <input
                    className="w-7 bg-transparent text-center text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    inputMode="numeric"
                    value={value || "1"}
                    onChange={(event) => {
                        const next = event.target.value.replace(/\D/g, "").slice(0, 2);
                        onChange(next ? String(Math.max(1, Math.min(10, Number(next)))) : "1");
                    }}
                    onBlur={(event) => commit(event.currentTarget)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                    }}
                />
            </label>
            <button type="button" className="grid h-full w-8 place-items-center text-muted-foreground transition hover:bg-card hover:text-foreground disabled:opacity-35" disabled={count >= 10} onClick={() => step(1)} aria-label="增加生成张数">
                <Plus className="size-3.5" />
            </button>
        </div>
    );
}

function normalizeGenerationCount(value: string) {
    return Math.max(1, Math.min(10, Math.floor(Number(value) || 1)));
}

function imageToolbarSizeLabel(size: string) {
    return size === "auto" ? "自动比例" : imageSizeLabel(size || "auto");
}

function ConversationTurnCard({
    turn,
    onRetry,
    onEdit,
    onDownload,
    onSaveAsset,
    now,
    viewportSize,
}: {
    turn: ConversationTurn;
    onRetry: (turnId: string, index: number) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number, prompt: string) => void;
    now: number;
    viewportSize: ViewportSize;
}) {
    return (
        <article className="space-y-3">
            <div className="mb-3 ml-auto w-fit max-w-[75%] rounded-2xl border border-border bg-muted/30 px-4 py-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
                    <span>{turn.mode === "image" ? "图生图" : "文生图"}</span>
                    <span>{turn.model}</span>
                </div>
                <Typography.Paragraph className="!mb-0 whitespace-pre-wrap !text-sm !leading-6 !text-foreground">{turn.prompt}</Typography.Paragraph>
                {turn.references.length ? (
                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                        <Image.PreviewGroup>
                            {turn.references.map((reference, refIndex) => (
                                <div key={reference.id} className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-muted/40 [&_.ant-image]:block [&_.ant-image]:overflow-hidden [&_.ant-image]:rounded-lg [&_.ant-image-img]:rounded-lg [&_.ant-image-mask]:rounded-lg">
                                    <Image src={reference.dataUrl} alt={reference.name} width={48} height={48} className="!h-12 !w-12 !object-cover" />
                                    <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-medium text-white">{imageReferenceLabel(refIndex)}</span>
                                </div>
                            ))}
                        </Image.PreviewGroup>
                    </div>
                ) : null}
            </div>
            <div className="inline-flex max-w-[80%] rounded-2xl border border-border bg-muted/20 p-3">
                <Image.PreviewGroup>
                    <div className="flex w-fit max-w-full flex-wrap gap-4">
                        {turn.results.map((result, resultIndex) =>
                            result.status === "success" && result.image ? (
                                <ResultImageCard key={result.id} image={result.image} index={resultIndex} model={turn.model} viewportSize={viewportSize} onEdit={onEdit} onDownload={onDownload} onSaveAsset={(image, itemIndex) => onSaveAsset(image, itemIndex, turn.prompt)} />
                            ) : result.status === "failed" ? (
                                <FailedImageCard key={result.id} error={result.error || "生成失败"} onRetry={() => onRetry(turn.id, resultIndex)} />
                            ) : (
                                <PendingImageCard key={result.id} startedAt={result.startedAt || turn.createdAt} now={now} viewportSize={viewportSize} />
                            ),
                        )}
                    </div>
                </Image.PreviewGroup>
            </div>
        </article>
    );
}

function ResultImageCard({
    image,
    index,
    model,
    viewportSize,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    model: string;
    viewportSize: ViewportSize;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const cardSize = getResultCardSize(image, viewportSize);

    return (
        <div className="min-w-0 max-w-full" style={{ width: cardSize.width }}>
            <div className="overflow-hidden rounded-xl bg-muted/40 [&_.ant-image]:block [&_.ant-image]:overflow-hidden [&_.ant-image]:rounded-xl [&_.ant-image-img]:rounded-xl [&_.ant-image-mask]:rounded-xl">
                <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="w-full object-contain" />
            </div>
            <div className="mt-2 space-y-2">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate text-foreground/70">{model}</span>
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title="添加到素材">
                        <Button className={`${RESULT_ACTION_BUTTON_CLASS} !rounded-lg !border-border`} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            添加到素材
                        </Button>
                    </Tooltip>
                    <Tooltip title="加入参考图">
                        <Button className={`${RESULT_ACTION_BUTTON_CLASS} !rounded-lg !border-border`} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            加入参考图
                        </Button>
                    </Tooltip>
                    <Tooltip title="下载">
                        <Button className={`${RESULT_ACTION_BUTTON_CLASS} !rounded-lg !border-border`} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            下载
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ startedAt, now, viewportSize }: { startedAt?: number; now: number; viewportSize: ViewportSize }) {
    const waitMs = startedAt ? Math.max(0, now - startedAt) : 0;
    const size = getPendingCardSize(viewportSize);
    return (
        <div className="relative aspect-square max-w-full overflow-hidden rounded-xl bg-muted/40" style={{ width: size }}>
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(161,161,170,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
                <span className="text-xs">等待 {formatDuration(waitMs)}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="w-72 max-w-full overflow-hidden rounded-xl bg-red-50 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end p-3">
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
        </div>
    );
}

function getResultCardSize(image: GeneratedImage, viewportSize: ViewportSize) {
    const maxWidth = Math.max(220, viewportSize.width ? viewportSize.width * 0.8 : 430);
    const maxHeight = Math.max(220, viewportSize.height ? viewportSize.height * 0.8 : 430);
    const width = image.width || 1024;
    const height = image.height || 1024;
    const scale = Math.min(maxWidth / width, maxHeight / height);
    return { width: Math.max(220, Math.round(width * scale)) };
}

function getPendingCardSize(viewportSize: ViewportSize) {
    const maxWidth = Math.max(220, viewportSize.width ? viewportSize.width * 0.8 : 288);
    const maxHeight = Math.max(220, viewportSize.height ? viewportSize.height * 0.8 : 288);
    return Math.round(Math.min(maxWidth, maxHeight));
}

function updateTurnResultAt(turns: ConversationTurn[], turnId: string, index: number, next: Partial<GenerationResult>) {
    return turns.map((turn) => (turn.id === turnId ? { ...turn, results: turn.results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item)) } : turn));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onNewConversation,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onNewConversation: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const [filter, setFilter] = useState<LogFilter>("all");
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));
    const filteredLogs = logs.filter((log) => {
        const hasImageTurn = log.turns.some((turn) => turn.references.length > 0);
        return filter === "all" || (filter === "image" ? hasImageTurn : !hasImageTurn);
    });

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold text-foreground">历史记录</h2>
                </div>
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onNewConversation}>
                    新建对话
                </Button>
            </div>
            <div className="mb-4 flex gap-2">
                {[
                    { value: "all" as const, label: "全部" },
                    { value: "text" as const, label: "文生图" },
                    { value: "image" as const, label: "图生图" },
                ].map((item) => (
                    <button
                        key={item.value}
                        type="button"
                        className={`h-8 rounded-lg border px-3 text-xs font-medium transition ${filter === item.value ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300" : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                        onClick={() => setFilter(item.value)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
            {selectedLogIds.length ? (
                <div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <span className="mr-auto">已选 {selectedLogIds.length} 条</span>
                    <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                        {allSelected ? "取消" : "全选"}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDeleteSelected}>
                        删除
                    </Button>
                </div>
            ) : null}
            <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
                {filteredLogs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!filteredLogs.length ? <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">暂无历史记录</div> : null}
            </div>
        </div>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 4);
    const modeLabel = log.turns.some((turn) => turn.references.length > 0) ? "图生图" : "文生图";

    return (
        <button
            type="button"
            className={`block w-full rounded-xl border p-3 text-left transition ${active ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30" : "border-border bg-card hover:bg-muted/50"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5 text-foreground">{log.title}</div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                            <span>{modeLabel}</span>
                            <span>{log.turns.length} 轮</span>
                            <span>{log.time}</span>
                        </div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    <img key={`${log.id}-${index}`} src={image} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1 text-[11px] text-muted-foreground">
                    <span className="rounded-md bg-muted px-1.5 py-1">成功 {log.successCount ?? log.imageCount}</span>
                    {log.failCount ? <span className="rounded-md bg-red-50 px-1.5 py-1 text-red-500 dark:bg-red-950/30 dark:text-red-300">失败 {log.failCount}</span> : null}
                    <span className="rounded-md bg-muted px-1.5 py-1">{formatDuration(log.durationMs)}</span>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const rawTurns = log.turns || [];
    const turns = await Promise.all(
        rawTurns.map(async (turn) => ({
            ...turn,
            references: await resolveReferences(turn.references),
            results: await Promise.all(
                turn.results.map(async (result) => ({
                    ...result,
                    image: result.image ? await resolveGeneratedImage(result.image) : undefined,
                })),
            ),
        })),
    );
    const references = await resolveReferences(log.references);
    const storedImages = await resolveGeneratedImages(log.images);
    const fallbackTurns: ConversationTurn[] =
        turns.length || (!log.prompt && !storedImages.length)
            ? turns
            : [
                  {
                      id: log.id || nanoid(),
                      prompt: log.prompt || log.title || "",
                      model: log.model || log.config?.imageModel || "",
                      mode: references.length ? "image" : "text",
                      references,
                      results: storedImages.map((image) => ({ id: image.id, status: "success", image })),
                      createdAt: log.createdAt || Date.now(),
                  },
              ];
    const images = storedImages.length ? storedImages : flattenTurnImages(fallbackTurns);
    const config = normalizeLogConfig(log);
    const latestTurn = fallbackTurns[fallbackTurns.length - 1];
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || fallbackTurns[0]?.prompt?.slice(0, 12) || log.model || "未命名",
        prompt: log.prompt || latestTurn?.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || latestTurn?.model || config.imageModel || "",
        config,
        references: references.length ? references : latestTurn?.references || [],
        durationMs: log.durationMs || sumImageDuration(images),
        successCount: log.successCount ?? images.length,
        failCount: log.failCount ?? countTurnFailures(fallbackTurns),
        imageCount: log.imageCount || countTurnResults(fallbackTurns) || images.length,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        imageResolution: log.imageResolution || config.imageResolution || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        turns: fallbackTurns,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: serializeReferences(log.references),
        images: serializeImages(log.images),
        thumbnails: [],
        turns: log.turns.map((turn) => ({
            ...turn,
            references: serializeReferences(turn.references),
            results: turn.results.map((result) => ({ ...result, image: result.image ? serializeImage(result.image) : undefined })),
        })),
    };
}

async function resolveReferences(references: ReferenceImage[] = []) {
    return Promise.all(
        references.map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
}

async function resolveGeneratedImages(images: GeneratedImage[] = []) {
    return Promise.all(images.map(resolveGeneratedImage));
}

async function resolveGeneratedImage(image: GeneratedImage) {
    return {
        ...image,
        dataUrl: await resolveImageUrl(image.storageKey, image.dataUrl),
    };
}

function serializeReferences(references: ReferenceImage[]) {
    return references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl }));
}

function serializeImages(images: GeneratedImage[]) {
    return images.map(serializeImage);
}

function serializeImage(image: GeneratedImage) {
    return { ...image, dataUrl: image.storageKey ? "" : image.dataUrl };
}

function flattenTurnImages(turns: ConversationTurn[]) {
    return turns.flatMap((turn) => turn.results.map((result) => result.image).filter((image): image is GeneratedImage => Boolean(image)));
}

function countTurnFailures(turns: ConversationTurn[]) {
    return turns.reduce((count, turn) => count + turn.results.filter((result) => result.status === "failed").length, 0);
}

function countTurnResults(turns: ConversationTurn[]) {
    return turns.reduce((count, turn) => count + turn.results.length, 0);
}

function sumImageDuration(images: GeneratedImage[]) {
    return images.reduce((total, image) => total + (image.durationMs || 0), 0);
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    const size = log.config?.size || log.size || "";
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size,
        imageResolution: log.config?.imageResolution || log.imageResolution || inferImageResolutionFromSize(size) || "1k",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItemTo<T extends { id: string }>(items: T[], sourceId: string, targetId: string) {
    const sourceIndex = items.findIndex((item) => item.id === sourceId);
    const targetIndex = items.findIndex((item) => item.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
    const next = [...items];
    const [source] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    return next;
}

function buildLog({ id, config, fallbackDurationMs, turns }: { id: string; config: GenerationLogConfig; fallbackDurationMs: number; turns: ConversationTurn[] }): GenerationLog {
    const firstTurn = turns[0];
    const latestTurn = turns[turns.length - 1];
    const images = flattenTurnImages(turns);
    const failCount = countTurnFailures(turns);
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        imageResolution: config.imageResolution,
        count: config.count,
    };
    return {
        id,
        createdAt: latestTurn?.createdAt || Date.now(),
        title: firstTurn?.prompt.slice(0, 12) || "未命名",
        prompt: latestTurn?.prompt || "",
        time: new Date(latestTurn?.createdAt || Date.now()).toLocaleString("zh-CN", { hour12: false }),
        model: latestTurn?.model || logConfig.imageModel || "",
        config: logConfig,
        references: latestTurn?.references || [],
        durationMs: sumImageDuration(images) || fallbackDurationMs,
        successCount: images.length,
        failCount,
        imageCount: countTurnResults(turns) || images.length,
        size: logConfig.size,
        quality: logConfig.quality,
        imageResolution: logConfig.imageResolution,
        status: images.length ? "成功" : "失败",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        turns,
    };
}
