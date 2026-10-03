export function contentSecurity(config) {
 const origin=config?.supabaseUrl;
 const connections=origin?` ${origin} ${origin.replace(/^http/,'ws')}`:'';
 return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${connections}; object-src 'none'; base-uri 'self'; form-action 'self'`;
}
