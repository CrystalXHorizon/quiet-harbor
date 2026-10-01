export function authNavigation(href) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const type = fragment.get('type');
  const requested = url.searchParams.get('account');
  const recovery = type === 'recovery' || requested === 'recovery';
  const invitation = type === 'invite';
  const callbackError = fragment.has('error') || fragment.has('error_code') || url.searchParams.has('error');
  return {
    recovery, invitation, callbackError,
    reset: requested === 'reset' || callbackError,
    open: recovery || invitation || callbackError || ['reset', 'login'].includes(requested) || url.searchParams.has('code'),
    implicit: fragment.has('access_token') && ['invite', 'recovery', 'signup', 'magiclink'].includes(type)
  };
}

export function authLandingUrl(href, action) {
  const url = new URL('./', href);
  url.search = ''; url.hash = '';
  if (action) url.searchParams.set('account', action);
  return url.href;
}
