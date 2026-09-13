import {PROVIDERS,normalizeConfig,providerEnv,packConnection,unpackConnection} from './providers.js';
import { quickRoute, demoReply, CRISIS_TEXT } from './safety.js';
import { runHarness, validateMessages, verifyKey, listModels } from './harness.js';
import {encryptKey,decryptKey,readSaved,writeSaved,forgetSaved} from './vault.js';
import {strategies,strategyMessages} from './strategies.js';
const $ = id => document.getElementById(id);
let history = [], connection = null, pending = null, generation = 0, step = 0, started = Date.now();
let strategyPending=null;
function cancelStrategy(){strategyPending?.abort();strategyPending=null;$('strategy-generate').disabled=false;$('strategy-stop').hidden=true;}
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
function cancel() { generation++; pending?.abort(); pending = null; cancelStrategy();$('strategy-result').textContent=''; setBusy(false); }
function trimHistory() { history = history.slice(-12); while (history.reduce((n,m) => n+m.content.length,0) > 16000) history.shift(); }
function resetChat() { cancel(); history = []; resetMood(); $('conversation').replaceChildren(); $('message').value = ''; started = Date.now(); welcome(); }
async function sendMessage() {
  const text = $('message').value.trim(); if (!text || pending) return;
  $('message').value = ''; addMessage('user', text); history.push({ role:'user', content:text }); trimHistory();
  if (quickRoute(text) === 'crisis') { addMessage('notice', CRISIS_TEXT, '留岸 · 现实支持提示'); history.push({role:'assistant',content:CRISIS_TEXT}); trimHistory(); openDialog('help-dialog'); return; }
  if (!connection) { const reply = demoReply(text, history.filter(m => m.role === 'user').length - 1); addMessage('assistant', reply.text, '留岸 · 本地预设回复'); history.push({ role:'assistant', content:reply.text }); trimHistory(); $('status').textContent = '这是本地预设回复。要与 AI 对话，请打开「连接与隐私」。'; return; }
  const requestId = ++generation; const controller = new AbortController(); pending = controller; setBusy(true);
  $('status').textContent = '正在倾听，并检查回答是否合适……';
  const timeout = setTimeout(() => controller.abort(), 95000);
  try {
    const data = await runHarness(validateMessages(history), providerEnv(connection.config,connection.key), {signal:controller.signal, reportErrors:true});
    if (typeof data.text !== 'string' || data.text.length > 8000) throw new Error('收到了无法显示的回答，请重试。');
    if (generation !== requestId) return;
    addMessage(data.route === 'crisis' ? 'notice' : 'assistant', data.text, data.mode === 'ai' ? '留岸 · '+connection.config.model : '留岸 · 保护提示');
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
$('choose-mood').onclick=()=>{$('checkin').scrollIntoView({block:'center'});$('checkin').focus({preventScroll:true});};
document.querySelectorAll('[data-prompt]').forEach(b => b.onclick = () => {if (!pending) {$('message').value = b.dataset.prompt; $('message').focus();}});
const moodSupport={
 '平稳':{comfort:'现在稍微平稳一些的话，可以在这里歇一歇，不用马上安排下一件事。',tip:'留意一件今天让你舒服些的小事，愿意的话，用一句话记下来。',strategy:7},
 '低落':{comfort:'今天提不起劲，也不用急着把自己劝好。你可以只说最难熬的那一点。',tip:'先放下一件不着急的事，给自己留几分钟休息；不用把休息也做成任务。',strategy:4},
 '紧绷':{comfort:'如果一直绷着，先不用逼自己把所有问题都想明白。我们可以只看眼前这一件。',tip:'选一件眼前的物品，看看它的颜色和轮廓。不需要闭眼，也不用改变呼吸。',strategy:0},
 '有些游离':{comfort:'这种不太在场的感觉可能不好形容。说不清也可以，不用急着找原因。',tip:'如果愿意，读一读身边物品上的文字，留意你所在的地方；不舒服就停下。',strategy:0},
 '委屈':{comfort:'有些话没被听见，会很不好受。你可以先说自己的感受，不用急着替别人解释。',tip:'试着补完一句：“这件事里，我最希望被理解的是……”只写你愿意写的部分。',strategy:5},
 '说不清':{comfort:'不用先给感受起名字。可以从“刚才发生了什么”开始，也可以先不解释。',tip:'选一个最容易开始的动作，比如喝一口水，或者看看窗外。做完再决定想不想聊。',strategy:6}
};
let selectedMood=null;
function resetMood(){selectedMood=null;document.querySelectorAll('[data-mood]').forEach(b=>b.setAttribute('aria-pressed','false'));$('mood-support').hidden=true;$('mood-note').textContent='选一个接近的就好；也可以直接聊。';}
function draftSupport(text){
 if(pending){$('mood-note').textContent='等这条回复结束，或点击“停止”后，再带入聊天。';return;}
 const input=$('message');const combined=input.value.trim()?input.value+'\n'+text:text;
 if(combined.length>4000){$('mood-note').textContent='输入框里的文字较多，请先发送或整理，再加入这句话。';return;}
 input.value=combined;input.focus();input.scrollIntoView({block:'center'});$('mood-note').textContent='已放进输入框，你可以修改后再发送。';
}
document.querySelectorAll('[data-mood]').forEach(b=>b.onclick=()=>{
 if(selectedMood===b.dataset.mood){resetMood();return;}
 selectedMood=b.dataset.mood;const s=moodSupport[selectedMood];
 document.querySelectorAll('[data-mood]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
 $('mood-comfort').textContent=s.comfort;$('mood-tip').textContent=s.tip;$('mood-support').hidden=false;
 $('mood-note').textContent='这是通用支持。选择感受不会发送聊天。';
});
$('mood-listen').onclick=()=>{if(selectedMood)draftSupport(`我现在感觉${selectedMood}。我想先被听一听，暂时不用急着给建议。`);};
$('mood-plan').onclick=()=>{if(selectedMood)draftSupport(`我现在感觉${selectedMood}。请结合我们刚才聊的内容，和我一起找一个现在能做的小步骤；不清楚的地方可以先问我。`);};
$('mood-practice').onclick=()=>{if(selectedMood)startGrounding(moodSupport[selectedMood].strategy);};
function paintStep() {const s=strategies[step];$('step-title').textContent=s.title;$('step-when').textContent=s.when;$('step-text').textContent=s.body;$('step-source').href=s.source;$('step-source').textContent=s.label+' ↗';$('next-step').textContent=step===strategies.length-1?'回到第一种方法':'看看另一种';document.querySelectorAll('[data-strategy]').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===step)));}
function startGrounding(index=0) {cancelStrategy();$('strategy-result').textContent='';step=Number.isInteger(index)&&strategies[index]?index:0; paintStep(); openDialog('ground-dialog');}
document.querySelectorAll('[data-ground]').forEach(b => b.onclick=startGrounding);
$('next-step').onclick = () => {step=(step+1)%strategies.length;paintStep();};
strategies.forEach((s,i)=>{const b=document.createElement('button');b.type='button';b.dataset.strategy=i;b.textContent=s.title;b.onclick=()=>{step=i;paintStep();};$('strategy-options').append(b);});
$('ground-dialog').addEventListener('close',cancelStrategy);
document.querySelectorAll('[data-practice-feedback]').forEach(b=>b.onclick=()=>{
 if(pending){$('strategy-result').textContent='请先等聊天回复结束，或停止回复后再继续聊。';return;}
 const title=strategies[step].title;$('ground-dialog').close();draftSupport(`我刚试了“${title}”，${b.dataset.practiceFeedback}。我想接着聊聊。`);
});
$('strategy-stop').onclick=()=>{cancelStrategy();$('strategy-result').textContent='已停止。你可以继续查看通用方法。';};
$('strategy-generate').onclick=async()=>{
 if(strategyPending)return;
 if(!connection){$('strategy-result').textContent='需要先在“连接与隐私”连接 AI 服务。未连接时，上方方法仍可直接查看，不会发送聊天。';return;}
 if(pending){$('strategy-result').textContent='请等这条聊天回复结束，或先停止回复。';return;}
 let messages;try{messages=validateMessages(strategyMessages(history));}catch(error){$('strategy-result').textContent=error.message;return;}
 const controller=new AbortController();strategyPending=controller;$('strategy-generate').disabled=true;$('strategy-stop').hidden=false;$('strategy-result').textContent='正在结合最近的聊天选择方法，并检查建议……';
 const timeout=setTimeout(()=>controller.abort(),95000);
 try{const result=await runHarness(messages,providerEnv(connection.config,connection.key),{signal:controller.signal,reportErrors:true});if(strategyPending!==controller)return;$('strategy-result').textContent=(result.mode==='ai'?'根据当前聊天的建议\n\n':'支持提示\n\n')+result.text;if(result.route==='crisis'){$('ground-dialog').close();openDialog('help-dialog');}}
 catch(error){if(strategyPending===controller)$('strategy-result').textContent=controller.signal.aborted?'请求已超时。可以先选一种通用方法，稍后再试。':error.message;}
 finally{clearTimeout(timeout);if(strategyPending===controller)cancelStrategy();}
};
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
function formConfig(requireModel=true){return normalizeConfig({provider:$('provider').value,base:$('api-base').value,protocol:$('api-protocol').value,model:$('api-model').value||(!requireModel?'model-list':''),tokenField:$('token-field').value,jsonMode:$('json-mode').checked});}
function destination(){try{$('connection-destination').textContent='请求发送到：'+providerEnv(formConfig(false),'').AI_ENDPOINT;}catch{$('connection-destination').textContent='请先填写有效的 HTTPS API 地址。';}}
function invalidateSettings(clearKey=false){settingsGeneration++;vaultGeneration++;verification?.abort();$('consent').checked=false;if(clearKey){$('model-options').replaceChildren();$('api-key').value='';}$('settings-status').textContent='设置已改变，请重新确认发送目标。当前聊天连接需验证成功后才会切换。';destination();}
function paintProvider(config){
 const p=PROVIDERS.find(p=>p.id===(config?.provider||$('provider').value));
 $('provider').value=p.id;$('api-base').value=config?.base??p.base;$('api-protocol').value=config?.protocol??p.protocol;$('api-model').value=config?.model??p.model;$('token-field').value=config?.tokenField??p.tokenField;$('json-mode').checked=config?.jsonMode??p.id==='deepseek';
 $('provider-docs').hidden=!p.docs;$('provider-docs').href=p.docs||'#';
 $('provider-note').textContent=p.id==='custom'?'自定义接口会接收你的密钥和对话，请核对接收方。仅支持下方两种协议。':p.id==='qwen'?'预设为北京兼容地址。不同地区的密钥和地址须匹配，也可填写业务空间专属地址。':'预设使用官方 API 地址。需要 API 平台的密钥，聊天应用订阅不等于 API 额度。';destination();
}
PROVIDERS.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;$('provider').append(o);});paintProvider();
$('provider').onchange=()=>{invalidateSettings(true);paintProvider();};
$('api-base').oninput=()=>invalidateSettings(true);
for(const id of ['api-protocol','api-model','token-field','json-mode'])$(id).addEventListener('input',()=>invalidateSettings(false));
$('consent').addEventListener('change',()=>{if(!$('consent').checked){settingsGeneration++;verification?.abort();}});
$('api-key').addEventListener('input',()=>{settingsGeneration++;vaultGeneration++;verification?.abort();});
$('load-models').onclick=async()=>{
 const id=++settingsGeneration,b=$('load-models');verification?.abort();verification=new AbortController();
 try{if(!$('consent').checked)throw new Error('请先确认请求发送目标并勾选同意。');const key=$('api-key').value.trim();if(!key)throw new Error('请先填写 API Key。');const env=providerEnv(formConfig(false),key);b.disabled=true;$('settings-status').textContent='正在读取模型列表……';const models=await listModels(env,{signal:verification.signal});if(id!==settingsGeneration)return;$('model-options').replaceChildren();models.forEach(model=>{const o=document.createElement('option');o.value=model;$('model-options').append(o);});$('settings-status').textContent=models.length?'已读取 '+models.length+' 个模型，点击模型输入框选择，或手动填写。':'没有可列出的模型，请手动填写。';}
 catch(error){if(id===settingsGeneration)$('settings-status').textContent=error.message;}finally{b.disabled=false;}
};

function clearPasswords(){ $('vault-password').value=''; $('vault-confirm').value=''; }
function vaultStatus(){try{$('vault-status').textContent=readSaved()?'此设备已有加密密钥，输入解锁密码即可恢复。':'此设备尚未保存密钥。';}catch{$('vault-status').textContent='无法读取本地存储；仍可使用临时连接。';}}
vaultStatus();
$('remember-key').onchange=()=>{vaultGeneration++;$('vault-fields').hidden=!$('remember-key').checked;clearPasswords();};
try{if(readSaved()){$('remember-key').checked=true;$('vault-fields').hidden=false;}}catch{}
$('save-key').onclick=async()=>{
  const id=++vaultGeneration,button=$('save-key');
  try{
    const config=formConfig();const key=$('api-key').value.trim() || (JSON.stringify(config)===JSON.stringify(connection?.config)?connection?.key:null);
    const password=$('vault-password').value;
    if(password!==$('vault-confirm').value)throw new Error('两次密码不一致。');
    button.disabled=true;
    const record=await encryptKey(packConnection(config,key),password);
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
    const saved=unpackConnection(key);paintProvider(saved.config);$('consent').checked=false;$('api-key').value=saved.key;clearPasswords();$('vault-status').textContent='已解锁到当前页面。勾选发送同意后，点击“验证并连接”。';
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
    const key=$('api-key').value.trim(); if (!key || /\s/.test(key) || key.length>1024) throw new Error('请输入有效的 API Key，不要包含空格。');
    const config=formConfig();
    button.disabled=true; $('settings-status').textContent='正在测试所选模型（不发送聊天内容）……';
    verification?.abort(); verification=new AbortController();
    await verifyKey(key,{signal:verification.signal,env:providerEnv(config,key)});
    if (id!==settingsGeneration) return;
    connection={key,config}; resetChat(); $('mode-badge').textContent=config.model+' · 已连接'; $('status').textContent='已连接 '+new URL(config.base).hostname+' / '+config.model+'。当前解锁密钥在刷新后清除。'; $('settings-status').textContent='连接成功。'; $('api-key').value=''; $('settings-dialog').close();
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
