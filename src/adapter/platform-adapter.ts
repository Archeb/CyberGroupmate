/**
 * platform-adapter.ts — 平台接入抽象
 *
 * 定义平台 adapter 的统一接口。
 * 平台连接、消息监听、消息标准化、以及面向 sandbox 的 host-call
 * 都应通过官方 adapter 暴露，而不是由 bootstrap 代码自行创建监听器。
 */

export interface PlatformAdapter {
    readonly platform: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    canHandle(method: string): boolean;
    handleCall(method: string, args: unknown[]): Promise<unknown>;
    getSceneTypeDefs?(scene: string, baseTypeDefs: string): string | undefined;
    /** 返回该平台的写操作方法名列表，用于 sandbox 安全限制 */
    getWriteMethods(): string[];
    /** 通过 adapter 下载媒体文件（各平台下载逻辑不同） */
    downloadMedia?(rawMessage: unknown, mediaRef: string): Promise<Buffer>;
}
