"use client";

import { DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Card, Checkbox, Col, Drawer, Flex, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { createContext, type CSSProperties, type ReactNode, useContext, useEffect, useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { fetchAdminSettings, fetchChannelModels, saveAdminSettings, type AdminModelCost, type AdminModelChannel, type AdminSettings, fetchAdminModels, saveAdminModel, updateAdminModelSort, toggleAdminModel, deleteAdminModel, refreshAdminModelCatalog, type AdminModelInfo } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [],
            textModels: [],
            imageModels: [],
            videoModels: [],
            audioModels: [],
            modelInfos: [],
            modelCosts: [],
            defaultModel: "",
            defaultImageModel: "",
            defaultVideoModel: "",
            defaultTextModel: "",
            defaultAudioModel: "",
            systemPrompt: "",
            allowCustomChannel: true,
            modelTypeRules: { textModels: "", imageModels: "", videoModels: "", audioModels: "" },
        },
        auth: { allowRegister: true, linuxDo: { enabled: false } },
    },
    private: { channels: [], promptSync: { enabled: true, cron: "*/5 * * * *" }, auth: { linuxDo: { clientId: "", clientSecret: "" } } },
};
const emptyModelConfig: AdminModelChannel = { protocol: "openai", name: "", baseUrl: "", apiKey: "", models: [], type: "", weight: 1, enabled: true, remark: "" };

const MODEL_SIZE_OPTIONS = ["auto", "1k", "2k", "4k"];
const SIZE_LABELS: Record<string, string> = { auto: "自动", "1k": "1K", "2k": "2K", "4k": "4K" };
const MODEL_TYPE_OPTIONS = ["text", "image", "video", "audio"];

const SortableRowContext = createContext<{ setActivatorNodeRef?: (element: HTMLElement | null) => void; listeners?: Record<string, any>; attributes?: Record<string, any> }>({});

function DraggableRow({ children, ...props }: { children: ReactNode; [key: string]: any }) {
    const dataId = props["data-row-key"];
    const id: UniqueIdentifier = typeof dataId === "number" ? dataId : String(dataId ?? "");
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style: CSSProperties = { ...props.style, transform: CSS.Transform.toString(transform), transition, ...(isDragging ? { position: "relative" as const, zIndex: 9999, opacity: 0.8, background: "var(--ant-color-bg-container)" } : {}) };
    return (
        <SortableRowContext.Provider value={{ attributes, listeners, setActivatorNodeRef }}>
            <tr {...props} ref={setNodeRef} style={style}>{children}</tr>
        </SortableRowContext.Provider>
    );
}
function DragHandle() {
    const { attributes, listeners, setActivatorNodeRef } = useContext(SortableRowContext);
    return <HolderOutlined ref={setActivatorNodeRef as any} style={{ cursor: "grab", color: "var(--ant-color-text-tertiary)" }} {...attributes} {...listeners} />;
}
function typeColor(type: string) { const map: Record<string, string> = { text: "blue", image: "purple", video: "orange", audio: "green" }; return map[type] || "default"; }
function modelCostCredits(items: AdminModelCost[], model: string) { return items.find((item) => item.model === model)?.credits ?? 0; }

function collectModelConfigModels(configs: AdminModelChannel[]) {
    return uniqueModels(configs.filter((item) => item.enabled).flatMap((item) => item.models || []));
}
function uniqueModels(models: string[]) { return [...new Set(models.map((m) => m.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function normalizeModelConfig(item: Partial<AdminModelChannel> = {}): AdminModelChannel {
    return { protocol: item.protocol || "openai", name: item.name || "", baseUrl: item.baseUrl || "", apiKey: item.apiKey || "", models: (item.models || []).map((m) => m.trim()).filter(Boolean), type: item.type || "", weight: item.weight || 1, enabled: item.enabled !== false, remark: item.remark || "" };
}
function mergeModelConfigApiKeys(currentConfigs: AdminModelChannel[], saved: AdminSettings): AdminSettings {
    return { ...saved, private: { ...saved.private, channels: saved.private.channels.map((item, i) => ({ ...item, apiKey: currentConfigs[i]?.apiKey || item.apiKey })) } };
}
function setModelCost(form: any, setModelCosts: (items: AdminModelCost[]) => void, model: string, credits: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminModelCost[];
    const next = current.some((c) => c.model === model) ? current.map((c) => (c.model === model ? { model, credits } : c)) : [...current, { model, credits }];
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}
function normalizeModelTypes(value: string) {
    const selected = new Set(value.split(",").map((item) => item.trim()).filter((item) => MODEL_TYPE_OPTIONS.includes(item)));
    return MODEL_TYPE_OPTIONS.filter((item) => selected.has(item)).join(",") || "text";
}
function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    const modelChannel = settings.public?.modelChannel;
    return {
        public: {
            modelChannel: {
                ...emptySettings.public.modelChannel,
                ...(modelChannel || {}),
                availableModels: modelChannel?.availableModels || [],
                textModels: modelChannel?.textModels || [],
                imageModels: modelChannel?.imageModels || [],
                videoModels: modelChannel?.videoModels || [],
                audioModels: modelChannel?.audioModels || [],
                modelInfos: modelChannel?.modelInfos || [],
                modelCosts: (modelChannel?.modelCosts || []).map((item) => ({ model: item.model?.trim() || "", credits: Math.max(0, Number(item.credits) || 0) })).filter((item) => item.model),
                allowCustomChannel: modelChannel?.allowCustomChannel !== false,
                modelTypeRules: modelChannel?.modelTypeRules || emptySettings.public.modelChannel.modelTypeRules,
            },
            auth: {
                allowRegister: settings.public?.auth?.allowRegister !== false,
                linuxDo: { enabled: settings.public?.auth?.linuxDo?.enabled === true },
            },
        },
        private: {
            channels: (settings.private?.channels || []).map(normalizeModelConfig),
            promptSync: { enabled: settings.private?.promptSync?.enabled !== false, cron: settings.private?.promptSync?.cron || emptySettings.private.promptSync.cron },
            auth: { linuxDo: { clientId: settings.private?.auth?.linuxDo?.clientId || "", clientSecret: settings.private?.auth?.linuxDo?.clientSecret || "" } },
        },
    };
}

export default function AdminModelsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();

    const [modelConfigs, setModelConfigs] = useState<AdminModelChannel[]>([]);
    const [modelConfigForm] = Form.useForm<AdminModelChannel>();
    const [isModelConfigDrawerOpen, setIsModelConfigDrawerOpen] = useState(false);
    const [isFetchingModelNames, setIsFetchingModelNames] = useState(false);
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [modelSelectOptions, setModelSelectOptions] = useState<string[]>([]);
    const [modelSelectSelected, setModelSelectSelected] = useState<string[]>([]);
    const [modelSelectKeyword, setModelSelectKeyword] = useState("");
    const [modelSelectNewModel, setModelSelectNewModel] = useState("");
    const [modelCosts, setModelCosts] = useState<AdminModelCost[]>([]);
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSavingModelConfig, setIsSavingModelConfig] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);

    const [modelsList, setModelsList] = useState<AdminModelInfo[]>([]);
    const [modelsTotal, setModelsTotal] = useState(0);
    const [modelsKeyword, setModelsKeyword] = useState("");
    const [modelsTypeFilter, setModelsTypeFilter] = useState("");
    const [modelsPage, setModelsPage] = useState(1);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelDrafts, setModelDrafts] = useState<Record<number, Partial<AdminModelInfo>>>({});
    const pageSizeModels = 30;
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    const loadAll = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const data = normalizeSettings(await fetchAdminSettings(token));
            form.setFieldsValue(data);
            setModelConfigs(data.private.channels);
            setModelCosts(data.public.modelChannel.modelCosts);
            setAvailableModels(data.public.modelChannel.availableModels);
        } catch (e) {
            message.error(e instanceof Error ? e.message : "读取设置失败");
        } finally { setIsLoading(false); }
    };
    const loadModels = async (query: { page?: number; keyword?: string; type?: string } = {}) => {
        if (!token) return;
        setModelsLoading(true);
        const params = { keyword: query.keyword ?? modelsKeyword, type: query.type ?? modelsTypeFilter, page: query.page ?? modelsPage, pageSize: pageSizeModels };
        try {
            const res = await fetchAdminModels(token, params);
            setModelsList(res.items || []);
            setModelsTotal(res.total || 0);
        } catch (e) {
            setModelsList([]);
            setModelsTotal(0);
            message.error(e instanceof Error ? e.message : "读取模型清单失败");
        } finally { setModelsLoading(false); }
    };

    useEffect(() => { void loadAll(); }, [token]);
    useEffect(() => { void loadModels(); }, [modelsPage, modelsKeyword, modelsTypeFilter, token]);

    async function saveModelSettings(successText = "已保存") {
        if (!token) return null;
        setIsSavingSettings(true);
        try {
            const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
            const nextSettings = normalizeSettings({
                ...values,
                public: { ...values.public, modelChannel: { ...values.public.modelChannel, availableModels: collectModelConfigModels(modelConfigs) } },
                private: { ...values.private, channels: modelConfigs },
            });
            const saved = normalizeSettings(await saveAdminSettings(token, nextSettings));
            const merged = mergeModelConfigApiKeys(modelConfigs, saved);
            setModelConfigs(merged.private.channels);
            setModelCosts(merged.public.modelChannel.modelCosts);
            setAvailableModels(merged.public.modelChannel.availableModels);
            form.setFieldsValue(merged);
            message.success(successText);
            return merged;
        } catch (e) {
            message.error(e instanceof Error ? e.message : "保存失败");
            return null;
        } finally {
            setIsSavingSettings(false);
        }
    }
    async function persistModelConfigs(nextConfigs: AdminModelChannel[]) {
        if (!token) return null;
        const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
        const nextSettings = normalizeSettings({ ...values, public: { ...values.public, modelChannel: { ...values.public.modelChannel, availableModels: collectModelConfigModels(nextConfigs) } }, private: { ...values.private, channels: nextConfigs } });
        const saved = normalizeSettings(await saveAdminSettings(token, nextSettings));
        const merged = mergeModelConfigApiKeys(nextConfigs, saved);
        setModelConfigs(merged.private.channels);
        setModelCosts(merged.public.modelChannel.modelCosts);
        setAvailableModels(merged.public.modelChannel.availableModels);
        form.setFieldsValue(merged);
        return merged;
    }
    const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
    const openModelConfigDrawer = (record?: AdminModelInfo) => {
        if (record) {
            // 编辑模式：根据模型行找到对应渠道，预填表单
            const idx = modelConfigs.findIndex((ch) => (ch.name || "").trim() === (record.provider || "").trim());
            if (idx >= 0) {
                modelConfigForm.setFieldsValue(modelConfigs[idx]);
                setEditingChannelIndex(idx);
            } else {
                modelConfigForm.setFieldsValue({ ...emptyModelConfig, name: record.provider || "" });
                setEditingChannelIndex(null);
            }
        } else {
            modelConfigForm.resetFields();
            modelConfigForm.setFieldsValue(emptyModelConfig);
            setEditingChannelIndex(null);
        }
        setIsModelConfigDrawerOpen(true);
    };
    const closeModelConfigDrawer = () => {
        setIsModelConfigDrawerOpen(false);
        setIsModelSelectorOpen(false);
        modelConfigForm.resetFields();
        setEditingChannelIndex(null);
    };
    const saveModelConfig = async () => {
        if (!token) return;
        setIsSavingModelConfig(true);
        try {
            const config = normalizeModelConfig(await modelConfigForm.validateFields());
            if (!config.models.length) {
                message.warning("请至少填写一个模型名称");
                return;
            }
            const next = editingChannelIndex != null
                ? modelConfigs.map((ch, i) => (i === editingChannelIndex ? config : ch))
                : [...modelConfigs, config];
            await persistModelConfigs(next);
            const syncResult = await refreshAdminModelCatalog(token);
            closeModelConfigDrawer();
            message.success(syncResult.synced > 0 ? `模型已${editingChannelIndex != null ? "更新" : "新增"}（同步 ${syncResult.synced} 个）` : "模型配置已保存，模型清单中没有新增项");
            const nextKeyword = syncResult.synced > 0 ? "" : config.models[0] || "";
            setModelsKeyword(nextKeyword);
            setModelsTypeFilter("");
            setModelsPage(1);
            await Promise.all([loadModels({ page: 1, keyword: nextKeyword, type: "" }), loadAll()]);
        } catch (e) {
            if (e && typeof e === "object" && "errorFields" in e) return;
            message.error(e instanceof Error ? e.message : "保存失败");
        } finally {
            setIsSavingModelConfig(false);
        }
    };
    const fetchModelNameList = async () => {
        if (!token) return;
        const config = modelConfigForm.getFieldsValue();
        if (!config.baseUrl || !config.apiKey) { message.warning("请先填写接口地址和 API Key"); return; }
        setIsFetchingModelNames(true);
        try {
            const fetched = await fetchChannelModels(token, { channel: normalizeModelConfig(config) });
            if (!fetched.length) {
                message.warning("上游未返回模型列表，请手动输入模型名称");
                return;
            }
            const current = uniqueModels(modelConfigForm.getFieldValue("models") || []);
            setModelSelectOptions(uniqueModels([...current, ...fetched]));
            setModelSelectSelected(uniqueModels([...current, ...fetched]));
            setModelSelectKeyword("");
            setModelSelectNewModel("");
            setIsModelSelectorOpen(true);
            message.success(`已拉取 ${fetched.length} 个模型`);
        } catch (e) { message.error(e instanceof Error ? e.message : "读取模型失败"); }
        finally { setIsFetchingModelNames(false); }
    };
    const addModelSelectModel = () => {
        const model = modelSelectNewModel.trim();
        if (!model) return;
        setModelSelectOptions((items) => uniqueModels([...items, model]));
        setModelSelectSelected((items) => uniqueModels([...items, model]));
        setModelSelectNewModel("");
    };
    const confirmModelSelection = () => {
        const models = uniqueModels(modelSelectSelected);
        if (!models.length) {
            message.warning("请至少选择一个模型");
            return;
        }
        modelConfigForm.setFieldValue("models", models);
        setIsModelSelectorOpen(false);
        message.success(`已选择 ${models.length} 个模型`);
    };

    const handleSaveModel = async (record: AdminModelInfo) => {
        if (!token) return;
        const providerName = record.provider?.trim();
        const modelName = record.model?.trim();
        if (!providerName) {
            message.warning("请填写服务商");
            return;
        }
        if (!modelName) {
            message.warning("请填写模型名称");
            return;
        }
        try {
            await saveAdminModel(token, { ...record, provider: providerName, model: modelName, displayName: record.displayName?.trim() || modelName, type: normalizeModelTypes(record.type || "text") });
            message.success("已保存");
            if (record.id > 0) {
                setModelDrafts((current) => {
                    const next = { ...current };
                    delete next[record.id];
                    return next;
                });
            }
            await loadModels();
            await loadAll();
        }
        catch (e) { message.error(e instanceof Error ? e.message : "保存失败"); }
    };
    const updateModelDraft = (id: number, patch: Partial<AdminModelInfo>) => {
        setModelDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
    };
    const modelDraftChanged = (record: AdminModelInfo) => {
        const draft = modelDrafts[record.id];
        return !!draft && Object.entries(draft).some(([key, value]) => value !== (record as any)[key]);
    };
    const modelWithDraft = (record: AdminModelInfo) => ({ ...record, ...(modelDrafts[record.id] || {}) });
    const handleToggleModel = async (id: number, enabled: boolean) => {
        if (!token) return;
        try {
            await toggleAdminModel(token, id, enabled);
            await loadModels();
            await loadAll();
        } catch (e) {
            message.error(e instanceof Error ? e.message : "切换失败");
        }
    };
    const handleDeleteModel = async (id: number, modelName: string) => {
        if (!token) return;
        Modal.confirm({ title: "删除模型", content: `确认删除 "${modelName}"？`, okText: "删除", okType: "danger" as const, cancelText: "取消", onOk: async () => { await deleteAdminModel(token, id); message.success("已删除"); await loadModels(); await loadAll(); } });
    };
    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIdx = modelsList.findIndex((m) => m.id === active.id);
        const newIdx = modelsList.findIndex((m) => m.id === over.id);
        if (oldIdx === -1 || newIdx === -1) return;
        const reordered = arrayMove(modelsList, oldIdx, newIdx);
        setModelsList(reordered);
        const orders = reordered.map((m, i) => ({ id: m.id, sortOrder: (modelsPage - 1) * pageSizeModels + i }));
        if (!token) return;
        try { await updateAdminModelSort(token, orders); } catch { void loadModels(); }
    };
    const refreshAll = async () => {
        await Promise.all([loadAll(), loadModels()]);
    };
    const modelSelectKeywordText = modelSelectKeyword.trim().toLowerCase();
    const visibleModelSelectModels = modelSelectOptions.filter((item) => !modelSelectKeywordText || item.toLowerCase().includes(modelSelectKeywordText));

    return (
        <main style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card size="small" title="模型清单" extra={
                    <Space>
                        <Button icon={<ReloadOutlined />} loading={isLoading || modelsLoading} size="small" onClick={() => void refreshAll()}>刷新</Button>
                        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={() => openModelConfigDrawer()}>新增模型</Button>
                    </Space>
                }>
                    <Flex justify="space-between" align="center" gap={12} wrap style={{ marginBottom: 12 }}>
                        <Space>
                            <Input.Search placeholder="搜索服务商 / 模型 / 显示名称" value={modelsKeyword} allowClear style={{ width: 260 }}
                                onChange={(e) => { setModelsKeyword(e.target.value); setModelsPage(1); }} />
                            <Select placeholder="类型筛选" value={modelsTypeFilter || undefined} allowClear style={{ width: 110 }}
                                onChange={(v) => { setModelsTypeFilter(v || ""); setModelsPage(1); }}
                                options={MODEL_TYPE_OPTIONS.map((t) => ({ label: t, value: t }))} />
                        </Space>
                    </Flex>
                    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                        <SortableContext items={modelsList.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                            <Table rowKey="id" loading={modelsLoading} size="small" dataSource={modelsList}
                                pagination={{ current: modelsPage, pageSize: pageSizeModels, total: modelsTotal, onChange: (p) => setModelsPage(p), showSizeChanger: false, showTotal: (t) => `共 ${t} 个模型` }}
                                scroll={{ x: 1130 }} components={{ body: { row: DraggableRow as any } }}
                                onRow={(record) => ({ "data-row-key": record.id } as any)}
                                columns={[
                                    { title: "序号", width: 56, align: "center" as const, render: (_: any, __: any, i: number) => <Space size={4}><Typography.Text type="secondary" style={{ fontSize: 12 }}>{(modelsPage - 1) * pageSizeModels + i + 1}</Typography.Text><DragHandle /></Space> },
                                    { title: "服务商", dataIndex: "provider", width: 104, align: "center" as const,
                                        render: (v: string, r: AdminModelInfo) => <Input size="small" variant="borderless" value={modelDrafts[r.id]?.provider ?? v ?? ""} placeholder="-" style={{ textAlign: "center" }} onChange={(e) => updateModelDraft(r.id, { provider: e.target.value })} onPressEnter={() => void handleSaveModel(modelWithDraft(r))} /> },
                                    { title: "模型", dataIndex: "model", width: 210, align: "center" as const, render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
                                    { title: "显示名称", dataIndex: "displayName", width: 190, align: "center" as const,
                                        render: (v: string, r: AdminModelInfo) => <Input size="small" variant="borderless" value={modelDrafts[r.id]?.displayName ?? v ?? r.model} placeholder={r.model} style={{ textAlign: "center" }} onChange={(e) => updateModelDraft(r.id, { displayName: e.target.value })} onPressEnter={() => void handleSaveModel(modelWithDraft(r))} /> },
                                    { title: "类型", dataIndex: "type", width: 170, align: "center" as const,
                                        render: (v: string, r: AdminModelInfo) => {
                                            const types = normalizeModelTypes(v || "text").split(",");
                                            return <Space size={2} wrap>{MODEL_TYPE_OPTIONS.map((t) => {
                                                const active = types.includes(t);
                                                return <Tag key={t} color={active ? typeColor(t) : "default"} style={{ cursor: "pointer", opacity: active ? 1 : 0.45 }}
                                                    onClick={() => {
                                                        const next = active ? types.filter((x) => x !== t) : [...types, t];
                                                        void handleSaveModel({ ...modelWithDraft(r), type: next.join(",") || "text" });
                                                    }}>{t}</Tag>;
                                            })}</Space>;
                                        }},
                                    { title: "最大尺寸", dataIndex: "maxSize", width: 110, align: "center" as const,
                                        render: (v: string, r: AdminModelInfo) => {
                                            const isImg = (r.type || "").includes("image");
                                            if (!isImg) return <Typography.Text type="secondary">-</Typography.Text>;
                                            return <Select size="small" variant="borderless" value={v || "auto"} popupMatchSelectWidth={false} style={{ minWidth: 86 }}
                                                onChange={(val) => handleSaveModel({ ...modelWithDraft(r), maxSize: val })}
                                                options={MODEL_SIZE_OPTIONS.map((s) => ({ label: SIZE_LABELS[s] || s, value: s }))} />;
                                        }},
                                    { title: "调用", dataIndex: "callCount", width: 82, align: "center" as const, render: (v: number) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v.toLocaleString()}</Typography.Text> },
                                    { title: "成功率", dataIndex: "successCount", width: 82, align: "center" as const,
                                        render: (v: number, r: AdminModelInfo) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.callCount > 0 ? `${((v / r.callCount) * 100).toFixed(0)}%` : "-"}</Typography.Text> },
                                    { title: "操作", width: 176, align: "center" as const, fixed: "right" as const, render: (_: any, r: AdminModelInfo) => (
                                        <Space size={2}>
                                            <Switch size="small" checked={r.enabled} onChange={(v) => handleToggleModel(r.id, v)} />
                                            <Button size="small" type="link" onClick={() => openModelConfigDrawer(r)}>编辑</Button>
                                            <Button size="small" type="link" disabled={!modelDraftChanged(r)} onClick={() => void handleSaveModel(modelWithDraft(r))}>保存</Button>
                                            <Button size="small" type="link" danger onClick={() => handleDeleteModel(r.id, r.model)}>删除</Button>
                                        </Space>
                                    )},
                                ]} />
                        </SortableContext>
                    </DndContext>
                </Card>

                <Card size="small" title="模型类型规则" extra={
                    <Space>
                        <Typography.Text type="secondary">影响新增模型和自动识别时分配模型类型</Typography.Text>
                        <Button size="small" icon={<SaveOutlined />} loading={isSavingSettings} onClick={() => void saveModelSettings("模型类型规则已保存")}>保存</Button>
                    </Space>
                }>
                    <Form form={form} layout="vertical" requiredMark={false}>
                        <Row gutter={16}>
                            <Col xs={24} md={12}>
                                <Form.Item name={["public", "modelChannel", "modelTypeRules", "textModels"]} label="文本模型匹配" extra="每行一个模式，支持 glob (*, ?) 和 /正则/">
                                    <Input.TextArea rows={3} placeholder="gpt-*\nclaude-*\ndeepseek-*" style={{ fontFamily: "monospace", fontSize: 13 }} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name={["public", "modelChannel", "modelTypeRules", "imageModels"]} label="图片模型匹配">
                                    <Input.TextArea rows={3} placeholder="gpt-image-*\nseedream-*" style={{ fontFamily: "monospace", fontSize: 13 }} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name={["public", "modelChannel", "modelTypeRules", "videoModels"]} label="视频模型匹配">
                                    <Input.TextArea rows={3} placeholder="seedance-*\nsora-*" style={{ fontFamily: "monospace", fontSize: 13 }} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name={["public", "modelChannel", "modelTypeRules", "audioModels"]} label="音频模型匹配">
                                    <Input.TextArea rows={3} placeholder="tts-*\nwhisper-*" style={{ fontFamily: "monospace", fontSize: 13 }} />
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>

                <Card size="small" title="模型算力点（Credits）" extra={<Button size="small" icon={<SaveOutlined />} loading={isSavingSettings} onClick={() => void saveModelSettings("模型算力点已保存")}>保存</Button>}>
                    <Table rowKey="model" pagination={false} size="small"
                        dataSource={availableModels.map((m) => ({ model: m, credits: modelCostCredits(modelCosts, m) }))}
                        columns={[
                            { title: "模型", dataIndex: "model" },
                            { title: "每次调用扣除", dataIndex: "credits", width: 220, render: (_: any, item: any) => (
                                <Space.Compact style={{ width: "100%" }}>
                                    <InputNumber min={0} step={1} precision={0} className="!w-full" value={item.credits}
                                        onChange={(v) => setModelCost(form, setModelCosts, item.model, Number(v) || 0)} />
                                    <Button disabled>点</Button>
                                </Space.Compact>
                            )},
                        ]} />
                </Card>
            </Flex>

            <Drawer title={editingChannelIndex != null ? "编辑模型" : "新增模型"} open={isModelConfigDrawerOpen} size={560} onClose={closeModelConfigDrawer}
                extra={<Space><Button onClick={closeModelConfigDrawer}>取消</Button><Button type="primary" loading={isSavingModelConfig} onClick={() => void saveModelConfig()}>保存</Button></Space>} destroyOnHidden>
                <Form form={modelConfigForm} layout="vertical" requiredMark={false} initialValues={emptyModelConfig}>
                    <Row gutter={16}>
                        <Col span={12}><Form.Item name="name" label="服务商名称" rules={[{ required: true, message: "请输入服务商名称" }]}><Input /></Form.Item></Col>
                        <Col span={12}><Form.Item name="protocol" label="协议"><Select options={[{ label: "OpenAI 兼容", value: "openai" }]} /></Form.Item></Col>
                        <Col span={12}><Form.Item name="weight" label="权重" extra="同一模型多个配置时按权重随机分配"><InputNumber min={1} className="!w-full" /></Form.Item></Col>
                        <Col span={12}><Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Col>
                        <Col span={24}><Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: "请输入接口地址" }]}><Input placeholder="https://api.example.com" /></Form.Item></Col>
                        <Col span={24}><Form.Item name="apiKey" label="API Key" extra="新增模型必须填写" rules={[{ required: true, message: "请输入 API Key" }]}><Input.Password placeholder="必填" autoComplete="off" /></Form.Item></Col>
                        <Col span={24}>
                            <Form.Item label="模型名称">
                                <Space.Compact style={{ width: "100%" }}>
                                    <Form.Item name="models" noStyle>
                                        <Select mode="tags" maxTagCount="responsive" tokenSeparators={[",", "\n"]} />
                                    </Form.Item>
                                    <Button loading={isFetchingModelNames} onClick={() => void fetchModelNameList()}>拉取列表</Button>
                                </Space.Compact>
                            </Form.Item>
                        </Col>
                        <Col span={24}><Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item></Col>
                    </Row>
                </Form>
            </Drawer>

            <Modal title="选择模型" open={isModelSelectorOpen} width={840} onOk={confirmModelSelection} onCancel={() => setIsModelSelectorOpen(false)}
                footer={<Space><Button onClick={() => setIsModelSelectorOpen(false)}>取消</Button><Button type="primary" onClick={confirmModelSelection}>确定</Button></Space>} destroyOnHidden>
                <Flex vertical gap={14}>
                    <Flex gap={12} wrap>
                        <Input.Search placeholder="搜索模型" allowClear value={modelSelectKeyword} onChange={(e) => setModelSelectKeyword(e.target.value)} style={{ flex: "1 1 260px" }} />
                        <Space.Compact style={{ flex: "1 1 320px" }}>
                            <Input value={modelSelectNewModel} placeholder="输入模型名称" onChange={(e) => setModelSelectNewModel(e.target.value)} onPressEnter={addModelSelectModel} />
                            <Button onClick={addModelSelectModel}>增加</Button>
                        </Space.Compact>
                    </Flex>
                    <Flex justify="space-between" align="center" gap={12} wrap>
                        <Typography.Text type="secondary">已选 {modelSelectSelected.length} 个</Typography.Text>
                        <Space size={8}>
                            <Button size="small" onClick={() => setModelSelectSelected(uniqueModels([...modelSelectSelected, ...visibleModelSelectModels]))}>全选当前</Button>
                            <Button size="small" onClick={() => setModelSelectSelected(modelSelectSelected.filter((item) => !visibleModelSelectModels.includes(item)))}>取消当前</Button>
                        </Space>
                    </Flex>
                    <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--ant-color-border-secondary)", paddingTop: 12 }}>
                        {visibleModelSelectModels.length ? (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 24, rowGap: 12 }}>
                                {visibleModelSelectModels.map((model) => (
                                    <Checkbox key={model} checked={modelSelectSelected.includes(model)} onChange={(e) => {
                                        setModelSelectSelected(e.target.checked ? uniqueModels([...modelSelectSelected, model]) : modelSelectSelected.filter((item) => item !== model));
                                    }}>
                                        <Typography.Text style={{ wordBreak: "break-all" }}>{model}</Typography.Text>
                                    </Checkbox>
                                ))}
                            </div>
                        ) : (
                            <div style={{ padding: "48px 0", textAlign: "center" }}><Typography.Text type="secondary">没有匹配的模型</Typography.Text></div>
                        )}
                    </div>
                </Flex>
            </Modal>

        </main>
    );
}
