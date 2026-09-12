const SLOT='quiet-harbor.encrypted-key.v1';
const iterations=600000;
const encoder=new TextEncoder();
const aad=encoder.encode(SLOT);
const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
async function derive(password,salt) {
  const base=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptKey(key,password) {
  if(typeof password!=='string' || password.length<12)throw new Error('解锁密码至少需要 12 个字符。');
  if(typeof key!=='string' || !key.trim() || key.length>1024)throw new Error('请输入有效的 API Key。');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await derive(password,salt),encoder.encode(key));
  return {version:1,iterations,salt:encode(salt),iv:encode(iv),ciphertext:encode(ciphertext)};
}
export async function decryptKey(record,password) {
  try {
    if(record?.version!==1 || record.iterations!==iterations || typeof record.ciphertext!=='string' || record.ciphertext.length>6000)throw Error();
    const salt=decode(record.salt),iv=decode(record.iv);
    if(salt.length!==16 || iv.length!==12)throw Error();
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},await derive(password,salt),decode(record.ciphertext));
    return new TextDecoder().decode(plain);
  } catch {throw new Error('无法解锁：密码不正确，或保存的数据已损坏。');}
}
export function readSaved(storage=localStorage) {
  const raw=storage.getItem(SLOT);if(raw===null)return null;
  if(raw.length>8000)throw new Error('保存的数据损坏，请忘记后重新保存。');
  try{return JSON.parse(raw);}catch{throw new Error('保存的数据损坏，请忘记后重新保存。');}
}
export function writeSaved(record,storage=localStorage) {storage.setItem(SLOT,JSON.stringify(record));}
export function forgetSaved(storage=localStorage) {storage.removeItem(SLOT);}
