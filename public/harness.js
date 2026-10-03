import { quickRoute, CRISIS_TEXT, BOUNDARY_TEXT, PAUSE_TEXT } from './safety.js';
export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_MODEL = 'deepseek-flash';
export class ProviderError extends Error {}
export function providerError(status) {
  if(status===401) return new ProviderError('AI 服务 API Key 无效或已失效，请重新连接。');
  if(status===402) return new ProviderError('AI 服务 账户余额不足，请到官方平台检查余额。');
  if(status===429) return new ProviderError('AI 服务 请求过于频繁，请稍后再试。');
  if(status===400||status===404||status===422) return new ProviderError('AI 服务拒绝请求，请检查接口路径、模型 ID、JSON 模式和输出参数。');
  if(status===403) return new ProviderError('AI 服务拒绝访问，请检查账户、地区与模型权限。');
  return new ProviderError('AI 服务 暂时无法完成请求，请稍后再试。');
}
export async function verifyKey(key,{signal,fetchImpl=fetch,env}={}) {
  if(env){const result=await complete({...env,AI_API_KEY:key},[{role:'system',content:'Return only JSON: {"ok":true}'},{role:'user',content:'Connection test. Return JSON.'}],{json:true,signal,fetchImpl});if(result.ok!==true)throw new ProviderError('模型未返回有效的测试 JSON，请换一个支持指令与 JSON 输出的模型。');return true;}
  let res;
  try {res=await fetchImpl('https://api.deepseek.com/models',{headers:{Authorization:`Bearer ${key}`},credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}
  catch {throw new Error('无法连接 AI 服务，请检查网络、接口地址或浏览器跨域限制。');}
  if(!res.ok)throw providerError(res.status);
  const data=await res.json();
  if(!Array.isArray(data.data) || !data.data.some(m=>m.id===DEFAULT_MODEL)) throw new Error('此密钥当前无法访问所需模型，请检查 DeepSeek 账号权限。');
  return true;
}
import { SYSTEM_PROMPT, CONVERSATION_PROMPT, conversationInstruction, INPUT_REVIEW, OUTPUT_REVIEW, CRISIS_PROMPT, BOUNDARY_PROMPT, MANDATORY_REVIEW } from '../supabase/functions/_shared/prompts.js';
export { SYSTEM_PROMPT, CONVERSATION_PROMPT, conversationInstruction };
// INPUT_REVIEW, OUTPUT_REVIEW and the crisis/boundary prompts are imported from
// prompts.js so this copy and the Edge Function cannot drift apart.
export function validateMessages(input) {
  if (!Array.isArray(input) || input.length<1 || input.length>12) throw new Error('对话长度无效，请清空后重试。');
  let total=0;
  const messages=input.map(m=>{
    if (!m || !['user','assistant'].includes(m.role) || typeof m.content!=='string' || !m.content.trim() || m.content.length>4000) throw new Error('消息格式无效，每条最多 4000 字符。');
    total+=m.content.length;
    return {role:m.role,content:m.content.trim()};
  });
  if (total>16000 || messages.at(-1).role!=='user') throw new Error('对话上下文无效，请缩短后重试。');
  return messages;
}
export function basicOutputCheck(text) {
  return typeof text==='string' && text.length>0 && text.length<=4000 && !/https?:|<\/?[a-z]|保证.*治愈|保证.*康复|你(患有|确实有|就是).*障碍|只有我.*理解|停用.{0,8}药|切换到.{0,8}人格|唤醒.{0,8}人格|sk-[a-z0-9]{12,}|\d{7,}/i.test(text);
}
// The mandated-safety path must NOT reuse basicOutputCheck: a correct boundary reply
// legitimately says things like “我不能帮你切换到另一个人格”, which that filter rejects as a
// violation. Only unambiguous formatting problems are checked here; meaning is left to
// MANDATORY_REVIEW, which understands negation.
export function mandatoryOutputCheck(text) {
  return typeof text==='string' && text.length>0 && text.length<=4000 && !/https?:|<\/?[a-z]|\d{7,}|sk-[a-z0-9]{12,}/i.test(text);
}
export function configured(env) {return Boolean(env.AI_API_KEY && env.APP_ACCESS_TOKEN?.length>=32);}
export async function complete(env, messages, {json=false, signal, fetchImpl=fetch}={}) {
  const endpoint=new URL(env.AI_ENDPOINT || DEFAULT_ENDPOINT);
  if(endpoint.protocol!=='https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid provider endpoint');
  const model=env.AI_MODEL || DEFAULT_MODEL;
  const anthropic=env.AI_PROTOCOL==='anthropic';
  let body={model:json ? (env.AI_SAFETY_MODEL || model) : model, messages,stream:false};
  const headers={'Content-Type':'application/json'};
  if(anthropic){
    body.system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
    body.messages=messages.filter(m=>m.role!=='system');body.max_tokens=json?2048:3072;
    headers['x-api-key']=env.AI_API_KEY;headers['anthropic-version']='2023-06-01';headers['anthropic-dangerous-direct-browser-access']='true';
  }else{
    headers.Authorization=`Bearer ${env.AI_API_KEY}`;
    body[env.AI_TOKEN_FIELD==='max_completion_tokens'?'max_completion_tokens':'max_tokens']=json?2048:3072;
    if(endpoint.hostname==='api.deepseek.com') body.thinking={type:'disabled'};
    if(json && (env.AI_JSON_MODE ?? endpoint.hostname==='api.deepseek.com'))body.response_format={type:'json_object'};
  }
  let res;try{res=await fetchImpl(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(28000)]):AbortSignal.timeout(28000),redirect:'error',credentials:'omit'});}
  catch(error){if(signal?.aborted)throw error;throw new ProviderError('无法连接 AI 服务：请检查网络、接口地址，或供应商是否允许浏览器跨域访问（CORS）。');}
  if(!res.ok) throw providerError(res.status);
  // Bound even a malformed/untrusted upstream body; never forward errors or reasoning_content.
  if(!res.body) throw new Error('Missing provider body');
  const reader=res.body.getReader(); let bytes=0; const chunks=[];
  while(true) {const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>64000){await reader.cancel();throw new Error('Provider response too large');}chunks.push(value);}
  const data=JSON.parse(await new Blob(chunks).text());
  let text;
  if(anthropic){
    if(data.stop_reason!=='end_turn'||!Array.isArray(data.content)||data.content.some(x=>x.type!=='text'))throw new ProviderError('模型返回了不完整或不支持的内容，请选择文本对话模型。');
    text=data.content.map(x=>x.text).join('');
  }else{
    const choice=data.choices?.[0];
    if(choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string')throw new ProviderError('模型未完成文本回复；可能达到输出上限，请换用非推理文本模型后重试。');
    text=choice.message.content;
  }
  if(typeof text!=='string'||!text.trim())throw new ProviderError('模型返回了空内容。');
  if(json){try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new ProviderError('模型未返回有效的检查结果，回复已暂停；可以换一个支持 JSON 输出的模型。');}}
  return text.trim();
}
export async function runHarness(messages, env, options={}) {
  const reply=(text,route)=>({text,route,mode:'guarded'});
  // A word filter cannot see context — a film plot is not a disclosure — so the keyword
  // route never decides on its own. It hints the router, and it stands in only when no
  // reviewed generated reply can be produced.
  const quick=quickRoute(messages.at(-1).content);
  let known=quick;
  try {
    const classify=await complete(env,[{role:'system',content:INPUT_REVIEW},{role:'user',content:JSON.stringify(quick==='support'?{messages}:{keyword_hint:quick,messages})}],{...options,json:true});
    const route=classify.route;
    if(route==='crisis'||route==='boundary'){
      known=route;
      const fallback=route==='crisis'?CRISIS_TEXT:BOUNDARY_TEXT;
      // Generated, not canned: the router already saw the whole conversation, and the
      // prompt forbids repeating last turn's emergency wording, so the reply can follow
      // what the person actually said.
      const draft=await complete(env,[{role:'system',content:route==='crisis'?CRISIS_PROMPT:BOUNDARY_PROMPT},...messages],options);
      if(!mandatoryOutputCheck(draft)) return reply(fallback,route);
      const reviewed=await complete(env,[{role:'system',content:MANDATORY_REVIEW},{role:'user',content:JSON.stringify({expect:route,messages,draft})}],{...options,json:true});
      if(reviewed.safe!==true) return reply(fallback,route);
      return reply(draft,route);
    }
    if(route!=='support') throw new Error('Invalid safety classification');
    known='support';
    const draft=await complete(env,[{role:'system',content:SYSTEM_PROMPT+'\n\n'+conversationInstruction(classify.mode)},...messages],options);
    if(!basicOutputCheck(draft)) return reply(PAUSE_TEXT,'paused');
    const reviewed=await complete(env,[{role:'system',content:OUTPUT_REVIEW},{role:'user',content:JSON.stringify({messages,draft})}],{...options,json:true});
    if(reviewed.safe!==true) return reply(PAUSE_TEXT,'paused');
    return {text:draft,route:'support',mode:'ai'};
  } catch(error) {
    // The fixed crisis/boundary text outranks the error-reporting contract: someone who
    // may be in danger must still get usable wording when the provider is unreachable.
    if(known==='crisis') return reply(CRISIS_TEXT,'crisis');
    if(known==='boundary') return reply(BOUNDARY_TEXT,'boundary');
    if(options.reportErrors) {
      if(options.signal?.aborted) throw new Error('请求已停止。');
      if(error instanceof ProviderError) throw error;
      if(error instanceof TypeError) throw new Error('无法连接 AI 服务，请检查网络、接口地址或浏览器跨域限制。');
    }
    return reply(PAUSE_TEXT,'paused');
  }
}

export async function listModels(env,{signal,fetchImpl=fetch}={}){
 const endpoint=new URL(env.AI_ENDPOINT);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new ProviderError('接口地址无效。');
 endpoint.pathname=endpoint.pathname.replace(/\/(chat\/completions|messages)$/,'/models');
 const headers=env.AI_PROTOCOL==='anthropic'?{'x-api-key':env.AI_API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}:{Authorization:`Bearer ${env.AI_API_KEY}`};
 let res;try{res=await fetchImpl(endpoint,{headers,credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}catch{throw new ProviderError('无法读取模型列表，可手动填写模型 ID；也请检查网络与浏览器跨域限制。');}
 if(!res.ok)throw providerError(res.status);
 const reader=res.body?.getReader();if(!reader)throw new ProviderError('模型列表为空。');let bytes=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2000000){await reader.cancel();throw new ProviderError('模型列表过大，请手动填写。');}chunks.push(value);}
 const data=JSON.parse(await new Blob(chunks).text());const items=Array.isArray(data)?data:data.data;
 if(!Array.isArray(items))throw new ProviderError('此接口未提供兼容的模型列表，请手动填写模型 ID。');
 return [...new Set(items.map(m=>m.id).filter(id=>typeof id==='string'&&id.length<=200&&!/\s/.test(id)))].slice(0,1500).sort();
}
