import http from 'node:http';
import {readFile} from 'node:fs/promises';
const allowed=new Set(['index.html','style.css','favicon.svg','app.js','safety.js','strategies.js','providers.js','community.js','community.css','site-config.json','auth-bundle.js','auth-bundle.js.LEGAL.txt']);
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json',svg:'image/svg+xml',txt:'text/plain; charset=utf-8'};
http.createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
 if(!allowed.has(path)){res.writeHead(404);res.end('Not found');return;}
 try{const data=await readFile(new URL('../dist/'+path,import.meta.url));res.writeHead(200,{'Content-Type':types[path.split('.').at(-1)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);}catch{res.writeHead(500);res.end('Run npm run build first');}
}).listen(Number(process.env.PORT||4177),process.env.HOST||'127.0.0.1',()=>console.log('http://127.0.0.1:'+(process.env.PORT||4177)));
