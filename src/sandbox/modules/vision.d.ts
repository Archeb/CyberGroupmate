/**
 * modules/vision.d.ts — Vision 视觉模块类型定义
 *
 * 提供图片识别能力，让 Agent 可以"看到"图片并理解其内容。
 * 图片路径限定在 workspace/ 目录下。
 *
 * vision: VisionModule — 全局可用
 */

interface VisionModule {
    /**
     * 看图：读取一张或多张图片文件，返回每张图片的文字描述。
     * 使用 Vision LLM 分析图片内容，支持 JPEG、PNG、WebP 等常见格式。
     *
     * @param imagePaths - 图片文件路径（支持绝对路径或相对于 workspace/ 的相对路径），可传入多个参数
     * @returns 每张图片的详细文字描述数组（与输入路径一一对应）
     *
     * @example
     * // 查看单张图片
     * const [desc] = await vision.see("screenshots/page.png");
     * console.log(desc);
     *
     * @example
     * // 同时查看多张图片
     * const descriptions = await vision.see("img1.jpg", "img2.png", "data/chart.png");
     * descriptions.forEach((d, i) => console.log(`图片${i+1}: ${d}`));
     */
    see(...imagePaths: string[]): Promise<string[]>;
}

declare const vision: VisionModule;
