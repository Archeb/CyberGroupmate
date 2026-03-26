<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { shortId } from '../lib/utils.js';

  let modal;
  let editCtx = null; // { type, key, data }
  let fields = [];
  let title = '编辑记忆';

  onMount(() => {
    async function onEdit(e) {
      const detail = e.detail;
      if (detail.type === 'person') {
        const data = await api(`/memory/user/${detail.userId}`);
        const identity = data.identity || {};
        editCtx = { type: 'person', key: { userId: detail.userId }, data: identity };
        title = `编辑用户: ${detail.userId}`;
        fields = [
          { name: 'displayName', label: '显示名', type: 'input', value: identity.displayName || '' },
          { name: 'username', label: 'Username', type: 'input', value: identity.username || '' },
          { name: 'aliases', label: '别名 (逗号分隔)', type: 'input', value: (identity.aliases || []).join(', ') },
        ];
      } else if (detail.type === 'profile') {
        const profiles = await api(`/memory/profiles/${detail.chatId}`);
        const p = profiles.find(x => x.userId === detail.userId) || {};
        editCtx = { type: 'profile', key: { userId: detail.userId, chatId: detail.chatId }, data: p };
        title = `编辑群内画像: ${detail.userId} @ ${shortId(detail.chatId)}`;
        fields = [
          { name: 'dunbarTier', label: '邓巴层', type: 'select', value: p.dunbarTier || 4, options: [1,2,3,4] },
          { name: 'dunbarReason', label: '分层理由', type: 'input', value: p.dunbarReason || '' },
          { name: 'traits', label: 'Traits (逗号分隔)', type: 'input', value: (p.traits || []).join(', ') },
          { name: 'interests', label: 'Interests (逗号分隔)', type: 'input', value: (p.interests || []).join(', ') },
          { name: 'communicationStyle', label: '沟通风格', type: 'input', value: p.communicationStyle || '' },
          { name: 'relationToAgent', label: '与 Agent 关系', type: 'input', value: p.relationToAgent || '' },
        ];
      } else if (detail.type === 'group') {
        const g = await api(`/memory/group/${detail.chatId}`);
        const model = g.model || g || {};
        editCtx = { type: 'group', key: { chatId: detail.chatId }, data: model };
        title = `编辑群组画像: ${model.chatTitle || shortId(detail.chatId)}`;
        fields = [
          { name: 'chatTitle', label: '群组标题', type: 'input', value: model.chatTitle || '' },
          { name: 'description', label: '群组描述', type: 'textarea', value: model.description || '' },
          { name: 'dominantLanguage', label: '主要语言', type: 'input', value: model.dominantLanguage || '' },
          { name: 'agentRole', label: 'Agent 角色', type: 'input', value: model.agentRole || '' },
          { name: 'engagementLevel', label: '参与度', type: 'select', value: model.engagementLevel || 'medium', options: ['high','medium','low'] },
          { name: 'recentFeedback', label: '近期反馈', type: 'textarea', value: model.recentFeedback || '' },
          { name: 'hotTopics', label: '热门话题 (逗号分隔)', type: 'input', value: (model.hotTopics || []).join(', ') },
          { name: 'tabooTopics', label: '禁忌话题 (逗号分隔)', type: 'input', value: (model.tabooTopics || []).join(', ') },
          { name: 'communicationNorms', label: '交流规范 (逗号分隔)', type: 'input', value: (model.communicationNorms || []).join(', ') },
        ];
      } else if (detail.type === 'fact') {
        const data = await api('/memory/facts?limit=200');
        const f = (data.items || []).find(x => x.id === detail.id);
        if (!f) { alert('未找到'); return; }
        editCtx = { type: 'fact', key: { id: detail.id }, data: f };
        title = `编辑事实: ${f.subject}`;
        fields = [
          { name: 'content', label: '内容', type: 'textarea', value: f.content || '' },
          { name: 'category', label: '分类', type: 'select', value: f.category || 'general', options: ['biographical','preference','anecdote','opinion','plan','relationship','general'] },
          { name: 'confidence', label: '置信度 (0-1)', type: 'input', value: String(f.confidence ?? 1) },
          { name: 'expiresAt', label: '过期时间 (ISO)', type: 'input', value: f.expiresAt || '' },
        ];
      } else if (detail.type === 'message') {
        editCtx = { type: 'message', key: { chatId: detail.chatId, messageId: detail.messageId }, data: detail };
        title = `编辑消息: ${detail.messageId}`;
        fields = [
          { name: 'text', label: '消息内容', type: 'textarea', value: detail.text || '' },
          { name: 'displayName', label: '显示名', type: 'input', value: detail.displayName || '' },
        ];
      }
      modal?.showModal();
    }

    window.addEventListener('memoryEdit', onEdit);
    return () => window.removeEventListener('memoryEdit', onEdit);
  });

  function getFieldValues() {
    const vals = {};
    for (const f of fields) { vals[f.name] = f.value; }
    return vals;
  }

  function splitCSV(str) {
    return str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];
  }

  async function save() {
    if (!editCtx) return;
    const v = getFieldValues();
    const { type, key } = editCtx;
    try {
      if (type === 'person') {
        await api(`/memory/person/${key.userId}`, { method: 'PUT', body: { displayName: v.displayName, username: v.username || undefined, aliases: splitCSV(v.aliases) }});
      } else if (type === 'profile') {
        await api(`/memory/profile/${key.userId}/${key.chatId}`, { method: 'PUT', body: {
          dunbarTier: parseInt(v.dunbarTier) || 4, dunbarReason: v.dunbarReason,
          traits: splitCSV(v.traits), interests: splitCSV(v.interests),
          communicationStyle: v.communicationStyle, relationToAgent: v.relationToAgent,
        }});
      } else if (type === 'group') {
        await api(`/memory/group/${key.chatId}`, { method: 'PUT', body: {
          chatTitle: v.chatTitle, description: v.description, dominantLanguage: v.dominantLanguage,
          agentRole: v.agentRole, engagementLevel: v.engagementLevel, recentFeedback: v.recentFeedback,
          hotTopics: splitCSV(v.hotTopics), tabooTopics: splitCSV(v.tabooTopics),
          communicationNorms: splitCSV(v.communicationNorms),
        }});
      } else if (type === 'fact') {
        await api(`/memory/fact/${key.id}`, { method: 'PUT', body: {
          content: v.content, category: v.category,
          confidence: parseFloat(v.confidence) || 1.0,
          expiresAt: v.expiresAt || null,
        }});
      } else if (type === 'message') {
        await api(`/memory/message/${key.chatId}/${key.messageId}`, { method: 'PUT', body: {
          text: v.text, displayName: v.displayName,
        }});
      }
    } catch (err) {
      alert('保存失败: ' + err);
      return;
    }
    modal.close();
    editCtx = null;
  }
</script>

<dialog bind:this={modal} class="modal">
  <div class="modal-box max-w-2xl">
    <h3 class="text-lg font-bold">{title}</h3>
    <div class="py-4 space-y-3">
      {#each fields as field}
        <div>
          <label class="label text-xs">{field.label}</label>
          {#if field.type === 'textarea'}
            <textarea class="textarea textarea-bordered textarea-sm w-full" rows="3"
                      bind:value={field.value}></textarea>
          {:else if field.type === 'select'}
            <select class="select select-bordered select-sm w-full" bind:value={field.value}>
              {#each field.options as opt}
                <option value={opt}>{opt}</option>
              {/each}
            </select>
          {:else}
            <input type="text" class="input input-bordered input-sm w-full" bind:value={field.value} />
          {/if}
        </div>
      {/each}
    </div>
    <div class="modal-action">
      <button class="btn btn-primary" onclick={save}>保存</button>
      <form method="dialog"><button class="btn">取消</button></form>
    </div>
  </div>
</dialog>
