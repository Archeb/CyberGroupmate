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

// ─── LLM Logs ───
export const llmLogs = writable([]);
export const llmStats = writable({ total: 0, success: 0, error: 0, totalTokens: 0 });
export const selectedLLMCallId = writable(null);
const MAX_LLM_LOGS = 200;

export function handleLLMCall(data) {
  llmStats.update(s => ({ ...s, total: s.total + 1 }));
  llmLogs.update(logs => {
    logs.unshift({ ...data, response: null });
    if (logs.length > MAX_LLM_LOGS) logs.pop();
    return logs;
  });
}

export function handleLLMResponse(data) {
  llmLogs.update(logs => {
    const entry = logs.find(e => e.callId === data.callId);
    if (entry) entry.response = data;
    return logs;
  });

  llmStats.update(s => {
    if (data.error) {
      s.error++;
    } else {
      s.success++;
    }
    if (data.usage?.totalTokens) {
      s.totalTokens += data.usage.totalTokens;
    }
    return s;
  });
}

export function clearLLMLogs() {
  llmLogs.set([]);
  llmStats.set({ total: 0, success: 0, error: 0, totalTokens: 0 });
  selectedLLMCallId.set(null);
}

// ─── Topic Detail ───
export const topicDetailId = writable(null);

// ─── Memory sub-tab ───
export const activeMemoryTab = writable('m-persons');
