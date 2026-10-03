import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const builtAt=new Date().toISOString();
await writeFile('supabase/functions/_shared/build-info.js',`export const BUILD_INFO=${JSON.stringify({commit,builtAt})};\n`);
