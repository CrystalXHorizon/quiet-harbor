import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSiteConfig, loadSiteConfig, createBackendClient } from '../public/backend-client.js';

const config = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'sb_publishable_test', inviteOnly: true };
const authSession = { access_token: 'user-access-token', refresh_token: 'not-exposed', user: { id: 'member-id', email: 'person@example.test', user_metadata: { role: 'owner' } } };
function fixture({ session = authSession, fetchImpl = async () => Response.json({ profile: { id: 'member-id', nickname: '小岸', role: 'member' }, ai: { ready: true }, usage: { used: 1, limit: 10 } }) } = {}) {
  let current = session, callback, signOuts = 0;
  const changes = [], events = [];
  const sdk = { auth: {
    getSession: async () => ({ data: { session: current }, error: null }),
    signOut: async () => { signOuts++; current = null; callback?.('SIGNED_OUT', null); return { error: null }; },
    onAuthStateChange: listener => { callback = listener; return { data: { subscription: { unsubscribe() {} } } }; }
  } };
  const client = createBackendClient(config, { createClient: () => sdk, fetchImpl, onChange: state => changes.push(state), onAuthEvent: event => events.push(event) });
  return { client, changes, events, get signOuts() { return signOuts; }, change(event, next) { current = next; callback(event, next); } };
}

test('site config permits only public credentials and secure project origins', async () => {
  assert.equal(validateSiteConfig({ supabaseUrl: '', supabaseAnonKey: '' }), null);
  assert.equal(validateSiteConfig(config).inviteOnly, true);
  assert.equal(validateSiteConfig({ ...config, inviteOnly: false }).inviteOnly, false);
  for (const supabaseUrl of ['http://untrusted.example', 'https://u:p@example.test', 'https://example.test/path', 'https://example.test?token=1']) {
    assert.throws(() => validateSiteConfig({ ...config, supabaseUrl }));
  }
  assert.equal(validateSiteConfig({ ...config, supabaseUrl: 'http://127.0.0.1:54321' }).supabaseUrl, 'http://127.0.0.1:54321');
  assert.throws(() => validateSiteConfig({ ...config, supabaseAnonKey: 'sb_secret_do_not_publish' }));
  const jwt = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  assert.throws(() => validateSiteConfig({ ...config, supabaseAnonKey: jwt('service_role') }));
  assert.equal(validateSiteConfig({ ...config, supabaseAnonKey: jwt('anon') }).supabaseAnonKey, jwt('anon'));
  assert.equal(await loadSiteConfig(async () => Response.json({}), 'http://localhost/config'), null);
});

test('anonymous requests stop before network and API calls cannot replace their action', async () => {
  let calls = 0;
  const anonymous = fixture({ session: null, fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(anonymous.client.api('me'), /登录已过期/);
  assert.equal(calls, 0); anonymous.client.dispose();
  const seen = [];
  const logged = fixture({ fetchImpl: async (url, options) => { seen.push({ url, options }); return Response.json({ ok: true }); } });
  await logged.client.api('posts.list', { action: 'admin.users', page: 1 });
  assert.equal(seen[0].url, `${config.supabaseUrl}/functions/v1/api`);
  assert.equal(seen[0].options.headers.Authorization, 'Bearer user-access-token');
  assert.equal(seen[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(seen[0].options.body), { action: 'posts.list', page: 1 });
  assert.ok(!JSON.stringify(seen).includes('not-exposed')); logged.client.dispose();
});

test('account presentation trusts server profile and never exposes session tokens or metadata roles', async () => {
  const { client } = fixture();
  const state = await client.refresh();
  assert.equal(state.profile.role, 'member');
  assert.deepEqual(state.user, { id: 'member-id', email: 'person@example.test' });
  assert.ok(!JSON.stringify(state).includes('access_token'));
  assert.ok(!JSON.stringify(state).includes('owner')); client.dispose();
});

test('logout aborts active fetch and discards responses even when transport ignores cancellation', async () => {
  let resolve, requested;
  const started = new Promise(done => { requested = done; });
  const f = fixture({ fetchImpl: (_, options) => new Promise(done => { resolve = done; requested(options); }) });
  const pending = f.client.api('posts.list');
  const options = await started;
  await f.client.signOut();
  assert.equal(options.signal.aborted, true);
  resolve(Response.json({ posts: [{ body: 'must not reappear' }] }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.client.getSession(), null);
  await assert.rejects(f.client.api('me'), /登录已过期/); f.client.dispose();
});

test('expired token clears account and MFA-required responses request a challenge', async () => {
  const expired = fixture({ fetchImpl: async () => Response.json({ error: '请重新登录。', code: 'unauthorized' }, { status: 401 }) });
  await assert.rejects(expired.client.api('me'), /请重新登录/);
  assert.equal(expired.signOuts, 1); assert.equal(expired.client.getSession(), null); expired.client.dispose();
  const mfa = fixture({ fetchImpl: async () => Response.json({ error: '需要二次验证。', code: 'mfa_required' }, { status: 403 }) });
  await assert.rejects(mfa.client.api('admin.ai.get'), /需要二次验证/);
  assert.deepEqual(mfa.events, ['MFA_REQUIRED']); mfa.client.dispose();
});

test('newer server profile refresh wins when responses arrive out of order', async () => {
  const responders = [];
  const f = fixture({ fetchImpl: () => new Promise(resolve => responders.push(resolve)) });
  const first = f.client.refresh();
  while (responders.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
  const second = f.client.refresh();
  while (responders.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  responders[1](Response.json({ profile: { role: 'member', nickname: '最新' } }));
  await second;
  responders[0](Response.json({ profile: { role: 'owner', nickname: '过时' } }));
  await first;
  assert.equal(f.client.getSession().profile.nickname, '最新');
  assert.equal(f.client.getSession().profile.role, 'member'); f.client.dispose();
});

test('MFA gate preserves challenge identity while clearing all application data until AAL2 refresh', async () => {
  let gated = false, calls = 0;
  const f = fixture({ fetchImpl: async () => {
    calls++;
    return gated ? Response.json({ error: '请完成二次验证。', code: 'mfa_required' }, { status: 403 }) : Response.json({ profile: { nickname: '小岸', role: 'member' }, ai: { ready: true }, usage: { used: 1, limit: 10 } });
  } });
  await f.client.refresh();
  assert.equal(f.client.getSession().ai.ready, true);
  gated = true;
  const blocked = await f.client.refresh();
  assert.equal(blocked.user.id, authSession.user.id);
  assert.equal(blocked.mfaRequired, true);
  assert.equal(blocked.profile, null);
  assert.equal(blocked.ai, null);
  assert.equal(blocked.usage, null);
  assert.equal(f.signOuts, 0, 'MFA needs the existing Auth session to challenge');
  assert.equal(calls, 2, 'MFA notification does not recursively retry me');
  assert.deepEqual(f.events, ['MFA_REQUIRED']);
  gated = false;
  const verified = await f.client.refresh();
  assert.equal(verified.profile.role, 'member');
  assert.equal(verified.mfaRequired, undefined);
  assert.equal(calls, 3);
  f.client.dispose();
});

test('MFA requirement discards an already pending application response', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = fixture({ fetchImpl: async (_, options) => {
    if (JSON.parse(options.body).action === 'posts.list') return new Promise(resolve => { release = resolve; started(options.signal); });
    return Response.json({ error: '请完成二次验证。', code: 'mfa_required' }, { status: 403 });
  } });
  const posts = f.client.api('posts.list');
  const signal = await waiting;
  await f.client.refresh();
  assert.equal(signal.aborted, true);
  release(Response.json({ posts: [{ body: 'prior private data' }] }));
  await assert.rejects(posts, { name: 'AbortError' });
  assert.equal(f.client.getSession().mfaRequired, true);
  f.client.dispose();
});
