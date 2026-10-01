import test from 'node:test';
import assert from 'node:assert/strict';
import { authNavigation, authLandingUrl } from '../public/auth-navigation.js';

test('recovery and invite callbacks open account even when initialization events were missed', () => {
  const recovery=authNavigation('https://example.com/quiet-harbor/#access_token=example&type=recovery');
  assert.equal(recovery.open,true);assert.equal(recovery.recovery,true);assert.equal(recovery.implicit,true);
  const invite=authNavigation('https://example.com/quiet-harbor/#access_token=example&type=invite');
  assert.equal(invite.open,true);assert.equal(invite.invitation,true);
});
test('PKCE recovery intent survives SDK removal of callback code and expired links open reset UI', () => {
  for(const suffix of ['?account=recovery&code=example','?account=recovery']) {
    const state=authNavigation('https://example.com/quiet-harbor/'+suffix);
    assert.equal(state.open,true);assert.equal(state.recovery,true);assert.equal(state.implicit,false);
  }
  const expired=authNavigation('https://example.com/quiet-harbor/#error=access_denied&error_code=otp_expired');
  assert.equal(expired.open,true);assert.equal(expired.reset,true);assert.equal(expired.callbackError,true);
  assert.equal(authNavigation('https://example.com/quiet-harbor/?account=reset').reset,true);
  assert.equal(authNavigation('https://example.com/quiet-harbor/').open,false);
});
test('recovery destination retains GitHub Pages path and strips old tokens', () => {
  assert.equal(authLandingUrl('https://example.com/quiet-harbor/?code=old#access_token=secret','recovery'),'https://example.com/quiet-harbor/?account=recovery');
});
