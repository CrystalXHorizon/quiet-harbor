const who='https://www.who.int/thailand/activities/doing-what-matters-in-times-of-stress';
const nhs='https://www.nhs.uk/every-mind-matters/mental-wellbeing-tips/self-help-cbt-techniques/problem-solving/';
export const strategies=[
 {title:'把注意力放回身边',when:'感觉飘远、思绪太满时，可以先试这项。',body:'睁着眼睛，选一件眼前的物品，描述它的颜色、轮廓，再留意一个周围的声音。不用强迫自己放松，也不必闭眼。如果关注身体让你不舒服，就只看外部环境。',source:who,label:'WHO · 压力应对指南'},
 {title:'和反复出现的念头拉开一点距离',when:'一个担忧反复转，暂时放不下时。',body:'试着把“肯定会出事”换成“我注意到自己又在担心会出事”。不用证明它对或错，再把注意力带回手边的一件事。这不是否认现实困难；如果这样说更难受，就跳过。',source:who,label:'WHO · 压力应对指南'},
 {title:'把难题缩成一个可做的小步骤',when:'事情堆在一起，不知道从哪里开始时。',body:'写下一件眼下能改变的事，想两个小办法，选一个容易开始的。明确什么时候做、需要谁帮忙。例如任务太大，可以先打开材料，写下一条要点；做完再决定下一步。',source:nhs,label:'NHS · 问题解决'},
 {title:'给担忧一个稍后处理的时间',when:'反复担忧打断当前生活，但没有即时危险时。',body:'先用一句话记下担忧，约一个具体的 10–15 分钟时段再处理。到时区分能行动的问题与暂时无法控制的猜测，只为能行动的一项做计划。紧急安全问题不要推迟处理；如果越记越难受，就停止。',source:nhs,label:'NHS · 问题解决'},
 {title:'先不急着赶走情绪',when:'越想让自己不难过，反而越累时。',body:'如果愿意，先用一个词描述此刻：难过、委屈，或者“说不清”。可以对自己说：“现在有这个感受，我暂时不用解决它。”然后看看周围，选一件普通的小事继续做。不必回想原因，也不用盯着感受；如果注意情绪让你更难受，就换成观察眼前物品。',source:who,label:'WHO · 压力应对指南'},
 {title:'把责备换成一句体谅',when:'脑子里一直在说“都是我的错”“我怎么又这样”时。',body:'想一想，如果朋友正经历同样的事，你会怎样和他说。给自己留一句同样具体的话，比如：“今天已经很吃力了，我可以先休息一下。”不必夸自己，也不用强迫自己相信一切都会好。觉得这句话不合适，就换成自己的说法，或先跳过。',source:who,label:'WHO · 压力应对指南'},
 {title:'为在意的事做一个很小的动作',when:'觉得失去方向，不知道现在做什么时。',body:'选一件你仍然在意的事，比如照顾自己、与人联系或保持好奇，再找一个此刻做得来的动作：倒一杯水，给信任的人发一句“今天有点累，方便聊几句吗”，或读半页喜欢的书。只选一个，做完就可以停；这不是今天必须完成的任务。',source:who,label:'WHO · 压力应对指南'},
 {title:'给今天留一点舒服的事',when:'一直处理烦心事，已经很久没有喘口气时。',body:'找一件过去让你稍微舒服一点、现在也方便做的小事，例如听一首熟悉的歌、翻几页轻松的书，或在安全熟悉的地方走一小段。先留几分钟，不要求立刻开心。结束后看看是轻松些、没变化，还是更累；没有帮助也不代表你做错了，下次可以换一种。',source:nhs,label:'NHS · 问题解决'}
];
export function strategyMessages(history){
 if(!history.some(m=>m.role==='user'))throw new Error('先聊聊你眼下的困难，再来试试；也可以直接选择上面的通用方法。');
 const request={role:'user',content:'请根据上面这段对话给我一两项此刻可以尝试的方法。只从以下方法中选择：'+strategies.map(s=>s.title+'：'+s.body).join('\n')+'。先简短说明你依据的是我说过的哪件事，不要编造细节或诊断。尊重我已经拒绝的练习，给一个具体的小步骤和不舒服时停止的选择。不需要每项都推荐，也不保证有效；若信息不足就直说，若有即时危险优先现实支持。'};
 const messages=[...history.slice(-11).map(m=>({role:m.role,content:m.content})),request];
 while(messages.reduce((n,m)=>n+m.content.length,0)>16000)messages.shift();
 return messages;
}
