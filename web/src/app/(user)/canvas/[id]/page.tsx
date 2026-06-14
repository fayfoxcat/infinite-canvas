import CanvasPageShell from "./canvas-page-shell";

// 静态导出兼容：生成 id="_" 占位页面，
// Cloudflare _redirects 把 /canvas/* 重写到 /canvas/_/。
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function CanvasPage() {
    return <CanvasPageShell />;
}
