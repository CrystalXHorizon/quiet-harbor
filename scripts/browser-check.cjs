// Browser integration checks use network fixtures ONLY here, never in shipped assets.
// Run: npm run build && node scripts/browser-check.cjs [base URL]
// Setup: npm ci && npx playwright install chromium; optionally set PLAYWRIGHT_MODULE
// to an existing Playwright module and PLAYWRIGHT_CHANNEL to an installed browser.
// No Supabase project or paid AI key is used. All API responses below are test fixtures.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=process.argv[2]||'http://127.0.0.1:4177';
const output=process.env.QH_QA_OUTPUT||path.resolve('test-results/browser');
const host='https://quiet-harbor-qa.supabase.co';
const ids={member:'11111111-1111-4111-8111-111111111111',owner:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333',post:'44444444-4444-4444-8444-444444444444',comment:'55555555-5555-4555-8555-555555555555',draft:'66666666-6666-4666-8666-666666666666'};
const fixed='2026-10-01T02:00:00.000Z';
const config={provider:'deepseek',name:'DeepSeek',base:'https://api.deepseek.com',protocol:'openai',model:'deepseek-chat',tokenField:'max_tokens',jsonMode:true};
function token(role,aal=role==='owner'?'aal2':'aal1',method='password'){const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');return `${b({alg:'HS256',typ:'JWT'})}.${b({sub:ids[role],role:'authenticated',aud:'authenticated',aal,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),amr:[{method,timestamp:Math.floor(Date.now()/1000)}]})}.qa-fixture-signature`;}
async function visible(locator){await locator.waitFor({state:'visible'});}
async function noOverflow(page,label){const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=size.width+1,`${label} overflows: ${JSON.stringify(size)}`);}
async function logout(page){await page.locator('#account-open').click();await page.getByRole('button',{name:'编辑资料',exact:true}).click();await page.getByRole('button',{name:'账户与安全设置',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).click();await visible(page.getByLabel('邮箱',{exact:true}));assert.equal(await page.locator('#community-view').textContent(),'');assert.equal(await page.locator('#admin-view').textContent(),'');assert.equal(await page.locator('#admin-nav').isVisible(),false);await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();await visible(page.locator('#chat-view'));assert.equal(await page.locator('#conversation .message').count(),1);assert.ok((await page.locator('#conversation').textContent()).includes('今天想聊点什么？'));}
async function prepare(browser,role,{mfa=false,email=false,totp=true}={}){const context=await browser.newContext({viewport:{width:1280,height:960},colorScheme:'dark'});const errors=[];const calls=[];const profile={id:ids[role],nickname:role==='owner'?'测试站长':'测试成员',role,status:'active',admission_status:'approved'};let enabled=true;let saved=null;let mfaVerified=false;let emailVerified=false;let emailSent=false;let challenges=0;
 const factorId='77777777-7777-4777-8777-777777777777',challengeId='88888888-8888-4888-8888-888888888888';
 const user={id:profile.id,email:`${role}@example.test`,aud:'authenticated',role:'authenticated',email_confirmed_at:fixed,created_at:fixed,updated_at:fixed,app_metadata:{provider:'email',providers:['email']},user_metadata:{nickname:profile.nickname},identities:[],factors:mfa&&totp?[{id:factorId,friendly_name:'QA 验证器',factor_type:'totp',status:'verified',created_at:fixed,updated_at:fixed}]:[]};
 const authTokens=()=>({access_token:token(role,mfa?(mfaVerified?'aal2':'aal1'):undefined),refresh_token:'qa-refresh-token',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user});
 const posts=[{id:ids.post,author_id:ids.other,nickname:'另一位成员',title:'今天的一点进展',body:'今天出门走了一小段。\n<img src=x onerror="window.qhInjected=true">',category:'progress',preference:'listen',status:'published',comments_open:true,created_at:fixed}];
 const comments=[{id:ids.comment,post_id:ids.post,author_id:ids.other,nickname:'另一位成员',body:'慢一点也可以。',status:'published',created_at:fixed}];
 const managedUser={id:ids.other,nickname:'另一位成员',role:'member',status:'active',created_at:fixed,status_started_at:null,status_until:null};
 const cors={'access-control-allow-origin':base,'access-control-allow-headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-expose-headers':'x-supabase-api-version','x-supabase-api-version':'2024-01-01'};
 async function json(route,body,status=200){await route.fulfill({status,contentType:'application/json',headers:cors,body:JSON.stringify(body)});}
 await context.route('**/site-config.json',route=>json(route,{supabaseUrl:host,supabaseAnonKey:'sb_publishable_browser_qa_fixture',inviteOnly:false}));
 await context.route(`${host}/**`,async route=>{const request=route.request(),url=new URL(request.url());if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:cors});return;}
  if(url.pathname==='/auth/v1/token'){await json(route,authTokens());return;}
  if(url.pathname==='/auth/v1/user'){await json(route,user);return;}
  if(mfa&&url.pathname===`/auth/v1/factors/${factorId}/challenge`){challenges++;await json(route,{id:challengeId,type:'totp',expires_at:Math.floor(Date.now()/1000)+300});return;}
  if(mfa&&url.pathname===`/auth/v1/factors/${factorId}/verify`){const p=request.postDataJSON();assert.equal(p.challenge_id,challengeId);if(p.code!=='123456'){await json(route,{code:'mfa_verification_failed',msg:'Invalid TOTP code'},422);return;}mfaVerified=true;await json(route,authTokens());return;}
  if(url.pathname==='/auth/v1/logout'){await json(route,{});return;}
  if(url.pathname!=='/functions/v1/api'){await json(route,{error:'Unmocked auth request'},400);return;}
  const p=request.postDataJSON();calls.push(p);const action=p.action;let result;
  if(action==='security.mfa.status'){await json(route,{email_available:email,email_enabled:emailVerified,email_verified:emailVerified,verified:mfaVerified||emailVerified,totp_enabled:mfa&&totp});return;}
  if(action==='security.email.send'){emailSent=true;await json(route,{challenge_id:challengeId,expires_at:new Date(Date.now()+300000).toISOString(),retry_after:60});return;}
  if(action==='security.email.verify'){assert.equal(p.challenge_id,challengeId);if(!emailSent||p.code!=='654321'){await json(route,{code:'email_code_invalid'},400);return;}emailVerified=true;await json(route,{ok:true});return;}
  if(action==='security.password.update'){assert.ok(emailVerified);assert.ok(p.password.length>=8);await json(route,{ok:true,sign_out:true});return;}
  if(mfa&&!mfaVerified&&!emailVerified){await json(route,{error:'请先完成两步验证，再继续使用账户。',code:'mfa_required',totp_enabled:totp},403);return;}
  if(action==='personal.overview')result={counts:{posts:0,comments:0,bookmarks:0,appeals:0,unread:0}};
  else if(action==='notifications.list')result={notifications:[],unread:0,hasMore:false};
  else if(action==='me')result={profile,ai:{ready:enabled,model:config.model},usage:{used:2,limit:30},security:{emailVerified,nativeVerified:role==='owner'&&!mfa||mfaVerified}};
  else if(action==='posts.list'){let found=posts;if(p.mine)found=found.filter(x=>x.author_id===profile.id);else found=found.filter(x=>x.status==='published');if(p.category)found=found.filter(x=>x.category===p.category);result={posts:found,hasMore:false};}
  else if(action==='posts.get'){const post=posts.find(x=>x.id===p.id);result={post,comments:comments.filter(x=>x.post_id===p.id),bookmarked:false};}
  else if(action==='posts.save'){assert.ok(p.title);assert.ok(p.body);const value={id:p.id||ids.draft,author_id:profile.id,nickname:profile.nickname,title:p.title,body:p.body,category:p.category,preference:p.preference,status:p.submit?'pending':'draft',comments_open:true,created_at:fixed};const index=posts.findIndex(x=>x.id===value.id);if(index>=0)posts[index]=value;else posts.push(value);result={ok:true,id:value.id};}
  else if(action==='comments.save'){comments.push({id:ids.draft,post_id:p.post_id,author_id:profile.id,nickname:profile.nickname,body:p.body,status:'pending',created_at:fixed});result={ok:true,id:ids.draft};}
  else if(action==='reports.create'){assert.ok(Boolean(p.post_id)!==Boolean(p.comment_id),'Report must target exactly one content item');result={ok:true,id:ids.draft};}
  else if(action==='chat'){assert.ok(p.messages.some(m=>m.role==='user'&&m.content==='我今天有点累。'));result={text:'今天可以先从一件小事开始。',route:'support',mode:'ai'};}
  else if(action==='admin.queue')result={posts:[{...posts[0],id:ids.draft,title:'待审核的测试帖子',status:'pending'}],comments:[],reports:[],appeals:[]};
  else if(action==='admin.moderate'){assert.equal(p.kind,'post');assert.equal(p.id,ids.draft);assert.equal(p.decision,'approve');assert.equal(p.reason,'内容符合社区约定。');result={ok:true};}
  else if(action==='admin.ai.get')result={config,enabled,user_daily_limit:30,global_daily_limit:300,key_set:true,key_last4:'1234'};
  else if(action==='admin.ai.test')result={ok:true,message:'连接测试通过。'};
  else if(action==='admin.ai.save'){assert.equal(p.key,'sk-browser-fixture-only');assert.equal(p.config.model,'deepseek-chat');assert.equal(p.user_daily_limit,25);assert.equal(p.global_daily_limit,250);saved=p;enabled=p.enabled;result={ok:true};}
  else if(action==='admin.usage')result={today:'2026-10-01',total:2,user_daily_limit:30,global_daily_limit:300,users:[{user_id:profile.id,nickname:profile.nickname,used:2}]};
  else if(action==='admin.audit')result={events:[]};
  else if(action==='admin.users')result={users:[profile,managedUser]};
  else if(action==='admin.user'){
   assert.equal(p.id,managedUser.id);assert.ok(p.reason);
   if(p.status==='active'){managedUser.status_until=null;managedUser.status_started_at=null;}
   else if(Object.hasOwn(p,'duration_seconds')||Object.hasOwn(p,'status_until')){
    managedUser.status_until=Object.hasOwn(p,'duration_seconds')?new Date(Date.now()+p.duration_seconds*1000).toISOString():p.status_until;
    managedUser.status_started_at=new Date().toISOString();
   }
   managedUser.status=p.status;managedUser.role=p.role||managedUser.role;result={ok:true,profile:managedUser};
  }
  else if(action==='blocks.list')result={users:[]};
  else {await json(route,{error:`Unmocked action ${action}`},400);return;}
  await json(route,result);
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.locator('#account-open').click();await page.getByLabel('邮箱',{exact:true}).fill(`${role}@example.test`);await page.getByLabel('密码',{exact:true}).fill('qa-password-fixture-only');await page.locator('#auth-dialog form button[type=submit]').click();if(mfa){await visible(page.getByRole('heading',{name:'完成二次验证',exact:true}));}else{await visible(page.getByText(`${profile.nickname} · ${role==='owner'?'站长':'普通成员'}`,{exact:true}));await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();}return {context,page,errors,calls,getSaved:()=>saved,getChallenges:()=>challenges};
}
async function checkRestrictions(browser){
 const owner=await prepare(browser,'owner'),page=owner.page;
 await page.locator('#admin-nav').click();await page.getByRole('button',{name:'用户管理',exact:true}).click();
 await visible(page.getByText('禁言限制发帖和回应；封禁限制账户使用。限时限制到期自动恢复，永久限制需手动解除。调整需要完成二次验证，角色与封禁仅站长可操作。',{exact:true}));
 const card=page.locator('.qh-post-card').filter({has:page.getByRole('heading',{name:'另一位成员',exact:true})});
 assert.equal(await card.getByRole('combobox',{name:'禁言时长',exact:true}).isVisible(),false);
 await card.getByRole('combobox',{name:'账户状态',exact:true}).selectOption('banned');
 await visible(card.getByRole('combobox',{name:'封禁时长',exact:true}));assert.equal(await card.getByRole('combobox',{name:'封禁时长',exact:true}).inputValue(),'86400');
 await card.getByRole('combobox',{name:'封禁时长',exact:true}).selectOption('604800');await card.getByLabel('操作原因',{exact:true}).fill('本地验收：限时封禁。');
 await card.getByRole('button',{name:'保存调整',exact:true}).click();await visible(card.getByText('账户调整已保存，将于',{exact:false}));
 let submitted=owner.calls.filter(x=>x.action==='admin.user').at(-1);assert.equal(submitted.duration_seconds,604800);assert.equal(submitted.status,'banned');assert.ok(!Object.hasOwn(submitted,'status_until'));
 const original=await card.locator('.qh-meta').last().textContent();
 await page.getByRole('button',{name:'AI 设置',exact:true}).click();await page.getByRole('button',{name:'用户管理',exact:true}).click();
 await visible(card.getByText('封禁时间：',{exact:false}));assert.equal(await card.getByRole('combobox',{name:'封禁时长',exact:true}).inputValue(),'keep');assert.equal(await card.locator('.qh-meta').last().textContent(),original);
 await card.getByRole('combobox',{name:'角色',exact:true}).selectOption('moderator');await card.getByLabel('操作原因',{exact:true}).fill('本地验收：保持期限调整角色。');await card.getByRole('button',{name:'保存调整',exact:true}).click();await visible(card.getByText('账户调整已保存，将于',{exact:false}));
 submitted=owner.calls.filter(x=>x.action==='admin.user').at(-1);assert.equal(submitted.role,'moderator');assert.ok(!Object.hasOwn(submitted,'duration_seconds'));assert.ok(!Object.hasOwn(submitted,'status_until'));assert.equal(await card.locator('.qh-meta').last().textContent(),original);
 await card.getByRole('combobox',{name:'封禁时长',exact:true}).selectOption('custom');
 const custom=await page.evaluate(()=>{const d=new Date(Date.now()+3*86400000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);});
 await card.getByRole('textbox',{name:'到期时间',exact:false}).fill(custom);
 assert.equal(await card.getByText('账户调整已保存，将于',{exact:false}).count(),0,'editing clears obsolete success deadlines');
 await card.getByRole('heading',{name:'另一位成员',exact:true}).click();
 await noOverflow(page,'restriction desktop');await card.screenshot({path:path.join(output,'timed-restrictions-desktop.png')});
 await page.setViewportSize({width:390,height:844});await noOverflow(page,'restriction mobile');
 await page.setViewportSize({width:390,height:1400});await card.screenshot({path:path.join(output,'timed-restrictions-mobile.png')});await page.setViewportSize({width:390,height:844});
 await card.getByRole('button',{name:'保存调整',exact:true}).click();await visible(card.getByText('账户调整已保存，将于',{exact:false}));
 submitted=owner.calls.filter(x=>x.action==='admin.user').at(-1);assert.equal(submitted.status_until,await page.evaluate(value=>new Date(value).toISOString(),custom));
 await card.getByRole('combobox',{name:'封禁时长',exact:true}).selectOption('custom');await card.getByRole('textbox',{name:'到期时间',exact:false}).fill('2020-01-01T00:00');
 const count=owner.calls.filter(x=>x.action==='admin.user').length;await card.getByRole('button',{name:'保存调整',exact:true}).click();assert.equal(owner.calls.filter(x=>x.action==='admin.user').length,count,'past deadlines never submit');
 await card.getByRole('combobox',{name:'封禁时长',exact:true}).selectOption('permanent');assert.equal(await card.getByRole('textbox',{name:'到期时间',exact:false}).isVisible(),false);
 await card.getByRole('button',{name:'保存调整',exact:true}).click();await visible(card.getByText('账户调整已保存，永久限制需手动解除。',{exact:true}));assert.equal(owner.calls.filter(x=>x.action==='admin.user').at(-1).status_until,null);
 await card.getByRole('combobox',{name:'账户状态',exact:true}).selectOption('muted');assert.equal(await card.getByRole('combobox',{name:'禁言时长',exact:true}).inputValue(),'86400');await card.getByRole('combobox',{name:'禁言时长',exact:true}).selectOption('3600');
 await card.getByRole('button',{name:'保存调整',exact:true}).click();await visible(card.getByText('账户调整已保存，将于',{exact:false}));assert.equal(owner.calls.filter(x=>x.action==='admin.user').at(-1).duration_seconds,3600);
 await card.getByRole('combobox',{name:'账户状态',exact:true}).selectOption('active');assert.equal(await card.getByRole('combobox',{name:'禁言时长',exact:true}).isVisible(),false);
 await card.getByRole('button',{name:'保存调整',exact:true}).click();await visible(card.getByText('账户调整已保存。',{exact:true}));assert.ok(!Object.hasOwn(owner.calls.filter(x=>x.action==='admin.user').at(-1),'duration_seconds'));
 assert.deepEqual(owner.errors,[]);await owner.context.close();console.log('Timed restrictions: presets, custom local time, permanent, retained deadline, unmute and desktop/mobile layout verified');
}
async function main(){await fs.mkdir(output,{recursive:true});const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});try{
 await checkRestrictions(browser);
 const unconfigured=await browser.newContext({viewport:{width:390,height:844}});await unconfigured.route('**/site-config.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({supabaseUrl:'',supabaseAnonKey:'',inviteOnly:true})}));const page=await unconfigured.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('#account-open').click();await visible(page.getByText('登录和社区尚未上线。站长配置后端后，你就可以在这里登录。',{exact:true}));await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();await page.locator('#community-nav').click();await visible(page.getByRole('heading',{name:'登录后，加入这里',exact:true}));await noOverflow(page,'unconfigured mobile');assert.deepEqual(errors,[]);await unconfigured.close();
 const member=await prepare(browser,'member');await member.page.locator('#message').fill('我今天有点累。');await member.page.locator('#send').click();await visible(member.page.getByText('今天可以先从一件小事开始。',{exact:true}));assert.ok(member.calls.some(x=>x.action==='chat'));await member.page.locator('#community-nav').click();await visible(member.page.getByRole('button',{name:'今天的一点进展',exact:true}));await member.page.getByRole('button',{name:'今天的一点进展',exact:true}).click();const detail=member.page.getByRole('dialog',{name:'帖子与回应',exact:true});await visible(detail.getByText('<img src=x onerror="window.qhInjected=true">',{exact:false}));assert.equal(await detail.locator('.qh-post-body img').count(),0);await member.page.screenshot({path:path.join(output,'post-dialog-dark-desktop.png'),fullPage:true});assert.equal(await member.page.evaluate(()=>window.qhInjected),undefined);await detail.getByRole('button',{name:'举报回应',exact:true}).click();const report=member.page.getByRole('dialog',{name:'举报这条回应',exact:true});await report.getByLabel('说明',{exact:true}).fill('浏览器集成检查：请复核。');await report.getByRole('button',{name:'确认提交',exact:true}).click();await visible(report.getByText('举报已提交。',{exact:true}));await report.getByRole('button',{name:'关闭',exact:true}).click();await detail.getByRole('button',{name:'关闭',exact:true}).click();
 await member.page.getByRole('button',{name:'写一篇帖子',exact:true}).click();const compose=member.page.getByRole('dialog',{name:'写一篇帖子',exact:true});await compose.getByLabel('标题',{exact:true}).fill('我今天愿意说一点');await compose.getByLabel('想说的话',{exact:false}).fill('这是一段仅用于本地测试的文字。<script>window.qhInjected=true</script>');await compose.getByRole('button',{name:'提交并审核',exact:true}).click();await visible(member.page.getByRole('button',{name:'我今天愿意说一点',exact:true}));await visible(member.page.getByText('待审核',{exact:true}));await noOverflow(member.page,'member desktop');await member.page.screenshot({path:path.join(output,'community-desktop.png'),fullPage:true});await member.page.setViewportSize({width:390,height:844});await noOverflow(member.page,'member mobile');await member.page.getByRole('button',{name:'我今天愿意说一点',exact:true}).click();await noOverflow(member.page,'post dialog mobile');await member.page.screenshot({path:path.join(output,'community-mobile.png'),fullPage:true});assert.deepEqual(member.errors,[]);assert.ok(member.calls.some(x=>x.action==='posts.save'&&x.submit));await member.page.getByRole('dialog',{name:'帖子与回应',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();await logout(member.page);await member.context.close();
 const owner=await prepare(browser,'owner');await owner.page.locator('#admin-nav').click();await visible(owner.page.getByRole('heading',{name:'管理后台',exact:true}));const review=owner.page.locator('.qh-post-card').filter({has:owner.page.getByRole('heading',{name:'待审核的测试帖子',exact:true})});await review.getByLabel('处理说明',{exact:false}).fill('内容符合社区约定。');await review.getByRole('button',{name:'通过并发布',exact:true}).click();await visible(owner.page.getByText('处理已完成。',{exact:true}));assert.ok(owner.calls.some(x=>x.action==='admin.moderate'));await owner.page.getByRole('button',{name:'AI 设置',exact:true}).click();await visible(owner.page.getByLabel('API Key',{exact:false}));assert.equal(await owner.page.getByLabel('API Key',{exact:false}).inputValue(),'');await owner.page.getByLabel('API Key',{exact:false}).fill('sk-browser-fixture-only');await owner.page.getByLabel('每位用户每日模型调用上限',{exact:true}).fill('25');await owner.page.getByLabel('全站每日模型调用上限',{exact:true}).fill('250');await owner.page.getByRole('button',{name:'测试聊天连接',exact:true}).click();await visible(owner.page.getByText('连接测试通过。',{exact:true}));await owner.page.getByRole('button',{name:'保存配置',exact:true}).click();await visible(owner.page.getByText('AI 配置已保存。',{exact:true}));assert.equal(await owner.page.getByLabel('API Key',{exact:false}).inputValue(),'');assert.ok(owner.getSaved());await owner.page.setViewportSize({width:390,height:844});await noOverflow(owner.page,'owner settings mobile');assert.deepEqual(owner.errors,[]);await logout(owner.page);await owner.context.close();
 const mfa=await prepare(browser,'member',{mfa:true});await visible(mfa.page.getByText('完成验证后才能读取账户资料、社区内容或使用 AI。',{exact:true}));assert.equal(await mfa.page.getByText('测试成员 · 普通成员',{exact:true}).count(),0);assert.equal(await mfa.page.locator('#community-view').textContent(),'');assert.equal(await mfa.page.locator('#mode-badge').textContent(),'待二次验证');await mfa.page.getByRole('button',{name:'关闭账户设置',exact:true}).click();await mfa.page.locator('#message').fill('等待验证时保留的草稿。');await mfa.page.locator('#send').click();await visible(mfa.page.getByRole('heading',{name:'完成二次验证',exact:true}));assert.equal(await mfa.page.locator('#message').inputValue(),'等待验证时保留的草稿。');assert.ok(!mfa.calls.some(x=>x.action==='chat'));await mfa.page.getByRole('button',{name:'继续二次验证',exact:true}).click();await visible(mfa.page.getByLabel('6 位验证码',{exact:true}));assert.equal(await mfa.page.getByLabel('6 位验证码',{exact:true}).isEnabled(),true);await mfa.page.getByLabel('6 位验证码',{exact:true}).fill('000000');await mfa.page.getByRole('button',{name:'验证',exact:true}).click();await visible(mfa.page.getByText('验证码不正确或已过期，请使用验证器里的新验证码。',{exact:true}));assert.equal(await mfa.page.getByLabel('6 位验证码',{exact:true}).isEnabled(),true);await mfa.page.getByLabel('6 位验证码',{exact:true}).fill('123456');await mfa.page.getByRole('button',{name:'验证',exact:true}).click();await visible(mfa.page.getByText('测试成员 · 普通成员',{exact:true}));assert.equal(await mfa.page.getByLabel('社区昵称',{exact:true}).isEnabled(),true);assert.equal(await mfa.page.getByRole('button',{name:'继续二次验证',exact:true}).count(),0);assert.equal(mfa.getChallenges(),2);assert.ok(mfa.calls.filter(x=>x.action==='me').length<10,'MFA must not recursively retry the profile request');assert.deepEqual(mfa.errors,[]);await mfa.page.getByRole('button',{name:'关闭账户设置',exact:true}).click();await mfa.page.locator('#community-nav').click();await visible(mfa.page.getByRole('button',{name:'今天的一点进展',exact:true}));await logout(mfa.page);await mfa.context.close();
 const email=await prepare(browser,'owner',{mfa:true,email:true});
 await email.page.getByRole('button',{name:'继续二次验证',exact:true}).click();
 await visible(email.page.getByLabel('邮箱收到的 6 位验证码',{exact:true}));
 await email.page.getByRole('button',{name:'验证器',exact:true}).click();
 await visible(email.page.getByLabel('6 位验证码',{exact:true}));
 await email.page.getByLabel('6 位验证码',{exact:true}).fill('123');
 await email.page.getByRole('button',{name:'邮箱验证码',exact:true}).click();
 assert.equal(await email.page.getByLabel('6 位验证码',{exact:true}).count(),0);
 await email.page.getByRole('button',{name:'发送邮箱验证码',exact:true}).click();
 await visible(email.page.getByText('验证码已发送，5 分钟内有效；如未收到，请检查垃圾邮件。重新发送需间隔 60 秒。',{exact:true}));
 await email.page.getByRole('button',{name:'验证器',exact:true}).click();
 await email.page.getByRole('button',{name:'邮箱验证码',exact:true}).click();
 await email.page.getByLabel('邮箱收到的 6 位验证码',{exact:true}).fill('000000');
 await email.page.getByRole('button',{name:'验证邮箱验证码',exact:true}).click();
 await visible(email.page.getByText('验证码不正确、已过期或尝试次数已用完，请重新获取。',{exact:true}));
 assert.equal(await email.page.getByLabel('邮箱收到的 6 位验证码',{exact:true}).inputValue(),'');
 await email.page.getByLabel('邮箱收到的 6 位验证码',{exact:true}).fill('654321');
 await email.page.setViewportSize({width:390,height:844});await noOverflow(email.page,'email MFA mobile');
 await email.page.screenshot({path:path.join(output,'email-mfa-mobile.png'),fullPage:true});
 await email.page.getByRole('button',{name:'验证邮箱验证码',exact:true}).click();
 await visible(email.page.getByText('测试站长 · 站长',{exact:true}));
 assert.equal(email.getChallenges(),0,'email alternative does not require any TOTP challenge');
 await email.page.getByRole('button',{name:'关闭账户设置',exact:true}).click();
 await email.page.locator('#admin-nav').click();await visible(email.page.getByRole('heading',{name:'管理后台',exact:true}));
 assert.ok(email.calls.some(x=>x.action==='admin.queue'));assert.deepEqual(email.errors,[]);
 await email.page.locator('#account-open').click();
 await email.page.getByRole('button',{name:'编辑资料',exact:true}).click();
 await email.page.getByRole('button',{name:'账户与安全设置',exact:true}).click();
 await email.page.getByRole('button',{name:'修改密码',exact:true}).click();
 await email.page.getByLabel('新密码',{exact:true}).fill('new-password-fixture-123');
 await email.page.getByLabel('确认新密码',{exact:true}).fill('new-password-fixture-123');
 await email.page.getByRole('button',{name:'保存密码',exact:true}).click();
 await visible(email.page.getByText('密码已更新，请使用新密码重新登录。',{exact:true}));
 assert.ok(email.calls.some(x=>x.action==='security.password.update'));await visible(email.page.getByLabel('邮箱',{exact:true}));
 await email.context.close();
 const recoverEmail=await prepare(browser,'member',{mfa:true,email:true,totp:false});
 await recoverEmail.page.goto(base+'/?account=recovery#access_token='+token('member','aal1','otp')+'&refresh_token=qa-refresh-token&type=recovery');
 await recoverEmail.page.getByRole('button',{name:'确认使用邮件链接',exact:true}).click();
 await visible(recoverEmail.page.getByRole('heading',{name:'设置新密码',exact:true}));
 assert.equal(await recoverEmail.page.getByText('测试成员 · 普通成员',{exact:true}).count(),0);
 await recoverEmail.page.getByLabel('新密码',{exact:true}).fill('recovered-password-fixture-123');
 await recoverEmail.page.getByLabel('确认新密码',{exact:true}).fill('recovered-password-fixture-123');
 await recoverEmail.page.getByRole('button',{name:'保存密码',exact:true}).click();
 await visible(recoverEmail.page.getByText('密码已更新，请使用新密码重新登录。',{exact:true}));
 assert.deepEqual(recoverEmail.errors,[]);await recoverEmail.context.close();
 console.log(JSON.stringify({ok:true,checks:['unconfigured login/community state','member password login and backend chat','plain-text XSS content','comment report target','create post -> pending','logout clears chat/community/admin and hides admin navigation','owner review approval','owner masked AI settings/test/save','enrolled TOTP login blocks app data until challenge; incorrect code remains retryable; verified login restores profile/community','switch between email and TOTP; incorrect email code retries; email alone unlocks management','desktop and mobile overflow','no uncaught page errors'],screenshots:[path.join(output,'community-desktop.png'),path.join(output,'community-mobile.png'),path.join(output,'email-mfa-mobile.png')]},null,2));
 }finally{await browser.close();}}
main().catch(error=>{console.error(error);process.exitCode=1;});
