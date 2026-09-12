import { quickRoute, demoReply, CRISIS_TEXT } from './safety.js';
const $ = id => document.getElementById(id);
let history = [], connection = null, pending = null, generation = 0, step = 0, started = Date.now();
const steps = [
  ['看见身边的一件东西', '如果愿意，睁着眼睛看一看周围。找到一件物品，留意它的颜色和形状，不用给体验做解释。'],
  ['留意一个接触点', '你可以感受脚与地面，或手与桌面的接触。如果这样不舒服，跳过这一步。保持自然呼吸就好。'],
  ['给自己一个小选择', '看看你现在在哪里。接下来，你更想喝一点水、换个舒服的位置，还是联系一个信任的人？你也可以什么都不做。']
];
function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); }
function addMessage(role, text, label) {
  const row = document.createElement('article'); row.className = `message ${role}`;
  if (role !== 'user') { const img = document.createElement('img'); img.src = './favicon.svg'; img.alt = ''; img.className = 'avatar'; row.append(img); }
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  const speaker = document.createElement('span'); speaker.className = 'speaker'; speaker.textContent = label || (role === 'user' ? '你' : '留岸');
  const p = document.createElement('p'); p.textContent = text; bubble.append(speaker, p); row.append(bubble); $('conversation').append(row);
  while ($('conversation').children.length > 60) $('conversation').firstElementChild.remove();
  row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function welcome() { addMessage('assistant', '欢迎来到留岸。\n\n这里不用表现得很好，也不必急着找到答案。你可以说说今天发生的事，或者只告诉我，现在是什么感觉。', '留岸 · 欢迎语'); }
function setBusy(value) { $('send').hidden = value; $('stop').hidden = !value; $('message').readOnly = value; $('conversation').setAttribute('aria-busy', String(value)); }
function cancel() { generation++; pending?.abort(); pending = null; setBusy(false); }
function trimHistory() { history = history.slice(-12); while (history.reduce((n,m) => n+m.content.length,0) > 16000) history.shift(); }
function resetChat() { cancel(); history = []; $('conversation').replaceChildren(); $('message').value = ''; started = Date.now(); welcome(); }
async function sendMessage() {
  const text = $('message').value.trim(); if (!text || pending) return;
  $('message').value = ''; addMessage('user', text); history.push({ role:'user', content:text }); trimHistory();
  if (quickRoute(text) === 'crisis') { addMessage('notice', CRISIS_TEXT, '留岸 · 现实支持提示'); history.push({role:'assistant',content:CRISIS_TEXT}); trimHistory(); openDialog('help-dialog'); return; }
  if (!connection) { const reply = demoReply(text, history.filter(m => m.role === 'user').length - 1); addMessage('assistant', reply.text, '留岸 · 本地预设回复'); history.push({ role:'assistant', content:reply.text }); trimHistory(); $('status').textContent = '这是本地预设回复。要与 DeepSeek 对话，请打开「连接与隐私」。'; return; }
  const requestId = ++generation; const controller = new AbortController(); pending = controller; setBusy(true);
  $('status').textContent = '正在倾听，并检查回答是否合适……';
  const timeout = setTimeout(() => controller.abort(), 95000);
  try {
    const res = await fetch(`${connection.url}/api/chat`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`}, body:JSON.stringify({messages:history}), signal:controller.signal, credentials:'omit', redirect:'error' });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || '暂时无法连接，请稍后再试。');
    if (typeof data.text !== 'string' || data.text.length > 8000) throw new Error('收到了无法显示的回答，请重试。');
    if (generation !== requestId) return;
    addMessage(data.route === 'crisis' ? 'notice' : 'assistant', data.text, data.mode === 'ai' ? '留岸 · DeepSeek' : '留岸 · 保护提示');
    history.push({role:'assistant',content:data.text}); trimHistory();
    $('status').textContent = data.mode === 'ai' ? '回复已完成检查。检查仍可能遗漏问题，请以专业支持为准。' : '已切换为预设支持提示。';
    if (data.route === 'crisis') openDialog('help-dialog');
    if (Date.now() - started > 20*60*1000) { $('status').textContent += ' 已聊了一会儿，你可以休息一下。'; started = Date.now(); }
  } catch (error) { if (generation === requestId) { $('status').textContent = controller.signal.aborted ? '请求已停止或超时。你可以稍后重试。' : error.message; addMessage('notice', '这次没能完成回复。你刚才的话仍在页面里；可以稍后再试，或先停一会儿。', '连接提示'); } }
  finally { clearTimeout(timeout); if (generation === requestId) { pending = null; setBusy(false); $('message').focus(); } }
}
$('chat-form').addEventListener('submit', e => {e.preventDefault(); void sendMessage();});
$('message').addEventListener('keydown', e => {if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {e.preventDefault(); void sendMessage();}});
$('stop').onclick = () => {cancel(); $('status').textContent = '已停止等待回复。服务商可能已经接收了请求。';};
$('clear').onclick = () => { resetChat(); $('status').textContent = '当前页面的对话已清空；不会删除服务商按其政策保留的请求。'; };
$('chat-nav').onclick = () => $('message').focus();
document.querySelectorAll('[data-prompt]').forEach(b => b.onclick = () => {if (!pending) {$('message').value = b.dataset.prompt; $('message').focus();}});
document.querySelectorAll('[data-mood]').forEach(b => b.onclick = () => {document.querySelectorAll('[data-mood]').forEach(x => x.setAttribute('aria-pressed',String(x === b))); $('mood-note').textContent = `此刻：${b.dataset.mood}。这不是测评，只是一次自我留意。`;});
function paintStep() { $('step-number').textContent = `0${step+1} / 03`; $('step-title').textContent=steps[step][0]; $('step-text').textContent=steps[step][1]; $('next-step').textContent=step === 2 ? '结束，回到聊天' : '下一步'; }
function startGrounding() {step=0; paintStep(); openDialog('ground-dialog');}
document.querySelectorAll('[data-ground]').forEach(b => b.onclick=startGrounding);
$('next-step').onclick = () => {if (step===2) $('ground-dialog').close(); else {step++;paintStep();}};
document.querySelectorAll('[data-help]').forEach(b => b.onclick=() => openDialog('help-dialog'));
document.querySelectorAll('[data-close]').forEach(b => b.onclick=() => b.closest('dialog').close());
for (const id of ['about-open','harness-open']) $(id).onclick = () => openDialog('about-dialog');
$('settings-open').onclick = () => openDialog('settings-dialog');
// Also accessible on narrow screens where the sidebar's secondary links are hidden.
$('mode-badge').outerHTML = '<button class="mode-badge" id="mode-badge" aria-label="连接与隐私">本地体验</button>';
$('mode-badge').onclick = () => openDialog('settings-dialog');
$('backend').value = location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? location.origin : '';
let settingsGeneration=0;
$('settings-form').onsubmit = async e => {
  e.preventDefault(); const id=++settingsGeneration; const button = e.submitter;
  try {
    if (!$('consent').checked) throw new Error('连接前，请确认你同意发送对话。');
    const url=new URL($('backend').value.trim());
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写 HTTPS 服务端根地址，本地测试可用 localhost。');
    const token=$('access-token').value.trim(); if (token.length<32) throw new Error('个人访问口令至少需要 32 个字符。');
    button.disabled=true; $('settings-status').textContent='正在检查服务端……';
    const res=await fetch(`${url.origin}/api/health`, {headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(10000), credentials:'omit', redirect:'error'});
    if (!res.ok) throw new Error('验证未通过，请检查地址、口令与允许访问的网页来源。');
    const data=await res.json(); if (!data.ready || data.service !== 'quiet-harbor') throw new Error('服务端尚未配置 DeepSeek 密钥或模型。');
    if (id!==settingsGeneration) return;
    connection={url:url.origin,token}; resetChat(); $('mode-badge').textContent='DeepSeek 已连接'; $('status').textContent='后续对话将发送给你连接的服务端及 DeepSeek。'; $('settings-status').textContent='连接成功。'; $('access-token').value=''; $('settings-dialog').close();
  } catch(error) {if(id===settingsGeneration) $('settings-status').textContent=error.name==='TimeoutError' ? '连接超时，请稍后再试。' : error.message;}
  finally {button.disabled=false;}
};
$('disconnect').onclick = () => {settingsGeneration++;connection=null;resetChat();$('access-token').value='';$('consent').checked=false;$('mode-badge').textContent='本地体验';$('status').textContent='本地体验使用预设回复，不会把文字发送到网络。';$('settings-dialog').close();};
// No chat-reading or chat-sending agent tool is exposed; only the visible grounding flow.
if (document.modelContext?.registerTool) {
  const lifecycle=new AbortController();
  try {Promise.resolve(document.modelContext.registerTool({name:'start_grounding',title:'打开回到当下',description:'打开可随时退出的感官提示，不读取或发送聊天记录。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected empty object'); startGrounding(); return {opened:true,step:1};}},{signal:lifecycle.signal})).catch(()=>{});} catch {}
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
welcome();
