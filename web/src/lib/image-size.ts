const IMAGE_RESOLUTION_BASE: Record<string, number> = {
    "1k": 1024,
    "2k": 2048,
    "4k": 2880,
};

const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

export function normalizeImageQuality(quality: string | undefined) {
    const value = (quality || "").trim().toLowerCase();
    return ["low", "medium", "high"].includes(value) ? value : undefined;
}

export function normalizeImageResolution(resolution: string | undefined) {
    const value = (resolution || "").trim().toLowerCase();
    return IMAGE_RESOLUTION_BASE[value] ? value : "1k";
}

export function imageResolutionLabel(value: string | undefined) {
    return ({ "1k": "1K", "2k": "2K", "4k": "4K" } as Record<string, string>)[normalizeImageResolution(value)];
}

export function normalizeImageSizeValue(size: string | undefined) {
    const value = (size || "").trim();
    const legacy = parseLegacyResolutionSize(value);
    return legacy?.ratio || value || "auto";
}

export function inferImageResolutionFromSize(size: string | undefined) {
    const value = (size || "").trim().toLowerCase();
    const legacy = parseLegacyResolutionSize(value);
    if (legacy) return legacy.resolution;
    const dimensions = parseImageDimensions(value);
    if (!dimensions) return undefined;
    const longEdge = Math.max(dimensions.width, dimensions.height);
    if (longEdge >= 2800) return "4k";
    if (longEdge >= 1800) return "2k";
    return "1k";
}

export function resolveImageRequestSize(resolution: string | undefined, size: string | undefined) {
    const value = (size || "").trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    const legacy = parseLegacyResolutionSize(value);
    if (legacy) return resolveRatioSize(legacy.resolution, legacy.ratio);
    if (value.includes(":")) return resolveRatioSize(normalizeImageResolution(resolution || ""), value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

export function resolveImageDisplayDimensions(size: string | undefined, resolution: string | undefined, fallback: { width: number; height: number }) {
    const value = (size || "").trim();
    const dimensions = parseImageDimensions(value);
    if (dimensions) return dimensions;
    const legacy = parseLegacyResolutionSize(value);
    const ratio = legacy?.ratio || (value.includes(":") ? value : "");
    if (!ratio) return fallback;
    try {
        const resolved = resolveRatioSize(legacy?.resolution || normalizeImageResolution(resolution), ratio);
        return parseImageDimensions(resolved) || fallback;
    } catch {
        return fallback;
    }
}

function resolveRatioSize(resolution: string, ratio: string) {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = IMAGE_RESOLUTION_BASE[normalizeImageResolution(resolution)];
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    const targetPixels = basePixels * basePixels;
    const longSideRaw = Math.sqrt(targetPixels * longRatio);
    const longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseLegacyResolutionSize(value: string) {
    const match = value.match(/^(.+)-(1k|2k|4k)$/i);
    return match ? { ratio: match[1], resolution: normalizeImageResolution(match[2]) } : null;
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    if (Math.max(w, h) / Math.min(w, h) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return { width: w, height: h };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}
