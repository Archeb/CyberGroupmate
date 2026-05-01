/**
 * stores.js — Svelte writable stores for global dashboard state
 */

import { writable, get } from 'svelte/store';
import { api } from './api.js';

// ─── Connection ───
export const wsStatus = writable('disconnected');

// ─── App State (from snapshot) ───
export const appState = writable({
  groups: [],
  metaCodeAct: {
    chatId: '__meta__',
    queueSize: 0,
    sessionSize: 0,
    executionCount: 0,
    isProcessing: false,
    historyBudget: {
      softCharLimit: 18000,
      trimTargetChars: 10000,
      minMessages: 8,
      hardMessageLimit: 48,
      trimTargetMessages: 32,
      currentChars: 0,
      currentMessages: 0,
      willTrimOnNextAppend: false,
    },
  },
  queue: { active: [], dequeued: [], blockedChatIds: [] },
  pendingCallbacks: [],
  globalState: {},
  sandboxPool: {},
  mainLoop: {},
  feedbackLoop: {},
});

// ─── Messages ───
export const messages = writable([]);
const MAX_MESSAGES = 500;
      if (!config.subagent.metaHistory) config.subagent.metaHistory = {};

export function addMessage(data, timestamp) {
  messages.update(msgs => {
    msgs.push({ ...data, timestamp });
    if (msgs.length > MAX_MESSAGES) msgs.shift();
    return msgs;
  });

  // Update group list if new chat, and sync chatTitle/isDirectMessage
  appState.update(s => {
    const existing = s.groups.find(g => g.chatId === data.chatId);
    if (!existing) {
      s.groups.push({
        chatId: data.chatId, engagement: 0, bufferSize: 0,
        topicCount: 0, stickiness: 'STRANGER', attendCount: 0,
        chatTitle: data.chatTitle || '',
        isDirectMessage: !!data.isDirectMessage,
      });
    } else {
      // 如果收到的 chatTitle 比现有更完整，更新它
      if (data.chatTitle && (!existing.chatTitle || existing.chatTitle === data.chatId)) {
        existing.chatTitle = data.chatTitle;
      }
      if (typeof data.isDirectMessage === 'boolean') {
        existing.isDirectMessage = data.isDirectMessage;
      }
    }
    return s;
  });
}

// ─── Tabs ───
export const activeTab = writable('messages');
export const selectedChatId = writable(null);
export const selectedCodeActChatId = writable(null);
export const selectedRecordingChatId = writable(null);

// ─── LLM Logs (progressive loading) ───
export const llmLogs = writable([]);
export const llmStats = writable({ total: 0, success: 0, error: 0, totalTokens: 0, totalCachedTokens: 0, totalCost: 0 });
export const selectedLLMCallId = writable(null);
export const tokenPricing = writable({});
export const llmLogHasMore = writable(false);
export const llmLogLoading = writable(false);
export const llmLogTotal = writable(0);
const MAX_LLM_LOGS = 2000;

/** profile name → model name reverse map (built from snapshot) */
let _modelToProfile = {};

/** Called when pricing config is available (from snapshot) */
export function setTokenPricing(pricing, llmProfiles) {
  tokenPricing.set(pricing || {});
  // Build reverse map: model → profile name  
  if (llmProfiles && typeof llmProfiles === 'object') {
    _modelToProfile = {};
    for (const [name, cfg] of Object.entries(llmProfiles)) {
      if (cfg && cfg.model) _modelToProfile[cfg.model] = name;
    }
  }
}

/** Calculate cost for a single call */
export function calculateCallCost(usage, model) {
  if (!usage) return 0;
  const pricing = get(tokenPricing);
  const profileName = _modelToProfile[model];
  const p = profileName ? pricing[profileName] : undefined;
  if (!p) return 0;

  const M = 1_000_000;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const cached = usage.cachedTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const regularPrompt = Math.max(0, prompt - cached);

  let cost = 0;
  cost += (regularPrompt / M) * p.input;
  cost += (completion / M) * p.output;
  cost += (cached / M) * (p.cachedInput ?? p.input);
  cost += (cacheCreation / M) * (p.cacheCreation ?? p.input);
  return cost;
}

/** 初始加载：从 llm:init 事件接收最近 N 条 log */
export function handleLLMInit(data) {
  const { logs, total, hasMore, stats } = data;
  llmLogs.set(logs || []);
  llmLogTotal.set(total || 0);
  llmLogHasMore.set(!!hasMore);
  // 用后端汇总统计重建 llmStats（含累计 cost）
  const costTotal = (logs || []).reduce((sum, e) => {
    if (e.response && !e.response.error) {
      return sum + calculateCallCost(e.response.usage, e.model);
    }
    return sum;
  }, 0);
  llmStats.set({
    total: stats?.total ?? total ?? 0,
    success: stats?.success ?? 0,
    error: stats?.error ?? 0,
    totalTokens: stats?.totalTokens ?? 0,
    totalCachedTokens: stats?.totalCachedTokens ?? 0,
    totalCost: costTotal,
  });
}

/** 增量：实时接收新的 LLM call */
export function handleLLMCall(data) {
  llmStats.update(s => ({ ...s, total: s.total + 1 }));
  llmLogTotal.update(n => n + 1);
  llmLogs.update(logs => {
    logs.unshift({ ...data, response: null, retries: [] });
    if (logs.length > MAX_LLM_LOGS) logs.pop();
    return logs;
  });
}

export function handleLLMResponse(data) {
  // Find the model for this call
  const logs = get(llmLogs);
  const entry = logs.find(e => e.callId === data.callId);
  const model = entry?.model ?? '';

  llmLogs.update(logs => {
    const e = logs.find(e => e.callId === data.callId);
    if (e) e.response = data;
    return logs;
  });

  const cost = data.error ? 0 : calculateCallCost(data.usage, model);

  llmStats.update(s => {
    if (data.error) {
      s.error++;
    } else {
      s.success++;
    }
    if (data.usage?.totalTokens) {
      s.totalTokens += data.usage.totalTokens;
    }
    if (data.usage?.cachedTokens) {
      s.totalCachedTokens += data.usage.cachedTokens;
    }
    s.totalCost += cost;
    return s;
  });
}

export function handleLLMRetry(data) {
  llmLogs.update(logs => {
    const e = logs.find(e => e.callId === data.callId);
    if (e) {
      if (!e.retries) e.retries = [];
      e.retries.push(data);
    }
    return logs;
  });
}

/** 加载更多历史 LLM logs（分页） */
export async function loadMoreLLMLogs() {
  if (get(llmLogLoading) || !get(llmLogHasMore)) return;
  llmLogLoading.set(true);
  try {
    const currentLogs = get(llmLogs);
    const offset = currentLogs.length;
    const result = await api(`/llm-logs?offset=${offset}&limit=30`);
    if (result && result.logs) {
      llmLogs.update(logs => {
        logs.push(...result.logs);
        return logs;
      });
      llmLogTotal.set(result.total);
      llmLogHasMore.set(result.hasMore);
    }
  } catch (err) {
    console.error('loadMoreLLMLogs error:', err);
  } finally {
    llmLogLoading.set(false);
  }
}

export function clearLLMLogs() {
  llmLogs.set([]);
  llmStats.set({ total: 0, success: 0, error: 0, totalTokens: 0, totalCachedTokens: 0, totalCost: 0 });
  selectedLLMCallId.set(null);
  llmLogHasMore.set(false);
  llmLogTotal.set(0);
}

// ─── Topic Detail ───
export const topicDetailId = writable(null);

// ─── Memory sub-tab ───
export const activeMemoryTab = writable('m-persons');
/** Pending cross-tab navigation payload; consumed by target tab on mount */
export const pendingMemoryLink = writable(null);

// ─── CodeAct Progress (real-time streaming) ───
/** Map<chatId, Array<progressEvent>> — 每个 chat 的实时进度事件列表 */
export const codeActProgress = writable({});

const MAX_PROGRESS_EVENTS = 100;

export function handleCodeActProgress(data) {
  codeActProgress.update(map => {
    const chatId = data.chatId;
    if (!map[chatId]) map[chatId] = [];
    map[chatId].push(data);
    // 限制每个 chat 的事件数量
    if (map[chatId].length > MAX_PROGRESS_EVENTS) {
      map[chatId] = map[chatId].slice(-MAX_PROGRESS_EVENTS);
    }
    return map;
  });
}

/** 清空指定 chat 的进度事件 */
export function clearCodeActProgress(chatId) {
  codeActProgress.update(map => {
    if (chatId) {
      delete map[chatId];
    } else {
      return {};
    }
    return map;
  });
}

// ─── Recording Pipeline Progress ───
/** Map<chatId, Array<recordingEvent>> — 每个 chat 的 recording pipeline 实时事件 */
export const recordingProgress = writable({});

const MAX_RECORDING_EVENTS = 200;

export function handleRecordingEvent(data) {
  recordingProgress.update(map => {
    const chatId = data.chatId;
    if (!map[chatId]) map[chatId] = [];
    map[chatId].push(data);
    if (map[chatId].length > MAX_RECORDING_EVENTS) {
      map[chatId] = map[chatId].slice(-MAX_RECORDING_EVENTS);
    }
    return map;
  });
}
