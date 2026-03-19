/**
 * app.js — Dashboard 前端应用
 *
 * 纯 JS，无框架。WebSocket 实时推送 + REST API 拉取。
 * 支持：自动滚动、自动更新、JSON 高亮、CodeAct 角色区分。
 */

const App = (() => {
    // ─── Config ───
    const params = new URLSearchParams(location.search);
    const TOKEN = params.get("token") || "";
    const API = `/api`;
    const WS_URL = `ws://${location.host}/ws?token=${TOKEN}`;
    const REFRESH_INTERVAL = 5000; // 5s

    // ─── State ───
    let ws = null;
    let state = { groups: [], queue: { active: [], dequeued: [] }, pendingCallbacks: [], globalState: {}, sandboxPool: {}, mainLoop: {}, feedbackLoop: {} };
    let messages = []; // ring buffer of recent messages
    const MAX_MESSAGES = 500;
    let selectedChatId = null; // for messages tab
    let selectedCodeActChatId = null;
    let refreshTimer = null;
    let activeTab = "messages";

    // LLM Log state
    let llmLogs = []; // { callId, caller, model, temperature, maxTokens, provider, messageSummaries, timestamp, response?, expanded? }
    const MAX_LLM_LOGS = 200;
    let llmStats = { total: 0, success: 0, error: 0, totalTokens: 0 };

    // ─── API Helpers ───
    async function api(path, opts = {}) {
        const sep = path.includes("?") ? "&" : "?";
        const url = `${API}${path}${sep}token=${TOKEN}`;
        const res = await fetch(url, {
            ...opts,
            headers: { "Content-Type": "application/json", ...opts.headers },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        return res.json();
    }

    // ─── Auto-scroll utility ───
    function isAtBottom(el) {
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
    }
    function scrollToBottom(el) {
        el.scrollTop = el.scrollHeight;
    }
    function autoScrollAfterRender(el, wasAtBottom) {
        if (wasAtBottom) requestAnimationFrame(() => scrollToBottom(el));
    }

    // ─── JSON Highlighting ───
    function renderJsonHighlighted(el, data) {
        const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        el.innerHTML = `<code class="language-json hljs">${json}</code>`;
        try { hljs.highlightElement(el.querySelector("code")); } catch { }
        scrollToBottom(el);
    }

    // ─── WebSocket ───
    function connectWS() {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => {
            document.getElementById("ws-status").className = "badge badge-success";
            document.getElementById("ws-status").textContent = "已连接";
        };
        ws.onclose = () => {
            document.getElementById("ws-status").className = "badge badge-error";
            document.getElementById("ws-status").textContent = "断开";
            setTimeout(connectWS, 3000);
        };
        ws.onerror = () => ws.close();
        ws.onmessage = (ev) => {
            try {
                const event = JSON.parse(ev.data);
                handleEvent(event);
            } catch { }
        };
    }

    function handleEvent(event) {
        switch (event.type) {
            case "snapshot":
                state = event.data;
                // Normalize queue format
                if (Array.isArray(state.queue)) {
                    state.queue = { active: state.queue, dequeued: [] };
                }
                renderAll();
                refreshActiveTab();
                break;
            case "nc:message":
                addMessage(event.data, event.timestamp);
                break;
            case "queue:update":
                if (Array.isArray(event.data)) {
                    state.queue = { active: event.data, dequeued: state.queue?.dequeued || [] };
                } else {
                    state.queue = event.data;
                }
                renderQueue();
                break;
            case "llm:call":
                handleLLMCall(event.data);
                break;
            case "llm:response":
                handleLLMResponse(event.data);
                break;
        }
    }

    // ─── Messages ───
    function addMessage(data, timestamp) {
        messages.push({ ...data, timestamp });
        if (messages.length > MAX_MESSAGES) messages.shift();
        // Update group list if new chat
        if (!state.groups.find(g => g.chatId === data.chatId)) {
            state.groups.push({ chatId: data.chatId, engagement: 0, bufferSize: 0, topicCount: 0, stickiness: "STRANGER", attendCount: 0 });
            renderChatList();
        }
        renderMessageStream();
    }

    function renderChatList() {
        const chatIds = [...new Set([...state.groups.map(g => g.chatId), ...messages.map(m => m.chatId)])];
        const list = document.getElementById("chat-list");
        list.innerHTML = `<div class="chat-item ${!selectedChatId ? 'active' : ''}" onclick="App.selectChat(null)">全部</div>` +
            chatIds.map(id => {
                const count = messages.filter(m => m.chatId === id).length;
                const label = getGroupLabel(id);
                return `<div class="chat-item ${selectedChatId === id ? 'active' : ''}" onclick="App.selectChat('${id}')" title="${id}">
                    <span>${escapeHtml(label)}</span><span class="badge badge-sm">${count}</span>
                </div>`;
            }).join("");
    }

    function renderMessageStream() {
        const filtered = selectedChatId ? messages.filter(m => m.chatId === selectedChatId) : messages;
        const el = document.getElementById("message-stream");
        const wasBottom = isAtBottom(el);
        el.innerHTML = filtered.slice(-200).map(m => {
            const time = new Date(m.timestamp).toLocaleTimeString();
            const isAgent = m.userId === "agent" || m.userId === "self";
            const isMention = m.mentionsAgent || m.isDirectMessage;
            const cls = [isAgent ? "is-agent" : "", isMention ? "is-mention" : ""].join(" ");
            const text = escapeHtml(m.text || "").slice(0, 500);
            const nameLink = isAgent ? `<span class="msg-user">🤖 Agent</span>` :
                `<span class="msg-user clickable-link" onclick="App.quickQueryUser('${m.userId}','${m.chatId}')">${escapeHtml(m.displayName || m.userId)}</span>`;
            // Group tag in "全部" view
            const groupTag = !selectedChatId ? `<span class="msg-group-tag" title="${m.chatId}">${escapeHtml(getGroupLabel(m.chatId))}</span>` : "";
            return `<div class="msg-item ${cls}">
                <span class="msg-time">${time}</span>
                ${groupTag}
                ${nameLink}
                <span class="msg-text">${text}</span>
            </div>`;
        }).join("");
        autoScrollAfterRender(el, wasBottom);
        document.getElementById("msg-chat-label").textContent = selectedChatId ? `Chat: ${selectedChatId}` : "全部";
    }

    async function selectChat(chatId) {
        selectedChatId = chatId;
        renderChatList();
        // Load historical messages from memory when selecting a specific group
        if (chatId) {
            try {
                const history = await api(`/messages/${chatId}?limit=100`);
                if (Array.isArray(history) && history.length > 0) {
                    // Merge with existing real-time messages, dedup by messageId
                    const existingIds = new Set(messages.map(m => m.messageId || m.id));
                    const newMsgs = history
                        .filter(m => !existingIds.has(m.messageId))
                        .map(m => ({
                            chatId: m.chatId,
                            messageId: m.messageId,
                            userId: m.userId,
                            displayName: m.displayName,
                            text: m.text,
                            timestamp: m.timestamp,
                        }));
                    if (newMsgs.length > 0) {
                        messages.push(...newMsgs);
                        messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                        if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
                    }
                }
            } catch { }
        }
        renderMessageStream();
    }

    // ─── Topics ───
    const expandedTopicGroups = new Set(); // track which groups are expanded
    let topicCache = {}; // chatId -> { topics[], hasMore, offset }
    let topicSearchMode = false; // whether search results are displayed

    async function renderTopics() {
        const container = document.getElementById("topics-container");
        if (topicSearchMode) return; // Don't overwrite search results
        if (!state.groups.length) { container.innerHTML = '<div class="text-sm opacity-60">暂无数据</div>'; return; }

        // Preserve current expand state from DOM
        container.querySelectorAll('.topic-group-collapse input[type="checkbox"]').forEach(input => {
            const cid = input.dataset.chatId;
            if (cid) {
                if (input.checked) expandedTopicGroups.add(cid);
                else expandedTopicGroups.delete(cid);
            }
        });

        container.innerHTML = state.groups.map(g => {
            const isExpanded = expandedTopicGroups.has(g.chatId);
            const label = getGroupLabel(g.chatId);
            const cached = topicCache[g.chatId];
            const totalBadge = cached ? `${cached.topics.length}${cached.hasMore ? '+' : ''} / ${cached.total || '?'}` : `${g.topicCount}`;
            return `<div class="collapse collapse-arrow bg-base-200 topic-group-collapse">
                <input type="checkbox" data-chat-id="${g.chatId}" ${isExpanded ? 'checked' : ''} onchange="App.toggleTopicGroup('${g.chatId}', this.checked)" />
                <div class="collapse-title text-sm font-medium flex justify-between items-center">
                    <span>${escapeHtml(label)}</span>
                    <span class="badge badge-sm">${totalBadge} 话题</span>
                </div>
                <div class="collapse-content">
                    <div id="topics-${CSS.escape(g.chatId)}" class="space-y-1">
                        ${cached ? renderTopicCards(cached.topics, g.chatId, cached.hasMore) : '<div class="text-xs opacity-60">加载中...</div>'}
                    </div>
                </div>
            </div>`;
        }).join("");

        // Auto-load topics for expanded groups
        for (const g of state.groups) {
            if (expandedTopicGroups.has(g.chatId) && !topicCache[g.chatId]) {
                loadTopics(g.chatId);
            }
        }
    }

    function toggleTopicGroup(chatId, isExpanded) {
        if (isExpanded) {
            expandedTopicGroups.add(chatId);
            if (!topicCache[chatId]) loadTopics(chatId);
        } else {
            expandedTopicGroups.delete(chatId);
        }
    }

    function renderTopicCards(topics, chatId, hasMore) {
        if (!topics.length) return '<div class="text-sm opacity-60">无话题</div>';
        let html = topics.map(t => {
            const stateClass = `state-${(t.state || "").toLowerCase()}`;
            const participants = (t.participantIds || []).map(p =>
                `<span class="clickable-link" onclick="App.quickQueryUser('${p}','${chatId}')">${escapeHtml(p)}</span>`
            ).join(", ");
            const engaged = t.wasEngaged ? `<span class="badge badge-xs badge-success">已回应 ×${t.interventionCount || 1}</span>` : '';
            const sourceBadge = t.source === "history" ? '<span class="badge badge-xs badge-ghost">历史</span>' : '';
            const timeStr = t.startedAt ? new Date(t.startedAt).toLocaleString() : '';
            return `<div class="topic-card ${stateClass} cursor-pointer" onclick="App.viewTopicDetail('${t.id}')">
                <div class="flex justify-between items-center">
                    <span class="font-semibold text-sm">${escapeHtml(t.label || t.id)}</span>
                    <div class="flex gap-1">${engaged} ${sourceBadge} <span class="badge badge-xs">${t.state}</span></div>
                </div>
                <div class="text-xs opacity-70 mt-1">${escapeHtml(t.summary || "")}</div>
                <div class="text-xs mt-1">
                    <span class="opacity-50">${timeStr}</span> |
                    参与者: ${participants || "无"} | 消息数: ${(t.messageIds || []).length} |
                    关键词: ${(t.keywords || []).map(k => escapeHtml(k)).join(", ")}
                </div>
            </div>`;
        }).join("");
        if (hasMore) {
            html += `<div class="text-center mt-2">
                <button class="btn btn-xs btn-outline" onclick="App.loadMoreTopics('${chatId}')">加载更多...</button>
            </div>`;
        }
        return html;
    }

    async function loadTopics(chatId) {
        const data = await api(`/topics/${chatId}?limit=10&offset=0`);
        const topics = data.topics || data; // backward compat
        topicCache[chatId] = {
            topics: Array.isArray(topics) ? topics : [],
            hasMore: data.hasMore ?? false,
            total: data.total ?? 0,
            offset: Array.isArray(topics) ? topics.length : 0,
        };
        const el = document.getElementById(`topics-${CSS.escape(chatId)}`);
        if (el) el.innerHTML = renderTopicCards(topicCache[chatId].topics, chatId, topicCache[chatId].hasMore);
    }

    async function loadMoreTopics(chatId) {
        const cached = topicCache[chatId];
        if (!cached || !cached.hasMore) return;
        const data = await api(`/topics/${chatId}?limit=10&offset=${cached.offset}`);
        const newTopics = data.topics || [];
        cached.topics.push(...newTopics);
        cached.hasMore = data.hasMore ?? false;
        cached.total = data.total ?? cached.total;
        cached.offset += newTopics.length;
        const el = document.getElementById(`topics-${CSS.escape(chatId)}`);
        if (el) el.innerHTML = renderTopicCards(cached.topics, chatId, cached.hasMore);
    }

    async function searchTopics() {
        const query = document.getElementById("topic-search-input").value.trim();
        if (!query) return;
        topicSearchMode = true;
        document.getElementById("topic-search-clear").style.display = "";
        const container = document.getElementById("topics-container");
        container.innerHTML = '<div class="text-sm opacity-60">搜索中...</div>';

        // Search across all groups
        let allResults = [];
        for (const g of state.groups) {
            try {
                const data = await api(`/topics/${g.chatId}/search?q=${encodeURIComponent(query)}`);
                const topics = data.topics || [];
                for (const t of topics) {
                    allResults.push({ ...t, chatId: g.chatId, chatLabel: getGroupLabel(g.chatId) });
                }
            } catch { }
        }

        if (!allResults.length) {
            container.innerHTML = '<div class="text-sm opacity-60">未找到匹配的话题</div>';
            return;
        }

        // Render flat search results grouped by chat
        const byChatId = {};
        for (const t of allResults) {
            if (!byChatId[t.chatId]) byChatId[t.chatId] = [];
            byChatId[t.chatId].push(t);
        }

        container.innerHTML = Object.entries(byChatId).map(([chatId, topics]) => {
            const label = topics[0].chatLabel || shortId(chatId);
            return `<div class="collapse collapse-arrow collapse-open bg-base-200">
                <input type="checkbox" checked />
                <div class="collapse-title text-sm font-medium">
                    <span>${escapeHtml(label)}</span>
                    <span class="badge badge-sm ml-2">${topics.length} 匹配</span>
                </div>
                <div class="collapse-content">
                    <div class="space-y-1">${renderTopicCards(topics, chatId, false)}</div>
                </div>
            </div>`;
        }).join("");
    }

    function clearTopicSearch() {
        topicSearchMode = false;
        document.getElementById("topic-search-input").value = "";
        document.getElementById("topic-search-clear").style.display = "none";
        renderTopics();
    }

    // ─── Queue ───
    function renderQueue() {
        const queueData = state.queue || { active: [], dequeued: [] };
        const activeList = queueData.active || [];
        const dequeuedList = queueData.dequeued || [];

        // Active queue
        const tbody = document.getElementById("queue-tbody");
        if (!activeList.length) { tbody.innerHTML = '<tr><td colspan="8" class="text-center opacity-60">队列为空</td></tr>'; }
        else {
            const sorted = [...activeList].sort((a, b) => b.priority - a.priority);
            tbody.innerHTML = sorted.map(e => {
                const pClass = e.priority > 50 ? "priority-high" : e.priority > 20 ? "priority-mid" : "priority-low";
                const blocked = e.blocked ? "is-blocked" : "";
                return `<tr class="queue-row ${blocked}">
                    <td class="font-mono text-xs clickable-id" onclick="App.quickQueryGroup('${e.chatId}')">${shortId(e.chatId)}</td>
                    <td class="${pClass}">${e.priority.toFixed(1)}</td>
                    <td><span class="badge badge-xs">${e.source}</span></td>
                    <td class="stickiness-${e.stickinessLevel}">${e.stickinessLevel}</td>
                    <td>${e.newMessageCount}</td>
                    <td>${(e.topicDigests || []).length}</td>
                    <td>${e.blocked ? '<span class="badge badge-xs badge-error">阻塞</span>' : '<span class="badge badge-xs badge-success">活跃</span>'}</td>
                    <td>
                        <div class="flex gap-1">
                            <button class="btn btn-xs btn-ghost" onclick="App.boostQueue('${e.chatId}')">⬆</button>
                            <button class="btn btn-xs btn-ghost text-error" onclick="App.removeFromQueue('${e.chatId}')">✕</button>
                        </div>
                    </td>
                </tr>`;
            }).join("");
        }

        // Dequeued history
        const dTbody = document.getElementById("dequeued-tbody");
        document.getElementById("dequeued-count").textContent = dequeuedList.length;
        if (!dequeuedList.length) {
            dTbody.innerHTML = '<tr><td colspan="5" class="text-center opacity-60">暂无历史</td></tr>';
        } else {
            dTbody.innerHTML = [...dequeuedList].reverse().map(d => {
                const e = d.entry;
                const time = new Date(d.dequeuedAt).toLocaleTimeString();
                return `<tr class="dequeued-row">
                    <td class="font-mono text-xs clickable-id" onclick="App.quickQueryGroup('${e.chatId}')">${shortId(e.chatId)}</td>
                    <td>${e.priority.toFixed(1)}</td>
                    <td><span class="badge badge-xs">${e.source}</span></td>
                    <td class="stickiness-${e.stickinessLevel}">${e.stickinessLevel}</td>
                    <td class="opacity-60">${time}</td>
                </tr>`;
            }).join("");
        }
    }

    async function boostQueue(chatId) {
        await api("/queue/boost", { method: "POST", body: { chatId, amount: 20 } });
    }

    async function removeFromQueue(chatId) {
        await api(`/queue/${chatId}`, { method: "DELETE" });
    }

    function showEnqueueModal() {
        document.getElementById("enqueue-modal").showModal();
    }

    async function doEnqueue() {
        const chatId = document.getElementById("enqueue-chatid").value;
        const priority = parseInt(document.getElementById("enqueue-priority").value) || 80;
        if (!chatId) return;
        await api("/queue/enqueue", { method: "POST", body: { chatId, priority } });
        document.getElementById("enqueue-modal").close();
    }

    // ─── Decisions ───
    async function renderDecisions() {
        const decisions = await api("/decisions");
        const el = document.getElementById("decisions-list");
        const wasBottom = isAtBottom(el);
        el.innerHTML = (decisions || []).map((d, i) => {
            const time = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : "";
            return `<div class="decision-item">
                <span class="opacity-50">${time}</span>
                <span class="clickable-link" onclick="App.quickQueryGroup('${d.chatId}')">${shortId(d.chatId)}</span>
                ${escapeHtml(d.decision || d.content || JSON.stringify(d))}
            </div>`;
        }).join("");
        autoScrollAfterRender(el, wasBottom);

        // Main agent history
        const history = await api("/main-agent/history");
        const hEl = document.getElementById("main-agent-history");
        const hWasBottom = isAtBottom(hEl);
        hEl.innerHTML = (history || []).map(msg => {
            const roleColor = msg.role === "assistant" ? "text-primary" : msg.role === "system" ? "text-info" : "text-success";
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            return `<div class="codeact-msg role-${msg.role}">
                <span class="role-label">${msg.role}</span>
                <div class="whitespace-pre-wrap mt-1 text-xs">${escapeHtml(content).slice(0, 2000)}</div>
            </div>`;
        }).join("");
        autoScrollAfterRender(hEl, hWasBottom);
    }

    // ─── CodeAct ───
    function renderCodeActChatList() {
        const chatIds = state.groups.map(g => g.chatId);
        const el = document.getElementById("codeact-chat-list");
        el.innerHTML = chatIds.map(id => {
            const g = state.groups.find(g => g.chatId === id);
            const active = g?.codeActProcessing ? "🔄" : "";
            return `<div class="chat-item ${selectedCodeActChatId === id ? 'active' : ''}" onclick="App.selectCodeActChat('${id}')">
                <span>${shortId(id)}</span>${active}
            </div>`;
        }).join("");
    }

    /** Parse code blocks in text and highlight them */
    function formatCodeActContent(rawText) {
        const escaped = escapeHtml(rawText);
        // Split by ```lang\n...\n``` patterns
        const parts = escaped.split(/(```[\s\S]*?```)/g);
        return parts.map(part => {
            const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
            if (match) {
                const lang = match[1] || "plaintext";
                const code = match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
                let highlighted;
                try {
                    highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                } catch {
                    highlighted = escapeHtml(code);
                }
                return `<pre class="code-block"><code class="hljs language-${lang}">${highlighted}</code></pre>`;
            }
            return `<span class="whitespace-pre-wrap">${part}</span>`;
        }).join("");
    }

    let codeActPollTimer = null;

    async function selectCodeActChat(chatId) {
        selectedCodeActChatId = chatId;
        // Clear previous polling
        if (codeActPollTimer) { clearInterval(codeActPollTimer); codeActPollTimer = null; }
        document.getElementById("codeact-label").textContent = getGroupLabel(chatId);
        await refreshCodeActSession(chatId);
    }

    async function refreshCodeActSession(chatId) {
        if (!chatId) return;
        const data = await api(`/codeact/${chatId}`);
        document.getElementById("codeact-session-size").textContent = data.sessionSize ?? "-";
        document.getElementById("codeact-exec-count").textContent = data.executionCount ?? "-";
        document.getElementById("codeact-queue-size").textContent = data.queueSize ?? "-";
        const cancelBtn = document.getElementById("codeact-cancel-btn");
        cancelBtn.classList.toggle("hidden", !data.isProcessing);
        const el = document.getElementById("codeact-session");
        const wasBottom = isAtBottom(el);
        el.innerHTML = (data.session || []).map(msg => {
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
            return `<div class="codeact-msg role-${msg.role}">
                <span class="role-label">${msg.role}</span>
                <div class="mt-1 text-xs">${formatCodeActContent(content.slice(0, 5000))}</div>
            </div>`;
        }).join("");
        autoScrollAfterRender(el, wasBottom);

        // Start live polling when CodeAct is actively processing
        if (data.isProcessing && !codeActPollTimer) {
            codeActPollTimer = setInterval(() => refreshCodeActSession(chatId), 2000);
        } else if (!data.isProcessing && codeActPollTimer) {
            clearInterval(codeActPollTimer);
            codeActPollTimer = null;
        }
    }

    async function cancelCodeAct() {
        if (!selectedCodeActChatId) return;
        if (!confirm(`确认取消 ${selectedCodeActChatId} 的 CodeAct 执行？`)) return;
        await api(`/codeact/${selectedCodeActChatId}/cancel`, { method: "POST" });
        await selectCodeActChat(selectedCodeActChatId);
    }

    // ─── Memory ───
    async function queryUser() {
        const userId = document.getElementById("memory-user-input").value;
        const chatId = document.getElementById("memory-user-chat").value;
        if (!userId) return;
        let path = `/memory/user/${userId}`;
        if (chatId) path += `?chatId=${chatId}`;
        const result = await api(path);
        renderJsonHighlighted(document.getElementById("memory-result"), result);
    }

    async function queryGroup() {
        const chatId = document.getElementById("memory-group-input").value;
        if (!chatId) return;
        const result = await api(`/memory/group/${chatId}`);
        renderJsonHighlighted(document.getElementById("memory-result"), result);
    }

    function quickQueryUser(userId, chatId) {
        switchTab("memory");
        document.getElementById("memory-user-input").value = userId;
        document.getElementById("memory-user-chat").value = chatId || "";
        queryUser();
    }

    function quickQueryGroup(chatId) {
        switchTab("memory");
        document.getElementById("memory-group-input").value = chatId;
        queryGroup();
    }

    // ─── Memory: Recall (keyword/semantic search) ───
    async function recallMemory() {
        const query = document.getElementById("recall-query-input").value.trim();
        if (!query) return;
        const chatId = document.getElementById("recall-chatid-input").value.trim();
        const resultEl = document.getElementById("recall-result");
        resultEl.innerHTML = '<div class="text-xs opacity-60">搜索中...</div>';
        try {
            const body = { query };
            if (chatId) body.chatId = chatId;
            const result = await api("/memory/recall", {
                method: "POST",
                body: body,
            });
            // Render recall results
            let html = '';
            if (result.deepSummary) {
                html += `<div class="mb-3 p-2 bg-base-200 rounded text-xs"><strong>摘要：</strong>${escapeHtml(result.deepSummary)}</div>`;
            }
            if (result.topics?.length) {
                html += `<h4 class="text-sm font-bold mb-1">🗂 话题 (${result.topics.length})</h4>`;
                html += result.topics.map(t => `<div class="topic-card mb-1 cursor-pointer" onclick="App.viewTopicDetail('${t.id}')">
                    <div class="font-semibold text-xs">${escapeHtml(t.label)}</div>
                    <div class="text-xs opacity-70">${escapeHtml(t.summary || '')}</div>
                    <div class="text-xs">${(t.keywords || []).map(k => '<span class="badge badge-xs">' + escapeHtml(k) + '</span>').join(' ')}</div>
                </div>`).join('');
            }
            if (result.facts?.length) {
                html += `<h4 class="text-sm font-bold mt-2 mb-1">💡 事实 (${result.facts.length})</h4>`;
                html += '<div class="space-y-1">' + result.facts.map(f => `<div class="text-xs p-1 bg-base-200 rounded">
                    <span class="badge badge-xs">${escapeHtml(f.category)}</span>
                    <span class="font-mono">${escapeHtml(f.subject)}</span>: ${escapeHtml(f.content)}
                    <span class="opacity-50">(${(f.confidence * 100).toFixed(0)}%)</span>
                </div>`).join('') + '</div>';
            }
            if (result.persons?.length) {
                html += `<h4 class="text-sm font-bold mt-2 mb-1">👤 关联人物 (${result.persons.length})</h4>`;
                html += result.persons.map(p => `<div class="text-xs p-1 bg-base-200 rounded">
                    <span class="clickable-link" onclick="App.quickQueryUser('${p.userId}','${p.chatId}')">${escapeHtml(p.userId)}</span>
                    T${p.dunbarTier} | ${escapeHtml((p.traits || []).join(', '))}
                </div>`).join('');
            }
            if (!html) html = '<div class="text-xs opacity-60">未找到匹配结果</div>';
            resultEl.innerHTML = html;
        } catch (err) {
            resultEl.innerHTML = `<div class="text-xs text-error">${escapeHtml(String(err))}</div>`;
        }
    }

    // ─── Topic Detail ───
    async function viewTopicDetail(topicId) {
        // Show the hidden tab
        const tab = document.getElementById("tab-topic-detail");
        tab.classList.remove("hidden");
        switchTab("topic-detail");

        // Show loading state
        document.getElementById("topic-detail-title").textContent = "加载中...";
        document.getElementById("topic-detail-meta").innerHTML = '';
        document.getElementById("topic-detail-messages").innerHTML = '<div class="opacity-60">加载中...</div>';
        document.getElementById("topic-detail-state").textContent = '';
        document.getElementById("topic-detail-time").textContent = '';

        try {
            const data = await api(`/topic/${topicId}`);
            document.getElementById("topic-detail-title").textContent = `📖 ${data.label || topicId}`;
            document.getElementById("topic-detail-state").textContent = data.state || '';
            document.getElementById("topic-detail-time").textContent =
                `${(data.startedAt || '').slice(0, 16)} ~ ${(data.endedAt || '进行中').slice(0, 16)}`;

            // Meta info
            let meta = '';
            if (data.summary) {
                meta += `<div class="p-2 bg-base-200 rounded"><strong>摘要：</strong>${escapeHtml(data.summary)}</div>`;
            }
            meta += `<div><strong>话题 ID：</strong><span class="font-mono">${escapeHtml(data.topicId)}</span></div>`;
            if (data.chatId) meta += `<div><strong>群组：</strong>${escapeHtml(getGroupLabel(data.chatId))}</div>`;
            meta += `<div><strong>消息数：</strong>${data.messageCount || 0}</div>`;
            if (data.sentiment) meta += `<div><strong>情感：</strong>${escapeHtml(data.sentiment)}</div>`;
            if (data.wasEngaged) meta += `<div><strong>已回应：</strong>×${data.interventionCount || 1}</div>`;
            if (data.keywords?.length) {
                meta += `<div><strong>关键词：</strong>${data.keywords.map(k => '<span class="badge badge-xs">' + escapeHtml(k) + '</span>').join(' ')}</div>`;
            }
            if (data.participants?.length) {
                meta += `<div><strong>参与者：</strong>${data.participants.map(p =>
                    `<span class="clickable-link" onclick="App.quickQueryUser('${p}','${data.chatId || ''}')">${escapeHtml(p)}</span>`
                ).join(', ')}</div>`;
            }
            if (data.keyPoints?.length) {
                meta += `<div><strong>要点：</strong><ul class="list-disc ml-4">${data.keyPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>`;
            }
            document.getElementById("topic-detail-meta").innerHTML = meta;

            // Messages
            const msgs = data.messages || [];
            if (!msgs.length) {
                document.getElementById("topic-detail-messages").innerHTML = '<div class="opacity-60">无相关消息</div>';
                return;
            }
            document.getElementById("topic-detail-messages").innerHTML = msgs.map(m => {
                const time = m.timestamp ? m.timestamp.slice(11, 19) : '';
                const name = m.displayName || m.userId || '?';
                return `<div class="msg-item">
                    <span class="msg-time">${time}</span>
                    <span class="msg-user clickable-link" onclick="App.quickQueryUser('${m.userId || ''}','${data.chatId || ''}')">${escapeHtml(name)}</span>
                    <span class="msg-text">${escapeHtml(m.text || '')}</span>
                </div>`;
            }).join('');
        } catch (err) {
            document.getElementById("topic-detail-title").textContent = "加载失败";
            document.getElementById("topic-detail-messages").innerHTML =
                `<div class="text-error text-xs">${escapeHtml(String(err))}</div>`;
        }
    }

    // ─── System Tab ───
    async function renderSystem() {
        // Global state
        const gs = await api("/global-state");
        renderJsonHighlighted(document.getElementById("global-state-display"), gs);

        // Sandbox pool
        const pool = await api("/sandbox/pool");
        const poolEl = document.getElementById("sandbox-pool-display");
        poolEl.innerHTML = `
            <div class="stats stats-vertical shadow w-full">
                <div class="stat py-2">
                    <div class="stat-title text-xs">总实例 / 使用中 / 空闲</div>
                    <div class="stat-value text-sm">${pool.total} / ${pool.inUse} / ${pool.idle}</div>
                </div>
            </div>
            ${(pool.instances || []).length ? '<div class="mt-2 space-y-1">' + (pool.instances || []).map(i => `
                <div class="flex justify-between text-xs px-2 py-1 bg-base-200 rounded">
                    <span class="font-mono">${shortId(i.chatId)}</span>
                    <span class="badge badge-xs ${i.inUse ? 'badge-error' : 'badge-success'}">${i.inUse ? '使用中' : '空闲'}</span>
                </div>`).join("") + '</div>' : ''}
        `;

        // Feedback loop
        const fl = await api("/feedbackloop");
        const flEl = document.getElementById("feedback-loop-display");
        const windows = fl.activeWindows || [];
        flEl.innerHTML = windows.length ? windows.map(w => `
            <div class="flex justify-between text-xs px-2 py-1 bg-base-200 rounded mb-1">
                <span class="font-mono">${shortId(w.chatId)}</span>
                <span>剩余 ${(w.remainingMs / 1000).toFixed(0)}s</span>
            </div>
        `).join("") : '<div class="text-xs opacity-60">无活跃窗口</div>';

        // Groups overview
        renderGroupsOverview();

        // Callbacks
        const callbacks = await api("/callbacks");
        const cbEl = document.getElementById("callbacks-display");
        const allCbs = [];
        for (const g of state.groups) {
            for (const cb of (g.lastCallbacks || [])) {
                allCbs.push(cb);
            }
        }
        const displayCbs = [...(callbacks || []), ...allCbs].slice(-20);
        cbEl.innerHTML = displayCbs.length ? displayCbs.map(cb => `
            <div class="decision-item">
                <span class="badge badge-xs ${cb.status === 'COMPLETED' ? 'badge-success' : 'badge-error'}">${cb.status}</span>
                <span class="font-mono">${shortId(cb.chatId)}</span>
                <span class="badge badge-xs">${cb.executionType}</span>
                ${escapeHtml(cb.summary || "")}
                <span class="opacity-50">${cb.durationMs}ms</span>
            </div>
        `).join("") : '<div class="text-xs opacity-60">无回调</div>';
    }

    function renderGroupsOverview() {
        const tbody = document.getElementById("groups-overview-tbody");
        tbody.innerHTML = state.groups.map(g => {
            const fp = g.fastPathStatus || {};
            return `<tr>
                <td class="font-mono text-xs clickable-id" onclick="App.quickQueryGroup('${g.chatId}')">${shortId(g.chatId)}</td>
                <td class="stickiness-${g.stickiness}">${g.stickiness}</td>
                <td>${(g.engagement || 0).toFixed(1)}</td>
                <td>${g.bufferSize || 0}</td>
                <td>${g.attendCount || 0}</td>
                <td>${fp.authorized ? `<span class="badge badge-xs badge-warning">${fp.repliesSent}/${fp.maxReplies}</span>` : '<span class="opacity-40">-</span>'}</td>
            </tr>`;
        }).join("");
    }

    // ─── Sticker Management ───
    let stickerCache = [];

    async function loadStickers() {
        stickerCache = await api("/stickers");
        document.getElementById("sticker-count").textContent = stickerCache.length;
        const tbody = document.getElementById("stickers-tbody");
        if (!stickerCache.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center opacity-60">暂无贴纸缓存</td></tr>';
            return;
        }
        tbody.innerHTML = stickerCache.map(s => {
            const time = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
            const emojiDisplay = s.emoji || "-";
            return `<tr>
                <td class="text-xl">${emojiDisplay}</td>
                <td class="max-w-xs truncate" title="${escapeHtml(s.description)}">${escapeHtml(s.description)}</td>
                <td class="font-mono text-xs max-w-32 truncate" title="${escapeHtml(s.uniqueFileId)}">${escapeHtml(s.uniqueFileId.slice(-16))}</td>
                <td class="text-xs opacity-60">${time}</td>
                <td>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="App.editSticker('${escapeHtml(s.uniqueFileId)}')">✏️</button>
                        <button class="btn btn-xs btn-ghost text-error" onclick="App.deleteSticker('${escapeHtml(s.uniqueFileId)}')">🗑</button>
                    </div>
                </td>
            </tr>`;
        }).join("");
    }

    async function deleteSticker(uniqueFileId) {
        if (!confirm(`确认删除贴纸 ${uniqueFileId.slice(-16)} 的缓存？`)) return;
        await api(`/stickers/${encodeURIComponent(uniqueFileId)}`, { method: "DELETE" });
        await loadStickers();
    }

    function editSticker(uniqueFileId) {
        const s = stickerCache.find(s => s.uniqueFileId === uniqueFileId);
        if (!s) return;
        document.getElementById("sticker-edit-id").textContent = uniqueFileId;
        document.getElementById("sticker-edit-emoji").value = s.emoji || "";
        document.getElementById("sticker-edit-desc").value = s.description || "";
        document.getElementById("sticker-edit-modal").showModal();
    }

    async function saveSticker() {
        const uniqueFileId = document.getElementById("sticker-edit-id").textContent;
        const emoji = document.getElementById("sticker-edit-emoji").value.trim() || undefined;
        const description = document.getElementById("sticker-edit-desc").value.trim();
        if (!description) { alert("描述不能为空"); return; }
        await api(`/stickers/${encodeURIComponent(uniqueFileId)}`, {
            method: "PUT",
            body: { description, emoji },
        });
        document.getElementById("sticker-edit-modal").close();
        await loadStickers();
    }


    // ─── Tab Management ───
    function switchTab(tab) {
        activeTab = tab;
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
        document.getElementById(`panel-${tab}`).classList.remove("hidden");
        document.querySelectorAll('[role="tab"]').forEach(t => {
            t.classList.toggle("tab-active", t.dataset.tab === tab);
        });
        refreshActiveTab();
    }

    /** Refresh data for the currently active tab */
    function refreshActiveTab() {
        if (activeTab === "topics") renderTopics();
        if (activeTab === "decisions") renderDecisions();
        if (activeTab === "codeact") {
            renderCodeActChatList();
            if (selectedCodeActChatId) selectCodeActChat(selectedCodeActChatId);
        }
        if (activeTab === "system") renderSystem();
        if (activeTab === "stickers") loadStickers();
        if (activeTab === "queue") renderQueue();
        if (activeTab === "llm-log") renderLLMLog();
        if (activeTab === "memory") refreshMemorySubTab();
    }

    // ─── Render All ───
    function renderAll() {
        // Stats bar
        document.getElementById("stat-groups").textContent = state.groups.length;
        const queueActive = state.queue?.active || [];
        document.getElementById("stat-queue").textContent = queueActive.length;
        const sp = state.sandboxPool || {};
        document.getElementById("stat-sandbox").textContent = `${sp.inUse || 0}/${sp.total || 0}`;
        document.getElementById("stat-callbacks").textContent = (state.pendingCallbacks || []).length;
        document.getElementById("tick-counter").textContent = `Tick: ${state.mainLoop?.tickCount ?? "-"}`;

        renderChatList();
        renderMessageStream();
        renderQueue();
    }

    // ─── Periodic Refresh ───
    function startPeriodicRefresh() {
        refreshTimer = setInterval(async () => {
            try {
                const snapshot = await api("/overview");
                state = snapshot;
                // Normalize queue
                if (Array.isArray(state.queue)) {
                    state.queue = { active: state.queue, dequeued: [] };
                }
                renderAll();
                refreshActiveTab();
            } catch { }
        }, REFRESH_INTERVAL);
    }

    // ─── Utilities ───
    function escapeHtml(str) {
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function shortId(id) {
        if (!id) return "?";
        const s = String(id);
        return s.length > 15 ? "…" + s.slice(-12) : s;
    }

    /** Get display label for a group: chatTitle if available, else shortId */
    function getGroupLabel(chatId) {
        const g = state.groups.find(g => g.chatId === chatId);
        if (g?.chatTitle) return g.chatTitle;
        return shortId(chatId);
    }

    // ─── Init ───
    function init() {
        // Tab click handlers
        document.querySelectorAll('[role="tab"][data-tab]').forEach(tab => {
            tab.addEventListener("click", () => switchTab(tab.dataset.tab));
        });
        connectWS();
        startPeriodicRefresh();
    }

    document.addEventListener("DOMContentLoaded", init);

    // ─── LLM Log ───

    const CALLER_COLORS = {
        "attend-handler": "badge-primary",
        "fast-path": "badge-warning",
        "session-runner": "badge-accent",
        "context-manager": "badge-info",
        "reflection": "badge-secondary",
        "memory": "badge-success",
        "vision": "badge-error",
        "recording-pipeline": "badge-ghost",
    };

    let selectedLLMCallId = null;

    function updateLLMStats() {
        const t = document.getElementById("llm-stat-total");
        const s = document.getElementById("llm-stat-success");
        const e = document.getElementById("llm-stat-error");
        const k = document.getElementById("llm-stat-tokens");
        if (t) t.textContent = llmStats.total;
        if (s) s.textContent = llmStats.success;
        if (e) e.textContent = llmStats.error;
        if (k) k.textContent = llmStats.totalTokens.toLocaleString();
    }

    function handleLLMCall(data) {
        llmStats.total++;
        const entry = { ...data, response: null };
        llmLogs.unshift(entry);
        if (llmLogs.length > MAX_LLM_LOGS) llmLogs.pop();

        updateLLMStats();

        // Incremental DOM: prepend a new row
        const listEl = document.getElementById("llm-log-list");
        if (!listEl) return;

        // Clear placeholder if present
        if (llmLogs.length === 1) listEl.innerHTML = "";

        const row = document.createElement("div");
        row.className = "llm-log-row";
        row.setAttribute("data-call-id", data.callId);
        row.onclick = () => selectLLMLog(data.callId);

        const time = new Date(data.timestamp).toLocaleTimeString();
        const callerBadge = CALLER_COLORS[data.caller] || "badge-ghost";
        const msgCount = data.messageSummaries?.length ?? 0;
        const hasImages = data.messageSummaries?.some(m => m.imageCount > 0);

        row.innerHTML = `
            <span class="llm-row-status" data-status="pending">⠇</span>
            <span class="llm-row-time">${time}</span>
            <span class="badge badge-xs ${callerBadge}">${escapeHtml(data.caller)}</span>
            <span class="llm-row-model">${escapeHtml(data.model)}</span>
            <span class="llm-row-meta">✉${msgCount}${hasImages ? ' 🖼' : ''}</span>
            <span class="llm-row-duration" data-field="duration">...</span>
        `;
        listEl.prepend(row);
    }

    function handleLLMResponse(data) {
        const entry = llmLogs.find(e => e.callId === data.callId);
        if (entry) entry.response = data;

        if (data.error) {
            llmStats.error++;
        } else {
            llmStats.success++;
        }
        if (data.usage?.totalTokens) {
            llmStats.totalTokens += data.usage.totalTokens;
        }
        updateLLMStats();

        // In-place update: find the row and patch status + duration
        const row = document.querySelector(`.llm-log-row[data-call-id="${data.callId}"]`);
        if (row) {
            const statusEl = row.querySelector("[data-status]");
            if (statusEl) {
                statusEl.setAttribute("data-status", data.error ? "error" : "ok");
                statusEl.textContent = data.error ? "✗" : "✓";
            }
            const durEl = row.querySelector("[data-field='duration']");
            if (durEl) {
                const tokStr = data.usage?.totalTokens ? ` (${data.usage.totalTokens}tok)` : "";
                durEl.textContent = `${data.durationMs}ms${tokStr}`;
            }
            if (data.error) row.classList.add("llm-log-error");
        }

        // If this is the selected entry, re-render detail
        if (selectedLLMCallId === data.callId) {
            renderLLMDetail(data.callId);
        }
    }

    function selectLLMLog(callId) {
        selectedLLMCallId = callId;
        // Update active row styling
        document.querySelectorAll(".llm-log-row").forEach(r => r.classList.remove("llm-log-active"));
        const row = document.querySelector(`.llm-log-row[data-call-id="${callId}"]`);
        if (row) row.classList.add("llm-log-active");
        renderLLMDetail(callId);
    }

    function renderLLMDetail(callId) {
        const detailEl = document.getElementById("llm-log-detail");
        if (!detailEl) return;

        const entry = llmLogs.find(e => e.callId === callId);
        if (!entry) {
            detailEl.innerHTML = '<div class="text-sm opacity-40 p-4">条目未找到</div>';
            return;
        }

        const r = entry.response;
        let html = '';

        // Header
        const callerBadge = CALLER_COLORS[entry.caller] || "badge-ghost";
        html += `<div class="llm-detail-header">
            <span class="badge badge-sm ${callerBadge}">${escapeHtml(entry.caller)}</span>
            <span class="opacity-70">${escapeHtml(entry.model)}</span>
            <span class="opacity-40">T=${entry.temperature} max=${entry.maxTokens}</span>
            ${r ? `<span class="opacity-60">${r.durationMs}ms</span>` : '<span class="text-warning">进行中...</span>'}
            ${r?.usage ? `<span class="opacity-40">prompt:${r.usage.promptTokens ?? '?'} / completion:${r.usage.completionTokens ?? '?'} / total:${r.usage.totalTokens ?? '?'}</span>` : ''}
        </div>`;

        // Messages
        html += '<div class="llm-detail-section"><div class="llm-detail-section-title">Messages (' + (entry.messageSummaries?.length ?? 0) + ')</div>';
        (entry.messageSummaries || []).forEach((m, mi) => {
            const roleClass = m.role === 'system' ? 'llm-role-system' : m.role === 'assistant' ? 'llm-role-assistant' : 'llm-role-user';
            const content = m.contentPreview || '';
            const truncLen = 200;
            const needsTrunc = content.length > truncLen;
            const msgId = `llm-msg-${callId}-${mi}`;
            html += `<div class="llm-detail-msg">
                <div class="llm-detail-msg-role ${roleClass}">${m.role}</div>
                <div class="llm-detail-msg-content" id="${msgId}">${escapeHtml(needsTrunc ? content.slice(0, truncLen) + '...' : content)}</div>`;
            if (needsTrunc) {
                html += `<span class="llm-msg-toggle" id="${msgId}-toggle" onclick="App.toggleMsgExpand('${callId}',${mi})">展开</span>`;
            }
            if (m.imageCount > 0) {
                html += '<div class="llm-detail-msg-images">';
                for (const url of (m.imageUrls || [])) {
                    const isData = url.startsWith('data:');
                    const label = isData ? url.split(';')[0].replace('data:', '') : 'URL';
                    html += `<span class="llm-img-hover-wrap">
                        <span class="badge badge-sm badge-outline">🖼️ ${escapeHtml(label)}</span>
                        <img class="llm-img-preview" src="${isData ? url : escapeHtml(url)}" alt="preview" loading="lazy" />
                    </span> `;
                }
                html += '</div>';
            }
            html += '</div>';
        });
        html += '</div>';

        // Response
        if (r) {
            html += '<div class="llm-detail-section"><div class="llm-detail-section-title">Response (' + (r.contentLength ?? 0) + ' chars)</div>';
            if (r.error) {
                html += `<div class="llm-detail-error">${escapeHtml(r.error)}</div>`;
            } else {
                const respContent = r.contentPreview || '(empty)';
                const respTruncLen = 500;
                const respNeedsTrunc = respContent.length > respTruncLen;
                const respId = `llm-resp-${callId}`;
                html += `<div class="llm-detail-response-body" id="${respId}">${escapeHtml(respNeedsTrunc ? respContent.slice(0, respTruncLen) + '...' : respContent)}</div>`;
                if (respNeedsTrunc) {
                    html += `<span class="llm-msg-toggle" id="${respId}-toggle" onclick="App.toggleRespExpand('${callId}')">展开</span>`;
                }
            }
            html += '</div>';
        }

        detailEl.innerHTML = html;
        detailEl.scrollTop = detailEl.scrollHeight;
    }

    function renderLLMLog() {
        // Called on tab switch — just update stats, list is already populated incrementally
        updateLLMStats();
    }

    function toggleLLMLogDetail(idx) {
        // unused now, kept for compat
    }

    function toggleMsgExpand(callId, msgIndex) {
        const entry = llmLogs.find(e => e.callId === callId);
        if (!entry || !entry.messageSummaries?.[msgIndex]) return;
        const content = entry.messageSummaries[msgIndex].contentPreview || '';
        const truncLen = 200;
        const msgEl = document.getElementById(`llm-msg-${callId}-${msgIndex}`);
        const togEl = document.getElementById(`llm-msg-${callId}-${msgIndex}-toggle`);
        if (!msgEl || !togEl) return;
        if (togEl.textContent === '展开') {
            msgEl.textContent = content;
            togEl.textContent = '收起';
        } else {
            msgEl.textContent = content.slice(0, truncLen) + '...';
            togEl.textContent = '展开';
        }
    }

    function toggleRespExpand(callId) {
        const entry = llmLogs.find(e => e.callId === callId);
        if (!entry?.response) return;
        const content = entry.response.contentPreview || '';
        const truncLen = 500;
        const el = document.getElementById(`llm-resp-${callId}`);
        const tog = document.getElementById(`llm-resp-${callId}-toggle`);
        if (!el || !tog) return;
        if (tog.textContent === '展开') {
            el.textContent = content;
            tog.textContent = '收起';
        } else {
            el.textContent = content.slice(0, truncLen) + '...';
            tog.textContent = '展开';
        }
    }

    function clearLLMLogs() {
        llmLogs = [];
        llmStats = { total: 0, success: 0, error: 0, totalTokens: 0 };
        selectedLLMCallId = null;
        updateLLMStats();
        const listEl = document.getElementById("llm-log-list");
        if (listEl) listEl.innerHTML = '<div class="text-sm opacity-40 p-4">等待 LLM 调用...</div>';
        const detailEl = document.getElementById("llm-log-detail");
        if (detailEl) detailEl.innerHTML = '<div class="text-sm opacity-40 p-4">← 点击左侧条目查看详情</div>';
    }

    // ─── Memory Sub-tabs ───
    let activeMemoryTab = 'm-persons';
    let memoryEditContext = null; // { type, key, data }

    function switchMemoryTab(tab) {
        activeMemoryTab = tab;
        document.querySelectorAll('.memory-subpanel').forEach(p => p.classList.add('hidden'));
        const panel = document.getElementById(`mpanel-${tab}`);
        if (panel) panel.classList.remove('hidden');
        document.querySelectorAll('[data-mtab]').forEach(t => {
            t.classList.toggle('tab-active', t.dataset.mtab === tab);
        });
        refreshMemorySubTab();
    }

    function refreshMemorySubTab() {
        if (activeMemoryTab === 'm-persons') loadPersons();
        if (activeMemoryTab === 'm-groups') loadGroups();
        if (activeMemoryTab === 'm-facts') loadFacts();
        if (activeMemoryTab === 'm-interactions') loadInteractions();
    }

    // ─── Person Identities ───
    let personsPage = 0;
    async function loadPersons(page) {
        if (page !== undefined) personsPage = page;
        const offset = personsPage * 50;
        const data = await api(`/memory/persons?limit=50&offset=${offset}`);
        document.getElementById('persons-count').textContent = data.total;
        const tbody = document.getElementById('persons-tbody');
        if (!data.items.length) { tbody.innerHTML = '<tr><td colspan="6" class="text-center opacity-60">暂无数据</td></tr>'; return; }
        tbody.innerHTML = data.items.map(p => {
            const aliases = (p.aliases || []).join(', ');
            const lastSeen = p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : '-';
            return `<tr>
                <td class="font-mono text-xs">${escapeHtml(p.userId)}</td>
                <td>${escapeHtml(p.displayName)}</td>
                <td class="max-w-32 truncate" title="${escapeHtml(aliases)}">${escapeHtml(aliases) || '-'}</td>
                <td>${p.totalMessageCount}</td>
                <td class="text-xs opacity-60">${lastSeen}</td>
                <td>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="App.editPerson('${escapeHtml(p.userId)}')">✏️</button>
                        <button class="btn btn-xs btn-ghost text-error" onclick="App.deletePerson('${escapeHtml(p.userId)}')">🗑</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
        // Pagination
        const totalPages = Math.ceil(data.total / 50);
        const pagEl = document.getElementById('persons-pagination');
        if (totalPages > 1) {
            pagEl.innerHTML = Array.from({ length: Math.min(totalPages, 10) }, (_, i) =>
                `<button class="btn btn-xs ${i === personsPage ? 'btn-primary' : 'btn-ghost'}" onclick="App.loadPersons(${i})">${i + 1}</button>`
            ).join('');
        } else pagEl.innerHTML = '';
    }

    async function editPerson(userId) {
        const data = await api(`/memory/user/${userId}`);
        const identity = data.identity || {};
        memoryEditContext = { type: 'person', key: { userId }, data: identity };
        document.getElementById('memory-edit-title').textContent = `编辑用户: ${userId}`;
        document.getElementById('memory-edit-fields').innerHTML = [
            fieldInput('displayName', '显示名', identity.displayName || ''),
            fieldInput('aliases', '别名 (逗号分隔)', (identity.aliases || []).join(', ')),
        ].join('');
        document.getElementById('memory-edit-modal').showModal();
    }

    async function deletePerson(userId) {
        if (!confirm(`确认删除用户画像 ${userId}？`)) return;
        await api(`/memory/person/${userId}`, { method: 'DELETE' });
        loadPersons();
    }

    // ─── Person Group Profiles ───
    async function loadProfiles() {
        const chatId = document.getElementById('profiles-chatid-input').value.trim();
        if (!chatId) { alert('请输入 chatId'); return; }
        const data = await api(`/memory/profiles/${chatId}`);
        const tbody = document.getElementById('profiles-tbody');
        if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="text-center opacity-60">暂无数据</td></tr>'; return; }
        tbody.innerHTML = data.map(p => {
            const traits = (p.traits || []).join(', ');
            const interests = (p.interests || []).join(', ');
            return `<tr>
                <td class="font-mono text-xs">${escapeHtml(p.userId)}</td>
                <td class="font-mono text-xs">${shortId(p.chatId)}</td>
                <td><span class="badge badge-xs">T${p.dunbarTier}</span></td>
                <td class="max-w-32 truncate" title="${escapeHtml(traits)}">${escapeHtml(traits) || '-'}</td>
                <td class="max-w-32 truncate" title="${escapeHtml(interests)}">${escapeHtml(interests) || '-'}</td>
                <td>${p.messageCount}</td>
                <td>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="App.editProfile('${escapeHtml(p.userId)}','${escapeHtml(p.chatId)}')">✏️</button>
                        <button class="btn btn-xs btn-ghost text-error" onclick="App.deleteProfile('${escapeHtml(p.userId)}','${escapeHtml(p.chatId)}')">🗑</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    async function editProfile(userId, chatId) {
        const profiles = await api(`/memory/profiles/${chatId}`);
        const p = profiles.find(x => x.userId === userId) || {};
        memoryEditContext = { type: 'profile', key: { userId, chatId }, data: p };
        document.getElementById('memory-edit-title').textContent = `编辑群内画像: ${userId} @ ${shortId(chatId)}`;
        document.getElementById('memory-edit-fields').innerHTML = [
            fieldSelect('dunbarTier', '邓巴层', p.dunbarTier || 4, [1,2,3,4]),
            fieldInput('dunbarReason', '分层理由', p.dunbarReason || ''),
            fieldInput('traits', 'Traits (逗号分隔)', (p.traits || []).join(', ')),
            fieldInput('interests', 'Interests (逗号分隔)', (p.interests || []).join(', ')),
            fieldInput('communicationStyle', '沟通风格', p.communicationStyle || ''),
            fieldInput('relationToAgent', '与 Agent 关系', p.relationToAgent || ''),
        ].join('');
        document.getElementById('memory-edit-modal').showModal();
    }

    async function deleteProfile(userId, chatId) {
        if (!confirm(`确认删除 ${userId} 在 ${shortId(chatId)} 的画像？`)) return;
        await api(`/memory/profile/${userId}/${chatId}`, { method: 'DELETE' });
        loadProfiles();
    }

    // ─── Group Models ───
    async function loadGroups() {
        const data = await api('/memory/groups');
        const tbody = document.getElementById('groups-tbody');
        if (!data.length) { tbody.innerHTML = '<tr><td colspan="8" class="text-center opacity-60">暂无数据</td></tr>'; return; }
        tbody.innerHTML = data.map(g => {
            const hot = (g.hotTopics || []).join(', ');
            const taboo = (g.tabooTopics || []).join(', ');
            return `<tr>
                <td class="font-mono text-xs" title="${escapeHtml(g.chatId)}">${shortId(g.chatId)}</td>
                <td>${escapeHtml(g.chatTitle || '-')}</td>
                <td class="max-w-40 truncate" title="${escapeHtml(g.description || '')}">${escapeHtml(g.description || '-')}</td>
                <td>${escapeHtml(g.dominantLanguage || '-')}</td>
                <td class="max-w-32 truncate" title="${escapeHtml(g.agentRole || '')}">${escapeHtml(g.agentRole || '-')}</td>
                <td class="max-w-32 truncate" title="${escapeHtml(hot)}">${escapeHtml(hot) || '-'}</td>
                <td class="max-w-32 truncate" title="${escapeHtml(taboo)}">${escapeHtml(taboo) || '-'}</td>
                <td>
                    <button class="btn btn-xs btn-ghost" onclick="App.editGroupModel('${escapeHtml(g.chatId)}')">✏️</button>
                </td>
            </tr>`;
        }).join('');
    }

    async function editGroupModel(chatId) {
        const g = await api(`/memory/group/${chatId}`);
        const model = g.model || g || {};
        memoryEditContext = { type: 'group', key: { chatId }, data: model };
        document.getElementById('memory-edit-title').textContent = `编辑群组画像: ${model.chatTitle || shortId(chatId)}`;
        document.getElementById('memory-edit-fields').innerHTML = [
            fieldInput('chatTitle', '群组标题', model.chatTitle || ''),
            fieldTextarea('description', '群组描述', model.description || ''),
            fieldInput('dominantLanguage', '主要语言', model.dominantLanguage || ''),
            fieldInput('agentRole', 'Agent 角色', model.agentRole || ''),
            fieldSelect('engagementLevel', '参与度', model.engagementLevel || 'medium', ['high','medium','low']),
            fieldTextarea('recentFeedback', '近期反馈', model.recentFeedback || ''),
            fieldInput('hotTopics', '热门话题 (逗号分隔)', (model.hotTopics || []).join(', ')),
            fieldInput('tabooTopics', '禁忌话题 (逗号分隔)', (model.tabooTopics || []).join(', ')),
            fieldInput('communicationNorms', '交流规范 (逗号分隔)', (model.communicationNorms || []).join(', ')),
        ].join('');
        document.getElementById('memory-edit-modal').showModal();
    }

    // ─── Core Facts ───
    let factsPage = 0;
    async function loadFacts(page) {
        if (page !== undefined) factsPage = page;
        const subject = document.getElementById('facts-subject-input').value.trim();
        const category = document.getElementById('facts-category-select').value;
        let url = `/memory/facts?limit=50&offset=${factsPage * 50}`;
        if (subject) url += `&subject=${encodeURIComponent(subject)}`;
        if (category) url += `&category=${encodeURIComponent(category)}`;
        const data = await api(url);
        document.getElementById('facts-count').textContent = data.total;
        const tbody = document.getElementById('facts-tbody');
        if (!data.items.length) { tbody.innerHTML = '<tr><td colspan="7" class="text-center opacity-60">暂无数据</td></tr>'; return; }
        tbody.innerHTML = data.items.map(f => {
            const updated = f.updatedAt ? new Date(f.updatedAt).toLocaleString() : '-';
            const expires = f.expiresAt ? new Date(f.expiresAt).toLocaleString() : '-';
            return `<tr>
                <td class="font-mono text-xs max-w-24 truncate" title="${escapeHtml(f.subject)}">${escapeHtml(f.subject)}</td>
                <td><span class="badge badge-xs">${escapeHtml(f.category)}</span></td>
                <td class="max-w-64 truncate" title="${escapeHtml(f.content)}">${escapeHtml(f.content)}</td>
                <td>${(f.confidence * 100).toFixed(0)}%</td>
                <td class="text-xs opacity-60">${expires}</td>
                <td class="text-xs opacity-60">${updated}</td>
                <td>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="App.editFact('${escapeHtml(f.id)}')">✏️</button>
                        <button class="btn btn-xs btn-ghost text-error" onclick="App.deleteFact('${escapeHtml(f.id)}')">🗑</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
        const totalPages = Math.ceil(data.total / 50);
        const pagEl = document.getElementById('facts-pagination');
        if (totalPages > 1) {
            pagEl.innerHTML = Array.from({ length: Math.min(totalPages, 10) }, (_, i) =>
                `<button class="btn btn-xs ${i === factsPage ? 'btn-primary' : 'btn-ghost'}" onclick="App.loadFacts(${i})">${i + 1}</button>`
            ).join('');
        } else pagEl.innerHTML = '';
    }

    function editFact(factId) {
        const row = document.querySelector(`#facts-tbody tr`);
        // Re-fetch from current data
        loadFactForEdit(factId);
    }

    async function loadFactForEdit(factId) {
        const data = await api(`/memory/facts?limit=200`);
        const f = (data.items || []).find(x => x.id === factId);
        if (!f) { alert('未找到'); return; }
        memoryEditContext = { type: 'fact', key: { id: factId }, data: f };
        document.getElementById('memory-edit-title').textContent = `编辑事实: ${f.subject}`;
        document.getElementById('memory-edit-fields').innerHTML = [
            fieldTextarea('content', '内容', f.content || ''),
            fieldSelect('category', '分类', f.category || 'general', ['biographical','preference','anecdote','opinion','plan','relationship','general']),
            fieldInput('confidence', '置信度 (0-1)', String(f.confidence ?? 1)),
            fieldInput('expiresAt', '过期时间 (ISO)', f.expiresAt || ''),
        ].join('');
        document.getElementById('memory-edit-modal').showModal();
    }

    async function deleteFact(id) {
        if (!confirm('确认删除此事实？')) return;
        await api(`/memory/fact/${id}`, { method: 'DELETE' });
        loadFacts();
    }

    // ─── Interactions ───
    let interactionsPage = 0;
    async function loadInteractions(page) {
        if (page !== undefined) interactionsPage = page;
        const chatId = document.getElementById('interactions-chatid-input').value.trim();
        const userId = document.getElementById('interactions-userid-input').value.trim();
        let url = `/memory/interactions?limit=50&offset=${interactionsPage * 50}`;
        if (chatId) url += `&chatId=${encodeURIComponent(chatId)}`;
        if (userId) url += `&userId=${encodeURIComponent(userId)}`;
        const data = await api(url);
        document.getElementById('interactions-count').textContent = data.total;
        const tbody = document.getElementById('interactions-tbody');
        if (!data.items.length) { tbody.innerHTML = '<tr><td colspan="8" class="text-center opacity-60">暂无数据</td></tr>'; return; }
        tbody.innerHTML = data.items.map(i => {
            const time = i.date ? new Date(i.date).toLocaleString() : '-';
            return `<tr>
                <td class="text-xs opacity-60">${time}</td>
                <td class="font-mono text-xs">${shortId(i.chatId)}</td>
                <td class="font-mono text-xs">${escapeHtml(i.userId)}</td>
                <td><span class="badge badge-xs">${escapeHtml(i.type)}</span></td>
                <td class="max-w-64 truncate" title="${escapeHtml(i.summary)}">${escapeHtml(i.summary)}</td>
                <td>${escapeHtml(i.sentiment)}</td>
                <td>${(i.significance * 100).toFixed(0)}%</td>
                <td>
                    <button class="btn btn-xs btn-ghost text-error" onclick="App.deleteInteraction('${escapeHtml(i.id)}')">🗑</button>
                </td>
            </tr>`;
        }).join('');
        const totalPages = Math.ceil(data.total / 50);
        const pagEl = document.getElementById('interactions-pagination');
        if (totalPages > 1) {
            pagEl.innerHTML = Array.from({ length: Math.min(totalPages, 10) }, (_, i) =>
                `<button class="btn btn-xs ${i === interactionsPage ? 'btn-primary' : 'btn-ghost'}" onclick="App.loadInteractions(${i})">${i + 1}</button>`
            ).join('');
        } else pagEl.innerHTML = '';
    }

    async function deleteInteraction(id) {
        if (!confirm('确认删除此交互记录？')) return;
        await api(`/memory/interaction/${id}`, { method: 'DELETE' });
        loadInteractions();
    }

    // ─── Memory Edit Modal Helpers ───
    function fieldInput(name, label, value) {
        return `<div><label class="label text-xs">${escapeHtml(label)}</label><input name="${name}" type="text" value="${escapeHtml(value)}" class="input input-bordered input-sm w-full" /></div>`;
    }
    function fieldTextarea(name, label, value) {
        return `<div><label class="label text-xs">${escapeHtml(label)}</label><textarea name="${name}" class="textarea textarea-bordered textarea-sm w-full" rows="3">${escapeHtml(value)}</textarea></div>`;
    }
    function fieldSelect(name, label, value, options) {
        return `<div><label class="label text-xs">${escapeHtml(label)}</label><select name="${name}" class="select select-bordered select-sm w-full">${options.map(o => `<option value="${o}" ${String(o) === String(value) ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    }

    async function saveMemoryEdit() {
        if (!memoryEditContext) return;
        const fields = document.getElementById('memory-edit-fields');
        const formData = {};
        fields.querySelectorAll('input, textarea, select').forEach(el => {
            formData[el.name] = el.value;
        });

        const { type, key } = memoryEditContext;
        try {
            if (type === 'person') {
                const body = {
                    displayName: formData.displayName,
                    aliases: formData.aliases ? formData.aliases.split(',').map(s => s.trim()).filter(Boolean) : [],
                };
                await api(`/memory/person/${key.userId}`, { method: 'PUT', body });
                loadPersons();
            } else if (type === 'profile') {
                const body = {
                    dunbarTier: parseInt(formData.dunbarTier) || 4,
                    dunbarReason: formData.dunbarReason,
                    traits: formData.traits ? formData.traits.split(',').map(s => s.trim()).filter(Boolean) : [],
                    interests: formData.interests ? formData.interests.split(',').map(s => s.trim()).filter(Boolean) : [],
                    communicationStyle: formData.communicationStyle,
                    relationToAgent: formData.relationToAgent,
                };
                await api(`/memory/profile/${key.userId}/${key.chatId}`, { method: 'PUT', body });
                loadProfiles();
            } else if (type === 'group') {
                const body = {
                    chatTitle: formData.chatTitle,
                    description: formData.description,
                    dominantLanguage: formData.dominantLanguage,
                    agentRole: formData.agentRole,
                    engagementLevel: formData.engagementLevel,
                    recentFeedback: formData.recentFeedback,
                    hotTopics: formData.hotTopics ? formData.hotTopics.split(',').map(s => s.trim()).filter(Boolean) : [],
                    tabooTopics: formData.tabooTopics ? formData.tabooTopics.split(',').map(s => s.trim()).filter(Boolean) : [],
                    communicationNorms: formData.communicationNorms ? formData.communicationNorms.split(',').map(s => s.trim()).filter(Boolean) : [],
                };
                await api(`/memory/group/${key.chatId}`, { method: 'PUT', body });
                loadGroups();
            } else if (type === 'fact') {
                const body = {
                    content: formData.content,
                    category: formData.category,
                    confidence: parseFloat(formData.confidence) || 1.0,
                    expiresAt: formData.expiresAt || null,
                };
                await api(`/memory/fact/${key.id}`, { method: 'PUT', body });
                loadFacts();
            }
        } catch (err) {
            alert('保存失败: ' + err);
            return;
        }
        document.getElementById('memory-edit-modal').close();
        memoryEditContext = null;
    }

    // Public API (for onclick handlers)
    return {
        selectChat, loadTopics, loadMoreTopics, toggleTopicGroup, searchTopics, clearTopicSearch,
        boostQueue, removeFromQueue, showEnqueueModal, doEnqueue,
        selectCodeActChat, cancelCodeAct, queryUser, queryGroup, quickQueryUser, quickQueryGroup, recallMemory,
        viewTopicDetail, loadStickers, deleteSticker, editSticker, saveSticker, clearLLMLogs, toggleLLMLogDetail, toggleMsgExpand, toggleRespExpand,
        switchMemoryTab, loadPersons, editPerson, deletePerson,
        loadProfiles, editProfile, deleteProfile,
        loadGroups, editGroupModel,
        loadFacts, editFact, deleteFact,
        loadInteractions, deleteInteraction,
        saveMemoryEdit,
    };
})();
