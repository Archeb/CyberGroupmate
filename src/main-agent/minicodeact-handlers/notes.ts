/**
 * minicodeact-handlers/notes.ts — notes 命名空间处理器
 *
 * 提供 notes.add / notes.remove
 */

import { registerHandlers, type MiniCodeActHandler, type MiniCodeActDeps } from "../minicodeact-executor.js";

function handler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const h = fn as MiniCodeActHandler;
    h.describe = descFn;
    return h;
}

registerHandlers("notes", {
    add: handler(
        (args, chatId, deps) => {
            const content = args.content as string;
            if (!content) {
                throw new Error("missing required arg: content");
            }
            const tags = (args.tags as string[]) ?? [];
            const relatedChatId = (args.relatedChatId as string) ?? chatId;
            const expiresAt = args.expiresAt as string | undefined;
            const note = deps.globalState.addNote(content, tags, relatedChatId, expiresAt);
            return { noteId: note.id };
        },
        (args) => {
            const content = String(args.content ?? "").slice(0, 30);
            return `已添加笔记: "${content}${String(args.content ?? "").length > 30 ? "..." : ""}"`;
        },
    ),

    remove: handler(
        (args, _chatId, deps) => {
            const noteId = args.noteId as string;
            if (!noteId) {
                throw new Error("missing required arg: noteId");
            }
            const success = deps.globalState.removeNote(noteId);
            return { success };
        },
        (args) => `已删除笔记: ${args.noteId}`,
    ),
});
