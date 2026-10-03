export function authNavigation(href) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const requested = url.searchParams.get('account');
  const hasFragmentTokens = fragment.has('access_token') || fragment.has('refresh_token');
  const accessToken=fragment.get('access_token'),refreshToken=fragment.get('refresh_token'),fragmentType=fragment.get('type');
  const fragmentLink=hasFragmentTokens && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken||'') &&
    /^[A-Za-z0-9_-]{8,2048}$/.test(refreshToken||'') && accessToken.length<=16000 && ['invite','recovery','signup','magiclink'].includes(fragmentType)
    ? {type:fragmentType,accessToken,refreshToken}:null;
  const rejected = hasFragmentTokens && !fragmentLink;
  const type = url.searchParams.get('type');
  const tokenHash = url.searchParams.get('token_hash');
  const emailLink = !rejected && tokenHash && ['invite', 'recovery', 'email', 'signup', 'magiclink'].includes(type)
    ? { type, tokenHash } : null;
  const recovery = !hasFragmentTokens && requested === 'recovery';
  const invitation = emailLink?.type === 'invite' || fragmentLink?.type === 'invite';
  const callbackError = rejected || fragment.has('error') || fragment.has('error_code') || url.searchParams.has('error');
  return {
    recovery, invitation, callbackError, rejected, emailLink, fragmentLink,
    reset: requested === 'reset' || callbackError,
    open: recovery || Boolean(emailLink||fragmentLink) || callbackError || ['reset', 'login'].includes(requested) || url.searchParams.has('code'),
    implicit: false
  };
}

export function authLandingUrl(href, action) {
  const url = new URL('./', href);
  url.search = ''; url.hash = '';
  if (action) url.searchParams.set('account', action);
  return url.href;
}
