export function chatAccess(session) {
  if (session?.mfaRequired) return 'mfa';
  if (!session?.user) return 'local';
  if (!session.profile) return 'loading';
  if (session.profile.status === 'banned') return 'blocked';
  return session.profile.admission_status === 'approved' ? 'remote' : 'local';
}
