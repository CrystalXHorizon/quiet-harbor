import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { configured, validateMessages, runHarness } from './harness.mjs';
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/index.html',['index.html','text/html; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/harness.js',['harness.js','text/javascript; charset=utf-8']],['/vault.js',['vault.js','text/javascript; charset=utf-8']],['/safety.js',['safety.js','text/javascript; charset=utf-8']],['/favicon.svg',['favicon.svg','image/svg+xml']]]);
export function createApp(env=process.env, options={}) {
  const origins=new Set((env.ALLOWED_ORIGINS || 'http://127.0.0.1:4173,http://localhost:4173').split(',').map(x=>x.trim()).filter(Boolean));
  let times=[],active=0,day='',dailyCount=0;
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    const send=(status,data)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    let path;try {path=new URL(req.url,'http://localhost').pathname;}catch{return send(400,{error:'请求无效。'});}
    if(!path.startsWith('/api/')) {
      if(req.method!=='GET' && req.method!=='HEAD') return send(405,{error:'方法不支持。'});
      const asset=assets.get(path);if(!asset)return send(404,{error:'页面不存在。'});
      try {const content=await readFile(new URL(`./public/${asset[0]}`,import.meta.url));res.writeHead(200,{'Content-Type':asset[1]});res.end(req.method==='HEAD'?undefined:content);}catch{send(500,{error:'页面暂不可用。'});}return;
    }
    const origin=req.headers.origin;
    if(origin && !origins.has(origin)) return send(403,{error:'网页来源未获允许。'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600'});return res.end();}
    const expected=env.APP_ACCESS_TOKEN || '';const received=req.headers.authorization || '';
    const a=Buffer.from(received),b=Buffer.from(`Bearer ${expected}`);
    if(expected.length<32 || a.length!==b.length || !timingSafeEqual(a,b)) return send(401,{error:'个人访问口令无效或尚未配置。'});
    if(path==='/api/health' && req.method==='GET') return send(200,{service:'quiet-harbor',ready:configured(env)});
    if(path!=='/api/chat' || req.method!=='POST')return send(404,{error:'接口不存在。'});
    if(!configured(env))return send(503,{error:'请先在服务端配置 DeepSeek 密钥及模型。'});
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(415,{error:'需要 JSON 请求。'});
    const now=Date.now();times=times.filter(t=>now-t<60000);const currentDay=new Date().toISOString().slice(0,10);if(day!==currentDay){day=currentDay;dailyCount=0;}
    if(times.length>=12 || active>=2 || dailyCount>=200){res.setHeader('Retry-After','60');return send(429,{error:dailyCount>=200?'今天的 AI 请求已达到上限，请明天再试。':'请求有些频繁，请稍后再试。'});}
    times.push(now);active++;
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const deadline=setTimeout(()=>{controller.abort();if(!res.headersSent)send(408,{error:'请求超时，请稍后再试。'});req.destroy();},90000);
    try {
      if(Number(req.headers['content-length'])>70000){send(413,{error:'消息过长。'});return;}
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>70000){send(413,{error:'消息过长。'});return;}chunks.push(chunk);}
      let messages;
      try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));messages=validateMessages(data.messages);}catch{return send(400,{error:'消息格式无效；最多 12 条、每条 4000 字符，总计 16000 字符。'});}
      dailyCount++;
      send(200,await runHarness(messages,env,{signal:controller.signal,...options}));
    }catch{if(!res.headersSent)send(500,{error:'暂时无法完成请求。'});}
    finally{active--;clearTimeout(deadline);}
  });
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const port=Number(process.env.PORT || 4173),host=process.env.HOST || '127.0.0.1';
  const server=createApp();server.requestTimeout=95000;server.headersTimeout=15000;
  server.listen(port,host,()=>console.log(`Quiet Harbor: http://${host}:${port}`));
}
