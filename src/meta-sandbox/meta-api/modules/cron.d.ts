/**
 * cron — Meta 周期唤醒 API。
 *
 * 用于注册周期性 Meta 回调。最短触发间隔为 1 小时。
 */

interface CronSetInput {
    name: string;
    /** cron 表达式，最短间隔 1 小时。 */
    cronExpr: string;
    /** 必填：每次触发后要做什么。 */
    callback: string;
    /** composite chatId 或 "meta"，默认 "meta"。 */
    bindingId?: string;
    data?: unknown;
}

interface CronEvent {
    id: string;
    type: "cron";
    bindingId: string;
    name: string;
    callback: string;
    data?: unknown;
    cronExpr?: string;
    createdAt: string;
    lastTriggeredAt?: string;
}

declare const cron: {
    /**
     * 注册周期性 Meta 唤醒。
     *
     * cronExpr 最短间隔为 1 小时。callback 必须写清楚每次触发后要做什么。
     *
     * @param input 周期任务名称、cron 表达式、callback 和可选数据。
     * @returns 创建的 cron。
     * @example
     * await cron.set({
     *   name: "每周检查跨群长期跟进",
     *   cronExpr: "0 9 * * 1",
     *   callback: "检查 meta todo 中所有跨群长期跟进项，决定是否派发或关闭。",
     *   bindingId: "meta"
     * });
     */
    set(input: CronSetInput): Promise<CronEvent>;

    /** 查询周期唤醒。 */
    get(id: string): Promise<CronEvent | null>;

    /** 列出周期唤醒。 */
    list(options?: { bindingId?: string }): Promise<CronEvent[]>;

    /** 删除周期唤醒。 */
    delete(id: string): Promise<boolean>;
};
