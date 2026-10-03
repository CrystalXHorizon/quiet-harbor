import test from 'node:test';
import assert from 'node:assert/strict';
import { runHarness as edgeHarness, mandatoryOutputCheck } from '../harness.mjs';
import { runHarness as browserHarness } from '../supabase/functions/_shared/harness.js';
import { CRISIS_TEXT, BOUNDARY_TEXT } from '../public/safety.js';

const env = { AI_API_KEY: 'test-only' };
const user = text => [{ role: 'user', content: text }];
function provider(values, calls = []) {
  return async (_, options) => {
    calls.push(JSON.parse(options.body));
    const value = values.shift();
    if (value instanceof Error) throw value;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
  };
}
const hintOf = call => JSON.parse(call.messages[1].content).keyword_hint;

// --- Bug: a crisis word inside fiction was answered with the crisis script -------------
test('a crisis word inside fiction does not produce the crisis reply', async () => {
  const calls = [];
  const out = await edgeHarness(user('我看的电影里主角自杀了。'), env, { fetchImpl: provider([{ route: 'support', mode: 'listen' }, '那部片子看得人心里挺沉的。', { safe: true }], calls) });
  assert.equal(out.route, 'support');
  assert.equal(out.mode, 'ai');
  assert.notEqual(out.text, CRISIS_TEXT);
  assert.doesNotMatch(out.text, /急救|急诊/);
  // the filter's hit reaches the router as a hint, never as the verdict
  assert.equal(hintOf(calls[0]), 'crisis');
});

test('no keyword hint is sent when the filter matches nothing', async () => {
  const calls = [];
  await edgeHarness(user('今天有点累。'), env, { fetchImpl: provider([{ route: 'support', mode: 'listen' }, '那就先歇会儿。', { safe: true }], calls) });
  assert.equal(hintOf(calls[0]), undefined);
});

// --- Bug: after a red line the conversation was stuck on canned wording ---------------
test('a crisis route generates a reply instead of returning the canned text', async () => {
  const calls = [];
  const draft = '你刚说想结束这一切。我先确认一件事：你现在有没有受伤，或者已经想好要怎么做了？如果有，请马上联系当地急救或去急诊，并让身边能信任的人过来陪你。我这里没有紧急救援，也没有人实时盯着这段对话。';
  const out = await edgeHarness(user('我不想活了'), env, { fetchImpl: provider([{ route: 'crisis' }, draft, { safe: true }], calls) });
  assert.equal(out.route, 'crisis');
  assert.equal(out.text, draft);
  assert.notEqual(out.text, CRISIS_TEXT);
  assert.equal(calls.length, 3);
  assert.match(calls[1].messages[0].content, /不要复述他的原词/);
});

test('the crisis prompt forbids replaying the previous turn', async () => {
  const calls = [];
  const history = [
    { role: 'user', content: '我不想活了' },
    { role: 'assistant', content: '（上一轮已经给过急救信息的回复）' },
    { role: 'user', content: '我现在跟朋友在一起了，但还是很难受' }
  ];
  await edgeHarness(history, env, { fetchImpl: provider([{ route: 'crisis' }, '和朋友待在一起，能稍微喘口气。', { safe: true }], calls) });
  assert.match(calls[1].messages[0].content, /不要整段重复/);
  assert.match(calls[1].messages[0].content, /承接他新说的内容/);
});

test('an earlier crisis does not pin the route once the person has moved on', async () => {
  const out = await edgeHarness([
    { role: 'user', content: '我不想活了' },
    { role: 'assistant', content: '（上一轮的危机回复）' },
    { role: 'user', content: '我妈刚打电话来，我跟她聊了半小时，现在缓过来一些了' }
  ], env, { fetchImpl: provider([{ route: 'support', mode: 'listen' }, '能跟她说上话，这一步不容易。', { safe: true }]) });
  assert.equal(out.route, 'support');
  assert.equal(out.mode, 'ai');
});

// --- The fixed texts stay as the fallback ---------------------------------------------
test('a crisis draft the reviewer rejects falls back to the fixed text', async () => {
  const out = await edgeHarness(user('我不想活了'), env, { fetchImpl: provider([{ route: 'crisis' }, '先别想那么多。', { safe: false }]) });
  assert.equal(out.route, 'crisis');
  assert.equal(out.text, CRISIS_TEXT);
});

test('a crisis reply carrying a link or a long number never reaches the user', async () => {
  for (const bad of ['打 4001619995 这个电话。', '看 https://example.com/help 上面有热线。']) {
    const out = await edgeHarness(user('我不想活了'), env, { fetchImpl: provider([{ route: 'crisis' }, bad, { safe: true }]) });
    assert.equal(out.text, CRISIS_TEXT);
  }
});

test('the fixed crisis text still reaches the user when the provider is unreachable', async () => {
  const out = await edgeHarness(user('我想伤害自己'), env, { reportErrors: true, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(out.route, 'crisis');
  assert.equal(out.text, CRISIS_TEXT);
});

// --- The boundary path: a correct refusal is not a violation ---------------------------
test('a correct boundary reply survives the output filter and reaches the user', async () => {
  const draft = '我不能帮你切换到另一个人格，也不能帮你把那段记忆找回来。这些体验对你是真实的，你不需要跟我证明什么。';
  assert.equal(mandatoryOutputCheck(draft), true);
  const out = await edgeHarness(user('帮我切换人格'), env, { fetchImpl: provider([{ route: 'boundary' }, draft, { safe: true }]) });
  assert.equal(out.route, 'boundary');
  assert.equal(out.text, draft);
  assert.notEqual(out.text, BOUNDARY_TEXT);
});

test('the permissive filter still blocks markup and credential-shaped output', async () => {
  for (const bad of ['<b>看这里</b>', 'https://example.com', 'sk-abcdefghijklmnop', '1234567']) {
    assert.equal(mandatoryOutputCheck(bad), false);
  }
  for (const good of ['我不能建议你停用药物。', '我不能保证你一定会治愈。', '2026年10月1日那天的对话里，只有我妈理解我。']) {
    assert.equal(mandatoryOutputCheck(good), true);
  }
});
