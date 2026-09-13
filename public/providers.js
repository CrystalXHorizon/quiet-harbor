// Official API presets; model availability and browser CORS depend on the account/platform.
export const PROVIDERS=[
 ['deepseek','DeepSeek','https://api.deepseek.com','https://api-docs.deepseek.com/','deepseek-flash'],
 ['openai','OpenAI / GPT','https://api.openai.com/v1','https://developers.openai.com/api/reference/resources/chat'],
 ['anthropic','Anthropic / Claude','https://api.anthropic.com/v1','https://platform.claude.com/docs/en/api/overview'],
 ['gemini','Google / Gemini','https://generativelanguage.googleapis.com/v1beta/openai','https://ai.google.dev/gemini-api/docs/openai'],
 ['qwen','阿里云百炼 / 通义千问','https://dashscope.aliyuncs.com/compatible-mode/v1','https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'],
 ['moonshot','月之暗面 / Kimi','https://api.moonshot.cn/v1','https://platform.kimi.com/docs/get-api-key'],
 ['zhipu','智谱 / GLM','https://open.bigmodel.cn/api/paas/v4','https://docs.bigmodel.cn/api-reference/模型-api/对话补全'],
 ['doubao','火山方舟 / 豆包','https://ark.cn-beijing.volces.com/api/v3','https://www.volcengine.com/docs/82379/1795150'],
 ['minimax','MiniMax','https://api.minimax.cn/v1','https://platform.minimax.cn/docs/api-reference/text-openai-api'],
 ['hunyuan','腾讯 / 混元','https://api.hunyuan.cloud.tencent.com/v1','https://cloud.tencent.cn/document/product/1729/111007'],
 ['baidu','百度千帆 / 文心','https://qianfan.baidubce.com/v2','https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb'],
 ['stepfun','阶跃星辰 / StepFun','https://api.stepfun.com/v1','https://platform.stepfun.com/docs/zh/welcome'],
 ['xai','xAI / Grok','https://api.x.ai/v1','https://docs.x.ai/developers/rest-api-reference/inference'],
 ['mistral','Mistral AI','https://api.mistral.ai/v1','https://docs.mistral.ai/api'],
 ['groq','Groq','https://api.groq.com/openai/v1','https://console.groq.com/docs/openai'],
 ['siliconflow','硅基流动','https://api.siliconflow.cn/v1','https://docs.siliconflow.cn/docs/userguide/quickstart'],
 ['together','Together AI','https://api.together.ai/v1','https://docs.together.ai/docs/inference/openai-compatibility'],
 ['openrouter','OpenRouter（多模型平台）','https://openrouter.ai/api/v1','https://openrouter.ai/docs/quickstart'],
 ['custom','自定义接口','','']
].map(([id,name,base,docs,model=''])=>({id,name,base,docs,model,protocol:id==='anthropic'?'anthropic':'openai',tokenField:id==='openai'?'max_completion_tokens':'max_tokens'}));
export function normalizeConfig(input){
 const preset=PROVIDERS.find(p=>p.id===input.provider);if(!preset)throw new Error('请选择供应商。');
 const protocol=input.protocol;if(!['openai','anthropic'].includes(protocol))throw new Error('请选择支持的接口协议。');
 let url;try{url=new URL(input.base.trim());}catch{throw new Error('请填写完整的 HTTPS API 地址。');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||/[{}]/.test(url.href))throw new Error('接口地址必须是 HTTPS，不能包含账号、密码、查询参数或占位符。');
 url.pathname=url.pathname.replace(/\/(chat\/completions|messages)\/?$/,'').replace(/\/+$/,'');
 const base=url.href.replace(/\/+$/,'');
 const model=(input.model||'').trim();if(!model||model.length>200||/\s/.test(model))throw new Error('请填写模型 ID（不是聊天应用名称），最多 200 个字符。');
 const tokenField=input.tokenField||preset.tokenField;if(!['max_tokens','max_completion_tokens'].includes(tokenField))throw new Error('输出参数无效。');
 return {provider:preset.id,name:preset.name,base,protocol,model,tokenField,jsonMode:!!input.jsonMode};
}
export function providerEnv(config,key){
 const c=normalizeConfig(config);
 return {AI_API_KEY:key,AI_ENDPOINT:c.base+(c.protocol==='anthropic'?'/messages':'/chat/completions'),AI_MODEL:c.model,AI_PROTOCOL:c.protocol,AI_TOKEN_FIELD:c.tokenField,AI_JSON_MODE:c.jsonMode};
}
export function packConnection(config,key){if(typeof key!=='string'||!key.trim()||/\s/.test(key)||key.length>1024)throw new Error('请输入有效的 API Key。');return JSON.stringify({kind:'quiet-harbor-connection',config:normalizeConfig(config),key});}
export function unpackConnection(text){
 if(!text.startsWith('{'))return {config:normalizeConfig({...PROVIDERS[0],provider:'deepseek',jsonMode:true}),key:text};
 const value=JSON.parse(text);if(value.kind!=='quiet-harbor-connection')throw new Error('保存的连接格式无效。');
 const config=normalizeConfig(value.config);packConnection(config,value.key);return {config,key:value.key};
}
