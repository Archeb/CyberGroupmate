/**
 * modules/vision.ts — Vision 视觉模块
 *
 * 通过 callHost 代理到 Host 侧的 Vision 处理。
 * 让 Agent 可以"看到"workspace 内的图片文件。
 */

export interface VisionCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: VisionCallbacks | null = null;

/**
 * 注入 Host 通信回调（由 sandbox-worker 调用）
 */
export function setVisionCallbacks(callbacks: VisionCallbacks): void {
    _callbacks = callbacks;
}

export const visionModule = {
    /**
     * 看图：读取一张或多张图片文件，返回每张图片的文字描述。
     * 使用 Vision LLM 分析图片内容。
     *
     * @param imagePaths - 图片文件路径列表
     * @returns 每张图片的详细文字描述数组
     */
    see: async (...imagePaths: string[]): Promise<string[]> => {
        if (!_callbacks) throw new Error("Vision module not initialized");
        if (imagePaths.length === 0) throw new Error("vision.see() 至少需要传入一个图片路径");
        const result = await _callbacks.callHost("vision.see", imagePaths);
        return result as string[];
    },
};
