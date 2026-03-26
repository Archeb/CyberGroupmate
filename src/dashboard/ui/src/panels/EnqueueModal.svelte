<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api.js';

  let modal;
  let chatId = '';
  let priority = 80;

  onMount(() => {
    function onShow(e) {
      if (e.detail?.chatId) chatId = e.detail.chatId;
      modal?.showModal();
    }
    window.addEventListener('showEnqueueModal', onShow);
    return () => window.removeEventListener('showEnqueueModal', onShow);
  });

  async function doEnqueue() {
    if (!chatId) return;
    await api('/queue/enqueue', { method: 'POST', body: { chatId, priority } });
    modal.close();
  }
</script>

<dialog bind:this={modal} class="modal">
  <div class="modal-box">
    <h3 class="text-lg font-bold">手动入队 Q3</h3>
    <div class="py-4 space-y-3">
      <input type="text" placeholder="ChatId" class="input input-bordered w-full" bind:value={chatId} />
      <input type="number" placeholder="优先级 (0-100)" class="input input-bordered w-full" bind:value={priority} />
    </div>
    <div class="modal-action">
      <button class="btn btn-primary" onclick={doEnqueue}>入队</button>
      <form method="dialog"><button class="btn">取消</button></form>
    </div>
  </div>
</dialog>
