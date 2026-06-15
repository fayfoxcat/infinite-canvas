"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import copyToClipboard from "copy-to-clipboard";
import { Bot, Copy, History, PanelRightClose, Plus, Settings2, Trash2, X } from "lucide-react";
import { Button, Modal, Switch, Tooltip } from "antd";
import { motion } from "motion/react";

import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { requestImageQuestion, type ChatCompletionMessage } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { DiaTextReveal } from "@/components/ui/dia-text-reveal";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { AgentChatComposer, AgentChatMessage, AgentModeSwitch, AgentPanelTabs, AgentWorkingMessage, type CanvasAgentChatMessage, type CanvasAgentMode } from "./canvas-agent-chat-ui";
import { CanvasLocalAgentPanel } from "./canvas-local-agent-panel";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasNodeData } from "../types";
import { useCanvasAgentStore } from "../stores/use-canvas-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";

const PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = PANEL_MOTION_MS / 1000;
const ONLINE_AGENT_MAX_STEPS = 4;
const ONLINE_AGENT_PROMPT =
    '你是 Infinite Canvas 网页内置在线画布助手。你只能返回 JSON，不要 Markdown，不要解释。格式：{"reply":"给用户看的中文说明","ops":[...]}。reply 只能说明“准备执行/等待确认”，不能说“已完成/已删除/已连接/已调整”，因为工具操作需要用户确认后才会执行。工具执行结果返回后，你要判断任务是否完成；完成时返回 ops:[]，未完成时返回下一步 ops。ops 可用类型：add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。add_node 支持 nodeType: text/image/config/video/audio，position:{x,y}，metadata。delete_node 必须带 id/ids，或用 nodeType:"config" 删除全部生成配置节点。delete_connections 可用 all:true 删除全部连线。文本内容放 metadata.content。用户要求生图、生成文字、视频或音频时，不要直接生成最终内容，要创建提示词文本节点、config 节点、connect_nodes，并追加 run_generation 触发画布已有生成工具；config 节点 metadata 至少包含 generationMode、composerContent、prompt、status:"idle"，composerContent/prompt 用 @[node:id] 引用提示词节点或参考节点。只输出能直接 JSON.parse 的对象。';
type OnlineAgentTab = "setup" | "chat" | "history" | "log";
type OnlineAgentLog = { id: string; time: string; title: string; data?: unknown };
type OnlineLoopContext = { step: number; previous?: unknown };

type CanvasAssistantPanelProps = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    snapshot: CanvasAgentSnapshot;
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    onSelectNodeIds: (ids: Set<string>) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onApplyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot;
    canUndoOps: boolean;
    onUndoOps: () => CanvasAgentSnapshot | null;
    onPasteImage: (file: File) => void;
    agentMode: CanvasAgentMode;
    onAgentModeChange: (mode: CanvasAgentMode) => void;
    onCollapseStart: () => void;
    onCollapse: () => void;
};

export function CanvasAssistantPanel({ nodes, selectedNodeIds, snapshot, sessions, activeSessionId, onSelectNodeIds, onSessionsChange, onApplyOps, canUndoOps, onUndoOps, onPasteImage, agentMode, onAgentModeChange, onCollapseStart, onCollapse }: CanvasAssistantPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const effectiveConfig = useEffectiveConfig();
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const confirmTools = useCanvasAgentStore((state) => state.confirmTools);
    const setAgentState = useCanvasAgentStore((state) => state.setAgentState);
    const [width, setWidth] = useState(390);
    const [view, setView] = useState<OnlineAgentTab>("chat");
    const [prompt, setPrompt] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [onlineLogs, setOnlineLogs] = useState<OnlineAgentLog[]>([]);
    const [closing, setClosing] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [localSessions, setLocalSessions] = useState<CanvasAssistantSession[]>(() => (sessions.length ? sessions : [createSession()]));
    const [localActiveSessionId, setLocalActiveSessionId] = useState<string | null>(activeSessionId);
    const snapshotRef = useRef(snapshot);

    useEffect(() => {
        if (!sessions.length) return;
        setLocalSessions(sessions);
        setLocalActiveSessionId(activeSessionId);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);

    useEffect(() => {
        onSessionsChange(localSessions, localActiveSessionId);
    }, [localActiveSessionId, localSessions, onSessionsChange]);

    const safeSessions = localSessions.length ? localSessions : [createSession()];
    const activeSession = useMemo(() => safeSessions.find((session) => session.id === localActiveSessionId) || safeSessions[0] || null, [localActiveSessionId, safeSessions]);
    const historySessions = safeSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const hasMessages = messages.length > 0;
    const activeModel = effectiveConfig.textModel || effectiveConfig.model;
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);
    const allSelectedReferences = useMemo(() => buildAssistantReferences(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const selectedReferences = useMemo(() => allSelectedReferences.filter((item) => !removedReferenceIds.has(item.id)), [allSelectedReferences, removedReferenceIds]);
    const iconButtonStyle = { color: theme.node.muted };

    useEffect(() => {
        setRemovedReferenceIds(new Set());
    }, [selectedNodeKey]);

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        setLocalSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(session) : session)));
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };
    const addOnlineLog = (title: string, data?: unknown) => setOnlineLogs((prev) => [{ id: nanoid(), time: new Date().toLocaleTimeString(), title, data }, ...prev].slice(0, 80));

    const upsertMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => {
            const exists = session.messages.some((item) => item.id === message.id);
            return {
                ...session,
                title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
                messages: exists ? session.messages.map((item) => (item.id === message.id ? { ...item, ...message } : item)) : [...session.messages, message],
                updatedAt: new Date().toISOString(),
            };
        });
    };

    const startChatSession = () => {
        if (activeSession && activeSession.messages.length === 0) {
            setLocalActiveSessionId(activeSession.id);
            return;
        }
        const session = createSession();
        setLocalSessions((prev) => [session, ...prev]);
        setLocalActiveSessionId(session.id);
    };

    const removeSessions = (ids: string[]) => {
        const next = safeSessions.filter((session) => !ids.includes(session.id));
        if (!next.length) {
            const session = createSession();
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        } else {
            setLocalSessions(next);
            setLocalActiveSessionId(localActiveSessionId && ids.includes(localActiveSessionId) ? next[0].id : localActiveSessionId);
        }
        cleanupImages({ sessions: next });
    };

    const clearSessions = () => {
        const session = createSession();
        setLocalSessions([session]);
        setLocalActiveSessionId(session.id);
        cleanupImages({ sessions: [session] });
    };

    const sendMessage = async (text: string, history: CanvasAssistantMessage[], savedReferences?: CanvasAssistantReference[]) => {
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            openConfigDialog(true);
            return;
        }

        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }

        const refs = savedReferences || selectedReferences;
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text, references: refs };
        const assistantId = nanoid();
        appendMessage(session.id, userMessage);
        addOnlineLog("发送请求", { text, selectedNodeIds: snapshotRef.current.selectedNodeIds, nodeCount: snapshotRef.current.nodes.length, connectionCount: snapshotRef.current.connections.length });
        setPrompt("");
        setIsRunning(true);
        void runOnlineAgentStep(session.id, assistantId, history, userMessage, { step: 1 });
    };

    const runOnlineAgentStep = async (sessionId: string, assistantId: string, history: CanvasAssistantMessage[], userMessage: CanvasAssistantMessage, loop: OnlineLoopContext) => {
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        let continued = false;
        try {
            setIsRunning(true);
            addOnlineLog(`Agent Loop ${loop.step} 开始`, loop.previous);
            const answer = await requestImageQuestion({ ...requestConfig, systemPrompt: "" }, await buildAgentMessages(snapshotRef.current, history, userMessage, loop), (streamText) => {
                const reply = partialAgentReply(streamText);
                if (reply) upsertMessage(sessionId, { id: assistantId, role: "assistant", text: pendingReply(reply) });
            });
            addOnlineLog("模型原始回复", answer);
            const result = parseAgentResult(answer);
            addOnlineLog("解析结果", result);
            const ops = normalizeOnlineOps(result.ops, userMessage.text, snapshotRef.current);
            addOnlineLog("归一化操作", ops);
            if (ops.length && sameOps(ops, objectDetail(loop.previous).ops)) {
                addOnlineLog(`Agent Loop ${loop.step} 停止`, { reason: "same_ops", ops });
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: "画布状态已更新，后续操作与上一轮重复，已停止继续执行。" });
                return;
            }
            if (ops.length) {
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: pendingReply(result.reply) });
                const toolMessage: CanvasAssistantMessage = { id: nanoid(), role: "tool", title: confirmTools ? "确认工具调用" : "画布操作执行中", text: summarizeCanvasAgentOps(ops) || "画布操作", detail: { name: "canvas_apply_ops", ops, intent: userMessage.text, assistantId, step: loop.step, status: confirmTools ? "pending" : "running" } };
                appendMessage(sessionId, toolMessage);
                addOnlineLog(confirmTools ? "等待用户确认" : "自动执行工具", { step: loop.step, ops });
                if (!confirmTools) continued = executeOnlineTool(sessionId, toolMessage.id, ops, { assistantId, userMessage, history, step: loop.step });
            } else {
                addOnlineLog(`Agent Loop ${loop.step} 结束`, { reply: result.reply, reason: "no_ops" });
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.reply });
            }
        } catch (error) {
            addOnlineLog("请求失败", error instanceof Error ? error.message : error);
            appendMessage(sessionId, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            if (!continued) setIsRunning(false);
        }
    };

    const executeOnlineTool = (sessionId: string, messageId: string, ops: CanvasAgentOp[], loop?: { assistantId?: string; userMessage?: CanvasAssistantMessage; history?: CanvasAssistantMessage[]; step?: number }) => {
        const beforeSnapshot = snapshotRef.current;
        const before = snapshotSignature(beforeSnapshot);
        const next = onApplyOps(ops);
        snapshotRef.current = next;
        const ranGeneration = ops.some((op) => op.type === "run_generation" && op.nodeId && beforeSnapshot.nodes.some((node) => node.id === op.nodeId));
        const changed = before !== snapshotSignature(next) || ranGeneration;
        const noopReason = changed ? "" : explainNoop(ops, beforeSnapshot);
        addOnlineLog(changed ? "执行成功" : "执行未生效", { ops, ranGeneration, noopReason, before: JSON.parse(before), after: JSON.parse(snapshotSignature(next)) });
        upsertMessage(sessionId, { id: messageId, role: "tool", title: changed ? "画布操作完成" : "画布操作未生效", text: changed ? summarizeCanvasAgentOps(ops) || "画布操作" : noopReason, detail: { name: "canvas_apply_ops", ops, status: changed ? "completed" : "noop", noopReason } });
        if (changed && loop?.assistantId && loop.userMessage) {
            const step = loop.step || 1;
            if (step < ONLINE_AGENT_MAX_STEPS) {
                void runOnlineAgentStep(sessionId, nanoid(), loop.history || [], loop.userMessage, { step: step + 1, previous: { changed, ops, snapshot: compactSnapshot(next) } });
                return true;
            }
            else addOnlineLog("Agent Loop 达到步数上限", { maxSteps: ONLINE_AGENT_MAX_STEPS });
        }
        return false;
    };

    const approveOnlineTool = (messageId: string) => {
        const message = safeSessions.flatMap((session) => session.messages).find((item) => item.id === messageId);
        const detail = objectDetail(message?.detail);
        const ops = normalizeOnlineOps(toolOps(detail), String(detail.intent || ""), snapshotRef.current);
        const session = safeSessions.find((session) => session.messages.some((item) => item.id === messageId));
        addOnlineLog("批准工具", { messageId, ops });
        if (session && ops.length) executeOnlineTool(session.id, messageId, ops, { assistantId: String(detail.assistantId || ""), userMessage: { id: "", role: "user", text: String(detail.intent || "") }, history: messages, step: Number(detail.step) || 1 });
    };

    const rejectOnlineTool = (messageId: string) => {
        const session = safeSessions.find((session) => session.messages.some((item) => item.id === messageId));
        addOnlineLog("拒绝工具", { messageId });
        if (session) upsertMessage(session.id, { id: messageId, role: "tool", title: "已拒绝执行", text: "工具调用已取消", detail: { ...objectDetail(session.messages.find((item) => item.id === messageId)?.detail), status: "rejected" } });
    };

    const submit = async () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        await sendMessage(text, messages);
    };

    const addImagesToCanvas = (files: FileList | File[] | null) => {
        const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
        if (file) onPasteImage(file);
    };

    const startResize = () => {
        const move = (event: MouseEvent) => setWidth(Math.min(760, Math.max(320, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        setClosing(true);
        onCollapseStart();
        window.setTimeout(onCollapse, PANEL_MOTION_MS);
    };

    const onlineContent = (
        <>
            <AgentPanelTabs
                value={view}
                theme={theme}
                items={[
                    { value: "setup", label: "连接配置", icon: <Settings2 className="size-3.5" /> },
                    { value: "chat", label: "对话" },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: historySessions.length },
                    { value: "log", label: "日志", count: onlineLogs.length },
                ]}
                onChange={setView}
                right={
                    <>
                        {view === "history" ? (
                            <Tooltip title="删除全部">
                                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<X className="size-4" />} disabled={!historySessions.length} onClick={() => setDeleteChatIds(historySessions.map((session) => session.id))} />
                            </Tooltip>
                        ) : null}
                        {view === "log" ? (
                            <Tooltip title="复制日志">
                                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Copy className="size-4" />} disabled={!onlineLogs.length} onClick={() => copyToClipboard(formatOnlineLogs(onlineLogs))} />
                            </Tooltip>
                        ) : null}
                        <Tooltip title="新对话">
                            <Button
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8"
                                style={iconButtonStyle}
                                icon={<Plus className="size-4" />}
                                disabled={!hasMessages}
                                onClick={() => {
                                    startChatSession();
                                    setView("chat");
                                }}
                            />
                        </Tooltip>
                        <Tooltip title="配置">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false)} />
                        </Tooltip>
                    </>
                }
            />

            {view === "setup" ? (
                <OnlineAgentSetupView theme={theme} activeModel={activeModel} onOpenConfig={() => openConfigDialog(true)} />
            ) : (
                <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {view === "history" ? (
                        <AssistantHistory
                            sessions={historySessions}
                            activeSession={activeSession}
                            onOpen={(id) => {
                                setLocalActiveSessionId(id);
                                setView("chat");
                            }}
                            onDelete={(id) => setDeleteChatIds([id])}
                        />
                    ) : view === "log" ? (
                        <OnlineAgentLogView logs={onlineLogs} theme={theme} />
                    ) : messages.length ? (
                        <>
                            {messages.map((message) => (
                                <div key={message.id} className="space-y-2">
                                    <AgentChatMessage item={assistantMessageToChatMessage(message)} theme={theme} user={user} onRejectTool={rejectOnlineTool} onApproveTool={approveOnlineTool} />
                                    {message.references?.length ? <MessageReferences message={message} /> : null}
                                </div>
                            ))}
                            {isRunning ? <AgentWorkingMessage theme={theme} /> : null}
                        </>
                    ) : (
                        <div className="flex h-full flex-col items-center justify-center px-1 text-center">
                            <div className="relative font-serif text-4xl font-bold italic tracking-normal" style={{ color: theme.node.text }}>
                                <span>Infinite Canvas</span>
                                <DiaTextReveal className="absolute inset-0" colors={["#A97CF8", "#F38CB8", "#FDCC92"]} textColor="transparent" duration={1.8} startOnView={false} text="Infinite Canvas" />
                            </div>
                            <div className="mt-3 font-serif text-base italic tracking-wide opacity-60">One canvas, infinite ideas</div>
                        </div>
                    )}
                </div>
            )}

            {view === "chat" ? (
                <>
                    {selectedReferences.length ? (
                        <div className="thin-scrollbar flex max-w-full gap-1.5 overflow-x-auto px-3 pb-1">
                            {selectedReferences.map((item, index) => (
                                <AssistantReferenceChip
                                    key={item.id}
                                    item={item}
                                    label={assistantImageReferenceLabel(selectedReferences, index)}
                                    onRemove={() => {
                                        setRemovedReferenceIds((prev) => new Set(prev).add(item.id));
                                        if (selectedNodeIds.has(item.id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== item.id)));
                                    }}
                                />
                            ))}
                        </div>
                    ) : null}
                    <AgentChatComposer
                        prompt={prompt}
                        sending={isRunning}
                        placeholder="描述你想让 Agent 如何操作画布"
                        theme={theme}
                        onPromptChange={setPrompt}
                        onSubmit={submit}
                        onAddFiles={addImagesToCanvas}
                        left={
                            <>
                                <CanvasPromptLibrary onSelect={setPrompt} />
                                <button type="button" className="max-w-[180px] truncate rounded-full px-2 py-1 text-xs opacity-60 transition hover:opacity-100" style={{ background: theme.node.fill, color: theme.node.text }} onClick={() => openConfigDialog(true)} title="配置文本模型">
                                    {activeModel || "配置模型"}
                                </button>
                            </>
                        }
                    />
                </>
            ) : null}

            <Modal
                title="删除对话记录？"
                open={deleteChatIds.length > 0}
                centered
                onCancel={() => setDeleteChatIds([])}
                footer={
                    <>
                        <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                        <Button
                            danger
                            type="primary"
                            onClick={() => {
                                deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                setDeleteChatIds([]);
                            }}
                        >
                            删除
                        </Button>
                    </>
                }
            >
                <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销。</p>
            </Modal>
        </>
    );

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <header className="flex h-14 items-center justify-between border-b px-4" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="grid size-8 place-items-center rounded-lg">
                            <Bot className="size-4" />
                        </span>
                        <div className="min-w-0">
                            <div className="text-base font-semibold leading-5">Agent</div>
                            <div className="truncate text-xs" style={{ color: theme.node.muted }}>
                                画布助手
                            </div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <AgentModeSwitch value={agentMode} theme={theme} onChange={onAgentModeChange} />
                        <label className="flex items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                            <Switch size="small" checked={confirmTools} onChange={(confirmTools) => setAgentState({ confirmTools })} />
                            工具确认
                        </label>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<PanelRightClose className="size-4" />} onClick={collapse} />
                        </Tooltip>
                    </div>
                </header>
                {agentMode === "local" ? (
                    <CanvasLocalAgentPanel
                        embedded
                        snapshot={snapshot}
                        canUndoOps={canUndoOps}
                        onApplyOps={onApplyOps}
                        onUndoOps={onUndoOps}
                    />
                ) : (
                    onlineContent
                )}
            </motion.aside>
        </motion.div>
    );
}

function AssistantHistory({
    sessions,
    activeSession,
    onOpen,
    onDelete,
}: {
    sessions: CanvasAssistantSession[];
    activeSession: CanvasAssistantSession | null;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="space-y-3">
            <div className="text-sm" style={{ color: theme.node.muted }}>
                {sessions.length ? `${sessions.length} 条历史` : "暂无历史"}
            </div>
            {sessions.map((session) => (
                <div key={session.id} className="rounded-lg border px-2.5 py-1.5 transition" style={{ borderColor: session.id === activeSession?.id ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}>
                    <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                                {session.id === activeSession?.id ? <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>当前</span> : null}
                                <div className="truncate text-sm font-medium leading-5">{session.title}</div>
                            </div>
                            <div className="truncate text-[11px] leading-4 opacity-65">{sessionPreview(session)}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <span className="text-[10px] opacity-55">{formatSessionTime(session.updatedAt || session.createdAt)}</span>
                            <Button size="small" className="!h-6 !px-2" onClick={() => onOpen(session.id)}>
                                进入
                            </Button>
                            <Tooltip title="删除记录">
                                <Button size="small" danger type="text" className="!h-6 !w-6 !min-w-6" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(session.id)} />
                            </Tooltip>
                        </div>
                    </div>
                </div>
            ))}
            {!sessions.length ? (
                <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                    网站 Agent 的对话记录会显示在这里
                </div>
            ) : null}
        </div>
    );
}

function OnlineAgentSetupView({ theme, activeModel, onOpenConfig }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; activeModel: string; onOpenConfig: () => void }) {
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">连接配置</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        网站 Agent 直接使用当前网页配置的文本模型和 API。
                    </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium leading-5">文本模型</div>
                            <div className="mt-1 truncate text-xs leading-5" style={{ color: theme.node.muted }}>
                                {activeModel || "未配置模型"}
                            </div>
                        </div>
                        <Button className="!h-8 !px-3" type="primary" icon={<Settings2 className="size-4" />} onClick={onOpenConfig}>
                            配置
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function OnlineAgentLogView({ logs, theme }: { logs: OnlineAgentLog[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="space-y-2">
            {!logs.length ? <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>网站 Agent 的排查日志会显示在这里</div> : null}
            {logs.map((log) => (
                <details key={log.id} className="rounded-lg border px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                    <summary className="cursor-pointer list-none text-sm font-medium">
                        {log.title}
                        <span className="ml-2 text-xs font-normal opacity-50">{log.time}</span>
                    </summary>
                    {log.data !== undefined ? <pre className="thin-scrollbar mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5" style={{ color: theme.node.muted }}>{stringifyLog(log.data)}</pre> : null}
                </details>
            ))}
        </div>
    );
}

function MessageReferences({ message }: { message: CanvasAssistantMessage }) {
    return (
        <div className={`flex max-w-[88%] flex-wrap gap-2 ${message.role === "user" ? "ml-auto justify-end" : "ml-11 justify-start"}`}>
            {message.references?.map((item, index, references) => (
                <AssistantReferenceChip key={item.id} item={item} label={assistantImageReferenceLabel(references, index)} />
            ))}
        </div>
    );
}

function AssistantReferenceChip({ item, label, onRemove }: { item: CanvasAssistantReference; label?: string; onRemove?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const text = (item.text || item.title).replace(/\s+/g, " ").trim().slice(0, 1) || "文";
    return (
        <div className="group/chip relative inline-flex h-8 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            {item.dataUrl ? (
                <span className="relative block size-8 shrink-0">
                    <img src={item.dataUrl} alt="" className="size-8 rounded-lg object-cover" />
                    {label ? <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-medium leading-none text-white">{label}</span> : null}
                </span>
            ) : (
                <span className="grid size-8 place-items-center rounded-lg border text-sm font-medium" style={{ background: theme.node.panel, borderColor: theme.node.activeStroke }}>
                    {text}
                </span>
            )}
            {onRemove ? (
                <button
                    type="button"
                    className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover/chip:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}
                    onClick={onRemove}
                    aria-label="移除引用"
                >
                    <X className="size-3" />
                </button>
            ) : null}
        </div>
    );
}

function assistantImageReferenceLabel(references: CanvasAssistantReference[], index: number) {
    if (!references[index]?.dataUrl) return undefined;
    const imageIndex = references.slice(0, index + 1).filter((item) => item.dataUrl).length - 1;
    return imageIndex >= 0 ? imageReferenceLabel(imageIndex) : undefined;
}

function assistantMessageToChatMessage(message: CanvasAssistantMessage): CanvasAgentChatMessage {
    return { id: message.id, role: message.role, title: message.title, text: message.text, meta: message.meta, detail: message.detail };
}

function formatSessionTime(value?: string) {
    return value ? new Date(value).toLocaleString() : "";
}

function sessionPreview(session: CanvasAssistantSession) {
    return session.messages.at(-1)?.text || `${session.messages.length} 条消息`;
}

function objectDetail(value: unknown) {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toolOps(value: unknown) {
    const ops = objectDetail(value).ops;
    return Array.isArray(ops) ? (ops as CanvasAgentOp[]) : [];
}

function sameOps(a: CanvasAgentOp[], b: unknown) {
    return Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
}

function stringifyLog(value: unknown) {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatOnlineLogs(logs: OnlineAgentLog[]) {
    return logs.map((log) => [`[${log.time}] ${log.title}`, log.data === undefined ? "" : stringifyLog(log.data)].filter(Boolean).join("\n")).join("\n\n");
}

function pendingReply(text: string) {
    return text
        .replace(/已(?:经)?完成/g, "准备执行")
        .replace(/已(?:经)?删除/g, "准备删除")
        .replace(/已(?:经)?连接/g, "准备连接")
        .replace(/已(?:经)?调整/g, "准备调整")
        .replace(/已(?:经)?整理/g, "准备整理")
        .replace(/已(?:经)?移动/g, "准备移动")
        .replace(/已(?:经)?创建/g, "准备创建")
        .replace(/已(?:经)?帮你/g, "准备帮你")
        .replace(/已(?:经)?将/g, "准备将");
}

function normalizeOnlineOps(ops: CanvasAgentOp[], intent: string, snapshot: CanvasAgentSnapshot) {
    if (/删|删除|移除|清空/.test(intent) && /连线|连接线|线条|边/.test(intent)) return snapshot.connections.length ? [...ops.filter((op) => op.type !== "connect_nodes"), { type: "delete_connections", all: true }] : ops;
    if (/删|删除|移除/.test(intent) && /生成配置|配置节点|config/i.test(intent)) {
        const ids = snapshot.nodes.filter((node) => node.type === CanvasNodeType.Config).map((node) => node.id);
        return ids.length ? (ops.some((op) => op.type === "delete_node") ? ops.map((op) => (op.type === "delete_node" && !op.id && !op.ids?.length ? { ...op, ids } : op)) : [...ops, { type: "delete_node", ids }]) : ops;
    }
    if (/连线|连接|串联/.test(intent)) {
        const nodes = snapshot.nodes.filter((node) => node.type !== CanvasNodeType.Config).sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
        const links = nodes.slice(1).map((node, index) => ({ type: "connect_nodes" as const, fromNodeId: nodes[index].id, toNodeId: node.id }));
        return links.length && !ops.some((op) => op.type === "connect_nodes" && op.fromNodeId && op.toNodeId) ? [...ops, ...links] : ops;
    }
    return ops;
}

function snapshotSignature(snapshot: CanvasAgentSnapshot) {
    return JSON.stringify({ nodes: snapshot.nodes, connections: snapshot.connections, selectedNodeIds: snapshot.selectedNodeIds, viewport: snapshot.viewport });
}

function explainNoop(ops: CanvasAgentOp[], snapshot: CanvasAgentSnapshot) {
    if (!ops.length) return "模型没有返回可执行的画布操作。";
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    const connectionIds = new Set(snapshot.connections.map((conn) => conn.id));
    const deleteConnectionOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "delete_connections" }> => op.type === "delete_connections");
    const connectOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "connect_nodes" }> => op.type === "connect_nodes");
    const deleteNodeOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "delete_node" }> => op.type === "delete_node");
    const updateOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "update_node" }> => op.type === "update_node");
    const selectOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "select_nodes" }> => op.type === "select_nodes");
    const generationOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation");
    if (deleteConnectionOps.length && !snapshot.connections.length) return "画布当前没有连线可删除。";
    if (deleteConnectionOps.length && deleteConnectionOps.every((op) => !op.all && [...(op.ids || []), ...(op.id ? [op.id] : [])].every((id) => !connectionIds.has(id)))) return "没有找到要删除的连线。";
    if (connectOps.length && connectOps.every((op) => snapshot.connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId))) return "这些节点已经存在对应连线，无需重复连接。";
    if (connectOps.length && connectOps.every((op) => !nodeIds.has(op.fromNodeId) || !nodeIds.has(op.toNodeId))) return "没有找到要连接的节点。";
    if (deleteNodeOps.length && deleteNodeOps.every((op) => op.nodeType === CanvasNodeType.Config) && !snapshot.nodes.some((node) => node.type === CanvasNodeType.Config)) return "画布当前没有生成配置节点可删除。";
    if (deleteNodeOps.length && deleteNodeOps.every((op) => [...(op.ids || []), ...(op.id ? [op.id] : [])].every((id) => !nodeIds.has(id)))) return "没有找到要删除的节点。";
    if (updateOps.length && updateOps.every((op) => !nodeIds.has(op.id))) return "没有找到要更新的节点。";
    if (selectOps.length && selectOps.every((op) => !(op.ids || []).some((id) => nodeIds.has(id)))) return "没有找到要选择的节点。";
    if (generationOps.length && generationOps.every((op) => !nodeIds.has(op.nodeId))) return "没有找到要触发生成的节点。";
    if (ops.every((op) => op.type === "set_viewport")) return "视图已经是目标状态。";
    if (selectOps.length && selectOps.every((op) => JSON.stringify(op.ids || []) === JSON.stringify(snapshot.selectedNodeIds))) return "选区已经是目标状态。";
    return "工具已执行，但画布状态没有变化；请在日志 tab 查看归一化操作和执行前后状态。";
}

function nodeToReference(node: CanvasNodeData): CanvasAssistantReference | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
    }
    if (node.type === CanvasNodeType.Text && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, text: node.metadata.content };
    }
    return null;
}

function buildAssistantReferences(nodes: CanvasNodeData[], selectedNodeIds: Set<string>) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return Array.from(selectedNodeIds)
        .map((id) => nodeById.get(id))
        .filter((node): node is CanvasNodeData => Boolean(node))
        .map(nodeToReference)
        .filter((item): item is CanvasAssistantReference => Boolean(item));
}

async function buildAgentMessages(snapshot: CanvasAgentSnapshot, history: CanvasAssistantMessage[], userMessage: CanvasAssistantMessage, loop?: OnlineLoopContext): Promise<ChatCompletionMessage[]> {
    const refs = userMessage.references || [];
    const loopText = loop?.previous ? `\n\n上一轮工具执行结果：${JSON.stringify(loop.previous)}\n请判断用户任务是否已经完成。完成则返回 {"reply":"完成说明","ops":[]}；未完成则只返回下一步 ops。` : "";
    return [
        { role: "system", content: ONLINE_AGENT_PROMPT },
        ...history.slice(-8).map((message): ChatCompletionMessage => ({ role: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant", content: message.text })),
        {
            role: "user",
            content: [
                ...refs.flatMap((item) => (item.text ? [{ type: "text" as const, text: `选中节点 ${item.title}：${item.text}` }] : [])),
                { type: "text", text: `当前画布：${JSON.stringify(compactSnapshot(snapshot))}\n\n用户需求：${userMessage.text}${loopText}` },
                ...(await Promise.all(refs.filter((item) => item.dataUrl).map(async (item) => ({ type: "image_url" as const, image_url: { url: await imageToDataUrl(item) } })))),
            ],
        },
    ];
}

function compactSnapshot(snapshot: CanvasAgentSnapshot) {
    return {
        title: snapshot.title,
        viewport: snapshot.viewport,
        selectedNodeIds: snapshot.selectedNodeIds,
        nodes: snapshot.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            width: node.width,
            height: node.height,
            metadata: compactMetadata(node.metadata || {}),
        })),
        connections: snapshot.connections,
    };
}

function compactMetadata(metadata: CanvasNodeData["metadata"]) {
    return {
        content: String(metadata?.content || "").slice(0, 500),
        prompt: String(metadata?.prompt || metadata?.composerContent || "").slice(0, 500),
        status: metadata?.status,
        generationMode: metadata?.generationMode,
        model: metadata?.model,
        size: metadata?.size,
    };
}

function parseAgentResult(text: string): { reply: string; ops: CanvasAgentOp[] } {
    const payload = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { reply?: unknown; ops?: unknown };
    const ops = Array.isArray(payload.ops) ? (payload.ops.filter((op) => op && typeof op === "object" && typeof (op as CanvasAgentOp).type === "string") as CanvasAgentOp[]) : [];
    return { reply: String(payload.reply || (ops.length ? "已完成画布操作" : "没有需要执行的画布操作")), ops };
}

function partialAgentReply(text: string) {
    const match = text.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (!match) return "";
    try {
        return JSON.parse(`"${match[1].replace(/\\?$/, "")}"`);
    } catch {
        return match[1];
    }
}

function createSession(): CanvasAssistantSession {
    const now = new Date().toISOString();
    return { id: nanoid(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}
