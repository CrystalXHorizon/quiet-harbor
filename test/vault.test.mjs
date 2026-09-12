import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptKey,decryptKey,readSaved,writeSaved,forgetSaved} from '../public/vault.js';
test('AES vault roundtrip, randomized encryption, wrong password and tampering',async()=>{
  const key='fake-key-for-test',password='a strong test password';
  const a=await encryptKey(key,password),b=await encryptKey(key,password);
  assert.notEqual(a.salt,b.salt);assert.notEqual(a.iv,b.iv);assert.notEqual(a.ciphertext,b.ciphertext);
  assert.equal(await decryptKey(a,password),key);
  assert.ok(!JSON.stringify(a).includes(key));assert.ok(!JSON.stringify(a).includes(password));
  await assert.rejects(decryptKey(a,'wrong password'),/无法解锁/);
  await assert.rejects(decryptKey({...a,ciphertext:(a.ciphertext[0]==='A'?'B':'A')+a.ciphertext.slice(1)},password),/无法解锁/);
  await assert.rejects(decryptKey({...a,iterations:1},password),/无法解锁/);
  const entries=new Map(),storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
  writeSaved(a,storage);assert.deepEqual(readSaved(storage),a);forgetSaved(storage);assert.equal(readSaved(storage),null);
});
test('weak passwords and empty keys rejected',async()=>{await assert.rejects(encryptKey('fake','short'));await assert.rejects(encryptKey('', 'long-password-here'));});
