// Browser authentication and the single authenticated application API.
// No provider credentials, chat history, or administrator secrets are persisted here.
export function validateSiteConfig(value) {
  if (!value || typeof value !== 'object' || !value.supabaseUrl || !value.supabaseAnonKey) return null;
  let url;
  try { url = new URL(value.supabaseUrl); } catch { throw new Error('站点登录地址配置不正确，请联系站长。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('站点登录地址配置不正确，请联系站长。');
  }
  const key = String(value.supabaseAnonKey).trim();
  if (key.startsWith('sb_secret_')) throw new Error('站点误用了服务端密钥，请立即撤销该密钥并联系站长。');
  if (key.split('.').length === 3) {
    try {
      const encoded = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      if (JSON.parse(atob(encoded)).role !== 'anon') throw new Error('private');
    } catch { throw new Error('站点只能使用公开的 Supabase publishable 或 anon 密钥。'); }
  } else if (!key.startsWith('sb_publishable_')) {
    throw new Error('站点只能使用公开的 Supabase publishable 或 anon 密钥。');
  }
  return { supabaseUrl: url.origin, supabaseAnonKey: key, inviteOnly: value.inviteOnly !== false };
}

export async function loadSiteConfig(fetchImpl = fetch, url = new URL('./site-config.json', import.meta.url)) {
  const response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('暂时无法读取站点配置，请稍后重试。');
  return validateSiteConfig(await response.json());
}

function abortError() { return new DOMException('账户已变更，请重试。', 'AbortError'); }
function safeUser(user) { return user ? { id: user.id, email: user.email || '' } : null; }
function apiError(body, status) {
  const fallbacks = { 400: '请求内容不正确，请检查后重试。', 401: '登录已过期，请重新登录。', 403: '当前账户没有此操作权限。', 404: '内容不存在或已不可用。', 429: '操作较频繁或已达到用量上限，请稍后再试。', 503: '服务尚未配置完成，请稍后再试。' };
  const message = typeof body?.error === 'string' && body.error.length <= 350 ? body.error : (fallbacks[status] || '服务暂时不可用，请稍后重试。');
  const error = new Error(message);
  error.isBackendError = true;
  error.code = typeof body?.code === 'string' ? body.code.slice(0, 60) : 'request_failed';
  error.status = status;
  return error;
}

export function createBackendClient(config, { createClient, fetchImpl = fetch, onChange = () => {}, onAuthEvent = () => {}, flowType = 'pkce' } = {}) {
  let authSession = null, session = null, epoch = 0, refreshVersion = 0, disposed = false, signedOut = false;
  const pending = new Set();
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType }
  });
  function notify() { if (!disposed) onChange(session); }
  function adopt(next) {
    if (next?.user?.id !== authSession?.user?.id || (!next && authSession)) {
      epoch++;
      refreshVersion++;
      for (const controller of pending) controller.abort();
      pending.clear();
      session = next ? { user: safeUser(next.user), profile: null, ai: null, usage: null } : null;
    }
    authSession = next;
    if (!next) session = null;
  }
  async function signOut() {
    // Clear local UI and pending responses immediately, including if the network is unavailable.
    signedOut = true;
    adopt(null);
    notify();
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw new Error('本页已退出。设备登录凭据清理未完成，请重试退出。');
  }
  async function api(action, payload = {}, { signal } = {}) {
    if (disposed) throw abortError();
    if (signedOut) throw apiError(null, 401);
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/.test(action)) throw new Error('请求操作不正确。');
    const currentEpoch = epoch;
    const { data, error } = await client.auth.getSession();
    if (currentEpoch !== epoch || signedOut) throw abortError();
    if (error || !data?.session?.access_token) throw apiError(null, 401);
    const tokenSession = data.session;
    // getSession may complete before an auth event has been delivered.
    if (!authSession) adopt(tokenSession);
    if (authSession.user.id !== tokenSession.user.id) throw abortError();
    const requestEpoch = epoch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(onAbort, 100000);
    pending.add(controller);
    try {
      const response = await fetchImpl(`${config.supabaseUrl}/functions/v1/api`, {
        method: 'POST', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${tokenSession.access_token}` },
        body: JSON.stringify({ ...payload, action })
      });
      if (requestEpoch !== epoch || disposed) throw abortError();
      const text = await response.text();
      if (requestEpoch !== epoch || disposed) throw abortError();
      if (text.length > 1500000) throw new Error('返回内容过大，请缩小查询范围。');
      let body;
      try { body = JSON.parse(text); } catch { throw new Error('服务未能返回有效结果，请稍后重试。'); }
      if (!response.ok || body?.error) {
        const problem = apiError(body, response.status);
        if (response.status === 401) { await signOut().catch(() => {}); }
        if (problem.code === 'mfa_required') {
          // Password sign-in can yield an AAL1 session for an enrolled account.
          // Retain only the identity needed to complete MFA; discard prior app data.
          epoch++;
          refreshVersion++;
          for (const active of pending) if (active !== controller) active.abort();
          session = { user: safeUser(tokenSession.user), profile: null, ai: null, usage: null, mfaRequired: true, error: problem.message };
          notify();
          onAuthEvent('MFA_REQUIRED');
        }
        throw problem;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('服务返回格式不正确。');
      return body;
    } finally {
      clearTimeout(timeout);
      pending.delete(controller);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async function refresh() {
    if (signedOut) return null;
    const revision = ++refreshVersion;
    const currentEpoch = epoch;
    const { data, error } = await client.auth.getSession();
    if (disposed || revision !== refreshVersion || currentEpoch !== epoch) return session;
    if (error || !data?.session) { adopt(null); notify(); return null; }
    adopt(data.session);
    const requestEpoch = epoch;
    const requestRevision = refreshVersion;
    const user = safeUser(data.session.user);
    try {
      const details = await api('me');
      if (disposed || requestEpoch !== epoch || requestRevision !== refreshVersion) return session;
      session = { user, profile: details.profile || null, ai: details.ai || null, usage: details.usage || null, application: details.application || null };
    } catch (error) {
      if (disposed || requestEpoch !== epoch || requestRevision !== refreshVersion || error.name === 'AbortError') return session;
      session = { user, profile: null, ai: null, usage: null, error: error.message, ...(error.code === 'mfa_required' ? { mfaRequired: true } : {}) };
    }
    notify();
    return session;
  }
  const { data: listener } = client.auth.onAuthStateChange((event, next) => {
    if (disposed) return;
    if (event === 'SIGNED_OUT') signedOut = true;
    if (event === 'SIGNED_IN') signedOut = false;
    if (signedOut && next) return;
    adopt(next);
    if (event === 'SIGNED_OUT') notify();
    // Supabase auth listeners must stay synchronous; wait until its lock is released.
    setTimeout(() => {
      if (disposed) return;
      onAuthEvent(event);
      if (event !== 'SIGNED_OUT') void refresh();
    }, 0);
  });
  return {
    client, api, refresh, signOut, getSession: () => session,
    dispose() { disposed = true; epoch++; for (const controller of pending) controller.abort(); pending.clear(); listener?.subscription?.unsubscribe(); }
  };
}
