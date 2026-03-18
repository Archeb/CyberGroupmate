/**
 * shared/skills.d.ts — 所有 scene 共享的代码型 skills 能力
 */

declare const skills: {
    memory: {
        recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>;
        browseForAnswer(request: Record<string, unknown>): Promise<unknown>;
    };
    social: {
        replyInTelegram(
            chatId: number | string,
            text: string,
            opts?: { replyTo?: number }
        ): Promise<unknown>;
    };
};
