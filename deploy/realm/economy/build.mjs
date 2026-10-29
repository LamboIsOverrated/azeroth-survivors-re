import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
await build({entryPoints:[join(here,'wallet-ui.mjs')],bundle:true,format:'esm',platform:'browser',target:['es2022'],outfile:join(here,'public/realm-wallet.bundle.js'),minify:true,legalComments:'eof'});
