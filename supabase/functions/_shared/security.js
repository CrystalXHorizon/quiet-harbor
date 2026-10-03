import { PROVIDERS, normalizeConfig } from './providers.js';

export class ApiError extends Error {
 constructor(code, status=400) { super(code); this.code=code; this.status=status; }
}
const messages={
 unauthorized:'登录已失效，请重新登录。', forbidden:'当前账户没有这项操作的权限。', admission_required:'账户尚未通过申请审核。', invite_invalid:'邀请码无效、已停用、过期或已用完。',
 mfa_required:'请先完成两步验证，再继续使用账户。', muted:'账户暂时不能发布内容，请联系管理员。',
 not_found:'内容不存在，或当前无法访问。', validation:'填写的内容或参数不符合要求，请检查后重试。',
 rate_limit:'操作太频繁了，请稍后再试。', quota_exceeded:'今日 AI 使用额度已用完，请明天再来。',
 not_configured:'AI 服务尚未启用，请联系站长。', provider_failed:'AI 服务暂时无法完成请求，请稍后再试。',
 origin_forbidden:'此网页地址尚未获准连接服务。', payload_too_large:'提交内容太长，请缩短后重试。',
 self_moderation:'请由另一位管理员审核你自己发布的内容。', duplicate:'已经提交过，请等待处理。',
 key_required:'更换供应商地址或协议时，请重新填写 API Key。', internal:'服务暂时不可用，请稍后再试。'
};
export function errorResponse(error) {
 const code=error instanceof ApiError && Object.hasOwn(messages,error.code)?error.code:'internal';
 return {body:{error:messages[code],code},status:code==='internal'?500:error.status};
}
export function rpcError(error) {
 const code=String(error?.message||'');
 if(Object.hasOwn(messages,code))return new ApiError(code,['forbidden','admission_required','muted','mfa_required','self_moderation'].includes(code)?403:code==='unauthorized'?401:code==='not_found'?404:['rate_limit','quota_exceeded'].includes(code)?429:code==='not_configured'?503:400);
 if(error?.code==='23505')return new ApiError('duplicate',409);
 if(['23502','23503','23514','22P02','22003'].includes(error?.code))return new ApiError('validation');
 return new ApiError('internal',500);
}
export function allowedOrigins(raw) {
 const values=(raw||'').split(',').map(x=>x.trim()).filter(Boolean);
 return new Set(values.filter(value=>{try{const u=new URL(value);return u.origin===value && (u.protocol==='https:' || (u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname)));}catch{return false;}}));
}
export function safeProviderConfig(input,extraHosts='') {
 let config;
 try{config=normalizeConfig(input);}catch{throw new ApiError('validation');}
 const url=new URL(config.base);
 const official=PROVIDERS.filter(p=>p.base).map(p=>new URL(p.base).hostname);
 const allowed=new Set([...official,...extraHosts.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)]);
 if(!allowed.has(url.hostname)||url.port && url.port!=='443'||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname))throw new ApiError('validation');
 return config;
}
export function validateKey(key) {
 if(typeof key!=='string'||key.length<8||key.length>1024||/\s/.test(key))throw new ApiError('validation');
 return key;
}
const encoder=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes));
function unb64(value) {try{return Uint8Array.from(atob(value),x=>x.charCodeAt(0));}catch{throw new ApiError('not_configured',503);}}
async function masterKey(raw) {
 const bytes=unb64(raw||'');if(bytes.length!==32)throw new ApiError('not_configured',503);
 return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
const aad=config=>encoder.encode('quiet-harbor:ai-key:v1:'+config.base+'|'+config.protocol);
export async function encryptKey(key,master,config) {
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(config)},await masterKey(master),encoder.encode(validateKey(key)));
 return {v:1,iv:b64(iv),data:b64(new Uint8Array(encrypted))};
}
export async function decryptKey(record,master,config) {
 if(!record||record.v!==1||typeof record.iv!=='string'||typeof record.data!=='string'||record.data.length>2000)throw new ApiError('not_configured',503);
 try{
  const iv=unb64(record.iv);if(iv.length!==12)throw new Error('Invalid IV');
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(config)},await masterKey(master),unb64(record.data));
  return validateKey(new TextDecoder().decode(clear));
 }catch{throw new ApiError('not_configured',503);}
}
export async function readJson(request,maxBytes=72000) {
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new ApiError('validation');
 if(Number(request.headers.get('content-length'))>maxBytes)throw new ApiError('payload_too_large',413);
 const reader=request.body?.getReader();if(!reader)throw new ApiError('validation');
 const chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new ApiError('payload_too_large',413);}chunks.push(value);}
 try{const value=JSON.parse(await new Blob(chunks).text());if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new ApiError('validation');}
}
// Call ONLY after the Auth service has validated this same bearer token.
export function verifiedAal2(token,userId) {
 try{const part=token.split('.')[1];const claims=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=')));return claims.sub===userId&&claims.aal==='aal2';}catch{return false;}
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIONS=new Set(['me','profile.update','posts.list','posts.get','posts.save','posts.delete','posts.comments','comments.save','comments.delete','bookmarks.toggle','blocks.toggle','blocks.list','reports.create','appeals.create','admin.queue','admin.moderate','admin.users','admin.user','admin.audit','admin.ai.get','admin.ai.save','admin.ai.test','admin.usage','chat']);
export function validateAction(input) {
 if(!ACTIONS.has(input.action))throw new ApiError('validation');
 const p={...input};delete p.action;
 for(const key of ['id','post_id','comment_id','user_id'])if(p[key]!==undefined&&(typeof p[key]!=='string'||!uuid.test(p[key])))throw new ApiError('validation');
 const required={
  'profile.update':['nickname'],'posts.get':['id'],'posts.save':['title','body','category','preference','submit'],'posts.delete':['id'],'posts.comments':['id','open'],
  'comments.save':['post_id','body'],'comments.delete':['id'],'bookmarks.toggle':['post_id'],'blocks.toggle':['user_id'],'reports.create':['reason'],
  'appeals.create':['post_id','reason'],'admin.moderate':['kind','id','decision','reason'],'admin.user':['id','reason'],
  'admin.ai.save':['config','enabled','user_daily_limit','global_daily_limit'],'admin.ai.test':['config'],'chat':['messages']
 }[input.action]||[];
 if(required.some(key=>p[key]===undefined))throw new ApiError('validation');
 for(const key of ['mine','bookmarked','submit','open','enabled'])if(p[key]!==undefined&&typeof p[key]!=='boolean')throw new ApiError('validation');
 if(p.page!==undefined&&(!Number.isInteger(p.page)||p.page<0||p.page>1000))throw new ApiError('validation');
 for(const [key,max] of [['nickname',40],['title',120],['body',input.action==='comments.save'?3000:6000],['reason',1000]])if(p[key]!==undefined&&(typeof p[key]!=='string'||!p[key].trim()||p[key].length>max))throw new ApiError('validation');
 for(const [key,allowed] of [['category',['share','advice','progress']],['preference',['listen','advice']],['status',input.action==='admin.application.review'?['approved','rejected']:['active','muted','banned']],['role',['member','moderator']]])if(p[key]!==undefined&&!allowed.includes(p[key]))throw new ApiError('validation');
 if(input.action==='reports.create'&&Number(!!p.post_id)+Number(!!p.comment_id)!==1)throw new ApiError('validation');
 if(input.action==='admin.user'&&p.role===undefined&&p.status===undefined)throw new ApiError('validation');
 for(const [key,max] of [['user_daily_limit',1000],['global_daily_limit',100000]])if(p[key]!==undefined&&(!Number.isInteger(p[key])||p[key]<1||p[key]>max))throw new ApiError('validation');
 if(p.moderation_model!==undefined&&(typeof p.moderation_model!=='string'||p.moderation_model.length>160||/\s/.test(p.moderation_model)))throw new ApiError('validation');
 // Privileged values are exclusively manufactured server-side.
 delete p.encrypted_key;delete p.key_last4;delete p.actor;delete p.aal2;delete p.code_hash;delete p.code_hint;
 const admissionRequired={'admission.apply':['reason'],'admission.redeem':['code'],'admin.application.review':['id','status','reason'],'admin.invites.create':['label','max_uses'],'admin.invites.update':['id','enabled']}[input.action]||[];
 if(admissionRequired.some(key=>p[key]===undefined))throw new ApiError('validation');
 if(p.code!==undefined&&(typeof p.code!=='string'||!/^[A-Za-z0-9-]{12,80}$/.test(p.code.trim())))throw new ApiError('validation');
 if(p.label!==undefined&&(typeof p.label!=='string'||!p.label.trim()||p.label.length>80))throw new ApiError('validation');
 if(p.max_uses!==undefined&&(!Number.isInteger(p.max_uses)||p.max_uses<1||p.max_uses>10000))throw new ApiError('validation');
 if(p.expires_at!==undefined&&p.expires_at!==null&&(typeof p.expires_at!=='string'||!Number.isFinite(Date.parse(p.expires_at))||Date.parse(p.expires_at)<=Date.now()))throw new ApiError('validation');
 return p;
}
for(const action of ['admission.apply','admission.redeem','admin.applications','admin.application.review','admin.invites.list','admin.invites.create','admin.invites.update'])ACTIONS.add(action);
export function generateInviteCode(){return Array.from(crypto.getRandomValues(new Uint8Array(20)),x=>x.toString(16).padStart(2,'0')).join('');}
export async function hashInviteCode(code){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code.trim().toUpperCase()))),x=>x.toString(16).padStart(2,'0')).join('');}
