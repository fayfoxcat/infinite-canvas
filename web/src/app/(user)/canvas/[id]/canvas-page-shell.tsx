"use client";

import { useEffect, useState } from "react";
import CanvasClientPage from "./canvas-client-page";

// hydrate 期间返回 null（与静态 HTML 一致），mounted 后渲染真实内容。
export default function CanvasPageShell() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);
    if (!mounted) return null;
    return <CanvasClientPage />;
}
