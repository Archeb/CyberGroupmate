/**
 * todo — Meta 跨会话/跨绑定 Todo API。
 *
 * 可用于记录跨群跟进事项。bindingId 可以是 composite chatId，也可以是 "meta"；默认 "meta"。
 */

interface MetaTodoSetInput {
    key: string;
    content: string;
    bindingId?: string;
    dueAt?: string | null;
}

interface MetaTodoListInput {
    bindingId?: string;
    includeExpired?: boolean;
}

interface MetaTodoItem {
    bindingId: string;
    key: string;
    content: string;
    dueAt?: string | null;
    createdAt: string;
    updatedAt: string;
    expired: boolean;
}

declare const todo: {
    /**
     * 新增或更新一个 Meta Todo。
     *
     * @param input Todo key、content、可选 bindingId 和 dueAt。
     * @returns 写入后的 Todo。
     * @example
     * await todo.set({
     *   key: "pending_crossgroup_reply",
     *   content: "检查 C 群 API 网关跨群回复是否需要继续跟进",
     *   bindingId: "telegram:-1001111111111"
     * });
     */
    set(input: MetaTodoSetInput): Promise<MetaTodoItem>;

    /**
     * 获取一个 Todo。
     *
     * @param key Todo key。
     * @param bindingId composite chatId 或 "meta"，默认 "meta"。
     * @returns 找到的 Todo；不存在时返回 null。
     */
    get(key: string, bindingId?: string): Promise<Omit<MetaTodoItem, "bindingId"> | null>;

    /**
     * 列出 Todo。未传 bindingId 时会列出 meta 和所有群绑定的 Todo。
     *
     * @param options 可选 bindingId 和 includeExpired。
     * @returns Todo 列表。
     */
    list(options?: MetaTodoListInput): Promise<MetaTodoItem[]>;

    /**
     * 删除一个 Todo。
     *
     * @param key Todo key。
     * @param bindingId composite chatId 或 "meta"，默认 "meta"。
     */
    delete(key: string, bindingId?: string): Promise<void>;
};
