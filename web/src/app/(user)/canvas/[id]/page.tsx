"use client";

import { useEffect, useState } from "react";
import CanvasClientPage from "./canvas-client-page";

// 静态导出兼容：generateStaticParams 生成 id="_" 占位页面。
// Cloudflare _redirects 把 /canvas/* 重写到 /canvas/_/。
// 客户端从浏览器 URL 提取真实 ID，hydration 期间只渲染空壳避免不匹配。
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);
    if (!mounted) return null;
    return <CanvasClientPage />;
}
