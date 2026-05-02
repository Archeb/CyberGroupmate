import type { MemoryStoreV2 } from "../../memory-v2/index.js";

type TodoMemory = Pick<MemoryStoreV2,
    "todoList" |
    "todoGet" |
    "todoUpsert" |
    "todoRemove" |
    "listGroupModels"
>;

export interface TodoSetInput {
    key: string;
    content: string;
    bindingId?: string;
    dueAt?: string | null;
}

export interface TodoListInput {
    bindingId?: string;
    includeExpired?: boolean;
}

export function createTodoApi(memory: TodoMemory) {
    return {
        get: async (key: string, bindingId = "meta") => {
            return memory.todoGet(normalizeBindingId(bindingId), key);
        },
        list: async (options: TodoListInput = {}) => {
            const bindingIds = options.bindingId
                ? [normalizeBindingId(options.bindingId)]
                : uniqueStrings(["meta", ...memory.listGroupModels().map((group) => group.chatId)]);
            return bindingIds.flatMap((bindingId) =>
                memory.todoList(bindingId, { includeExpired: options.includeExpired })
                    .map((item) => ({ ...item, bindingId }))
            );
        },
        set: async (input: TodoSetInput) => {
            const bindingId = normalizeBindingId(input.bindingId);
            return {
                bindingId,
                ...memory.todoUpsert(bindingId, input.key, input.content, input.dueAt ?? null),
            };
        },
        delete: async (key: string, bindingId = "meta") => {
            memory.todoRemove(normalizeBindingId(bindingId), key);
        },
    };
}

function normalizeBindingId(bindingId?: string): string {
    const value = bindingId?.trim();
    return value && value.length > 0 ? value : "meta";
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
