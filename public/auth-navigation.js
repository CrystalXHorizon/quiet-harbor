export function authNavigation(href) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const requested = url.searchParams.get('account');
  const rejected = fragment.has('access_token') || fragment.has('refresh_token');
  const type = url.searchParams.get('type');
  const tokenHash = url.searchParams.get('token_hash');
  const emailLink = !rejected && tokenHash && ['invite', 'recovery', 'email', 'signup', 'magiclink'].includes(type)
    ? { type, tokenHash } : null;
  const recovery = !rejected && requested === 'recovery';
  const invitation = emailLink?.type === 'invite';
  const callbackError = rejected || fragment.has('error') || fragment.has('error_code') || url.searchParams.has('error');
  return {
    recovery, invitation, callbackError, rejected, emailLink,
    reset: requested === 'reset' || callbackError,
    open: recovery || Boolean(emailLink) || callbackError || ['reset', 'login'].includes(requested) || url.searchParams.has('code'),
    implicit: false
  };
}

export function authLandingUrl(href, action) {
  const url = new URL('./', href);
  url.search = ''; url.hash = '';
  if (action) url.searchParams.set('account', action);
  return url.href;
}
