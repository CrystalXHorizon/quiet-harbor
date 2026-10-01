import { createClient } from '@supabase/supabase-js';
import { createBackendClient, loadSiteConfig } from './backend-client.js';

const roleNames = { member: '普通成员', moderator: '社区管理员', owner: '站长' };
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, handler, className = 'secondary') {
  const node = element('button', text, className); node.type = 'button'; node.onclick = handler; return node;
}
function input(form, labelText, name, { type = 'text', autocomplete = 'off', value = '', minLength, maxLength, required = true } = {}) {
  const label = element('label', labelText), node = element('input');
  node.type = type; node.name = name; node.autocomplete = autocomplete; node.value = value; node.required = required;
  node.id = `auth-${name}`; label.htmlFor = node.id;
  if (minLength) node.minLength = minLength;
  if (maxLength) node.maxLength = maxLength;
  form.append(label, node); return node;
}
function landingUrl() { const url = new URL('./', location.href); url.search = ''; url.hash = ''; return url.href; }
function authError(error) {
  if (error?.isBackendError) return error.message;
  const messages = {
    invalid_credentials: '邮箱或密码不正确。', email_not_confirmed: '请先打开验证邮件确认邮箱，再回来登录。',
    user_already_exists: '这个邮箱已经注册，可以直接登录或找回密码。', signup_disabled: '目前仅向受邀用户开放，请联系站长。',
    over_email_send_rate_limit: '邮件发送较频繁，请稍后再试。', over_request_rate_limit: '操作较频繁，请稍后再试。',
    weak_password: '密码强度不足，请使用至少 12 位、且不常见的密码。', same_password: '新密码不能与原密码相同。',
    mfa_verification_failed: '验证码不正确或已过期，请使用验证器里的新验证码。',
    mfa_factor_name_conflict: '已有待验证的验证器，请先完成或重新开始设置。',
    bad_jwt: '登录已过期，请重新登录。', session_not_found: '登录已过期，请重新登录。'
  };
  return messages[error?.code] || (error?.status === 429 ? '操作较频繁，请稍后再试。' : '暂时没能完成操作，请检查网络或稍后重试。');
}

export async function initAuth({ onChange = () => {} } = {}) {
  const dialog = document.getElementById('auth-dialog');
  if (!dialog) throw new Error('缺少账户对话框。');
  let config = null, backend = null, mode = 'login', pending = false, viewId = 0, enrolled = null;
  let startupError = '', recovery = false, factorId = null;
  const callback = new URLSearchParams(location.hash.slice(1));
  let invitation = callback.get('type') === 'invite';
  const implicitCallback = callback.has('access_token') && ['invite', 'recovery', 'signup', 'magiclink'].includes(callback.get('type'));
  let content, status;
  function open() { render(); if (!dialog.open) dialog.showModal(); }
  function message(text) { status.textContent = text; }
  function clearSensitive() { dialog.querySelectorAll('input[type="password"], input[name="totp"]').forEach(node => { node.value = ''; }); }
  function abandonEnrollment() {
    const unused = enrolled?.id; enrolled = null; factorId = null;
    if (unused && backend) void backend.client.auth.mfa.unenroll({ factorId: unused }).catch(() => {});
  }
  dialog.addEventListener('close', () => { clearSensitive(); abandonEnrollment(); viewId++; });
  async function run(task, success) {
    if (pending) return;
    pending = true;
    const revision = viewId;
    const activeStatus = status;
    activeStatus.textContent = '正在处理……';
    const controls = [...content.querySelectorAll('button, input')];
    controls.forEach(node => { node.disabled = true; });
    try {
      const result = await task();
      if (result?.error) throw result.error;
      if (revision === viewId) await success?.(result);
    } catch (error) {
      if (revision === viewId) activeStatus.textContent = error?.code || error?.status ? authError(error) : (error.message || '暂时无法完成操作。');
    } finally {
      pending = false;
      controls.forEach(node => { node.disabled = false; });
      clearSensitive();
    }
  }
  function submit(form, title, handler) {
    const row = element('div', undefined, 'dialog-actions');
    const action = element('button', title, 'primary'); action.type = 'submit'; row.append(action); form.append(row);
    form.onsubmit = event => { event.preventDefault(); void handler(); };
  }
  function switchMode(value) { if (pending) return; clearSensitive(); mode = value; render(); }
  function render() {
    viewId++;
    const close = button('×', () => dialog.close(), 'close'); close.setAttribute('aria-label', '关闭账户设置');
    const title = element('h2', '我的账户'); title.id = 'auth-title'; dialog.setAttribute('aria-labelledby', title.id);
    content = element('div', undefined, 'auth-content');
    status = element('p', '', 'auth-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    dialog.replaceChildren(close, element('span', '留岸 · 账户', 'overline'), title, content, status);
    if (!config || !backend) {
      content.append(element('p', startupError || '登录和社区尚未上线。站长配置后端后，你就可以在这里登录。'), element('p', '目前可以继续使用本地陪伴体验与小练习；这里不会创建演示账户。'));
      return;
    }
    const session = backend.getSession();
    if (session?.mfaRequired) { title.textContent = '完成二次验证'; renderAccount(session); return; }
    if (recovery && session?.user) { title.textContent = '设置新密码'; renderPassword(); return; }
    if (session?.user) { renderAccount(session); return; }
    const tabs = element('div', undefined, 'auth-tabs support-actions');
    tabs.append(button('登录', () => switchMode('login'), mode === 'login' ? 'primary' : 'secondary'));
    if (!config.inviteOnly) tabs.append(button('注册', () => switchMode('signup'), mode === 'signup' ? 'primary' : 'secondary'));
    content.append(tabs);
    if (config.inviteOnly) content.append(element('p', '目前仅向受邀用户开放。已有邀请的话，请先打开邀请邮件，再设置密码。'));
    const form = element('form', undefined, 'auth-form');
    const email = input(form, '邮箱', 'email', { type: 'email', autocomplete: 'email', maxLength: 254 });
    let password, nickname;
    if (mode !== 'reset') password = input(form, '密码', 'password', { type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', minLength: mode === 'signup' ? 12 : 1, maxLength: 128 });
    if (mode === 'signup') {
      nickname = input(form, '社区昵称', 'nickname', { autocomplete: 'nickname', minLength: 2, maxLength: 30 });
      form.append(element('small', '昵称会展示在社区，邮箱不会公开。聊天仍只保留在当前页面；账户登录状态保存在这台设备上。'));
    }
    submit(form, mode === 'reset' ? '发送找回密码邮件' : mode === 'signup' ? '注册并验证邮箱' : '登录', () => {
      const address = email.value.trim(), pass = password?.value || '', name = nickname?.value.trim();
      if (password) password.value = '';
      return run(async () => {
        if (mode === 'reset') return backend.client.auth.resetPasswordForEmail(address, { redirectTo: landingUrl() });
        if (mode === 'signup') return backend.client.auth.signUp({ email: address, password: pass, options: { emailRedirectTo: landingUrl(), data: { nickname: name } } });
        return backend.client.auth.signInWithPassword({ email: address, password: pass });
      }, async result => {
        if (mode === 'reset') { message('如果这个邮箱可以找回密码，你会收到邮件。请在这个浏览器中打开邮件链接。'); return; }
        if (mode === 'signup' && !result.data?.session) { message('请查看邮箱中的验证邮件，完成后再来登录。若没有收到，请检查垃圾邮件。'); return; }
        await backend.refresh(); render(); message(backend.getSession()?.mfaRequired ? '密码已确认，还需要完成二次验证。' : '已登录。');
      });
    });
    content.append(form, button(mode === 'reset' ? '返回登录' : '忘记密码', () => switchMode(mode === 'reset' ? 'login' : 'reset'), 'plain'));
  }
  function renderPassword() {
    content.append(element('p', '请为账户设置至少 12 位的新密码。'));
    const form = element('form', undefined, 'auth-form');
    const password = input(form, '新密码', 'new-password', { type: 'password', autocomplete: 'new-password', minLength: 12, maxLength: 128 });
    const confirm = input(form, '确认新密码', 'password-confirm', { type: 'password', autocomplete: 'new-password', minLength: 12, maxLength: 128 });
    submit(form, '保存密码', () => {
      if (password.value !== confirm.value) { message('两次密码不一致，请重新输入。'); return; }
      const pass = password.value; password.value = ''; confirm.value = '';
      return run(() => backend.client.auth.updateUser({ password: pass }), async () => { recovery = false; invitation = false; await backend.refresh(); render(); message('密码已更新。'); });
    });
    content.append(form);
  }
  function renderAccount(session) {
    const profile = session.profile;
    content.append(element('p', session.user.email), element('p', session.mfaRequired ? '完成验证后才能读取账户资料、社区内容或使用 AI。' : profile ? `${profile.nickname || '成员'} · ${roleNames[profile.role] || '成员'}` : '账户已登录，正在等待后端资料。'));
    if (session.error) content.append(element('p', session.error));
    if (profile?.status === 'banned') content.append(element('p', '账户已被停用。如有疑问，请联系站长。'));
    if (profile?.status === 'muted') content.append(element('p', '账户当前处于禁言状态，暂时不能发布或回复。'));
    if (session.usage) content.append(element('small', `今日 AI 用量：${Number(session.usage.used) || 0} / ${Number(session.usage.limit) || 0} 次。`));
    if (profile) {
      const form = element('form', undefined, 'auth-form');
      const nickname = input(form, '社区昵称', 'nickname', { autocomplete: 'nickname', value: profile.nickname || '', minLength: 2, maxLength: 30 });
      submit(form, '保存昵称', () => run(() => backend.api('profile.update', { nickname: nickname.value.trim() }), async () => { await backend.refresh(); render(); message('昵称已保存。'); }));
      content.append(form);
    }
    const security = element('section', undefined, 'auth-mfa');
    security.append(element('h3', '账户安全'), element('p', '已设置验证器的账户，每次登录后都需要完成第二步验证。站长和管理员修改设置或处理社区内容前，也需要完成验证。'));
    security.append(button(session.mfaRequired ? '继续二次验证' : '设置或验证二次验证', () => { void showMfa(security); }));
    content.append(security);
    const actions = element('div', undefined, 'dialog-actions');
    if (!session.mfaRequired) actions.append(button('修改密码', () => { recovery = true; render(); }));
    actions.append(button('刷新账户状态', () => run(async () => { await backend.refresh(); }, () => render())), button('退出登录', () => run(() => backend.signOut(), () => { recovery = false; mode = 'login'; render(); message('已退出登录。'); })));
    content.append(element('small', '聊天正文不会随账户同步。请在共享设备上使用后退出登录。'), actions);
  }
  async function showMfa(container) {
    await run(async () => {
      const factors = await backend.client.auth.mfa.listFactors();
      if (factors.error) throw factors.error;
      const verified = factors.data.totp?.filter(item => item.status === 'verified') || [];
      const assurance = await backend.client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance.error) throw assurance.error;
      return { verified, assurance: assurance.data };
    }, result => {
      container.replaceChildren(element('h3', '二次验证'));
      if (result.assurance.currentLevel === 'aal2') { container.append(element('p', '本次登录已完成二次验证。')); message(''); return; }
      if (result.verified.length) {
        factorId = result.verified[0].id;
        container.append(element('p', '输入验证器中的 6 位验证码。'));
        renderMfaCode(container);
      } else {
        container.append(element('p', '使用验证器应用添加账户。完成首次验证后，其他设备上的旧登录会失效。'));
        container.append(button('开始设置验证器', () => {
          const enrollmentView = viewId;
          void run(async () => {
            if (!enrolled) {
              const result = await backend.client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `留岸 ${new Date().toISOString().slice(0, 19)}` });
              if (result.error) throw result.error;
              if (viewId !== enrollmentView || !dialog.open) {
                await backend.client.auth.mfa.unenroll({ factorId: result.data.id });
                throw new Error('已取消验证器设置。');
              }
              enrolled = result.data;
            }
            return enrolled;
          }, data => {
            factorId = data.id;
            container.replaceChildren(element('h3', '添加到验证器'));
            if (typeof data.totp?.qr_code === 'string') {
              const image = document.createElement('img'); image.alt = '使用验证器扫描此二维码'; image.width = 200; image.height = 200;
              // Treat SDK SVG as an image, never as executable page markup.
              const raw = data.totp.qr_code.replace(/^data:image\/svg\+xml;utf-8,/, '');
              image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
              container.append(image);
            }
            container.append(element('p', '也可以在验证器里手动输入此密钥：'), element('code', data.totp?.secret || ''), element('small', '此密钥只用于你的验证器，不要发送给别人。'));
            renderMfaCode(container);
            message('扫描或填写后，输入验证器生成的验证码以完成设置。');
          });
        }));
      }
    });
  }
  function renderMfaCode(container) {
    const form = element('form', undefined, 'auth-form');
    const code = input(form, '6 位验证码', 'totp', { autocomplete: 'one-time-code', minLength: 6, maxLength: 6 }); code.inputMode = 'numeric'; code.pattern = '[0-9]{6}';
    submit(form, '验证', () => {
      const value = code.value.trim(); code.value = '';
      return run(() => backend.client.auth.mfa.challengeAndVerify({ factorId, code: value }), async () => { enrolled = null; factorId = null; await backend.refresh(); render(); message(backend.getSession()?.mfaRequired ? '验证状态还未更新，请刷新账户状态后再试。' : '二次验证已完成。'); });
    });
    container.append(form);
  }
  try { config = await loadSiteConfig(); } catch (error) { startupError = error.message; }
  const controller = {
    configured: Boolean(config), open,
    getSession: () => backend?.getSession() || null,
    async api(action, payload, options) { if (!backend) throw new Error('登录与社区尚未配置，请先使用本地体验。'); return backend.api(action, payload, options); },
    async signOut() { if (backend) await backend.signOut(); },
    async refresh() { return backend ? backend.refresh() : null; }
  };
  if (config) {
    backend = createBackendClient(config, {
      createClient, flowType: implicitCallback ? 'implicit' : 'pkce',
      onChange: session => {
        onChange(session);
        // Do not replace a form while the user is typing or completing a request.
        if (dialog.open && !pending && mode !== 'reset' && !recovery && !enrolled && !factorId && document.activeElement?.tagName !== 'INPUT') render();
      },
      onAuthEvent: event => {
        if (event === 'PASSWORD_RECOVERY') { recovery = true; open(); }
        if (event === 'SIGNED_IN' && invitation) { recovery = true; open(); }
        if (event === 'MFA_REQUIRED') {
          // Repeated me requests or token refreshes must not erase a TOTP form.
          // The challenge uses Auth directly, so it works before profile access.
          if (!dialog.open) open();
          else if (!pending && !factorId && !enrolled) render();
          message('请在账户安全里完成二次验证后继续。');
        }
        if (event === 'SIGNED_OUT') { recovery = false; enrolled = null; factorId = null; mode = 'login'; if (dialog.open) render(); }
      }
    });
    const initialized = await backend.client.auth.initialize();
    if (initialized.error) startupError = '邮箱链接可能已过期、已使用，或需要在发送邮件的浏览器中打开。请重新获取邮件后再试。';
    await backend.refresh();
  } else { onChange(null); }
  render();
  if (startupError && config) { if (implicitCallback || new URLSearchParams(location.search).has('code')) open(); message(startupError); }
  return controller;
}
