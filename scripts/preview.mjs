import http from 'node:http';
import {readFile} from 'node:fs/promises';
const allowed=new Set(['index.html','community-rules.html','community-rules.css','style.css','theme.css','theme.js','favicon.svg','app.js','safety.js','strategies.js','providers.js','community.js','community.css','personal.js','personal.css','site-config.json','auth-bundle.js','auth-bundle.js.LEGAL.txt','chat-state.js','form-validation.js']);
const security=JSON.parse(await readFile(new URL('../dist/security-headers.json',import.meta.url),'utf8'));
for(const file of [...allowed].filter(f=>!f.endsWith('.LEGAL.txt')))await readFile(new URL('../dist/'+file,import.meta.url));
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json',svg:'image/svg+xml',txt:'text/plain; charset=utf-8'};
http.createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
 if(!allowed.has(path)){res.writeHead(404);res.end('Not found');return;}
 try{const data=await readFile(new URL('../dist/'+path,import.meta.url));res.writeHead(200,{...security,'Content-Type':types[path.split('.').at(-1)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);}catch{res.writeHead(500);res.end('Run npm run build first');}
}).listen(Number(process.env.PORT||4177),process.env.HOST||'127.0.0.1',()=>console.log(`http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||4177}`));
