// Framework-neutral reference. The parent application provides its authenticated grant proxy.
export function startEmbedding(frame, status, dshOrigin, workspaceId) {
  const origin = new URL(dshOrigin).origin;
  const channelId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const pending = new Set();
  let destroyed = false, initialized = false, initRequested = false;
  const show = text => { status.textContent = text; };
  const abort = new AbortController();
  const timeout = setTimeout(() => { abort.abort(); show('工作台加载超时，请检查服务与嵌入配置。'); }, 15000);
  let initTimeout;
  async function receive(event) {
    if (destroyed || event.origin !== origin || event.source !== frame.contentWindow) return;
    const m = event.data;
    if (!m || typeof m !== 'object' || m.protocol !== 'dsh.embed' || m.version !== '1.0' ||
        m.channel_id !== channelId || typeof m.request_id !== 'string' || !m.payload || typeof m.payload !== 'object') return;
    if (m.type === 'ready' && !initRequested) {
      initRequested = true; clearTimeout(timeout); show('正在授权并检查工作区…');
      initTimeout = setTimeout(() => { abort.abort(); show('初始化超时，请重新获取授权。'); }, 30000);
      try {
        const response = await fetch('/api/ai/embed-grant', {
          method: 'POST', credentials: 'same-origin', signal: abort.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId, request_id: requestId })
        });
        if (!response.ok) throw new Error('授权失败');
        const grant = await response.json();
        if (typeof grant.ticket !== 'string' || grant.ticket.length < 32) throw new Error('授权响应无效');
        if (destroyed) return;
        pending.add(requestId);
        frame.contentWindow.postMessage({ protocol: 'dsh.embed', version: '1.0', type: 'init',
          channel_id: channelId, request_id: requestId, payload: { ticket: grant.ticket } }, origin);
      } catch { clearTimeout(initTimeout); if (!destroyed) show('无法完成授权，请重试或联系管理员。'); }
    } else if (m.type === 'initialized' && pending.has(m.request_id) && !initialized) {
      if (m.payload.workspace_id !== workspaceId) { show('工作区不匹配，已阻止继续。'); return; }
      initialized = true; pending.delete(m.request_id); clearTimeout(initTimeout); show('工作台已就绪');
    } else if (m.type === 'error') {
      clearTimeout(timeout); clearTimeout(initTimeout);
      show(typeof m.payload.message === 'string' ? m.payload.message.slice(0,1000) : '工作台发生错误');
    } else if (m.type === 'connection.changed' && initialized) {
      show(m.payload.state === 'connected' ? '已连接' : '连接中断，正在恢复；不会重复发送任务');
    }
  }
  window.addEventListener('message', receive);
  frame.src = `${origin}/embed?channel_id=${encodeURIComponent(channelId)}`;
  show('正在加载工作台…');
  return () => { destroyed = true; abort.abort(); clearTimeout(timeout); clearTimeout(initTimeout);
    pending.clear(); window.removeEventListener('message', receive); frame.src = 'about:blank'; };
}
