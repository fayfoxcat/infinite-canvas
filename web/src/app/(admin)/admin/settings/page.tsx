"use client";

import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Card, Col, Flex, Form, Input, Row, Select, Space, Switch, Typography } from "antd";
import { useEffect, useState } from "react";

import { fetchAdminSettings, saveAdminSettings, type AdminModelChannel, type AdminSettings } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [], textModels: [], imageModels: [], videoModels: [], audioModels: [], modelInfos: [],
            modelCosts: [], defaultModel: "", defaultImageModel: "", defaultVideoModel: "", defaultTextModel: "", defaultAudioModel: "",
            systemPrompt: "", allowCustomChannel: true,
            modelTypeRules: { textModels: "", imageModels: "", videoModels: "", audioModels: "" },
        },
        auth: { allowRegister: true, linuxDo: { enabled: false } },
    },
    private: { channels: [], promptSync: { enabled: true, cron: "*/5 * * * *" }, auth: { linuxDo: { clientId: "", clientSecret: "" } } },
};

function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    return {
        public: {
            modelChannel: {
                availableModels: settings.public?.modelChannel?.availableModels || [],
                textModels: settings.public?.modelChannel?.textModels || [],
                imageModels: settings.public?.modelChannel?.imageModels || [],
                videoModels: settings.public?.modelChannel?.videoModels || [],
                audioModels: settings.public?.modelChannel?.audioModels || [],
                modelInfos: settings.public?.modelChannel?.modelInfos || [],
                modelCosts: (settings.public?.modelChannel?.modelCosts || []).map((c) => ({ model: c.model?.trim() || "", credits: Math.max(0, c.credits || 0) })),
                defaultModel: settings.public?.modelChannel?.defaultModel || "",
                defaultImageModel: settings.public?.modelChannel?.defaultImageModel || "",
                defaultVideoModel: settings.public?.modelChannel?.defaultVideoModel || "",
                defaultTextModel: settings.public?.modelChannel?.defaultTextModel || "",
                defaultAudioModel: settings.public?.modelChannel?.defaultAudioModel || "",
                systemPrompt: settings.public?.modelChannel?.systemPrompt || "",
                allowCustomChannel: settings.public?.modelChannel?.allowCustomChannel !== false,
                modelTypeRules: settings.public?.modelChannel?.modelTypeRules || { textModels: "", imageModels: "", videoModels: "", audioModels: "" },
            },
            auth: { allowRegister: settings.public?.auth?.allowRegister !== false, linuxDo: { enabled: settings.public?.auth?.linuxDo?.enabled === true } },
        },
        private: {
            channels: (settings.private?.channels || []).map((c) => ({ protocol: c.protocol || "openai", name: c.name || "", baseUrl: c.baseUrl || "", apiKey: "", models: (c.models || []).map((m) => m.trim()).filter(Boolean), type: c.type || "", weight: c.weight || 1, enabled: c.enabled !== false, remark: c.remark || "" })),
            promptSync: { enabled: settings.private?.promptSync?.enabled !== false, cron: settings.private?.promptSync?.cron || "*/5 * * * *" },
            auth: { linuxDo: { clientId: settings.private?.auth?.linuxDo?.clientId || "", clientSecret: "" } },
        },
    };
}

function mergeChannelApiKeys(currentChannels: AdminModelChannel[], saved: AdminSettings): AdminSettings {
    return { ...saved, private: { ...saved.private, channels: saved.private.channels.map((item, i) => ({ ...item, apiKey: currentChannels[i]?.apiKey || item.apiKey })) } };
}

export default function AdminSettingsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const publicModels = Form.useWatch(["public", "modelChannel", "availableModels"], form) || [];

    const loadSettings = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const data = normalizeSettings(await fetchAdminSettings(token));
            form.setFieldsValue(data);
        } catch (e) { message.error(e instanceof Error ? e.message : "读取设置失败"); }
        finally { setIsLoading(false); }
    };

    useEffect(() => { void loadSettings(); }, [token]);

    const saveSettings = async () => {
        if (!token) return;
        setIsSaving(true);
        try {
            const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
            const saved = normalizeSettings(await saveAdminSettings(token, values));
            const merged = mergeChannelApiKeys(values.private.channels, saved);
            form.setFieldsValue(merged);
            message.success("已保存");
        } catch (e) { message.error(e instanceof Error ? e.message : "保存失败"); }
        finally { setIsSaving(false); }
    };

    return (
        <main style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap>
                        <Typography.Title level={5} style={{ margin: 0 }}>系统设置</Typography.Title>
                        <Space>
                            <Button icon={<ReloadOutlined />} loading={isLoading} onClick={() => void loadSettings()}>刷新</Button>
                            <Button type="primary" icon={<SaveOutlined />} loading={isSaving} onClick={() => void saveSettings()}>保存设置</Button>
                        </Space>
                    </Flex>
                </Card>

                <Card variant="borderless">
                    <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                        <Flex vertical gap={12}>
                            <Card size="small" title="默认模型">
                                <Row gutter={16}>
                                    <Col xs={24} md={4}><Form.Item name={["public", "modelChannel", "defaultModel"]} label="默认模型"><Select showSearch allowClear options={publicModels.map((m) => ({ label: m, value: m }))} /></Form.Item></Col>
                                    <Col xs={24} md={4}><Form.Item name={["public", "modelChannel", "defaultImageModel"]} label="默认图片模型"><Select showSearch allowClear options={publicModels.map((m) => ({ label: m, value: m }))} /></Form.Item></Col>
                                    <Col xs={24} md={5}><Form.Item name={["public", "modelChannel", "defaultVideoModel"]} label="默认视频模型"><Select showSearch allowClear options={publicModels.map((m) => ({ label: m, value: m }))} /></Form.Item></Col>
                                    <Col xs={24} md={5}><Form.Item name={["public", "modelChannel", "defaultTextModel"]} label="默认文本模型"><Select showSearch allowClear options={publicModels.map((m) => ({ label: m, value: m }))} /></Form.Item></Col>
                                    <Col xs={24} md={6}><Form.Item name={["public", "modelChannel", "defaultAudioModel"]} label="默认音频模型"><Select showSearch allowClear options={publicModels.map((m) => ({ label: m, value: m }))} /></Form.Item></Col>
                                </Row>
                            </Card>

                            <Card size="small" title="系统设置">
                                <Form.Item name={["public", "modelChannel", "systemPrompt"]} label="系统提示词"><Input.TextArea rows={3} /></Form.Item>
                                <Row gutter={16}>
                                    <Col xs={24} md={8}><Form.Item name={["public", "modelChannel", "allowCustomChannel"]} label="允许用户自定义渠道" valuePropName="checked"><Switch /></Form.Item></Col>
                                    <Col xs={24} md={8}><Form.Item name={["public", "auth", "allowRegister"]} label="允许用户注册" valuePropName="checked"><Switch /></Form.Item></Col>
                                </Row>
                            </Card>

                            <Card size="small" title={<Space><img src="/icons/linuxdo.svg" alt="" width={18} height={18} />Linux.do 登录</Space>}>
                                <Typography.Text type="secondary">回调地址 /api/auth/linux-do/callback，<Typography.Link href="https://connect.linux.do" target="_blank" rel="noreferrer">管理 OAuth App</Typography.Link></Typography.Text>
                                <Row gutter={16} style={{ marginTop: 12 }}>
                                    <Col xs={24} md={6}><Form.Item name={["public", "auth", "linuxDo", "enabled"]} label="开启" valuePropName="checked"><Switch /></Form.Item></Col>
                                    <Col xs={24} md={9}><Form.Item name={["private", "auth", "linuxDo", "clientId"]} label="Client ID"><Input placeholder="OAuth App ID" /></Form.Item></Col>
                                    <Col xs={24} md={9}><Form.Item name={["private", "auth", "linuxDo", "clientSecret"]} label="Client Secret"><Input.Password placeholder="留空沿用已保存密钥" autoComplete="off" /></Form.Item></Col>
                                </Row>
                            </Card>

                            <Card size="small" title="提示词定时同步">
                                <Row gutter={16}>
                                    <Col xs={24} md={6}><Form.Item name={["private", "promptSync", "enabled"]} label="开启" valuePropName="checked"><Switch /></Form.Item></Col>
                                    <Col xs={24} md={18}><Form.Item name={["private", "promptSync", "cron"]} label="Cron" extra="默认每 5 分钟同步"><Input placeholder="*/5 * * * *" /></Form.Item></Col>
                                </Row>
                            </Card>
                        </Flex>
                    </Form>
                </Card>
            </Flex>
        </main>
    );
}
