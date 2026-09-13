import test from 'node:test';
import assert from 'node:assert/strict';
import {strategyMessages,strategies} from '../public/strategies.js';
import {validateMessages,runHarness} from '../public/harness.js';
test('strategy request carries real context and bounds it without mutating chat',()=>{
 const history=[{role:'user',content:'明天面试，不想做身体练习。'},{role:'assistant',content:'先不做。'}];
 const original=JSON.stringify(history);const messages=validateMessages(strategyMessages(history));
 assert.deepEqual(messages.slice(0,-1),history);assert.match(messages.at(-1).content,/尊重我已经拒绝/);assert.equal(JSON.stringify(history),original);
 assert.throws(()=>strategyMessages([]));
 const large=Array.from({length:30},()=>({role:'user',content:'甲'.repeat(4000)}));assert.ok(validateMessages(strategyMessages(large)).length<=12);
 assert.ok(messages.at(-1).content.length<=4000);
 for(const strategy of strategies)assert.ok(messages.at(-1).content.includes(strategy.title));
});
test('personal suggestions still require input triage and output review',async()=>{
 const messages=strategyMessages([{role:'user',content:'面试让我一直担忧。'}]);let count=0;
 const values=[{route:'support',mode:'practical'},'你提到面试。可以先列一个能准备的小问题。',{safe:true}];
 const result=await runHarness(messages,{AI_API_KEY:'fake-test'},{fetchImpl:async(_,options)=>{count++;const v=values.shift();return Response.json({choices:[{finish_reason:'stop',message:{content:typeof v==='string'?v:JSON.stringify(v)}}]});}});
 assert.equal(result.mode,'ai');assert.equal(count,3);
 const danger=await runHarness(strategyMessages([{role:'user',content:'今晚准备伤害自己。'}]),{AI_API_KEY:'fake-test'},{fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({route:'crisis'})}}]})});assert.equal(danger.route,'crisis');
});

