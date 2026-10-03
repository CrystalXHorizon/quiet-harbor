import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chatAccess} from '../public/chat-state.js';
import {authNavigation} from '../public/auth-navigation.js';
import {contentSecurity} from '../public/content-security.js';

test('a signed-in account without a profile retains its draft instead of entering local demo',()=>{
 assert.equal(chatAccess({user:{id:'member'},profile:null}),'loading');
 assert.equal(chatAccess(null),'local');
 assert.equal(chatAccess({user:{id:'member'},profile:{status:'active',admission_status:'approved'}}),'remote');
 assert.equal(chatAccess({user:{id:'member'},profile:{status:'banned',admission_status:'approved'}}),'blocked');
});
test('token fragments never carry a password or invitation intent; email token hashes require confirmation',()=>{
 for(const type of ['invite','recovery','signup','magiclink']){
  const state=authNavigation(`https://example.test/?account=recovery#access_token=attacker&refresh_token=attacker&type=${type}`);
  assert.equal(state.rejected,true);assert.equal(state.implicit,false);assert.equal(state.recovery,false);assert.equal(state.invitation,false);assert.equal(state.emailLink,null);
 }
 const link=authNavigation('https://example.test/?token_hash=fixture&type=invite');
 assert.deepEqual(link.emailLink,{tokenHash:'fixture',type:'invite'});assert.equal(link.recovery,false);
});
test('CSP names only the configured Auth project and explicitly permits local HTTP development',()=>{
 const live=contentSecurity({supabaseUrl:'https://example.supabase.co'});
 assert.ok(live.includes("connect-src 'self' https://example.supabase.co wss://example.supabase.co;"));
 assert.ok(!live.includes("connect-src 'self' https:;"));
 assert.ok(contentSecurity({supabaseUrl:'http://127.0.0.1:54321'}).includes('http://127.0.0.1:54321'));
});
test('fixed safety copy and browser provider metadata stay identical to their server sources',async()=>{
 const source=async p=>(await readFile(new URL(p,import.meta.url),'utf8')).replaceAll('\r\n','\n');
 assert.equal(await source('../public/safety.js'),await source('../supabase/functions/_shared/safety.js'));
 const server=await source('../supabase/functions/_shared/providers.js');
 assert.equal(await source('../public/providers.js'),server.slice(0,server.indexOf('export function providerEnv')));
});
