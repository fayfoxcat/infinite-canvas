"use client";

import dynamic from "next/dynamic";

const CanvasClientPage = dynamic(() => import("./canvas-client-page"), { ssr: false });

export default function CanvasPageShell() {
    return <CanvasClientPage />;
}
