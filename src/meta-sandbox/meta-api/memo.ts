import type { GlobalState } from "../../main-agent/global-state.js";

type MemoStateReader = Pick<GlobalState, "memoSet" | "memoGet" | "memoDelete" | "memoList">;

export function createMemoApi(globalState: MemoStateReader) {
    return {
        set: async (key: string, value: unknown, ttlMinutes?: number): Promise<void> => {
            globalState.memoSet(key, value, ttlMinutes);
        },
        get: async (key: string): Promise<unknown | null> => {
            return globalState.memoGet(key);
        },
        delete: async (key: string): Promise<void> => {
            globalState.memoDelete(key);
        },
        list: async (): Promise<Array<{ key: string; value: unknown; expiresAt?: string }>> => {
            return globalState.memoList();
        },
    };
}