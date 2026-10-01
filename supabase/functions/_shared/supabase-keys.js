function defaultKey(raw, prefix) {
 if(typeof raw!=='string'||!raw.trim())return undefined;
 try{
  const keys=JSON.parse(raw);
  if(!keys||typeof keys!=='object'||Array.isArray(keys)||!Object.hasOwn(keys,'default'))return undefined;
  const key=keys.default;
  return typeof key==='string'&&key.startsWith(prefix)&&key.length>prefix.length&&!/\s/.test(key)?key:undefined;
 }catch{return undefined;}
}
function legacyKey(value) {return typeof value==='string'&&value.trim()?value.trim():undefined;}

// Hosted Supabase injects named JSON dictionaries; older/self-hosted projects
// may still supply only the legacy JWT keys. Never select an arbitrary named key.
export function resolveSupabaseKeys(env) {
 return {
  publishableKey:defaultKey(env.SUPABASE_PUBLISHABLE_KEYS,'sb_publishable_')||legacyKey(env.SUPABASE_ANON_KEY),
  secretKey:defaultKey(env.SUPABASE_SECRET_KEYS,'sb_secret_')||legacyKey(env.SUPABASE_SERVICE_ROLE_KEY)
 };
}
