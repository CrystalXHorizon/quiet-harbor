// Fast conservative triage, NOT a clinical assessment or complete risk detector.
export const CRISIS_TEXT = '听起来你现在可能正在承受很难熬的痛苦。你此刻是否已经受伤，或有马上伤害自己或他人的可能？如果有，请立即联系当地急救服务或前往急诊，并请身边可信任的人陪着你。在能安全做到的情况下，先远离可能造成伤害的物品。这里无法提供紧急救援，也没有真人实时查看聊天。';
export const BOUNDARY_TEXT = '我可以陪你谈谈此刻的感受，但不能为你诊断、引导身份切换或找回记忆，也不能建议调整药物。你不需要证明或解释这些体验。我们可以先留意身边的环境；如果这些困扰持续，建议联系有相关经验的精神科医生或心理治疗师。';
export const PAUSE_TEXT = '这次回答没能通过完整的检查，所以先暂停 AI 回复。你可以稍后再试，也可以选择「回到当下」或联系信任的人。';
export function quickRoute(text) {
  const t = String(text).normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g, '').toLowerCase();
  if (/自杀|自殺|自残|自殘|不想活|想死|结束生命|結束生命|伤害自己|傷害自己|杀人|殺人|跳楼|跳樓|割腕|服药过量|吞了.*药|suicid|kill myself|end my life|hurt myself|overdos|kill (him|her|them)/i.test(t)) return 'crisis';
  if (/催眠|恢复.*记忆|找回.*记忆|恢復.*記憶|切换.*人格|切換.*人格|召唤.*人格|帮我.*诊断|幫我.*診斷|停药|停藥|药.*剂量|藥.*劑量|recover.*memor|switch.*alter/i.test(t)) return 'boundary';
  return 'support';
}
export function demoReply(text, turn = 0) {
  const route = quickRoute(text);
  if (route === 'crisis') return { text: CRISIS_TEXT, route };
  if (route === 'boundary') return { text: BOUNDARY_TEXT, route };
  if (/不真实|不真實|游离|遊離|飘|麻木|解离|解離/.test(text)) return { route: 'grounding', text: '这种感觉可能让人不安。暂时不用急着解释它。\n\n如果你愿意，可以看一看周围，找一件颜色清楚的物品，轻轻说出它的颜色。觉得不舒服就停下。你也可以点「回到当下」，按自己的节奏试试。' };
  if (/安静|安靜|不想说|不想說/.test(text)) return { route: 'support', text: '好，可以先不解释。你不需要现在就回复。\n\n让自己保持一个舒服的位置，看看身边的环境；也可以关掉页面休息一会儿。' };
  const replies = ['我们可以从很小的一件事开始。\n\n你现在更希望有人听你说，还是一起想一个能让接下来几分钟好过一点的小办法？', '不用把感受整理得很清楚。你可以只说最想被听见的那一部分，也可以暂时不说。\n\n此刻有什么能让你稍微舒服一点点？'];
  return { route: 'support', text: replies[turn % replies.length] };
}
