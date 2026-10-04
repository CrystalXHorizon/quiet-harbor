import {runHarness,validateMessages,verifyKey} from './harness.js';
import {BUILD_INFO} from './build-info.js';
import {providerEnv} from './providers.js';
import {resolveSupabaseKeys} from './supabase-keys.js';
import {runModeration,POLICY_VERSION} from './moderation.js';
import {generateInviteCode,hashInviteCode} from './security.js';
import {ApiError,errorResponse,rpcError,allowedOrigins,safeProviderConfig,validateKey,encryptKey,decryptKey,readJson,verifiedAal2,verifiedPasswordSession,validateAction} from './security.js';
import {emailMfaConfigured,generateEmailCode,emailCodeHash,sendEmailCode} from './email-mfa.js';

export function moderationConnection(job, allowedHosts) {
 if(!job || !['post','comment'].includes(job.kind) || !job.content || typeof job.content.body!=='string' || !job.context || !job.encrypted_key)throw new ApiError('internal',503);
 return safeProviderConfig(job.config,allowedHosts);
}

export function createApiHandler({env,fetchImpl=fetch}) {
 const origins=allowedOrigins(env.ALLOWED_ORIGINS);
 const {publishableKey,secretKey}=resolveSupabaseKeys(env);
 async function internalFetch(path,body,token,method) {
  const service=token===undefined;
  const key=service?secretKey:publishableKey;
  const headers={apikey:key,'Content-Type':'application/json'};
  if(!env.SUPABASE_URL||!headers.apikey)throw new ApiError('not_configured',503);
  // Opaque secret keys authenticate through apikey; only JWTs use Bearer.
  if(!service||!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${service?key:token}`;
  let response;try{response=await fetchImpl(env.SUPABASE_URL.replace(/\/$/,'')+path,{method:method||(body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new ApiError('internal',503);}
  if(response.status===204)return null;
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
   if(request.method==='GET'&&new URL(request.url).pathname.endsWith('/health')){
    const database=await internalFetch('/rest/v1/rpc/qh_backend_version',{});
    return new Response(JSON.stringify({ok:true,...BUILD_INFO,...database}),{status:200,headers});
   }
   if(request.method!=='POST')throw new ApiError('validation',405);
   const match=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
   if(!match||match[1].length>16000)throw new ApiError('unauthorized',401);
   const token=match[1];
   // getUser checks signature, expiry and current Auth account. Never authorize from
   // unverified JWT contents or signup metadata.
   const user=await internalFetch('/auth/v1/user',undefined,token);
   if(!user.id||!user.email_confirmed_at)throw new ApiError('unauthorized',401);
   const aal2=verifiedAal2(token,user.id);
   const passwordSession=verifiedPasswordSession(token,user.id);
   const authSession=passwordSession?.id||null;
   const input=await readJson(request);const payload=validateAction(input);
   const emailRpc=(operation,payload={})=>internalFetch('/rest/v1/rpc/qh_email_mfa',{actor:user.id,auth_session:authSession,operation,payload});
   const emailStatus=authSession?await emailRpc('status'):{email_enabled:false,email_verified:false};
   const mfaVerified=aal2||emailStatus.email_verified===true;
   // A session grant is bound to the signed session ID and current verified email.
   // Challenge endpoints remain available while private application data is gated.
   if(input.action.startsWith('security.')){
    let result;
    if(input.action==='security.mfa.status'){
     result={...emailStatus,verified:mfaVerified,totp_enabled:Array.isArray(user.factors)&&user.factors.some(f=>f.factor_type==='totp'&&f.status==='verified'),
      email_available:emailMfaConfigured(env)&&!!passwordSession?.password};
    }else if(input.action==='security.password.update'){
     if(!mfaVerified)throw new ApiError('mfa_required',403);
     await emailRpc('authorize_password',{native_mfa:aal2});
     // Revoke the application grants BEFORE changing Auth credentials. If Auth
     // fails, the user can verify again; stale proof cannot survive a password reset.
     await emailRpc('revoke_sessions',{native_mfa:aal2});
     await internalFetch(`/auth/v1/admin/users/${user.id}`,{password:payload.password},undefined,'PUT');
     result={ok:true,sign_out:true};
    }else if(input.action==='security.email.disable'){
     result=await emailRpc('disable',{native_mfa:aal2});
    }else{
     // A passwordless email sign-in must not count as two independent steps.
     if(!passwordSession?.password)throw new ApiError('password_required',403);
     if(!emailMfaConfigured(env))throw new ApiError('email_mfa_unavailable',503);
     if(input.action==='security.email.send'){
      const code=generateEmailCode(),challengeId=crypto.randomUUID();
      const codeHash=await emailCodeHash(env,user.id,authSession,challengeId,code);
      result=await emailRpc('start',{challenge_id:challengeId,code_hash:codeHash,email:user.email});
      try{await sendEmailCode(env,user.email,code,challengeId,fetchImpl);}catch(error){await emailRpc('cancel',{challenge_id:challengeId}).catch(()=>{});throw error;}
     }else{
      const codeHash=await emailCodeHash(env,user.id,authSession,payload.challenge_id,payload.code);
      result=await emailRpc('verify',{challenge_id:payload.challenge_id,code_hash:codeHash});
      if(result.error_code)throw new ApiError(result.error_code,400);
     }
    }
    return new Response(JSON.stringify(result),{status:200,headers});
   }
   const totpEnabled=Array.isArray(user.factors)&&user.factors.some(f=>f.factor_type==='totp'&&f.status==='verified');
   if((emailStatus.email_enabled||totpEnabled)&&!mfaVerified){const problem=new ApiError('mfa_required',403);problem.totpEnabled=totpEnabled;throw problem;}
   // SQL independently rechecks the email grant when authorizing each operation.
   const rpc=(action,payload={})=>internalFetch('/rest/v1/rpc/qh_action',{actor:user.id,action,payload,aal2,auth_session:authSession});
   let billingError=null;
   function chargedFetch(kind,firstReserved=true) {
    let first=true;
    return async (url,options)=>{
     options.signal?.throwIfAborted();
     try{if(!first || !firstReserved)await internalFetch('/rest/v1/rpc/qh_reserve_model',{actor:user.id,kind});}catch(error){billingError=error;throw error;}
     options.signal?.throwIfAborted();
     try{await internalFetch('/rest/v1/rpc/qh_record_ai_call',{actor:user.id,kind,start_turn:first&&kind==='chat'});}catch(error){billingError=error;throw error;}
     options.signal?.throwIfAborted();
     first=false;
     return fetchImpl(url,options);
    };
   }
   let result;
   if(input.action==='chat'){
    let messages;try{messages=validateMessages(payload.messages);}catch{throw new ApiError('validation');}
    // qh_action me rechecks status on every request and rate-limits the gateway.
    const me=await rpc('me');if(me.profile.status==='banned')throw new ApiError('forbidden',403);
    if(me.profile.admission_status!=='approved')throw new ApiError('admission_required',403);
    const reserved=await internalFetch('/rest/v1/rpc/qh_reserve_ai',{actor:user.id});
    const config=safeProviderConfig(reserved.config,env.AI_ALLOWED_HOSTS);
    const key=await decryptKey(reserved.encrypted_key,env.AI_ENCRYPTION_KEY,config);
    try{result=await runHarness(messages,providerEnv(config,key),{fetchImpl:chargedFetch('chat'),signal:request.signal,reportErrors:true});}catch(error){if(billingError)throw billingError;if(error instanceof ApiError)throw error;throw new ApiError('provider_failed',502);}
    if(billingError&&result.route==='paused')throw billingError;
   }else if(input.action==='admin.ai.save'||input.action==='admin.ai.test'){
    // Permission must be checked before reading stored ciphertext or using a supplied key.
    await rpc('admin.ai.get');
    if(!mfaVerified)throw new ApiError('mfa_required',403);
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
     try{await verifyKey(key,{env:providerEnv(config,key),fetchImpl:chargedFetch('test',false),signal:request.signal});}catch(error){if(billingError)throw billingError;if(error instanceof ApiError)throw error;throw new ApiError('provider_failed',502);}
     result={ok:true};
    }else{
     if(payload.enabled&&!key)throw new ApiError('key_required');
     const securePayload={config,enabled:payload.enabled,user_daily_limit:payload.user_daily_limit,global_daily_limit:payload.global_daily_limit,moderation_model:payload.moderation_model};
     if(key){securePayload.encrypted_key=await encryptKey(key,env.AI_ENCRYPTION_KEY,config);securePayload.key_last4=key.slice(-4);}
     result=await rpc('admin.ai.save',securePayload);
    }
   }else if(input.action==='admin.invites.create'){
    await rpc('admin.invites.list');if(!mfaVerified)throw new ApiError('mfa_required',403);
    const code=(payload.code||generateInviteCode()).trim().toUpperCase();
    const {code:ignored,...safe}=payload;
    result=await rpc(input.action,{...safe,code_hash:await hashInviteCode(code),code_hint:code.slice(-4)});
    result={...result,code};
   }else if(input.action==='admission.redeem'){
    result=await rpc(input.action,{code_hash:await hashInviteCode(payload.code)});
    if(result.error_code==='invite_invalid')throw new ApiError('invite_invalid');
   }else result=await rpc(input.action,payload);
   if(input.action==='me')result={...result,security:{emailVerified:emailStatus.email_verified===true,nativeVerified:aal2}};
   if(['posts.save','comments.save'].includes(input.action)&&result?.moderation_job_id){
    const job_id=result.moderation_job_id;
    let outcome={decision:'error',reason:'自动审核暂时未完成，已保留待人工审核。',rule_ids:[],policy_version:POLICY_VERSION};
    let model='';
    try{
     const job=await internalFetch('/rest/v1/rpc/qh_claim_moderation',{actor:user.id,job_id});
     const config=moderationConnection(job,env.AI_ALLOWED_HOSTS);
     const key=await decryptKey(job.encrypted_key,env.AI_ENCRYPTION_KEY,config);
     model=config.model;
     outcome=await runModeration(job,providerEnv(config,key),{fetchImpl:chargedFetch('moderation'),signal:request.signal});
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
