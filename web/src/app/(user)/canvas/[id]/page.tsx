import CanvasClientPage from "./canvas-client-page";

// 静态导出兼容：生成一个占位页面，实际路由由客户端的 useParams 从 URL 中提取真实 ID
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function CanvasPage() {
    return <CanvasClientPage />;
}
