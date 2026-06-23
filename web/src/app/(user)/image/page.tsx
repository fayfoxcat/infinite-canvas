"use client";

import { ArrowLeft, ArrowRight, BookOpen, Download, FolderPlus, History, ImagePlus, Link2, LoaderCircle, PenLine, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { App, Button, Drawer, Image, Input, Popover, Tag, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import type { ReferenceImage } from "@/types/image";

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
    image?: GeneratedImage;
    error?: string;
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
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type GenerationMode = "text" | "image";
type LogFilter = "all" | GenerationMode;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const CLOUD_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const WORKBENCH_CONTROL_BUTTON_CLASS =
    "!h-8 !rounded-xl !border-neutral-200 !bg-white !text-neutral-950 !shadow-sm transition hover:!border-neutral-300 hover:!bg-neutral-50 dark:!border-neutral-800 dark:!bg-neutral-950 dark:!text-neutral-100 dark:hover:!bg-neutral-900";
const WORKBENCH_ICON_BUTTON_CLASS =
    `${WORKBENCH_CONTROL_BUTTON_CLASS} !grid !w-8 !min-w-8 !place-items-center !p-0`;
const ASPECT_OPTIONS = [
    { value: "auto", label: "自动", width: 1, height: 1 },
    { value: "21:9", label: "21:9", width: 21, height: 9 },
    { value: "16:9", label: "16:9", width: 16, height: 9 },
    { value: "3:2", label: "3:2", width: 3, height: 2 },
    { value: "4:3", label: "4:3", width: 4, height: 3 },
    { value: "1:1", label: "1:1", width: 1, height: 1 },
    { value: "3:4", label: "3:4", width: 3, height: 4 },
    { value: "2:3", label: "2:3", width: 2, height: 3 },
    { value: "9:16", label: "9:16", width: 9, height: 16 },
];

export default function ImagePage() {
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [generationMode, setGenerationMode] = useState<GenerationMode>("text");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [logFilter, setLogFilter] = useState<LogFilter>("all");
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const visibleLogs = logs.filter((log) => logMatchesFilter(log, logFilter));

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        if (nextReferences.length) setGenerationMode("image");
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addDroppedReferences = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        void addReferences(event.dataTransfer.files);
    };

    const addPastedReferences = (event: ClipboardEvent<HTMLElement>) => {
        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        event.preventDefault();
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        void addReferences(transfer.files);
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

        setElapsedMs(0);
        setRunning(true);
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = generationCount - successCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");

        try {
            const logImages = await Promise.all(
                successImages.map(async (image) => {
                    const stored = await uploadImage(image.dataUrl);
                    return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                }),
            );
            saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    status: successCount ? "成功" : "失败",
                    images: logImages,
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
        setGenerationMode("image");
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success("已加入参考图");
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setGenerationMode("image");
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning("生图工作台只能使用文本或图片素材");
        }
        setAssetPickerOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(refreshLogs);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setGenerationMode(log.references?.length ? "image" : "text");
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
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
        return { text, config: { ...effectiveConfig, channelMode: CLOUD_API_BASE ? ("remote" as const) : effectiveConfig.channelMode, model, count: "1" }, references: generationMode === "image" ? [...references] : [] };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references) : await requestGeneration(snapshot.config, snapshot.text);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl) };
            setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            setResults((value) => updateResultAt(value, index, { status: "failed", error: error instanceof Error ? error.message : "生成失败" }));
            throw error;
        }
    };

    const retryResult = (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        void runGenerationSlot(index, snapshot).catch(() => {});
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-neutral-50 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-xl border border-neutral-200 bg-card p-4 shadow-sm dark:border-neutral-800 lg:block">
                    <LogPanel
                        logs={visibleLogs}
                        filter={logFilter}
                        activeLogId={previewLog?.id}
                        onFilterChange={setLogFilter}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="flex min-h-0 flex-col gap-3">
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-card px-3 py-2 shadow-sm dark:border-neutral-800 lg:hidden">
                        <h1 className="text-lg font-semibold">生图工作台</h1>
                        <div className="flex gap-2">
                            <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                记录
                            </Button>
                            <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsDrawerOpen(true)}>
                                参数
                            </Button>
                        </div>
                    </div>

                    <section className="min-h-[360px] flex-1 rounded-xl border border-neutral-200 bg-card p-4 shadow-sm dark:border-neutral-800 lg:min-h-0 lg:p-5">
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <h2 className="text-base font-semibold">图 1</h2>
                            {running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(elapsedMs)}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className={`grid h-[calc(100%-2rem)] min-h-[300px] gap-4 ${results.length === 1 ? "grid-cols-1" : "sm:grid-cols-2 2xl:grid-cols-3"}`}>
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <StageResultCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" ? (
                                        <StageFailedCard key={result.id} error={result.error || "生成失败"} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <StagePendingCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div
                                className="flex h-[calc(100%-2rem)] min-h-[300px] flex-col items-center justify-center rounded-lg border border-dashed border-neutral-200 bg-neutral-50/50 text-center dark:border-neutral-800 dark:bg-neutral-900/50 lg:min-h-[520px]"
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={addDroppedReferences}
                            >
                                <ImagePlus className="mb-3 size-10 text-neutral-400" />
                                <div className="text-sm font-medium text-neutral-400">图 1 会显示在这里</div>
                            </div>
                        )}
                    </section>

                    <section className="rounded-xl border border-neutral-200 bg-card p-3 shadow-sm dark:border-neutral-800" onDragOver={(event) => event.preventDefault()} onDrop={addDroppedReferences} onPaste={addPastedReferences}>
                        <div className="grid gap-3 md:grid-cols-[92px_minmax(0,1fr)]">
                            <button
                                type="button"
                                className="group relative flex h-24 w-full rotate-[-4deg] items-center justify-center overflow-hidden rounded-lg border border-dashed border-neutral-200 bg-neutral-50 text-neutral-400 transition hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 md:h-28"
                                onClick={() => fileInputRef.current?.click()}
                                aria-label="添加参考图"
                            >
                                {references[0] ? (
                                    <img src={references[0].dataUrl} alt={references[0].name} className="size-full object-cover" />
                                ) : (
                                    <ImagePlus className="size-5 transition group-hover:scale-105" />
                                )}
                            </button>
                            <div className="min-w-0">
                                <Input.TextArea
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    variant="borderless"
                                    autoSize={{ minRows: 5, maxRows: 7 }}
                                    className="!px-0 !text-base"
                                    placeholder="描述、拖入、粘贴你想生成或编辑的图片，例如：一张电影感的人像海报，暖色霓虹灯，浅景深"
                                />
                                {references.length ? (
                                    <div className="hover-scrollbar hover-scrollbar-hint mt-3 flex gap-2 overflow-x-auto pb-1">
                                        {references.map((item, index) => (
                                            <div key={item.id} className="group relative size-16 shrink-0 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
                                                <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                                <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                                <button
                                                    type="button"
                                                    className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                    onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                    aria-label="移除参考图"
                                                >
                                                    <Trash2 className="size-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <div className="flex h-8 items-center rounded-xl border border-neutral-200 bg-neutral-50 p-0.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                                <button
                                    type="button"
                                    className={`h-7 rounded-lg px-3 text-sm transition ${generationMode === "text" ? "bg-white font-medium text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-neutral-50" : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"}`}
                                    onClick={() => setGenerationMode("text")}
                                >
                                    文生图
                                </button>
                                <button
                                    type="button"
                                    className={`h-7 rounded-lg px-3 text-sm transition ${generationMode === "image" ? "bg-white font-medium text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-neutral-50" : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"}`}
                                    onClick={() => setGenerationMode("image")}
                                >
                                    图生图
                                </button>
                            </div>
                            <ModelPicker config={effectiveConfig} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" onMissingConfig={() => openConfigDialog(false)} />
                            <Popover
                                open={settingsOpen}
                                onOpenChange={setSettingsOpen}
                                trigger="click"
                                placement="topLeft"
                                arrow={false}
                                styles={{ container: { padding: 0, borderRadius: 24, boxShadow: "none" } }}
                                content={<WorkbenchSettingsPanel config={effectiveConfig} updateConfig={updateConfig} />}
                            >
                                <Button className={`${WORKBENCH_CONTROL_BUTTON_CLASS} !px-3`} size="small" icon={<SlidersHorizontal className="size-3.5" />}>
                                    {workbenchSizeLabel(effectiveConfig.size)} | {workbenchResolutionLabel(effectiveConfig.quality)}
                                </Button>
                            </Popover>
                            <Button className={WORKBENCH_ICON_BUTTON_CLASS} size="small" icon={<BookOpen className="size-3.5" />} title="提示词库" aria-label="提示词库" onClick={() => setPromptDialogOpen(true)} />
                            <Button className={WORKBENCH_ICON_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} title="我的素材" aria-label="我的素材" onClick={() => setAssetPickerOpen(true)} />
                            <Button
                                className="ml-auto !h-8 !rounded-xl !border-neutral-950 !bg-neutral-950 !px-4 !font-medium !text-white disabled:!border-neutral-200 disabled:!bg-neutral-100 disabled:!text-neutral-400 dark:!border-neutral-100 dark:!bg-neutral-100 dark:!text-neutral-950 dark:disabled:!border-neutral-800 dark:disabled:!bg-neutral-900 dark:disabled:!text-neutral-500"
                                type="primary"
                                icon={<Sparkles className="size-4" />}
                                loading={running}
                                disabled={!canGenerate || running}
                                onClick={() => void generate()}
                            >
                                生成
                            </Button>
                        </div>
                        <div className="mt-2 text-xs text-neutral-400">
                            当前尺寸 {effectiveConfig.size || "auto"} · {CLOUD_API_BASE ? "云端后端" : "本地渠道"} · 按次计费 0.00 USD
                        </div>
                    </section>
                </section>
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
                    logs={visibleLogs}
                    filter={logFilter}
                    activeLogId={previewLog?.id}
                    onFilterChange={setLogFilter}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsDrawerOpen} onClose={() => setSettingsDrawerOpen(false)}>
                <WorkbenchSettingsPanel config={effectiveConfig} updateConfig={updateConfig} />
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

function WorkbenchSettingsPanel({ config, updateConfig }: { config: AiConfig; updateConfig: UpdateAiConfig }) {
    const size = config.size || "auto";
    const selectedAspect = ASPECT_OPTIONS.find((item) => item.value === size) || (parseWorkbenchSize(size) ? null : ASPECT_OPTIONS[0]);
    const dimensions = readWorkbenchDimensions(size);
    const selectAspect = (value: string) => updateConfig("size", value);
    const updateDimension = (key: "width" | "height", value: number) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        updateConfig("size", `${alignWorkbenchDimension(width)}x${alignWorkbenchDimension(height)}`);
    };

    return (
        <div className="w-[420px] max-w-full rounded-[24px] border border-neutral-200 bg-white p-5 text-neutral-950 shadow-[0_28px_90px_rgba(15,23,42,0.22)] dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
            <div className="text-sm font-medium text-neutral-500 dark:text-neutral-400">画面比例</div>
            <div className="mt-3 grid grid-cols-3 gap-2 rounded-[22px] bg-neutral-50 p-2 dark:bg-neutral-900">
                {ASPECT_OPTIONS.map((item) => (
                    <button
                        key={item.value}
                        type="button"
                        className={`flex h-[68px] flex-col items-center justify-center gap-1 rounded-2xl text-sm transition ${
                            selectedAspect?.value === item.value ? "bg-white text-neutral-950 shadow-[0_8px_24px_rgba(15,23,42,0.08)] dark:bg-neutral-800 dark:text-neutral-50" : "text-neutral-700 hover:bg-white/70 dark:text-neutral-300 dark:hover:bg-neutral-800/70"
                        }`}
                        onClick={() => selectAspect(item.value)}
                    >
                        <AspectGlyph option={item} />
                        <span>{item.label}</span>
                    </button>
                ))}
            </div>

            <div className="mt-5 text-sm font-medium text-neutral-500 dark:text-neutral-400">分辨率</div>
            <button
                type="button"
                className="mt-3 h-12 w-full rounded-2xl border border-neutral-100 bg-white text-sm font-semibold shadow-[0_6px_18px_rgba(15,23,42,0.05)] transition hover:border-neutral-200 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
                onClick={() => updateConfig("quality", "low")}
            >
                1K
            </button>

            <div className="mt-5 text-sm font-medium text-neutral-500 dark:text-neutral-400">尺寸</div>
            <div className="mt-3 grid grid-cols-[1fr_28px_1fr] items-center gap-2">
                <DimensionBox label="W" value={dimensions.width} onChange={(value) => updateDimension("width", value)} />
                <div className="grid size-7 place-items-center rounded-full bg-white text-neutral-400 shadow-sm dark:bg-neutral-900">
                    <Link2 className="size-4" />
                </div>
                <DimensionBox label="H" value={dimensions.height} onChange={(value) => updateDimension("height", value)} />
            </div>
            <div className="mt-2 text-right text-xs text-neutral-400">单位：像素</div>
        </div>
    );
}

function AspectGlyph({ option }: { option: (typeof ASPECT_OPTIONS)[number] }) {
    const isAuto = option.value === "auto";
    const wide = option.width >= option.height;
    const width = isAuto ? 18 : wide ? 22 : 12;
    const height = isAuto ? 18 : wide ? 10 : 20;
    return (
        <span className="grid h-6 place-items-center text-neutral-700 dark:text-neutral-200">
            {isAuto ? <SlidersHorizontal className="size-4" /> : <span className="block rounded border-2 border-current" style={{ width, height }} />}
        </span>
    );
}

function DimensionBox({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
    return (
        <label className="grid h-12 grid-cols-[36px_minmax(0,1fr)] items-center rounded-2xl bg-neutral-50 text-sm dark:bg-neutral-900">
            <span className="pl-4 font-semibold text-neutral-500 dark:text-neutral-400">{label}</span>
            <input
                key={`${label}-${value}`}
                type="number"
                min={1}
                defaultValue={value}
                className="min-w-0 bg-transparent px-3 text-right font-medium outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                onBlur={(event) => onChange(Number(event.currentTarget.value) || value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
            />
        </label>
    );
}

function workbenchSizeLabel(size: string) {
    const value = (size || "auto").trim().toLowerCase();
    if (!value || value === "auto") return "自动比例";
    if (value.includes(":")) return value;
    return "自定义";
}

function workbenchResolutionLabel(quality: string) {
    const value = (quality || "low").trim().toLowerCase();
    if (!value || value === "auto" || value === "low" || value === "standard" || value === "1k") return "1K";
    if (value === "medium" || value === "2k" || value === "hd") return "2K";
    if (value === "high" || value === "4k") return "4K";
    return value.toUpperCase();
}

function readWorkbenchDimensions(size: string) {
    const value = (size || "auto").trim().toLowerCase();
    const dimensions = parseWorkbenchSize(value);
    if (dimensions) return dimensions;
    const ratio = ASPECT_OPTIONS.find((item) => item.value === value);
    if (!ratio || ratio.value === "auto") return { width: 1024, height: 1024 };
    const isLandscape = ratio.width >= ratio.height;
    const long = alignWorkbenchDimension((1024 * Math.max(ratio.width, ratio.height)) / Math.min(ratio.width, ratio.height));
    return isLandscape ? { width: long, height: 1024 } : { width: 1024, height: long };
}

function parseWorkbenchSize(size: string) {
    const match = size.match(/^(\d+)x(\d+)$/i);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function alignWorkbenchDimension(value: number) {
    return Math.max(16, Math.round(value / 16) * 16);
}

function StageResultCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    return (
        <div className="group relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
            <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="max-h-full object-contain" preview={{ mask: "查看大图" }} />
            <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-2 rounded-lg border border-white/60 bg-white/90 p-2 shadow-sm backdrop-blur dark:border-neutral-700/80 dark:bg-neutral-950/80">
                <span className="mr-auto text-xs text-neutral-500 dark:text-neutral-400">
                    {image.width}x{image.height} · {formatBytes(image.bytes)} · {formatDuration(image.durationMs)}
                </span>
                <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                    素材
                </Button>
                <Button size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                    参考
                </Button>
                <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                    下载
                </Button>
            </div>
        </div>
    );
}

function StagePendingCard() {
    return (
        <div className="relative min-h-[300px] overflow-hidden rounded-lg border border-dashed border-neutral-300 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(115,115,115,0.28) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function StageFailedCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="flex min-h-[300px] flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50 p-5 text-center dark:border-red-950 dark:bg-red-950/20">
            <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
            <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mt-3 !text-xs !text-red-500 dark:!text-red-300">
                {error}
            </Typography.Paragraph>
            <Button size="small" danger onClick={onRetry}>
                重试
            </Button>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    filter,
    activeLogId,
    onFilterChange,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    filter: LogFilter;
    activeLogId?: string;
    onFilterChange: (filter: LogFilter) => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    return (
        <>
            <div className="mb-5">
                <h2 className="text-base font-semibold">历史记录</h2>
                <div className="mt-1 text-sm text-neutral-400">仅保留1天</div>
            </div>
            <div className="mb-4 flex gap-2">
                {[
                    ["all", "全部"],
                    ["text", "文生图"],
                    ["image", "图生图"],
                ].map(([value, label]) => (
                    <Button key={value} size="small" type={filter === value ? "primary" : "default"} onClick={() => onFilterChange(value as LogFilter)}>
                        {label}
                    </Button>
                ))}
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard key={log.id} log={log} active={activeLogId === log.id} onClick={() => onPreviewLog(log)} />
                ))}
                {!logs.length ? <div className="flex min-h-72 items-center justify-center rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 text-center text-sm font-medium text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900/50">暂无历史记录</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, active, onClick }: { log: GenerationLog; active: boolean; onClick: () => void }) {
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 3);
    const modeLabel = log.references.length ? "图生图" : "文生图";

    return (
        <button
            type="button"
            className={`block w-full rounded-xl border p-2 text-left transition ${active ? "border-neutral-950 bg-neutral-100 dark:border-neutral-100 dark:bg-neutral-900" : "border-neutral-200 bg-background hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"}`}
            onClick={onClick}
        >
            <div className="flex gap-2">
                {thumbnails[0] ? (
                    <img src={thumbnails[0]} alt="" className="size-14 shrink-0 rounded-lg object-cover" />
                ) : (
                    <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-neutral-200 bg-neutral-50 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900">
                        <ImagePlus className="size-4" />
                    </div>
                )}
                <div>
                    <div className="line-clamp-2 text-sm font-medium leading-5">{log.title}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-5 items-center rounded-md px-1.5 text-[11px] leading-none">{modeLabel}</Tag>
                        <Tag className="m-0 flex h-5 items-center rounded-md px-1.5 text-[11px] leading-none">{log.imageCount}张</Tag>
                    </div>
                </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-neutral-400">
                <span className="truncate">{log.time}</span>
                <span>{formatDuration(log.durationMs)}</span>
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
        const cutoff = Date.now() - LOG_RETENTION_MS;
        return logs.filter((log) => (log.createdAt || 0) >= cutoff).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

function logMatchesFilter(log: GenerationLog, filter: LogFilter) {
    if (filter === "all") return true;
    return filter === "image" ? log.references.length > 0 : log.references.length === 0;
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
