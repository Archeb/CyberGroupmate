/**
 * remind — Meta 一次性唤醒 API。
 *
 * 用于注册未来某个时间点的 Meta 回调。需要未来唤醒时使用 remind.set()，不要用 setTimeout / setInterval。
 */

interface ReminderSetInput {
    name: string;
    /** 必填：被唤醒后要做什么。 */
    callback: string;
    /** composite chatId 或 "meta"，默认 "meta"。 */
    bindingId?: string;
    /** ISO 时间；与 delayMinutes 二选一。 */
    triggerAt?: string;
    /** 延迟分钟数；与 triggerAt 二选一。 */
    delayMinutes?: number;
    data?: unknown;
}

interface SchedulerListInput {
    bindingId?: string;
    includeTriggered?: boolean;
}

interface ReminderEvent {
    id: string;
    type: "reminder";
    bindingId: string;
    name: string;
    callback: string;
    data?: unknown;
    triggerAt?: string;
    createdAt: string;
    triggered?: boolean;
}

declare const remind: {
    /**
     * 注册一次性 Meta 唤醒。
     *
     * callback 必须写清楚被唤醒后要做什么。triggerAt 和 delayMinutes 二选一。
     *
     * @param input 唤醒名称、callback、触发时间和可选数据。
     * @returns 创建的 reminder。
     * @example
     * const reminder = await remind.set({
     *   name: "检查跨群回复",
     *   delayMinutes: 15,
     *   callback: "检查 C 群 API 网关选型回复结果；如果有追问，查询最近消息并决定是否再次派发。",
     *   bindingId: "telegram:-1001111111111"
     * });
     * console.log(reminder.id);
     */
    set(input: ReminderSetInput): Promise<ReminderEvent>;

    /** 查询一次性唤醒。 */
    get(id: string): Promise<ReminderEvent | null>;

    /** 列出一次性唤醒。 */
    list(options?: SchedulerListInput): Promise<ReminderEvent[]>;

    /** 删除一次性唤醒。 */
    delete(id: string): Promise<boolean>;
};
