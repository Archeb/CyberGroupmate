/**
 * context-engine/index.ts — 公共导出
 */

export { ContextEngine, contextEvents } from "./context-engine.js";
export { ContextLedger } from "./context-ledger.js";
export { renderPrompt, renderTemplate, loadTemplate } from "./template-engine.js";
export type {
    SectionProvider,
    SectionSchema,
    SectionNode,
    RenderResult,
    ResolveContext,
    ContextManifest,
    SectionManifestEntry,
    CacheStrategy,
    HistoryStrategy,
    DeltaStats,
    DiffResult,
    CommittedSection,
} from "./types.js";
