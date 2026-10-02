import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('real Postgres migration: deny browser access, authorize roles, isolate revisions, moderate and reserve quotas',async()=>{
 const db=new PGlite();
 try{
  // Supabase owns these objects in production; only its minimal surface is mocked.
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  const migrations=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,migrations),'utf8'));
  await db.exec(await readFile(new URL('../supabase/tests/security.sql',import.meta.url),'utf8'));
 }finally{await db.close();}
});
