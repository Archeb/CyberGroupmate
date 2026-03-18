/**
 * shared/scene.d.ts — 所有 scene 共享的场景信息能力
 *
 * agent 不再主动切换场景，框架根据角色自动注入对应的 API。
 */

declare const scene: {
    /** 当前所在场景名称（框架自动设置） */
    current: string;

    /** 列出所有可用场景及简介 */
    list(): void;

    /** 展示当前场景的完整类型定义（L2） */
    showFullTypes(): void;
};
