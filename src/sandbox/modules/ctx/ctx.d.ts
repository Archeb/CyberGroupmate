/**
 * shared/ctx.d.ts — 跨 turn 持久化的用户 state bag
 *
 * ctx 是一个空对象，LLM 可以用它在多个代码执行 turn 之间存储任意状态。
 * 例如：ctx.data = await fetch(...); 下一轮可以读取 ctx.data
 *
 * 注意：ctx 上不再挂载平台 API。
 * 平台 API 通过顶层变量访问：telegram.xxx 或 discord.xxx
 */

declare const ctx: Record<string, any>;
