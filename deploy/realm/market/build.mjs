import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname,join } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
await build({entryPoints:[join(here,'market-ui.mjs')],bundle:true,format:'esm',platform:'browser',target:['es2022'],supported:{'template-literal':false},outfile:join(here,'public/realm-market.bundle.js'),minify:true,legalComments:'eof'});
