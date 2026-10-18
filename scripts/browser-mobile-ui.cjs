// Mobile UI acceptance checks. All backend responses below are local fixtures.
// Run: npm run build (with fixture env) && node scripts/preview.mjs, then
//      node scripts/browser-mobile-ui.cjs [base URL]
// No Supabase project, paid AI key or real network service is used.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=process.argv[2]||'http://127.0.0.1:4177';
const output=path.resolve('test-results/mobile-ui-2026-10-17');
const host='https://quiet-harbor-qa.supabase.co';
const ids={member:'11111111-1111-4111-8111-111111111111',owner:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333',post:'44444444-4444-4444-8444-444444444444',comment:'55555555-5555-4555-8555-555555555555',draft:'66666666-6666-4666-8666-666666666666',notification:'77777777-7777-4777-8777-777777777777'};
const fixed='2026-10-01T02:00:00.000Z';
const config={provider:'deepseek',name:'DeepSeek',base:'https://api.deepseek.com',protocol:'openai',model:'deepseek-chat',tokenField:'max_tokens',jsonMode:true};
const results=[],shots=[];
function record(name,details={}){results.push({name,ok:true,details});}
async function shot(page,name,fullPage=false){const file=path.join(output,name);await page.screenshot({path:file,fullPage});shots.push(path.basename(file));}
function token(role,aal=role==='owner'?'aal2':'aal1',method='password'){const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');return `${b({alg:'HS256',typ:'JWT'})}.${b({sub:ids[role],role:'authenticated',aud:'authenticated',aal,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),amr:[{method,timestamp:Math.floor(Date.now()/1000)}]})}.qa-fixture-signature`;}
async function visible(locator){await locator.waitFor({state:'visible'});}
async function openMore(page){const trigger=page.locator('#more-open');if(await trigger.isVisible())await trigger.click();}
async function openAccount(page){await openMore(page);await page.locator('#account-open').click();}
async function noOverflow(page,label){const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector('main')?.scrollWidth,mainClient:document.querySelector('main')?.clientWidth}));assert.ok(size.scroll<=size.width+1,`${label}: document horizontal overflow ${JSON.stringify(size)}`);if(size.main!=null)assert.ok(size.main<=size.mainClient+1,`${label}: main horizontal overflow ${JSON.stringify(size)}`);}
async function minTargets(page,selector,label,min=44){const values=await page.locator(selector).evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {height:Math.round(r.height),width:Math.round(r.width),text:(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,16)};}));assert.ok(values.length>0,`${label}: no visible target for ${selector}`);for(const value of values)assert.ok(value.height>=min-0.5,`${label}: ${selector} target ${value.height}px < ${min}px (${value.text})`);return values;}
async function minFonts(page,selector,label,min=16){const values=await page.locator(selector).evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>parseFloat(getComputedStyle(el).fontSize)));assert.ok(values.length>0,`${label}: no visible element for ${selector}`);for(const value of values)assert.ok(value>=min-0.5,`${label}: ${selector} font ${value}px < ${min}px`);return values;}
async function firstScreen(page,label){
 const m=await page.evaluate(()=>{
  const rect=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
  const send=document.getElementById('send'),sr=send?send.getBoundingClientRect():null;
  const hit=sr?document.elementFromPoint(sr.left+sr.width/2,sr.top+sr.height/2):null;
  const tabbar=document.getElementById('mobile-tabbar');
  return {innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,topbar:rect('#mobile-topbar'),tabbar:rect('#mobile-tabbar'),tabbarShown:Boolean(tabbar&&getComputedStyle(tabbar).display!=='none'),send:rect('#send'),sendHit:Boolean(hit&&hit.closest('#send')),brand:rect('.mobile-brand')};
 });
 assert.ok(m.topbar,`${label}: mobile topbar missing`);
 assert.ok(Math.abs(m.topbar.height-60)<=1,`${label}: topbar height ${m.topbar.height}`);
 assert.ok(Math.abs(m.topbar.top)<=1,`${label}: topbar not fixed at top`);
 assert.ok(m.brand&&m.brand.height>=24,`${label}: brand missing`);
 assert.ok(m.send,`${label}: send button missing`);
 assert.ok(m.send.height>=44&&m.send.width>=44,`${label}: send ${m.send.width}x${m.send.height} below 44px`);
 assert.ok(m.send.top>=0&&m.send.bottom<=m.innerHeight+0.5,`${label}: send not in first screen ${JSON.stringify(m.send)} innerHeight=${m.innerHeight}`);
 assert.ok(m.sendHit,`${label}: send covered by another element`);
 assert.ok(m.tabbarShown,`${label}: bottom tabbar hidden`);
 assert.ok(m.send.bottom<=m.tabbar.top+0.5,`${label}: tabbar covers composer`);
 assert.ok(Math.abs(m.tabbar.bottom-m.innerHeight)<=1,`${label}: tabbar bottom ${m.tabbar.bottom} != ${m.innerHeight}`);
 assert.ok(m.scrollWidth<=m.innerWidth+1,`${label}: document horizontal overflow`);
 return m;
}
async function fixture(browser,{role='member',viewport={width:390,height:844},colorScheme='light',hasTouch=false,slowChat=false}={}){
 const context=await browser.newContext({viewport,colorScheme,hasTouch,isMobile:hasTouch});const errors=[],calls=[];let signedOut=false,releaseChat=null;
 const profile={id:ids[role],nickname:role==='owner'?'测试站长':'测试成员',role,status:'active',admission_status:'approved',created_at:fixed};
 const user={id:profile.id,email:`${role}@example.test`,aud:'authenticated',role:'authenticated',email_confirmed_at:fixed,created_at:fixed,updated_at:fixed,app_metadata:{provider:'email',providers:['email']},user_metadata:{nickname:profile.nickname},identities:[],factors:[]};
 const authTokens=()=>({access_token:token(role),refresh_token:'qa-refresh-token',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user});
 const posts=[{id:ids.post,author_id:ids.other,nickname:'另一位成员',title:'今天的一点进展',body:'今天出门走了一小段。\n<img src=x onerror="window.qhInjected=true">',category:'progress',preference:'listen',status:'published',comments_open:true,created_at:fixed}];
 const comments=[{id:ids.comment,post_id:ids.post,author_id:ids.other,nickname:'另一位成员',body:'慢一点也可以。',status:'published',created_at:fixed}];
 const notifications=[{id:ids.notification,title:'社区通知',body:'你收藏的帖子有了新回应。',read_at:null,created_at:fixed,post_id:ids.post}];
 const cors={'access-control-allow-origin':base,'access-control-allow-headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-expose-headers':'x-supabase-api-version','x-supabase-api-version':'2024-01-01'};
 const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',headers:cors,body:JSON.stringify(body)});
 await context.route('**/site-config.json',route=>json(route,{supabaseUrl:host,supabaseAnonKey:'sb_publishable_browser_qa_fixture',inviteOnly:false}));
 await context.route(`${host}/**`,async route=>{const request=route.request(),url=new URL(request.url());if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:cors});return;}
  if(url.pathname==='/auth/v1/token'){await json(route,authTokens());return;}
  if(url.pathname==='/auth/v1/user'){await json(route,user);return;}
  if(url.pathname==='/auth/v1/logout'){signedOut=true;await json(route,{});return;}
  if(url.pathname!=='/functions/v1/api'){await json(route,{error:'Unmocked auth request'},400);return;}
  const requestBody=request.postDataJSON();calls.push(requestBody);const action=requestBody.action;let result;
  if(action==='me')result={profile,ai:{ready:true,model:config.model},usage:{used:2,limit:30},security:{emailVerified:true,nativeVerified:true}};
  else if(action==='personal.overview')result={counts:{posts:2,comments:1,bookmarks:0,appeals:0,unread:1}};
  else if(action==='personal.comments')result={comments:[],hasMore:false};
  else if(action==='personal.bookmarks')result={bookmarks:[],hasMore:false};
  else if(action==='personal.appeals')result={appeals:[],hasMore:false};
  else if(action==='notifications.list')result={notifications,unread:1,hasMore:false};
  else if(action==='notifications.read')result={ok:true};
  else if(action==='notifications.read_all')result={ok:true};
  else if(action==='posts.list'){let found=posts.filter(item=>item.status==='published');if(requestBody.mine)found=found.filter(item=>item.author_id===profile.id);if(requestBody.bookmarked)found=[];if(requestBody.category)found=found.filter(item=>item.category===requestBody.category);result={posts:found,hasMore:false};}
  else if(action==='posts.get')result={post:posts[0],comments,bookmarked:false};
  else if(action==='comments.save')result={ok:true,status:'pending',id:ids.draft};
  else if(action==='bookmarks.toggle')result={ok:true,active:true};
  else if(action==='reports.create')result={ok:true,id:ids.draft};
  else if(action==='blocks.list')result={users:[]};
  else if(action==='chat'){if(slowChat)await new Promise(resolve=>{releaseChat=resolve;});try{await json(route,{text:'今天可以先从一件小事开始。',route:'support',mode:'ai'});}catch{/* client aborted the fixture request */}return;}
  else if(action==='admin.queue')result={posts:[{...posts[0],id:ids.draft,title:'待审核的测试帖子',status:'pending'}],comments:[],reports:[],appeals:[]};
  else if(action==='admin.users')result={users:[],hasMore:false};
  else if(action==='admin.audit')result={events:[],hasMore:false};
  else if(action==='admin.ai.get')result={config,enabled:true,user_daily_limit:30,global_daily_limit:300,key_set:true,key_last4:'1234'};
  else if(action==='admin.usage')result={today:'2026-10-01',total:2,user_daily_limit:30,global_daily_limit:300,users:[]};
  else result={ok:true};
  await json(route,result);
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
 if(viewport.width<=620)await visible(page.locator('#mobile-topbar'));
 async function signIn(){await openAccount(page);await page.getByLabel('邮箱',{exact:true}).fill(`${role}@example.test`);await page.getByLabel('密码',{exact:true}).fill('qa-password-fixture-only');await page.locator('#auth-dialog form button[type=submit]').click();await visible(page.getByText(`${profile.nickname} · ${role==='owner'?'站长':'普通成员'}`,{exact:true}).first());await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();await visible(page.locator('#chat-view'));}
 return {context,page,errors,calls,signIn,releaseChat:()=>releaseChat?.(),get signedOut(){return signedOut;}};
}
async function checkSizes(browser){
 for(const [width,height] of [[320,568],[375,667],[390,844],[430,932]])for(const colorScheme of ['light','dark']){
  const f=await fixture(browser,{viewport:{width,height},colorScheme});
  try{
   await visible(f.page.locator('.suggestions'));
   assert.equal(await f.page.evaluate(()=>document.documentElement.dataset.theme),colorScheme,`${width}x${height}: ${colorScheme} token set`);
   await firstScreen(f.page,`${width}x${height} ${colorScheme}`);
   const suggestion=await f.page.evaluate(()=>{const el=document.querySelector('.suggestions');return {scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,overflowX:getComputedStyle(el).overflowX};});
   assert.ok(suggestion.overflowX==='auto'||suggestion.overflowX==='scroll',`${width}x${height}: suggestions are not horizontally scrollable`);
   assert.ok(suggestion.scrollWidth>suggestion.clientWidth,`${width}x${height}: suggestions unexpectedly fit, touch targets were squeezed`);
   await minTargets(f.page,'#mobile-tabbar .nav-item, #mobile-tabbar .practice-tab',`${width}x${height} tabs`);
   await minTargets(f.page,'#mobile-topbar button',`${width}x${height} topbar`);
   await minFonts(f.page,'#message',`${width}x${height} composer`);
   const bubble=await f.page.locator('.bubble p').first().evaluate(el=>{const style=getComputedStyle(el);return {font:parseFloat(style.fontSize),line:parseFloat(style.lineHeight)};});
   assert.ok(bubble.font>=16,`${width}x${height}: bubble font ${bubble.font}`);
   assert.ok(bubble.line>=bubble.font*1.7,`${width}x${height}: bubble line-height ${bubble.line}`);
   await noOverflow(f.page,`${width}x${height} chat`);
   const file=`size-${width}x${height}${colorScheme==='dark'?'-dark':''}.png`;
   await shot(f.page,file);
   assert.deepEqual(f.errors,[]);
   record(`尺寸 ${width}x${height} ${colorScheme==='dark'?'深色':'浅色'}：发送首屏可见、无横溢、底栏不遮挡、触控/字号`,{suggestion,files:[file]});
  }finally{await f.context.close();}
 }
}
async function checkLightFlow(browser){
 const f=await fixture(browser,{viewport:{width:390,height:844}});
 const page=f.page;
 try{
  await f.signIn();
  await visible(page.locator('#conversation .message'));
  await firstScreen(page,'390x844 登录后');
  const helpSnapshot=await page.locator('.mobile-topbar').ariaSnapshot();
  assert.ok(helpSnapshot.includes('需要现实中的支持'),`mobile help button needs its full accessible name, aria snapshot was:\n${helpSnapshot}`);
  assert.equal(await page.locator('.mobile-topbar [data-help]').getAttribute('aria-label'),'需要现实中的支持');
  assert.equal(await page.getByRole('button',{name:'需要现实中的支持',exact:true}).isVisible(),true);
  await shot(page,'after-chat-light.png');
  record('390×844 浅色：登录后聊天首屏发送可见、现实支持按钮可访问名完整',{helpLabel:await page.locator('.mobile-topbar [data-help]').getAttribute('aria-label'),ariaSnapshot:helpSnapshot});
  // More sheet: real controls, permissions, Escape and focus return.
  await page.locator('#more-open').click();await visible(page.locator('#more-dialog'));
  const entries=await page.locator('#more-dialog button, #more-dialog a').evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>(el.getAttribute('aria-label')||el.textContent||'').trim()).filter(Boolean));
  assert.ok(entries.some(text=>text.includes('测试成员')),'more sheet must expose the real account button');
  assert.ok(entries.some(text=>text.includes('通知')),'more sheet must expose notifications');
  assert.ok(entries.some(text=>text.includes('账户与隐私')),'more sheet must expose privacy settings');
  assert.ok(entries.some(text=>text.includes('陪伴边界')),'more sheet must expose the boundary entry');
  assert.equal(await page.locator('#admin-nav').isVisible(),false,'member must not see admin entry');
  await minTargets(page,'#more-dialog button','more sheet');
  await shot(page,'after-more.png');
  await page.keyboard.press('Escape');await page.locator('#more-dialog').waitFor({state:'hidden'});
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'more-open','Escape must return focus to more trigger');
  await page.locator('#more-open').click();await visible(page.locator('#more-dialog'));
  await page.locator('#more-close').click();await page.locator('#more-dialog').waitFor({state:'hidden'});
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'more-open','close button must return focus to more trigger');
  record('更多面板：账户/通知/隐私/边界/权限管理员入口、44px、Escape 焦点返回',{entries});
  // Every more entry opens the real dialog and closes the sheet.
  await page.locator('#more-open').click();await page.locator('#settings-open').click();
  await visible(page.locator('#settings-dialog'));assert.equal(await page.locator('#more-dialog').isVisible(),false,'opening settings must close more');
  await page.waitForTimeout(400);
  const settingsFocus=await page.evaluate(()=>({inside:Boolean(document.activeElement.closest('#settings-dialog')),tag:document.activeElement.tagName,id:document.activeElement.id,label:document.activeElement.getAttribute?.('aria-label')||''}));
  assert.ok(settingsFocus.inside,'focus must stay inside the settings dialog, not jump back to the more trigger');
  await page.locator('#settings-dialog .close').click();
  await page.locator('#more-open').click();await page.locator('#about-open').click();
  await visible(page.locator('#about-dialog'));assert.equal(await page.locator('#more-dialog').isVisible(),false,'opening boundary must close more');
  await page.locator('#about-dialog .close').click();
  await page.locator('#more-open').click();await page.locator('#notifications-open').click();
  await visible(page.locator('#personal-view'));
  await page.waitForTimeout(400);
  const afterMoreNavigation=await page.evaluate(()=>({activeId:document.activeElement.id,insideMore:Boolean(document.activeElement.closest('#more-dialog'))}));
  assert.equal(afterMoreNavigation.activeId,'personal-view','switching views must move focus to the destination view, not the more trigger');
  assert.equal(afterMoreNavigation.insideMore,false,'focus must leave the closed more sheet');
  const notificationTab=page.locator('#personal-view .qh-tabs button[aria-label^="通知"]');
  assert.equal(await notificationTab.getAttribute('aria-pressed'),'true','notifications entry must open the notifications tab');
  await page.locator('#chat-nav').click();await visible(page.locator('#chat-view'));
  record('更多面板所有入口：设置/边界/通知均打开原功能并关闭面板且不抢焦点',{settingsFocus,notificationsFocus:afterMoreNavigation.activeId});
  // Mood sheet uses the real check-in node and allows returning to chat.
  await page.locator('#choose-mood').click();await visible(page.locator('#mood-dialog'));
  assert.equal(await page.locator('#mood-dialog [data-mood]').count(),6,'mood sheet must contain all six feelings');
  await minTargets(page,'#mood-dialog [data-mood]','mood buttons');
  await page.locator('#mood-dialog [data-mood="低落"]').click();await visible(page.locator('#mood-support'));
  assert.equal(await page.locator('#mood-dialog .support-actions button').count(),3,'mood sheet must contain three follow-up actions');
  await minTargets(page,'#mood-dialog .support-actions button','mood actions');
  await shot(page,'after-mood.png');
  await page.locator('#mood-listen').click();
  await page.locator('#mood-dialog').waitFor({state:'hidden'});await visible(page.locator('#chat-view'));
  await page.waitForTimeout(400);
  const moodActionFocus=await page.evaluate(()=>document.activeElement.id);
  assert.equal(moodActionFocus,'message','mood action must leave focus in the composer, not bounce back to choose-mood');
  assert.ok((await page.locator('#message').inputValue()).includes('低落'),'mood action must draft text into the real composer');
  await page.locator('#message').fill('');
  // Ordinary cancel still returns focus to the trigger.
  await page.locator('#choose-mood').click();await visible(page.locator('#mood-dialog'));
  await page.getByRole('button',{name:'关闭感受面板'}).click();
  await page.locator('#mood-dialog').waitFor({state:'hidden'});await page.waitForTimeout(400);
  const moodCancelFocus=await page.evaluate(()=>document.activeElement.id);
  assert.equal(moodCancelFocus,'choose-mood','ordinary mood close must return focus to the trigger');
  record('感受面板：原 checkin 节点、六种感受、三个后续动作、回到聊天且焦点正确',{moodActionFocus,moodCancelFocus});
  // Practice tab and appearance / real support entries.
  await page.locator('#practice-nav').click();await visible(page.locator('#ground-dialog'));
  assert.equal(await page.locator('#ground-dialog [data-strategy]').count(),8,'grounding dialog must keep eight methods');
  await page.locator('#ground-dialog [data-close]').first().click();
  await page.locator('#appearance-open').click();await visible(page.locator('#appearance-dialog'));
  assert.ok((await page.locator('#appearance-open').boundingBox()).height>=44,'appearance trigger must be 44px');
  await page.locator('[data-theme-choice="dark"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await shot(page,'appearance-dark-390.png');
  await page.locator('[data-theme-choice="light"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await page.getByRole('button',{name:'关闭外观设置',exact:true}).click();
  await page.locator('[data-help]').click();await visible(page.locator('#help-dialog'));
  assert.ok((await page.locator('#help-dialog h2').textContent()).includes('不必一个人承担'),'help dialog must open from the phone topbar');
  await page.getByRole('button',{name:'我知道了',exact:true}).click();
  record('练习、外观、现实支持：手机入口复用原对话框',{});
  // Community: readable list, post reading and a real reply.
  await page.locator('#community-nav').click();await visible(page.getByRole('heading',{name:'在这里，慢慢说',exact:true}));
  await minFonts(page,'.qh-post-card h2','community post title',18);
  await minTargets(page,'.qh-post-card .qh-button','community card actions');
  await noOverflow(page,'390x844 community');
  await shot(page,'after-community.png');
  await page.getByRole('button',{name:'今天的一点进展',exact:true}).click();
  const detail=page.getByRole('dialog',{name:'帖子与回应',exact:true});await visible(detail);
  const detailBox=await detail.boundingBox();assert.ok(detailBox.width<=390,`post dialog ${detailBox.width}px wider than phone`);
  await minTargets(detail,'.qh-close','post dialog close');
  const closeBox=await detail.locator(':scope > .qh-close').boundingBox();
  assert.ok(closeBox.x>detailBox.width/2,`post dialog close must stay at the top-right corner, got x=${closeBox.x}`);
  await minFonts(detail,'.qh-post-body','post body',16);
  await minFonts(detail,'.qh-reply-form textarea','reply textarea',16);
  await shot(page,'after-post-dialog.png');
  await detail.getByLabel('留一句你愿意说的安慰',{exact:true}).fill('本地验收：慢慢来，我在听。');
  await detail.getByRole('button',{name:'提交并审核',exact:true}).click();
  await visible(detail.getByText('已保存，等待进一步审核',{exact:false}));
  assert.ok(f.calls.some(call=>call.action==='comments.save'&&call.body.includes('本地验收')),'reply must submit through the real community action');
  await detail.locator(':scope > .qh-close').click();
  record('社区：卡片可读、帖子近全屏阅读、回复提交真实生效',{});
  // Personal: 3×2 tabs, four counts, readable forms.
  await page.locator('#personal-nav').click();await visible(page.locator('#personal-view'));
  await visible(page.getByRole('heading',{name:'测试成员',exact:true}));
  const personal=await page.evaluate(()=>{const tabs=document.querySelector('#personal-view .qh-tabs');const counts=document.querySelector('#personal-view .qh-personal-counts');return {tabColumns:getComputedStyle(tabs).gridTemplateColumns.split(' ').length,tabCount:tabs.querySelectorAll('button').length,countColumns:getComputedStyle(counts).gridTemplateColumns.split(' ').length,countChildren:counts.children.length};});
  assert.equal(personal.tabCount,6,'personal must keep six tabs');
  assert.equal(personal.tabColumns,3,'personal tabs must be a 3-column grid');
  assert.equal(personal.countColumns,4,'personal counts must keep four columns');
  assert.equal(personal.countChildren,4,'personal counts data must stay');
  await minTargets(page,'#personal-view .qh-tabs button','personal tabs');
  await page.locator('#personal-view .qh-tabs button[aria-label="我的帖子"]').click();
  await visible(page.locator('#personal-view .qh-personal-content'));
  await shot(page,'after-personal.png');
  await page.locator('#personal-view .qh-tabs button[aria-label^="通知"]').click();
  await visible(page.locator('#personal-view .qh-personal-content'));
  await page.locator('#personal-view .qh-tabs button[aria-label="个人设置"]').click();
  await visible(page.locator('#personal-view form'));
  await minFonts(page,'#personal-view .qh-field input, #personal-view .qh-field select, #personal-view .qh-field textarea','personal fields');
  await minTargets(page,'#personal-view .qh-field input, #personal-view .qh-field select, #personal-view .qh-field textarea','personal fields');
  await shot(page,'after-personal-settings.png');
  await page.locator('#chat-nav').click();await visible(page.locator('#chat-view'));
  record('个人中心：3×2 栏目、四项统计、16px 表单与 44px 触控',{personal});
  // Cross-breakpoint resize keeps nodes, views and handlers.
  await page.locator('#community-nav').click();await visible(page.locator('#community-view'));
  await page.locator('#appearance-open').focus();
  await page.setViewportSize({width:800,height:900});await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'appearance-open','focus must survive the move to desktop chrome');
  assert.equal(await page.evaluate(()=>document.getElementById('admin-nav').hidden),true,'hidden permission state must survive resize');
  const desktopState=await page.evaluate(()=>({sidebar:Boolean(document.getElementById('community-nav').closest('.sidebar')),topbar:Boolean(document.getElementById('account-open').closest('.topbar-actions')),rightPanel:Boolean(document.getElementById('checkin').closest('.right-panel')),mobileTopbar:getComputedStyle(document.getElementById('mobile-topbar')).display,communityVisible:!document.getElementById('community-view').hidden,unique:['account-open','notifications-open','admin-nav','chat-nav','community-nav','personal-nav','checkin'].every(id=>document.querySelectorAll('#'+id).length===1)}));
  assert.deepEqual(desktopState,{sidebar:true,topbar:true,rightPanel:true,mobileTopbar:'none',communityVisible:true,unique:true},'desktop resize must restore real nodes');
  await page.locator('#appearance-open').click();await visible(page.locator('#appearance-dialog'));
  await page.getByRole('button',{name:'关闭外观设置',exact:true}).click();
  await page.locator('#community-nav').focus();
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'community-nav','focus must survive the move back to phone chrome');
  const phoneState=await page.evaluate(()=>({chatSlot:Boolean(document.getElementById('chat-nav').closest('#mobile-slot-chat')),communitySlot:Boolean(document.getElementById('community-nav').closest('#mobile-slot-community')),personalSlot:Boolean(document.getElementById('personal-nav').closest('#mobile-slot-personal')),more:Boolean(document.getElementById('account-open').closest('#more-account-list')),mood:Boolean(document.getElementById('checkin').closest('#mood-dialog-body')),communityVisible:!document.getElementById('community-view').hidden,unique:['account-open','notifications-open','admin-nav','chat-nav','community-nav','personal-nav','checkin'].every(id=>document.querySelectorAll('#'+id).length===1)}));
  assert.deepEqual(phoneState,{chatSlot:true,communitySlot:true,personalSlot:true,more:true,mood:true,communityVisible:true,unique:true},'phone resize must move nodes back without losing state');
  await page.locator('#chat-nav').click();await visible(page.locator('#chat-view'));
  record('跨 620px 缩放往返：节点、视图、ID 与事件保持',{desktopState,phoneState});
  // Keyboard / compact viewport keeps the send button reachable and cleans up.
  await page.locator('#message').focus();
  await page.setViewportSize({width:390,height:420});await page.waitForFunction(()=>document.documentElement.classList.contains('keyboard-open'));
  const compact=await page.evaluate(()=>{const send=document.getElementById('send').getBoundingClientRect();const style=getComputedStyle(document.documentElement);return {tabbar:getComputedStyle(document.getElementById('mobile-tabbar')).display,sendBottom:send.bottom,height:innerHeight,visualOffset:visualViewport?.offsetTop??0,appHeight:style.getPropertyValue('--app-height').trim(),offsetVar:style.getPropertyValue('--vv-offset-top').trim()};});
  assert.equal(compact.tabbar,'none','tabbar must hide while the compact keyboard layout is active');
  assert.ok(compact.sendBottom<=compact.height+0.5,`send ${compact.sendBottom} below compact viewport ${compact.height}`);
  assert.equal(compact.offsetVar,'0px','headless visual viewport offsetTop stays 0px; CSS keeps the offset variable clean');
  await shot(page,'keyboard-390x420.png');
  await page.evaluate(()=>document.activeElement.blur());
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>!document.documentElement.classList.contains('keyboard-open'));
  await visible(page.locator('#mobile-tabbar'));
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--app-height')&&document.documentElement.classList.contains('keyboard-open')),false,'keyboard styles must be cleaned up');
  await firstScreen(page,'390x844 after keyboard');
  record('键盘/短视口：底栏隐藏、发送可达、关闭后恢复且无残留样式',{compact});
  // Long message and URL wrapping.
  const longText='我想慢慢说清楚这一阵子的感受。'.repeat(90)+' https://example.test/'+ 'a'.repeat(140);
  await page.locator('#message').fill(longText);
  await page.locator('#send').click();
  await visible(page.getByText('今天可以先从一件小事开始。',{exact:true}));
  const longState=await page.evaluate(()=>{const bubble=document.querySelector('.message.user .bubble'),conversation=document.getElementById('conversation'),send=document.getElementById('send').getBoundingClientRect();return {bubbleWidth:bubble.getBoundingClientRect().width,conversationWidth:conversation.clientWidth,bubbleScrollWidth:bubble.scrollWidth,conversationScrollWidth:conversation.scrollWidth,conversationClientWidth:conversation.clientWidth,sendBottom:send.bottom,innerHeight}});
  assert.ok(longState.bubbleWidth<=longState.conversationWidth,'long message bubble wider than conversation');
  assert.ok(longState.conversationScrollWidth<=longState.conversationClientWidth+1,'long message causes horizontal conversation overflow');
  assert.ok(longState.bubbleScrollWidth<=longState.bubbleWidth+1,'long URL overflows its bubble');
  assert.ok(longState.sendBottom<=longState.innerHeight+0.5,'send hidden after long message');
  await shot(page,'long-message-390.png');
  record('长消息/长链接：气泡换行、无横向溢出、发送仍可见',{longState});
  // Logout returns to the local chat welcome state.
  await openAccount(page);
  await page.getByRole('button',{name:'编辑资料',exact:true}).click();
  await page.getByRole('button',{name:'账户与安全设置',exact:true}).click();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await visible(page.getByLabel('邮箱',{exact:true}));
  assert.equal(await page.locator('#admin-nav').isVisible(),false);
  await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();
  await visible(page.locator('#chat-view'));
  assert.equal(await page.locator('#conversation .message').count(),1,'logout must reset the local conversation');
  assert.ok(f.signedOut,'logout must reach the auth fixture');
  record('登录/退出：退出后回到本地体验并清空聊天',{});
  assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}
}
async function checkLongConversation(browser){
 for(const [width,height] of [[390,844],[320,568]]){
  // 390×844 mirrors the independent report: touch context, signed out, local replies.
  const f=await fixture(browser,{viewport:{width,height},hasTouch:width===390});
  const page=f.page;
  try{
   await visible(page.locator('.suggestions'));
   const longText='这是一段较长的本地验收消息。'.repeat(100);
   for(let round=1;round<=3;round++){
    await page.locator('#message').fill(round===1?longText:`${longText}（第 ${round} 轮）`);
    await page.locator('#send').click();
    await page.waitForFunction(count=>document.querySelectorAll('#conversation .message.user').length>=count,round);
    await page.waitForTimeout(150);
   }
   await page.waitForTimeout(1500);
   const state=await page.evaluate(()=>{
    const main=document.querySelector('main'),conv=document.getElementById('conversation'),heading=document.querySelector('.chat-heading'),send=document.getElementById('send'),tabbar=document.getElementById('mobile-tabbar');
    const sendRect=send.getBoundingClientRect(),tabRect=tabbar.getBoundingClientRect(),headingRect=heading.getBoundingClientRect();
    const hit=document.elementFromPoint(sendRect.left+sendRect.width/2,sendRect.top+sendRect.height/2);
    return {mainScrollHeight:main.scrollHeight,mainClientHeight:main.clientHeight,mainScrollTop:main.scrollTop,conversationClient:conv.clientHeight,conversationScroll:conv.scrollHeight,conversationScrollTop:conv.scrollTop,headingTop:headingRect.top,headingBottom:headingRect.bottom,sendTop:sendRect.top,sendBottom:sendRect.bottom,sendHit:Boolean(hit&&hit.closest('#send')),tabbarTop:tabRect.top,innerHeight,innerWidth,docScrollWidth:document.documentElement.scrollWidth};
   });
   assert.ok(state.mainScrollHeight<=state.mainClientHeight+1,`${width}x${height}: main grew with conversation ${JSON.stringify(state)}`);
   assert.ok(state.conversationScroll>state.conversationClient+1,`${width}x${height}: conversation does not scroll independently`);
   assert.ok(state.conversationClient<state.mainClientHeight,`${width}x${height}: conversation taller than main`);
   assert.ok(state.headingTop>=0&&state.headingBottom<=state.innerHeight,`${width}x${height}: heading left the visible viewport ${JSON.stringify(state)}`);
   assert.ok(state.sendTop>=0&&state.sendBottom<=state.tabbarTop-0.5,`${width}x${height}: send overlaps the tabbar ${JSON.stringify(state)}`);
   assert.ok(state.sendHit,`${width}x${height}: send is covered after a long conversation`);
   assert.ok(state.docScrollWidth<=state.innerWidth+1,`${width}x${height}: horizontal overflow after a long conversation`);
   await shot(page,`long-conversation-${width}x${height}.png`);
   const afterScroll=await page.evaluate(()=>{const conv=document.getElementById('conversation');conv.scrollTop=0;const main=document.querySelector('main'),send=document.getElementById('send').getBoundingClientRect(),heading=document.querySelector('.chat-heading').getBoundingClientRect(),tabbar=document.getElementById('mobile-tabbar').getBoundingClientRect();return {mainScrollTop:main.scrollTop,headingTop:heading.top,sendBottom:send.bottom,tabbarTop:tabbar.top};});
   assert.equal(afterScroll.mainScrollTop,0,`${width}x${height}: scrolling the conversation must not scroll main`);
   assert.ok(afterScroll.headingTop>=0,`${width}x${height}: heading left after conversation scroll`);
   assert.ok(afterScroll.sendBottom<=afterScroll.tabbarTop-0.5,`${width}x${height}: tabbar covers send after conversation scroll`);
   // Compact keyboard layout must keep the same guarantee with a loaded conversation.
   await page.locator('#message').focus();
   await page.setViewportSize({width,height:width===390?420:360});
   await page.waitForFunction(()=>document.documentElement.classList.contains('keyboard-open'));
   await page.waitForTimeout(300);
   const compact=await page.evaluate(()=>{const send=document.getElementById('send').getBoundingClientRect(),heading=document.querySelector('.chat-heading').getBoundingClientRect(),conv=document.getElementById('conversation');return {tabbar:getComputedStyle(document.getElementById('mobile-tabbar')).display,headingTop:heading.top,sendTop:send.top,sendBottom:send.bottom,innerHeight,conversationClient:conv.clientHeight,conversationScroll:conv.scrollHeight,offsetVar:getComputedStyle(document.documentElement).getPropertyValue('--vv-offset-top').trim()};});
   assert.equal(compact.tabbar,'none',`${width}x${height}: compact keyboard tabbar`);
   assert.ok(compact.headingTop>=0,`${width}x${height}: compact heading hidden`);
   assert.ok(compact.sendTop>=0&&compact.sendBottom<=compact.innerHeight+0.5,`${width}x${height}: compact send outside viewport ${JSON.stringify(compact)}`);
   assert.ok(compact.conversationScroll>compact.conversationClient,`${width}x${height}: compact conversation not scrollable`);
   assert.equal(compact.offsetVar,'0px',`${width}x${height}: clean visualViewport offset variable`);
   await shot(page,`long-conversation-${width}x${height}-compact.png`);
   record(`长对话 ${width}x${height}：会话独立滚动、main 不增长、heading/发送保持可见、键盘布局`,{state,afterScroll,compact});
   assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
 }
}
async function checkTouchAndStop(browser){
 const touch=await fixture(browser,{viewport:{width:390,height:844},hasTouch:true});
 try{
  await touch.signIn();
  assert.equal(await touch.page.evaluate(()=>matchMedia('(pointer: coarse)').matches),true,'touch fixture must report a coarse pointer');
  await touch.page.locator('#message').click();await touch.page.keyboard.type('第一行');
  await touch.page.keyboard.press('Enter');
  const value=await touch.page.locator('#message').inputValue();
  assert.ok(value.includes('\n'),'touch Enter must insert a newline instead of sending');
  assert.equal(touch.calls.filter(call=>call.action==='chat').length,0,'touch Enter must not send a chat request');
  await touch.page.locator('#send').click();
  await visible(touch.page.getByText('今天可以先从一件小事开始。',{exact:true}));
  assert.ok(touch.calls.some(call=>call.action==='chat'),'send button must submit on touch');
  record('触屏 Enter 换行、按钮发送',{value});
  assert.deepEqual(touch.errors,[]);
 }finally{await touch.context.close();}
 const stop=await fixture(browser,{viewport:{width:390,height:844},slowChat:true});
 try{
  await stop.signIn();
  await stop.page.locator('#message').fill('这条回复我先停一下。');
  await stop.page.locator('#send').click();
  await visible(stop.page.locator('#stop'));
  assert.equal(await stop.page.locator('#send').isVisible(),false,'send must hide while a reply is pending');
  const stopBox=await stop.page.locator('#stop').boundingBox();assert.ok(stopBox.height>=44,`stop button ${stopBox.height}px`);
  await stop.page.locator('#stop').click();
  await visible(stop.page.locator('#send'));
  assert.equal(await stop.page.locator('#stop').isVisible(),false,'stop must hide after cancellation');
  assert.ok((await stop.page.locator('#status').textContent()).includes('已停止等待回复'),'stop must explain the stopped request');
  stop.releaseChat();
  record('停止生成：44px 停止按钮、恢复发送、状态可读',{});
  assert.deepEqual(stop.errors,[]);
 }finally{await stop.context.close();}
}
async function checkDark(browser){
 const f=await fixture(browser,{viewport:{width:390,height:844},colorScheme:'dark'});
 try{
  await f.signIn();await visible(pageLocator(f.page,'#conversation .message'));
  assert.equal(await f.page.evaluate(()=>document.documentElement.dataset.theme),'dark','dark color scheme must select the dark token set');
  const colors=await f.page.evaluate(()=>({body:getComputedStyle(document.body).backgroundColor,composer:getComputedStyle(document.querySelector('.composer')).backgroundColor,tabbar:getComputedStyle(document.getElementById('mobile-tabbar')).backgroundColor}));
  assert.equal(colors.body,'rgb(16, 16, 16)','dark page token expected');
  await firstScreen(f.page,'390x844 dark');
  await noOverflow(f.page,'390x844 dark');
  await shot(f.page,'after-chat-dark.png');
  record('390×844 深色：token、首屏发送、无横溢',{colors});
  assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}
}
function pageLocator(page,selector){return page.locator(selector);}
async function checkDesktop(browser){
 const f=await fixture(browser,{viewport:{width:1280,height:900},colorScheme:'light'});
 try{
  await f.signIn();await visible(f.page.locator('#conversation .message'));
  await f.page.locator('#message').fill('第一行');await f.page.keyboard.press('Shift+Enter');
  assert.ok((await f.page.locator('#message').inputValue()).includes('\n'),'desktop Shift+Enter must insert a newline');
  await f.page.locator('#message').fill('我今天有点累。');await f.page.keyboard.press('Enter');
  await visible(f.page.getByText('今天可以先从一件小事开始。',{exact:true}));
  assert.ok(f.calls.some(call=>call.action==='chat'),'desktop Enter must send');
  const state=await f.page.evaluate(()=>({sidebar:getComputedStyle(document.querySelector('.sidebar')).display,mobileTopbar:getComputedStyle(document.getElementById('mobile-topbar')).display,rightPanel:getComputedStyle(document.querySelector('.right-panel')).display,mobileTabbar:getComputedStyle(document.getElementById('mobile-tabbar')).display,chatNavParent:Boolean(document.getElementById('chat-nav').closest('.sidebar')),accountParent:Boolean(document.getElementById('account-open').closest('.topbar-actions')),checkinParent:Boolean(document.getElementById('checkin').closest('.right-panel')),scrollWidth:document.documentElement.scrollWidth,innerWidth}));
  assert.equal(state.sidebar,'flex','desktop sidebar must stay');
  assert.equal(state.mobileTopbar,'none','desktop must hide the phone topbar');
  assert.equal(state.mobileTabbar,'none','desktop must hide the phone tabbar');
  assert.equal(state.rightPanel,'flex','desktop must keep the support column');
  assert.ok(state.chatNavParent&&state.accountParent&&state.checkinParent,'desktop must own the real nodes');
  assert.ok(state.scrollWidth<=state.innerWidth+1,'desktop horizontal overflow');
  const send=await f.page.locator('#send').boundingBox();assert.ok(send&&send.height>=44,'desktop send target');
  await shot(f.page,'desktop.png',true);
  record('桌面 1280×900：原侧栏/顶栏/右栏结构、桌面发送与对话',{state});
  assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}
}
async function checkLandscape(browser){
 const f=await fixture(browser,{viewport:{width:844,height:390},colorScheme:'light'});
 try{
  await f.signIn();
  assert.equal(await f.page.locator('#mobile-topbar').isVisible(),false,'844px wide keeps the desktop chrome');
  await noOverflow(f.page,'844x390 landscape');
  await f.page.locator('#send').scrollIntoViewIfNeeded();
  const send=await f.page.locator('#send').boundingBox();
  assert.ok(send.y>=0&&send.y+send.height<=390+0.5,`landscape send not reachable after scroll: ${JSON.stringify(send)}`);
  const scroll=await f.page.evaluate(()=>({scrollHeight:document.documentElement.scrollHeight,innerHeight,canScroll:document.documentElement.scrollHeight>innerHeight}));
  await shot(f.page,'landscape-844x390.png');
  record('横屏 844×390：允许纵向滚动且发送可达、无横溢',{send,scroll});
  assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}
}
async function checkOwner(browser){
 const f=await fixture(browser,{role:'owner',viewport:{width:390,height:844}});
 try{
  await f.signIn();await visible(f.page.locator('#conversation .message'));
  await f.page.locator('#more-open').click();await visible(f.page.locator('#more-dialog'));
  assert.equal(await f.page.locator('#admin-nav').isVisible(),true,'approved owner must see the admin entry');
  await minTargets(f.page,'#more-dialog #admin-nav','owner admin entry');
  await f.page.locator('#admin-nav').click();
  await visible(f.page.getByRole('heading',{name:'管理后台',exact:true}));
  assert.equal(await f.page.locator('#more-dialog').isVisible(),false,'admin navigation must close more');
  await f.page.waitForTimeout(400);
  const adminFocus=await f.page.evaluate(()=>document.activeElement.id);
  assert.equal(adminFocus,'admin-view','admin navigation must move focus to the admin view, not the more trigger');
  await noOverflow(f.page,'owner admin mobile');
  await shot(f.page,'after-more-admin.png');
  record('权限管理员入口：站长在更多面板看到并打开管理后台',{adminFocus});
  assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}
}
async function main(){
 await fs.mkdir(output,{recursive:true});
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 try{
  await checkSizes(browser);
  await checkLightFlow(browser);
  await checkLongConversation(browser);
  await checkTouchAndStop(browser);
  await checkDark(browser);
  await checkDesktop(browser);
  await checkLandscape(browser);
  await checkOwner(browser);
 }finally{
  await browser.close();
  const report={generatedAt:new Date().toISOString(),base,deviceMatrix:['320x568','375x667','390x844','430x932','844x390 landscape','1280x900 desktop'],colorSchemes:['light','dark'],results,screenshots:shots,limitations:['真实 iOS/Android 软键盘无法在本地 headless 浏览器中复现；键盘检查使用短视口 + 聚焦模拟，并已如实标注。']};
  await fs.writeFile(path.join(output,'checks.json'),JSON.stringify(report,null,2)+'\n');
  await fs.writeFile(path.join(output,'checks.md'),['# 手机端验收检查（本地 fixture）','',`生成时间：${report.generatedAt}`,'',...results.map((item,index)=>`${index+1}. **${item.name}** — 通过`),'',`截图：${shots.join('、')}`,'','限制：真实 iOS/Android 软键盘无法在本地 headless 浏览器中复现；键盘检查使用短视口 + 聚焦模拟。',''].join('\n'));
 }
 console.log(JSON.stringify({ok:true,checks:results.map(item=>item.name),screenshots:shots.map(name=>path.join(output,name))},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
