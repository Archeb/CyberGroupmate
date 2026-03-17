/**
 * app.js — Dashboard 前端应用
 *
 * 纯 JS，无框架。WebSocket 实时推送 + REST API 拉取。
 */

const App = (() => {
    // ─── Config ───
    const params = new URLSearchParams(location.search);
    const TOKEN = params.get("token") || "";
    const API = `/api`;
    const WS_URL = `ws://${location.host}/ws?token=${TOKEN}`;

    // ─── State ───
    let ws = null;
    let state = { groups: [], queue: [], pendingCallbacks: [], globalState: {}, sandboxPool: {}, mainLoop: {}, feedbackLoop: {} };
    let messages = []; // ring buffer of recent messages
    const MAX_MESSAGES = 500;
    let selectedChatId = null; // for messages tab
    let selectedCodeActChatId = null;
    let refreshTimer = null;

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
            } catch {}
        };
    }

    function handleEvent(event) {
        switch (event.type) {
            case "snapshot":
                state = event.data;
                renderAll();
                break;
            case "nc:message":
                addMessage(event.data, event.timestamp);
                break;
            case "queue:update":
                state.queue = event.data;
                renderQueue();
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
                const short = id.length > 15 ? id.slice(-12) : id;
                return `<div class="chat-item ${selectedChatId === id ? 'active' : ''}" onclick="App.selectChat('${id}')" title="${id}">
                    <span>${short}</span><span class="badge badge-sm">${count}</span>
                </div>`;
            }).join("");
    }

    function renderMessageStream() {
        const filtered = selectedChatId ? messages.filter(m => m.chatId === selectedChatId) : messages;
        const el = document.getElementById("message-stream");
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
        el.innerHTML = filtered.slice(-200).map(m => {
            const time = new Date(m.timestamp).toLocaleTimeString();
            const isAgent = m.userId === "agent" || m.userId === "self";
            const isMention = m.mentionsAgent;
            const cls = [isAgent ? "is-agent" : "", isMention ? "is-mention" : ""].join(" ");
            const text = escapeHtml(m.text || "").slice(0, 500);
            const nameLink = isAgent ? `<span class="msg-user">🤖 Agent</span>` :
                `<span class="msg-user cursor-pointer hover:underline" onclick="App.quickQueryUser('${m.userId}','${m.chatId}')">${escapeHtml(m.displayName || m.userId)}</span>`;
            return `<div class="msg-item ${cls}">
                <span class="msg-time">${time}</span>
                ${nameLink}
                <span class="msg-text">${text}</span>
            </div>`;
        }).join("");
        if (atBottom) el.scrollTop = el.scrollHeight;
        document.getElementById("msg-chat-label").textContent = selectedChatId ? `Chat: ${selectedChatId}` : "全部";
    }

    function selectChat(chatId) {
        selectedChatId = chatId;
        renderChatList();
        renderMessageStream();
    }

    // ─── Topics ───
    function renderTopics() {
        const container = document.getElementById("topics-container");
        if (!state.groups.length) { container.innerHTML = '<div class="text-sm opacity-60">暂无数据</div>'; return; }
        container.innerHTML = state.groups.map(g => {
            return `<div class="collapse collapse-arrow bg-base-200">
                <input type="checkbox" />
                <div class="collapse-title text-sm font-medium flex justify-between items-center">
                    <span>${escapeHtml(g.chatId)}</span>
                    <span class="badge badge-sm">${g.topicCount} 话题</span>
                </div>
                <div class="collapse-content">
                    <div id="topics-${CSS.escape(g.chatId)}" class="space-y-1">
                        <button class="btn btn-xs btn-ghost" onclick="App.loadTopics('${g.chatId}')">加载话题</button>
                    </div>
                </div>
            </div>`;
        }).join("");
    }

    async function loadTopics(chatId) {
        const topics = await api(`/topics/${chatId}`);
        const el = document.getElementById(`topics-${CSS.escape(chatId)}`);
        if (!topics.length) { el.innerHTML = '<div class="text-sm opacity-60">无话题</div>'; return; }
        el.innerHTML = topics.map(t => {
            const stateClass = `state-${(t.state||"").toLowerCase()}`;
            const participants = (t.participantIds || []).map(p =>
                `<span class="cursor-pointer hover:underline text-primary" onclick="App.quickQueryUser('${p}','${chatId}')">${escapeHtml(p)}</span>`
            ).join(", ");
            return `<div class="topic-card ${stateClass}">
                <div class="flex justify-between items-center">
                    <span class="font-semibold text-sm">${escapeHtml(t.label || t.id)}</span>
                    <span class="badge badge-xs">${t.state}</span>
                </div>
                <div class="text-xs opacity-70 mt-1">${escapeHtml(t.summary || "")}</div>
                <div class="text-xs mt-1">
                    参与者: ${participants || "无"} | 消息数: ${(t.messageIds||[]).length} |
                    关键词: ${(t.keywords||[]).map(k => escapeHtml(k)).join(", ")}
                </div>
            </div>`;
        }).join("");
    }

    // ─── Queue ───
    function renderQueue() {
        const tbody = document.getElementById("queue-tbody");
        if (!state.queue.length) { tbody.innerHTML = '<tr><td colspan="8" class="text-center opacity-60">队列为空</td></tr>'; return; }
        const sorted = [...state.queue].sort((a, b) => b.priority - a.priority);
        tbody.innerHTML = sorted.map(e => {
            const pClass = e.priority > 50 ? "priority-high" : e.priority > 20 ? "priority-mid" : "priority-low";
            const blocked = e.blocked ? "is-blocked" : "";
            return `<tr class="queue-row ${blocked}">
                <td class="font-mono text-xs cursor-pointer hover:underline" onclick="App.quickQueryGroup('${e.chatId}')">${shortId(e.chatId)}</td>
                <td class="${pClass}">${e.priority.toFixed(1)}</td>
                <td><span class="badge badge-xs">${e.source}</span></td>
                <td class="stickiness-${e.stickinessLevel}">${e.stickinessLevel}</td>
                <td>${e.newMessageCount}</td>
                <td>${(e.topicDigests||[]).length}</td>
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
        el.innerHTML = (decisions || []).map((d, i) => {
            const time = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : "";
            return `<div class="decision-item">
                <span class="opacity-50">${time}</span>
                <span class="cursor-pointer hover:underline text-primary" onclick="App.quickQueryGroup('${d.chatId}')">${shortId(d.chatId)}</span>
                ${escapeHtml(d.decision || d.content || JSON.stringify(d))}
            </div>`;
        }).join("");

        // Main agent history
        const history = await api("/main-agent/history");
        const hEl = document.getElementById("main-agent-history");
        hEl.innerHTML = (history || []).map(msg => {
            const roleColor = msg.role === "assistant" ? "text-primary" : msg.role === "system" ? "text-info" : "text-success";
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            return `<div class="codeact-msg role-${msg.role}">
                <span class="${roleColor} font-bold text-[0.7rem]">[${msg.role}]</span>
                <div class="whitespace-pre-wrap mt-1">${escapeHtml(content).slice(0, 2000)}</div>
            </div>`;
        }).join("");
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

    async function selectCodeActChat(chatId) {
        selectedCodeActChatId = chatId;
        renderCodeActChatList();
        document.getElementById("codeact-label").textContent = chatId;
        const data = await api(`/codeact/${chatId}`);
        document.getElementById("codeact-session-size").textContent = data.sessionSize ?? "-";
        document.getElementById("codeact-exec-count").textContent = data.executionCount ?? "-";
        document.getElementById("codeact-queue-size").textContent = data.queueSize ?? "-";
        const cancelBtn = document.getElementById("codeact-cancel-btn");
        cancelBtn.classList.toggle("hidden", !data.isProcessing);
        const el = document.getElementById("codeact-session");
        el.innerHTML = (data.session || []).map(msg => {
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            return `<div class="codeact-msg role-${msg.role}">
                <span class="font-bold text-[0.7rem]">[${msg.role}]</span>
                <pre class="whitespace-pre-wrap mt-1 text-xs">${escapeHtml(content).slice(0, 5000)}</pre>
            </div>`;
        }).join("");
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
        document.getElementById("memory-result").textContent = JSON.stringify(result, null, 2);
    }

    async function queryGroup() {
        const chatId = document.getElementById("memory-group-input").value;
        if (!chatId) return;
        const result = await api(`/memory/group/${chatId}`);
        document.getElementById("memory-result").textContent = JSON.stringify(result, null, 2);
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

    // ─── System Tab ───
    async function renderSystem() {
        // Global state
        const gs = await api("/global-state");
        document.getElementById("global-state-display").textContent = JSON.stringify(gs, null, 2);

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
            ${(pool.instances||[]).length ? '<div class="mt-2 space-y-1">' + (pool.instances||[]).map(i => `
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
        // Also include recent callbacks from groups
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
                <td class="font-mono text-xs cursor-pointer hover:underline" onclick="App.quickQueryGroup('${g.chatId}')">${shortId(g.chatId)}</td>
                <td class="stickiness-${g.stickiness}">${g.stickiness}</td>
                <td>${(g.engagement || 0).toFixed(1)}</td>
                <td>${g.bufferSize || 0}</td>
                <td>${g.attendCount || 0}</td>
                <td>${fp.authorized ? `<span class="badge badge-xs badge-warning">${fp.repliesSent}/${fp.maxReplies}</span>` : '<span class="opacity-40">-</span>'}</td>
            </tr>`;
        }).join("");
    }

    // ─── Tab Management ───
    function switchTab(tab) {
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
        document.getElementById(`panel-${tab}`).classList.remove("hidden");
        document.querySelectorAll('[role="tab"]').forEach(t => {
            t.classList.toggle("tab-active", t.dataset.tab === tab);
        });
        // Lazy load tab data
        if (tab === "topics") renderTopics();
        if (tab === "decisions") renderDecisions();
        if (tab === "codeact") renderCodeActChatList();
        if (tab === "system") renderSystem();
    }

    // ─── Render All ───
    function renderAll() {
        // Stats bar
        document.getElementById("stat-groups").textContent = state.groups.length;
        document.getElementById("stat-queue").textContent = state.queue.length;
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
                renderAll();
            } catch {}
        }, 10000);
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

    // ─── Init ───
    function init() {
        // Tab click handlers
        document.querySelectorAll('[role="tab"]').forEach(tab => {
            tab.addEventListener("click", () => switchTab(tab.dataset.tab));
        });
        connectWS();
        startPeriodicRefresh();
    }

    document.addEventListener("DOMContentLoaded", init);

    // Public API (for onclick handlers)
    return {
        selectChat, loadTopics, boostQueue, removeFromQueue, showEnqueueModal, doEnqueue,
        selectCodeActChat, cancelCodeAct, queryUser, queryGroup, quickQueryUser, quickQueryGroup,
    };
})();
