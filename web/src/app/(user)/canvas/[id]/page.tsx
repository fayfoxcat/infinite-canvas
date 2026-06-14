import CanvasPageShell from "./canvas-page-shell";

export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function CanvasPage() {
    return <CanvasPageShell />;
}
