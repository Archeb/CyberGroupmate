<script>
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import MonacoEditor from '../components/MonacoEditor.svelte';

  let servers = [];
  let configJson = '[]';
  let loading = false;
  let saving = false;
  let notice = null;
  let wasMcpTabActive = false;

  $: {
    const isMcpTabActive = $activeTab === 'mcp';
    if (isMcpTabActive && !wasMcpTabActive && !loading) {
      loadMcpState();
    }
    wasMcpTabActive = isMcpTabActive;
  }

  function showNotice(message, type = 'info') {
    notice = { message, type };
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => {
      notice = null;
    }, type === 'error' ? 8000 : 4000);
  }

  async function loadMcpState() {
    loading = true;
    try {
      const [serversRes, configsRes] = await Promise.all([
        api('/mcp'),
        api('/mcp/configs'),
      ]);
      if (serversRes.error) throw new Error(serversRes.error);
      if (configsRes.error) throw new Error(configsRes.error);
      servers = serversRes.servers || [];
      configJson = JSON.stringify(configsRes.configs || [], null, 2);
    } catch (err) {
      showNotice('加载 MCP 状态失败: ' + err, 'error');
      servers = [];
    }
    loading = false;
  }

  async function saveConfigs() {
    saving = true;
    try {
      const configs = JSON.parse(configJson || '[]');
      const res = await api('/mcp/configs', {
        method: 'PUT',
        body: { configs },
      });
      if (res.error) {
        showNotice('保存失败: ' + res.error, 'error');
      } else {
        servers = res.servers || [];
        configJson = JSON.stringify(res.configs || configs, null, 2);
        showNotice('全局 MCP 配置已应用', 'success');
      }
    } catch (err) {
      showNotice('JSON 无效: ' + err, 'error');
    }
    saving = false;
  }

  async function disconnectServer(name) {
    try {
      const res = await api('/mcp/' + encodeURIComponent(name), { method: 'DELETE' });
      if (res.error) {
        showNotice('卸载失败: ' + res.error, 'error');
        return;
      }
      await loadMcpState();
      showNotice(`${name} 已卸载`, 'success');
    } catch (err) {
      showNotice('卸载失败: ' + err, 'error');
    }
  }

  function useStdioTemplate() {
    configJson = JSON.stringify([
      {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        env: {},
      },
    ], null, 2);
  }

  function useHttpTemplate() {
    configJson = JSON.stringify([
      {
        name: 'remote-http',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          Authorization: 'Bearer <token>',
        },
      },
    ], null, 2);
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold">MCP</h2>
        <p class="text-sm text-base-content/70">全局 MCP 服务器安装与运行状态。所有 sandbox 共享这一份配置。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-outline btn-sm" on:click={useStdioTemplate}>stdio 模板</button>
        <button class="btn btn-outline btn-sm" on:click={useHttpTemplate}>HTTP 模板</button>
        <button class="btn btn-ghost btn-sm" on:click={loadMcpState} disabled={loading || saving}>
          {loading ? '刷新中...' : '刷新'}
        </button>
        <button class="btn btn-primary btn-sm" on:click={saveConfigs} disabled={saving || loading}>
          {saving ? '保存中...' : '应用 JSON 配置'}
        </button>
      </div>
    </div>

    {#if notice}
      <div class={`alert ${notice.type === 'error' ? 'alert-error' : notice.type === 'success' ? 'alert-success' : 'alert-info'}`}>
        <span>{notice.message}</span>
      </div>
    {/if}

    <div class="stats stats-vertical lg:stats-horizontal shadow-sm bg-base-200">
      <div class="stat py-3">
        <div class="stat-title">已安装 Servers</div>
        <div class="stat-value text-2xl">{servers.length}</div>
      </div>
      <div class="stat py-3">
        <div class="stat-title">运行中</div>
        <div class="stat-value text-2xl">{servers.filter((srv) => srv.running).length}</div>
      </div>
      <div class="stat py-3">
        <div class="stat-title">总工具数</div>
        <div class="stat-value text-2xl">{servers.reduce((sum, srv) => sum + (srv.tools?.length || 0), 0)}</div>
      </div>
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-[1.05fr_1.35fr] gap-4">
      <div class="card bg-base-200 shadow-sm">
        <div class="card-body p-4">
          <div class="flex items-center justify-between gap-3 mb-2">
            <h3 class="card-title text-base">当前全局 Servers</h3>
            <span class="badge badge-outline">shared</span>
          </div>

          {#if loading}
            <div class="text-sm text-base-content/60">正在加载 MCP 状态...</div>
          {:else if servers.length === 0}
            <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
              当前没有已安装的 MCP Server。可以直接在右侧 JSON 编辑器里填入配置并应用。
            </div>
          {:else}
            <div class="space-y-3">
              {#each servers as srv}
                <div class="rounded-xl border border-base-300 bg-base-100 p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1 space-y-2">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class={`badge badge-sm ${srv.running ? 'badge-success' : 'badge-error'}`}>
                          {srv.running ? 'running' : 'stopped'}
                        </span>
                        <span class="font-mono font-semibold break-all">{srv.name}</span>
                        <span class="badge badge-secondary badge-sm">{srv.transport}</span>
                        <span class="badge badge-outline badge-sm">{srv.tools?.length || 0} tools</span>
                      </div>
                      {#if srv.url}
                        <div class="text-xs text-base-content/60 break-all">{srv.url}</div>
                      {/if}
                      {#if srv.tools?.length > 0}
                        <div class="flex flex-wrap gap-1">
                          {#each srv.tools as tool}
                            <span class="badge badge-ghost badge-xs">{tool}</span>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <button class="btn btn-error btn-outline btn-xs" on:click={() => disconnectServer(srv.name)}>
                      卸载
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-200 shadow-sm">
        <div class="card-body p-4 space-y-3">
          <div>
            <h3 class="card-title text-base">安装配置 JSON</h3>
            <p class="text-sm text-base-content/60">直接编辑全局安装配置数组。保存后会按 JSON 全量替换当前 MCP 安装状态。</p>
          </div>

          <MonacoEditor bind:value={configJson} language="json" height={560} />

          <div class="text-xs text-base-content/60 leading-6">
            每项至少需要 `name`，并且提供 `command` 或 `url`。`stdio` 使用 `command` / `args` / `env`，`streamable-http` 使用 `url` / `headers`。
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
