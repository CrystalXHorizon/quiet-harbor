const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const base=process.argv[2]||'http://127.0.0.1:4177';
const host='https://quiet-harbor-qa.supabase.co',uid='11111111-1111-4111-8111-111111111111';
const user={id:uid,email:'browser@example.test',aud:'authenticated',role:'authenticated',email_confirmed_at:'2026-10-03',app_metadata:{provider:'email',providers:['email']},user_metadata:{},identities:[],factors:[]};
const token=aal=>'header.'+Buffer.from(JSON.stringify({sub:uid,aal,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';
const tokens=aal=>({access_token:token(aal),refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user});
async function fixture(browser,{owner=false,slow=false,chatStatus=200}={}){
 const context=await browser.newContext({viewport:{width:390,height:844}});const calls=[],errors=[];let verifies=0,pkce=0;
 let release;const gate=slow?new Promise(resolve=>release=resolve):Promise.resolve();
 const profile={id:uid,nickname:owner?'测试站长':'测试成员',role:owner?'owner':'member',status:'active',admission_status:'approved'};
 const cors={'access-control-allow-origin':base,'access-control-allow-headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS'};
 const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',headers:cors,body:JSON.stringify(body)});
 await context.route(host+'/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
  if(path==='/auth/v1/token'){if(new URL(req.url()).searchParams.get('grant_type')==='pkce'){pkce++;assert.ok(req.postDataJSON().code_verifier);}return json(route,tokens(owner?'aal2':'aal1'));}
  if(path==='/auth/v1/verify'){verifies++;return json(route,tokens('aal1'));}
  if(path==='/auth/v1/user')return json(route,user);
  if(path==='/auth/v1/logout')return json(route,{});
  if(path!=='/functions/v1/api')return json(route,{code:'unexpected'},400);
  const p=req.postDataJSON();calls.push(p);
  if(p.action==='me'){await gate;return json(route,{profile,ai:{ready:true},usage:{used:0,limit:30}});}
  if(p.action==='notifications.list')return json(route,{notifications:[],unread:0});
  if(p.action==='admin.queue')return json(route,{posts:[],comments:[],reports:[],appeals:[]});
  if(p.action==='admin.users')return json(route,{users:Array.from({length:p.page?5:20},(_,i)=>({id:'fixture-user-'+(i+(p.page||0)*20),nickname:'分页成员 '+(i+(p.page||0)*20),role:'member',status:'active',created_at:'2026-10-03'})),hasMore:!p.page});
  if(p.action==='admin.audit')return json(route,{events:Array.from({length:p.page?5:20},(_,i)=>({id:i+(p.page||0)*20,action:'ai.save',actor_id:null,created_at:'2026-10-03'})),hasMore:!p.page});
  if(p.action==='chat')return json(route,chatStatus===401?{code:'unauthorized',error:'raw upstream detail'}:null,chatStatus);
  return json(route,{posts:[],hasMore:false});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 async function signIn(){await page.goto(base);await page.locator('#account-open').click();await page.getByLabel('邮箱',{exact:true}).fill(user.email);await page.getByLabel('密码',{exact:true}).fill('browser-fixture-password');await page.locator('#auth-dialog form button[type=submit]').click();await page.waitForFunction(()=>Boolean(localStorage.getItem('sb-quiet-harbor-qa-auth-token')));if(!slow)await page.getByText(`${profile.nickname} · ${owner?'站长':'普通成员'}`,{exact:true}).waitFor();await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();}
 return {context,page,calls,errors,signIn,release:()=>release?.(),get verifies(){return verifies;},get pkce(){return pkce;}};
}
async function main(){const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 const headers=await fetch(base).then(r=>r.headers);assert.match(headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(headers.get('x-frame-options'),'DENY');
 const contrast=await fixture(browser);await contrast.page.goto(base);await contrast.page.locator('#account-open').click();
 for(const name of ['登录','申请加入']){
  const tab=contrast.page.locator('.auth-tabs').getByRole('button',{name,exact:true});await tab.click();
  const ratio=await tab.evaluate(el=>{
   const style=getComputedStyle(el),luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
   const a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert.ok(ratio>=4.5,`${name} selected-tab contrast ${ratio.toFixed(2)} is below 4.5`);
  assert.ok(await tab.evaluate(el=>el.getBoundingClientRect().height>=44));
 }
 assert.deepEqual(contrast.errors,[]);await contrast.context.close();
 const rejected=await fixture(browser);await rejected.page.goto(base+'/#access_token=attacker&refresh_token=attacker&type=invite');await rejected.page.locator('#auth-dialog').waitFor({state:'visible'});assert.equal(await rejected.page.getByLabel('新密码',{exact:true}).count(),0);assert.equal(rejected.verifies,0);assert.equal(rejected.calls.length,0);assert.equal(await rejected.page.evaluate(()=>location.hash),'');assert.deepEqual(rejected.errors,[]);await rejected.context.close();
 for(const type of ['invite','recovery']){
  const fragment=await fixture(browser);
  await fragment.page.goto(base+'/#access_token='+token('aal1')+'&refresh_token=fixture-refresh&type='+type);
  await fragment.page.getByRole('heading',{name:'确认邮件链接',exact:true}).waitFor();
  assert.equal(fragment.calls.length,0);assert.equal(await fragment.page.evaluate(()=>localStorage.getItem('sb-quiet-harbor-qa-auth-token')),null);
  assert.equal(await fragment.page.getByLabel('新密码',{exact:true}).count(),0);assert.equal(await fragment.page.evaluate(()=>location.hash),'');
  await fragment.page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(fragment.calls.length,0);
  assert.deepEqual(fragment.errors,[]);await fragment.context.close();
 }
 for(const type of ['invite','recovery','email','magiclink']){const link=await fixture(browser);await link.page.goto(base+'/?type='+type+'&token_hash=email-fixture');await link.page.getByRole('heading',{name:'确认邮件链接',exact:true}).waitFor();assert.equal(link.verifies,0);assert.equal(await link.page.getByLabel('新密码',{exact:true}).count(),0);await link.page.getByRole('button',{name:'确认使用邮件链接',exact:true}).click();if(type!=='recovery'){await link.page.getByText('测试成员 · 普通成员',{exact:true}).waitFor();assert.equal(await link.page.getByLabel('新密码',{exact:true}).count(),0);}else await link.page.getByLabel('新密码',{exact:true}).waitFor();assert.equal(link.verifies,1);assert.deepEqual(link.errors,[]);await link.context.close();}
 const pkce=await fixture(browser);await pkce.context.addInitScript(()=>localStorage.setItem('sb-quiet-harbor-qa-auth-token-code-verifier',JSON.stringify('a'.repeat(64)+'/PASSWORD_RECOVERY')));await pkce.page.goto(base+'/?account=recovery&code=pkce-fixture');await pkce.page.getByLabel('新密码',{exact:true}).waitFor();assert.equal(pkce.pkce,1);assert.deepEqual(pkce.errors,[]);await pkce.context.close();
 const loading=await fixture(browser,{slow:true});await loading.signIn();await loading.page.locator('#message').fill('资料还没加载的草稿');await loading.page.locator('#send').click();await loading.page.locator('#auth-dialog').waitFor({state:'visible'});assert.equal(await loading.page.locator('#message').inputValue(),'资料还没加载的草稿');assert.equal(loading.calls.filter(x=>x.action==='chat').length,0);assert.equal(await loading.page.getByText('留岸 · 本地预设回复',{exact:true}).count(),0);loading.release();await loading.context.close();
 const expired=await fixture(browser,{chatStatus:401});await expired.signIn();await expired.page.locator('#message').fill('会话过期检查');await expired.page.locator('#send').click();await expired.page.getByText('登录已过期，请重新登录后继续。',{exact:true}).waitFor();assert.deepEqual(expired.errors,[]);await expired.context.close();
 const invalid=await fixture(browser);await invalid.signIn();await invalid.page.locator('#message').fill('响应为 null');await invalid.page.locator('#send').click();await invalid.page.getByText('连接暂时不可用，请稍后重试。',{exact:true}).waitFor();assert.deepEqual(invalid.errors,[]);await invalid.context.close();
 const paging=await fixture(browser,{owner:true});await paging.signIn();await paging.page.locator('#admin-nav').click();for(const name of ['用户管理','操作记录']){await paging.page.getByRole('button',{name,exact:true}).click();await paging.page.getByRole('button',{name:'下一页',exact:true}).click();await paging.page.getByRole('button',{name:'上一页',exact:true}).waitFor();assert.equal(await paging.page.getByRole('button',{name:'下一页',exact:true}).count(),0);}assert.ok(paging.calls.some(x=>x.action==='admin.users'&&x.page===1));assert.ok(paging.calls.some(x=>x.action==='admin.audit'&&x.page===1));assert.deepEqual(paging.errors,[]);await paging.context.close();
 const mobile=await fixture(browser);await mobile.page.goto(base);await mobile.page.locator('#message').fill('我想伤害自己');await mobile.page.locator('#send').click();await mobile.page.locator('#help-dialog').waitFor({state:'visible'});assert.equal(await mobile.page.evaluate(()=>document.activeElement.id),'help-title');await mobile.page.getByRole('dialog').getByRole('button',{name:'我知道了'}).click();assert.ok(await mobile.page.locator('#clear').evaluate(el=>el.getBoundingClientRect().height>=44));await mobile.page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));assert.equal(await mobile.page.locator('.sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().top)),0);assert.ok(await mobile.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await fs.mkdir('test-results/browser',{recursive:true});await mobile.page.evaluate(()=>window.scrollTo(0,0));await mobile.page.screenshot({path:'test-results/browser/audit-mobile.png',fullPage:true});assert.deepEqual(mobile.errors,[]);await mobile.context.close();
 console.log('Audit browser checks passed: selected auth-tab contrast, token rejection/confirmation/PKCE, pending profile, expired session, invalid JSON shape, admin pagination, mobile target/focus/sticky navigation and real CSP headers');
 }finally{await browser.close();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
