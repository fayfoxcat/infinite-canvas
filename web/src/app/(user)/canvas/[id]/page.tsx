import dynamic from "next/dynamic";

const CanvasClientPage = dynamic(() => import("./canvas-client-page"), { ssr: false });

export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function CanvasPage() {
    return <CanvasClientPage />;
}
