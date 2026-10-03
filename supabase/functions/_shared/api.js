import {runHarness,validateMessages,verifyKey} from './harness.js';
import {providerEnv} from './providers.js';
import {resolveSupabaseKeys} from './supabase-keys.js';
import {runModeration,POLICY_VERSION} from './moderation.js';
import {generateInviteCode,hashInviteCode} from './security.js';
import {ApiError,errorResponse,rpcError,allowedOrigins,safeProviderConfig,validateKey,encryptKey,decryptKey,readJson,verifiedAal2,validateAction} from './security.js';

export function createApiHandler({env,fetchImpl=fetch}) {
 const origins=allowedOrigins(env.ALLOWED_ORIGINS);
 const {publishableKey,secretKey}=resolveSupabaseKeys(env);
 async function internalFetch(path,body,token) {
  const service=token===undefined;
  const key=service?secretKey:publishableKey;
  const headers={apikey:key,'Content-Type':'application/json'};
  if(!env.SUPABASE_URL||!headers.apikey)throw new ApiError('not_configured',503);
  // Opaque secret keys authenticate through apikey; only JWTs use Bearer.
  if(!service||!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${service?key:token}`;
  let response;try{response=await fetchImpl(env.SUPABASE_URL.replace(/\/$/,'')+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new ApiError('internal',503);}
  let data;try{data=await response.json();}catch{throw new ApiError('internal',503);}
  if(!response.ok){if(!service)throw new ApiError('unauthorized',401);throw rpcError(data);}
  return data;
 }
 async function settings() {
  const rows=await internalFetch('/rest/v1/qh_ai_settings?id=eq.true&select=config,encrypted_key,enabled');
  if(!rows[0])throw new ApiError('not_configured',503);return rows[0];
 }
 return async request=>{
  const origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(origin&&origins.has(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Max-Age':'600'});
  try{
   if(!origin||!origins.has(origin))throw new ApiError('origin_forbidden',403);
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
   if(request.method!=='POST')throw new ApiError('validation',405);
   const match=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
   if(!match||match[1].length>16000)throw new ApiError('unauthorized',401);
   const token=match[1];
   // getUser checks signature, expiry and current Auth account. Never authorize from
   // unverified JWT contents or signup metadata.
   const user=await internalFetch('/auth/v1/user',undefined,token);
   if(!user.id||!user.email_confirmed_at)throw new ApiError('unauthorized',401);
   const aal2=verifiedAal2(token,user.id);
   // Once TOTP is enrolled, a password-only session may challenge/recover through
   // Auth but must not read private application data. Enrollment state comes from
   // the verified Auth response, never from client metadata or the JSON request.
   if(Array.isArray(user.factors)&&user.factors.some(f=>f.factor_type==='totp'&&f.status==='verified')&&!aal2)throw new ApiError('mfa_required',403);
   const input=await readJson(request);const payload=validateAction(input);
   const rpc=(action,payload={})=>internalFetch('/rest/v1/rpc/qh_action',{actor:user.id,action,payload,aal2});
   let result;
   if(input.action==='chat'){
    let messages;try{messages=validateMessages(payload.messages);}catch{throw new ApiError('validation');}
    // qh_action me rechecks status on every request and rate-limits the gateway.
    const me=await rpc('me');if(me.profile.status==='banned')throw new ApiError('forbidden',403);
    if(me.profile.admission_status!=='approved')throw new ApiError('admission_required',403);
    const reserved=await internalFetch('/rest/v1/rpc/qh_reserve_ai',{actor:user.id});
    const config=safeProviderConfig(reserved.config,env.AI_ALLOWED_HOSTS);
    const key=await decryptKey(reserved.encrypted_key,env.AI_ENCRYPTION_KEY,config);
    try{result=await runHarness(messages,providerEnv(config,key),{fetchImpl,signal:request.signal,reportErrors:true});}catch{throw new ApiError('provider_failed',502);}
   }else if(input.action==='admin.ai.save'||input.action==='admin.ai.test'){
    // Permission must be checked before reading stored ciphertext or using a supplied key.
    await rpc('admin.ai.get');
    if(!aal2)throw new ApiError('mfa_required',403);
    const config=safeProviderConfig(payload.config,env.AI_ALLOWED_HOSTS);
    const current=await settings();
    const sameEndpoint=current.config?.base===config.base&&current.config?.protocol===config.protocol;
    let key;
    if(payload.key!==undefined&&payload.key!=='')key=validateKey(payload.key);
    else if(current.encrypted_key&&sameEndpoint)key=await decryptKey(current.encrypted_key,env.AI_ENCRYPTION_KEY,config);
    else if(current.encrypted_key&&!sameEndpoint)throw new ApiError('key_required');
    if(input.action==='admin.ai.test'){
     if(!key)throw new ApiError('key_required');
     await rpc('admin.ai.test');
     try{await verifyKey(key,{env:providerEnv(config,key),fetchImpl,signal:request.signal});}catch{throw new ApiError('provider_failed',502);}
     result={ok:true};
    }else{
     if(payload.enabled&&!key)throw new ApiError('key_required');
     const securePayload={config,enabled:payload.enabled,user_daily_limit:payload.user_daily_limit,global_daily_limit:payload.global_daily_limit,moderation_model:payload.moderation_model};
     if(key){securePayload.encrypted_key=await encryptKey(key,env.AI_ENCRYPTION_KEY,config);securePayload.key_last4=key.slice(-4);}
     result=await rpc('admin.ai.save',securePayload);
    }
   }else if(input.action==='admin.invites.create'){
    await rpc('admin.invites.list');if(!aal2)throw new ApiError('mfa_required',403);
    const code=(payload.code||generateInviteCode()).trim().toUpperCase();
    const {code:ignored,...safe}=payload;
    result=await rpc(input.action,{...safe,code_hash:await hashInviteCode(code),code_hint:code.slice(-4)});
    result={...result,code};
   }else if(input.action==='admission.redeem'){
    result=await rpc(input.action,{code_hash:await hashInviteCode(payload.code)});
    if(result.error_code==='invite_invalid')throw new ApiError('invite_invalid');
   }else result=await rpc(input.action,payload);
   if(['posts.save','comments.save'].includes(input.action)&&result?.moderation_job_id){
    const job_id=result.moderation_job_id;
    let outcome={decision:'error',reason:'自动审核暂时未完成，已保留待人工审核。',rule_ids:[],policy_version:POLICY_VERSION};
    let model='';
    try{
     const job=await internalFetch('/rest/v1/rpc/qh_claim_moderation',{actor:user.id,job_id});
     const config=safeProviderConfig(job.config,env.AI_ALLOWED_HOSTS);
     const key=await decryptKey(job.encrypted_key,env.AI_ENCRYPTION_KEY,config);
     model=job.moderation_model||config.model;
     outcome=await runModeration(job,{...providerEnv(config,key),AI_MODEL:model},{fetchImpl,signal:request.signal});
    }catch{/* A saved submission must never become published when moderation fails. */}
    try{
     const completed=await internalFetch('/rest/v1/rpc/qh_complete_moderation',{actor:user.id,job_id,...outcome,model});
     result={...result,...completed,moderation:outcome.decision};
    }catch{result={...result,moderation:'pending'};}
   }
   return new Response(JSON.stringify(result),{status:200,headers});
  }catch(error){const response=errorResponse(error);return new Response(JSON.stringify(response.body),{status:response.status,headers});}
 };
}
