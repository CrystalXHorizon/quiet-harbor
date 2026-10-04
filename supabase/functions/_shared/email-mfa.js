import {ApiError} from './security.js';

export function emailMfaConfigured(env) {
 return typeof env.MFA_RESEND_API_KEY==='string'&&/^re_[A-Za-z0-9_-]+$/.test(env.MFA_RESEND_API_KEY)
  &&typeof env.MFA_EMAIL_FROM==='string'&&/^[^\s<>@]+@[^\s<>@]+$/.test(env.MFA_EMAIL_FROM)
  &&typeof env.MFA_EMAIL_SECRET==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(env.MFA_EMAIL_SECRET);
}

export function generateEmailCode() {
 // Rejection sampling avoids bias when mapping a random integer to six digits.
 const value=new Uint32Array(1);
 do{crypto.getRandomValues(value);}while(value[0]>=4294000000);
 return String(value[0]%1000000).padStart(6,'0');
}

export async function emailCodeHash(env,userId,sessionId,challengeId,code) {
 if(!emailMfaConfigured(env))throw new ApiError('email_mfa_unavailable',503);
 const bytes=Uint8Array.from(atob(env.MFA_EMAIL_SECRET),c=>c.charCodeAt(0));
 if(bytes.length!==32)throw new ApiError('email_mfa_unavailable',503);
 const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const data=new TextEncoder().encode(JSON.stringify(['qh:email-mfa:v1',userId,sessionId,challengeId,code]));
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,data)),n=>n.toString(16).padStart(2,'0')).join('');
}

export async function sendEmailCode(env,email,code,challengeId,fetchImpl) {
 if(!emailMfaConfigured(env))throw new ApiError('email_mfa_unavailable',503);
 let response;
 try{
  response=await fetchImpl('https://api.resend.com/emails',{
   method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{Authorization:`Bearer ${env.MFA_RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`qh-email-mfa-${challengeId}`},
   body:JSON.stringify({from:`留岸 <${env.MFA_EMAIL_FROM}>`,to:[email],subject:'留岸 · 二次验证验证码',
    text:`你的留岸二次验证验证码是：${code}\n\n验证码在 5 分钟内有效，仅用于你正在操作的登录会话。请勿向任何人提供验证码。\n如果不是你本人操作，请忽略此邮件，并检查账户安全。`,
    html:`<!doctype html><html lang="zh-CN"><body><h2>留岸 · 二次验证</h2><p>请在正在操作的留岸页面输入此验证码：</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p><p>验证码在 5 分钟内有效，仅用于当前登录会话。请勿向任何人提供验证码。</p><p>如果不是你本人操作，请忽略此邮件，并检查账户安全。</p></body></html>`})
  });
 }catch{throw new ApiError('email_send_failed',503);}
 if(!response.ok)throw new ApiError('email_send_failed',503);
}
