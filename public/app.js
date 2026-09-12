import { quickRoute, demoReply, CRISIS_TEXT } from './safety.js';
import { runHarness, validateMessages, verifyKey } from './harness.js';
import {encryptKey,decryptKey,readSaved,writeSaved,forgetSaved} from './vault.js';
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
function welcome() { addMessage('assistant', '今天想聊点什么？不想从头解释也没关系，从你想说的地方开始。', '留岸 · 欢迎语'); }
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
    const data = await runHarness(validateMessages(history), { AI_API_KEY: connection.key }, {signal:controller.signal, reportErrors:true});
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
let settingsGeneration=0;
let verification=null;
let vaultGeneration=0;
function clearPasswords(){ $('vault-password').value=''; $('vault-confirm').value=''; }
function vaultStatus(){try{$('vault-status').textContent=readSaved()?'此设备已有加密密钥，输入解锁密码即可恢复。':'此设备尚未保存密钥。';}catch{$('vault-status').textContent='无法读取本地存储；仍可使用临时连接。';}}
vaultStatus();
$('remember-key').onchange=()=>{$('vault-fields').hidden=!$('remember-key').checked;clearPasswords();};
$('save-key').onclick=async()=>{
  const id=++vaultGeneration,button=$('save-key');
  try{
    const key=$('api-key').value.trim() || connection?.key;
    const password=$('vault-password').value;
    if(password!==$('vault-confirm').value)throw new Error('两次密码不一致。');
    button.disabled=true;
    const record=await encryptKey(key,password);
    if(id!==vaultGeneration)return;
    try{writeSaved(record);}catch{throw new Error('浏览器不允许保存，密钥未写入。你仍可临时连接。');}
    clearPasswords();vaultStatus();$('vault-status').textContent='已用 AES-256-GCM 加密保存。可继续验证连接；下次输入密码解锁。忘记密码只能重新输入 API Key。';
  }catch(error){if(id===vaultGeneration)$('vault-status').textContent=error.message;}
  finally{button.disabled=false;}
};
$('unlock-key').onclick=async()=>{
  const id=++vaultGeneration,button=$('unlock-key');
  try{
    const record=readSaved();if(!record)throw new Error('还没有保存过密钥。');
    button.disabled=true;const key=await decryptKey(record,$('vault-password').value);
    if(id!==vaultGeneration)return;
    $('api-key').value=key;clearPasswords();$('vault-status').textContent='已解锁到当前页面。勾选发送同意后，点击“验证并连接”。';
  }catch(error){if(id===vaultGeneration){clearPasswords();$('vault-status').textContent=error.message;}}
  finally{button.disabled=false;}
};
$('forget-key').onclick=()=>{
  vaultGeneration++;settingsGeneration++;verification?.abort();
  try{forgetSaved();connection=null;cancel();$('api-key').value='';clearPasswords();$('mode-badge').textContent='本地体验';$('status').textContent='已断开连接并清除已保存的密钥。';vaultStatus();}catch{$('vault-status').textContent='无法删除本地存储，请在浏览器设置中清除此网站数据。';}
};
$('settings-form').onsubmit = async e => {
  e.preventDefault(); const id=++settingsGeneration; const button = e.submitter;
  try {
    if (!$('consent').checked) throw new Error('连接前，请确认你同意发送对话。');
    const key=$('api-key').value.trim(); if (!key || /\s/.test(key)) throw new Error('请输入有效的 DeepSeek API Key，不要包含空格。');
    button.disabled=true; $('settings-status').textContent='正在连接 DeepSeek 官方 API……';
    verification?.abort(); verification=new AbortController();
    await verifyKey(key,{signal:verification.signal});
    if (id!==settingsGeneration) return;
    connection={key}; resetChat(); $('mode-badge').textContent='DeepSeek 已连接'; $('status').textContent='已直连 DeepSeek。密钥只在当前页面保留，刷新即清除。'; $('settings-status').textContent='连接成功。'; $('api-key').value=''; $('settings-dialog').close();
  } catch(error) {if(id===settingsGeneration) $('settings-status').textContent=error.name==='TimeoutError' ? '连接超时，请稍后再试。' : error.message;}
  finally {button.disabled=false;}
};
$('disconnect').onclick = () => {settingsGeneration++;verification?.abort();connection=null;resetChat();$('api-key').value='';$('consent').checked=false;$('mode-badge').textContent='本地体验';$('status').textContent='本地体验使用预设回复，不会把文字发送到网络。';$('settings-dialog').close();};
$('settings-dialog').addEventListener('close',()=>{vaultGeneration++;clearPasswords();settingsGeneration++;verification?.abort();$('api-key').value='';});
window.addEventListener('pagehide',()=>{vaultGeneration++;clearPasswords();});
window.addEventListener('pagehide',()=>{connection=null;cancel();verification?.abort();$('api-key').value='';});
window.addEventListener('pageshow',e=>{if(e.persisted){connection=null;resetChat();$('mode-badge').textContent='本地体验';$('consent').checked=false;$('status').textContent='返回页面后已断开连接，请重新输入 API Key。';}});
// No chat-reading or chat-sending agent tool is exposed; only the visible grounding flow.
if (document.modelContext?.registerTool) {
  const lifecycle=new AbortController();
  try {Promise.resolve(document.modelContext.registerTool({name:'start_grounding',title:'打开回到当下',description:'打开可随时退出的感官提示，不读取或发送聊天记录。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected empty object'); startGrounding(); return {opened:true,step:1};}},{signal:lifecycle.signal})).catch(()=>{});} catch {}
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
welcome();
