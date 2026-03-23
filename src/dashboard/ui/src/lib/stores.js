/**
 * stores.js — Svelte writable stores for global dashboard state
 */

import { writable, get } from 'svelte/store';

// ─── Connection ───
export const wsStatus = writable('disconnected');

// ─── App State (from snapshot) ───
export const appState = writable({
  groups: [],
  queue: { active: [], dequeued: [] },
  pendingCallbacks: [],
  globalState: {},
  sandboxPool: {},
  mainLoop: {},
  feedbackLoop: {},
});

// ─── Messages ───
export const messages = writable([]);
const MAX_MESSAGES = 500;

export function addMessage(data, timestamp) {
  messages.update(msgs => {
    msgs.push({ ...data, timestamp });
    if (msgs.length > MAX_MESSAGES) msgs.shift();
    return msgs;
  });

  // Update group list if new chat
  appState.update(s => {
    if (!s.groups.find(g => g.chatId === data.chatId)) {
      s.groups.push({
        chatId: data.chatId, engagement: 0, bufferSize: 0,
        topicCount: 0, stickiness: 'STRANGER', attendCount: 0,
      });
    }
    return s;
  });
}

// ─── Tabs ───
export const activeTab = writable('messages');
export const selectedChatId = writable(null);
export const selectedCodeActChatId = writable(null);
export const selectedRecordingChatId = writable(null);

// ─── LLM Logs ───
export const llmLogs = writable([]);
export const llmStats = writable({ total: 0, success: 0, error: 0, totalTokens: 0, totalCost: 0 });
export const selectedLLMCallId = writable(null);
export const tokenPricing = writable({});
const MAX_LLM_LOGS = 200;

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

export function handleLLMCall(data) {
  llmStats.update(s => ({ ...s, total: s.total + 1 }));
  llmLogs.update(logs => {
    logs.unshift({ ...data, response: null });
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
    s.totalCost += cost;
    return s;
  });
}

export function clearLLMLogs() {
  llmLogs.set([]);
  llmStats.set({ total: 0, success: 0, error: 0, totalTokens: 0, totalCost: 0 });
  selectedLLMCallId.set(null);
}

// ─── Topic Detail ───
export const topicDetailId = writable(null);

// ─── Memory sub-tab ───
export const activeMemoryTab = writable('m-persons');

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
