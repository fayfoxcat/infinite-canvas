"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = typeof window !== "undefined" ? (process.env.NEXT_PUBLIC_API_BASE_URL || "") : "";
const HEALTH_URL = `${API_BASE}/api/health`;
const POLL_INTERVAL_MS = 30_000;

export type BackendHealth = {
    connected: boolean;
    checking: boolean;
    lastChecked: Date | null;
    error: string | null;
};

export function useBackendHealth(): [BackendHealth, () => void] {
    const [connected, setConnected] = useState(false);
    const [checking, setChecking] = useState(false);
    const [lastChecked, setLastChecked] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);

    const check = useCallback(async () => {
        setChecking(true);
        setError(null);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(HEALTH_URL, { signal: controller.signal, cache: "no-store" });
            clearTimeout(timeout);
            const text = await response.text();
            setConnected(response.ok && text.trim() === "ok");
            setLastChecked(new Date());
        } catch (err) {
            setConnected(false);
            setError(err instanceof Error ? err.message : "连接检查失败");
            setLastChecked(new Date());
        } finally {
            setChecking(false);
        }
    }, []);

    useEffect(() => {
        void check();
        timer.current = setInterval(() => {
            void check();
        }, POLL_INTERVAL_MS);
        return () => {
            if (timer.current) clearInterval(timer.current);
        };
    }, [check]);

    return [{ connected, checking, lastChecked, error }, check];
}
