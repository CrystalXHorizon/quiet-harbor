import {createApiHandler} from '../_shared/api.js';

// The gateway's legacy JWT mode is disabled in config.toml to support current
// asymmetric signing keys. This handler verifies every bearer token with Auth.
Deno.serve(createApiHandler({env:{
 SUPABASE_URL:Deno.env.get('SUPABASE_URL'),
 SUPABASE_ANON_KEY:Deno.env.get('SUPABASE_ANON_KEY'),
 SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
 ALLOWED_ORIGINS:Deno.env.get('ALLOWED_ORIGINS'),
 AI_ENCRYPTION_KEY:Deno.env.get('AI_ENCRYPTION_KEY'),
 AI_ALLOWED_HOSTS:Deno.env.get('AI_ALLOWED_HOSTS')||''
}}));
