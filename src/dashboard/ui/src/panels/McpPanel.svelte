<script>
import { activeTab, appState } from '../lib/stores.js';
import { api } from '../lib/api.js';

let chatId = '';
let servers = [];
let loading = false;
let error = '';
let toast = '';
let toastType = 'success';

// Connect form state
let connectName = '';
let connectCommand = '';
let connectArgs = '';
let connectEnv = '';
let connecting = false;

// Auto-load when tab becomes active + sandbox pool available
$: if ($activeTab === 'mcp' && $appState.sandboxPool) {
    const instances = $appState.sandboxPool.instances ?? [];
    if (instances.length > 0 && !chatId) {
        chatId = instances[0].chatId;
    }
}

$: if ($activeTab === 'mcp' && chatId) {
    loadServers();
}

function showToast(msg, type = 'success') {
    toast = msg;
    toastType = type;
    setTimeout(() => { toast = ''; }, 3000);
}

async function loadServers() {
    if (!chatId) return;
    loading = true;
    error = '';
    try {
        const res = await api(`/sandbox/${encodeURIComponent(chatId)}/mcp`);
        if (res.error) {
            error = res.error;
            servers = [];
        } else {
            servers = res.servers ?? [];
        }
    } catch (e) {
        error = String(e);
        servers = [];
    }
    loading = false;
}

async function connectServer() {
    if (!connectName || !connectCommand) return;
    connecting = true;
    error = '';
    try {
        let args;
        if (connectArgs.trim()) {
            try {
                args = JSON.parse(connectArgs.trim());
            } catch {
                args = connectArgs.trim().split(/\s+/);
            }
        }
        let env;
        if (connectEnv.trim()) {
            try {
                env = JSON.parse(connectEnv.trim());
            } catch {
                error = 'env 格式错误，需要 JSON 对象';
                connecting = false;
                return;
            }
        }
        const res = await api(`/sandbox/${encodeURIComponent(chatId)}/mcp/connect`, {
            method: 'POST',
            body: { name: connectName, command: connectCommand, args, env },
        });
        if (res.error) {
            error = res.error;
        } else {
            showToast(`${connectName} 已连接 (${res.tools?.length ?? 0} tools)`);
            connectName = '';
            connectCommand = '';
            connectArgs = '';
            connectEnv = '';
            await loadServers();
        }
    } catch (e) {
        error = String(e);
    }
    connecting = false;
}

async function disconnectServer(name) {
    try {
        const res = await api(`/sandbox/${encodeURIComponent(chatId)}/mcp/${encodeURIComponent(name)}`, {
            method: 'DELETE',
        });
        if (res.error) {
            showToast(res.error, 'error');
        } else {
            showToast(`${name} 已断开`);
            await loadServers();
        }
    } catch (e) {
        showToast(String(e), 'error');
    }
}
</script>

<div class="p-4 space-y-4">
    <!-- Toast -->
    {#if toast}
        <div class="toast toast-top toast-end z-50">
            <div class="alert {toastType === 'error' ? 'alert-error' : 'alert-success'} shadow-lg">
                <span>{toast}</span>
            </div>
        </div>
    {/if}

    <!-- Header -->
    <div class="flex items-center gap-3">
        <h2 class="text-xl font-bold">MCP Servers</h2>

        <!-- Chat selector -->
        {#if $appState.sandboxPool?.instances?.length > 0}
            <select class="select select-bordered select-sm" bind:value={chatId} on:change={loadServers}>
                {#each $appState.sandboxPool.instances as inst}
                    <option value={inst.chatId}>{inst.chatId}</option>
                {/each}
            </select>
        {:else}
            <span class="badge badge-ghost">无活动 Sandbox</span>
        {/if}

        <button class="btn btn-ghost btn-sm" on:click={loadServers} disabled={!chatId || loading}>
            {loading ? '刷新中...' : '刷新'}
        </button>
    </div>

    {#if error}
        <div class="alert alert-error shadow-sm">
            <span>{error}</span>
        </div>
    {/if}

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Server List -->
        <div class="card bg-base-200 shadow">
            <div class="card-body">
                <h3 class="card-title text-base">已连接的 Servers</h3>
                {#if servers.length === 0}
                    <p class="text-base-content/50 text-sm">暂无连接</p>
                {:else}
                    <div class="space-y-2">
                        {#each servers as srv}
                            <div class="bg-base-100 p-3 rounded-lg flex items-start justify-between gap-2">
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2">
                                        <span class="badge badge-sm {srv.running ? 'badge-success' : 'badge-error'}">
                                            {srv.running ? '●' : '○'}
                                        </span>
                                        <span class="font-mono font-semibold">{srv.name}</span>
                                        <span class="badge badge-outline badge-sm">{srv.tools?.length ?? 0} tools</span>
                                    </div>
                                    {#if srv.tools?.length > 0}
                                        <div class="mt-1 flex flex-wrap gap-1">
                                            {#each srv.tools as tool}
                                                <span class="badge badge-ghost badge-xs">{tool}</span>
                                            {/each}
                                        </div>
                                    {/if}
                                </div>
                                <button
                                    class="btn btn-error btn-xs btn-outline"
                                    on:click={() => disconnectServer(srv.name)}
                                >断开</button>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>

        <!-- Connect Form -->
        <div class="card bg-base-200 shadow">
            <div class="card-body">
                <h3 class="card-title text-base">连接新 Server</h3>
                <div class="space-y-2">
                    <div class="form-control">
                        <label class="label"><span class="label-text">名称</span></label>
                        <input type="text" placeholder="e.g. filesystem"
                            class="input input-bordered input-sm" bind:value={connectName} />
                    </div>
                    <div class="form-control">
                        <label class="label"><span class="label-text">启动命令</span></label>
                        <input type="text" placeholder="e.g. npx"
                            class="input input-bordered input-sm" bind:value={connectCommand} />
                    </div>
                    <div class="form-control">
                        <label class="label"><span class="label-text">参数 (空格分隔或 JSON 数组)</span></label>
                        <input type="text" placeholder='-y @anthropic/mcp-filesystem /workspace'
                            class="input input-bordered input-sm" bind:value={connectArgs} />
                    </div>
                    <div class="form-control">
                        <label class="label"><span class="label-text">环境变量 (JSON, 可选)</span></label>
                        <input type="text" placeholder='{"API_KEY": "..."}'
                            class="input input-bordered input-sm" bind:value={connectEnv} />
                    </div>
                    <button
                        class="btn btn-primary btn-sm w-full mt-2"
                        on:click={connectServer}
                        disabled={!connectName || !connectCommand || !chatId || connecting}
                    >
                        {connecting ? '连接中...' : '连接'}
                    </button>
                </div>
            </div>
        </div>
    </div>
</div>
