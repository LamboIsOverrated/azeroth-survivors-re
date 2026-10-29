import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import './wallet.css';

globalThis.Buffer ??= Buffer;

async function api(path, body) {
  const response = await fetch(`/api/economy${path}`, {credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : {method: 'POST', headers: {'content-type':'application/json','x-realm-economy':'1'}, body:JSON.stringify(body)})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Wallet request did not complete.');
  return result;
}

export async function connectPhantom() {
  const provider = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
  if (!provider) throw new Error('Open this page with the Phantom browser extension installed.');
  return connect(provider);
}

export async function connectSolflare() {
  const provider = window.solflare;
  if (!provider) throw new Error('Open this page with the Solflare browser extension installed.');
  return connect(provider);
}

async function connect(provider) {
  const connection = await provider.connect();
  const wallet = new PublicKey(connection?.publicKey ?? provider.publicKey).toBase58();
  const challenge = await api('/wallet/challenge', {wallet});
  const result = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
  const signature = Buffer.from(result.signature ?? result).toString('base64');
  return api('/wallet/verify', {challengeId:challenge.challengeId,signature});
}

function formatAtoms(value, decimals) {
  if (decimals === null) return `${value} atoms (decimals unavailable)`;
  const padded = value.padStart(decimals + 1, '0');
  if (!decimals) return padded;
  const whole = padded.slice(0,-decimals), fraction = padded.slice(-decimals).replace(/0+$/,'');
  return whole + (fraction ? `.${fraction}` : '');
}

function solNetwork(cluster) {
  if (cluster === 'devnet') return 'Solana devnet · test SOL, no cash value';
  if (cluster === 'mainnet-beta') return 'Solana mainnet-beta';
  throw new Error('The wallet network is unavailable.');
}

export function solBalanceText(chain, cluster) {
  const network = solNetwork(cluster);
  if (!chain || chain.cluster !== cluster) throw new Error('The wallet balance network does not match this realm.');
  if (chain.available === false) return `${network}: ${typeof chain.reason === 'string' ? chain.reason : 'Wallet balance unavailable.'}`;
  if (chain.available !== true || chain.genesisVerified !== true || chain.commitment !== 'finalized' || chain.displayOnly !== true || typeof chain.solLamports !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(chain.solLamports) || BigInt(chain.solLamports) > 18446744073709551615n) throw new Error('A verified native SOL wallet balance is unavailable.');
  return `${formatAtoms(chain.solLamports,9)} SOL · ${network} · finalized wallet balance, display only`;
}

if (['/', '/play'].includes(location.pathname) && !document.querySelector('#realm-wallet-launcher')) {
  const styles = document.createElement('link'); styles.rel='stylesheet'; styles.href='/realm-wallet.bundle.css'; document.head.append(styles);
  const launcher = document.createElement('button'); launcher.id='realm-wallet-launcher'; launcher.textContent='Wallet · TEST';
  const dialog = document.createElement('dialog'); dialog.id='realm-wallet-dialog'; dialog.setAttribute('aria-labelledby','realm-wallet-title');
  dialog.innerHTML = `<div class="realm-wallet-top"><span class="realm-wallet-eyebrow">TEST REALM</span><button data-action="close" aria-label="Close wallet">✕</button></div>
    <h2 id="realm-wallet-title">Your realm wallet</h2>
    <p>The world keeps running while this panel is open.</p>
    <p class="realm-wallet-warning">TEST only · Nonredeemable · No carryover to launch</p>
    <p>Characters, items and TEST funds may be reset before launch. Wallet linking is optional for test play.</p>
    <div class="realm-wallet-actions"><button data-action="phantom">Link Phantom</button><button data-action="solflare">Link Solflare</button></div>
    <p data-field="address" class="realm-wallet-address">No linked wallet.</p>
    <section><h3>In-game TEST currency (last saved)</h3><p data-field="character">Loading authoritative character balances…</p><ul data-field="characters"></ul></section>
    <section><h3>Your wallet · Native SOL</h3><p>Game currency target: SOL. No custom token is needed. TEST game money and vault units cannot be exchanged for SOL.</p><p data-field="network">Checking the Solana network…</p><p data-field="chain">Link a wallet to view its native SOL balance.</p></section>
    <p class="realm-wallet-warning">Deposits and withdrawals are unavailable during this test.</p>
    <details data-field="testTools" hidden><summary>Test tools</summary><section><h3>Account TEST vault</h3><strong data-field="vault">—</strong><p>These test units are separate from character money and cannot be redeemed.</p><button data-action="allocate" hidden>Claim one-time TEST allocation</button></section><ol data-field="history"></ol></details>
    <p data-field="status" role="status" aria-live="polite"></p>
    <button data-action="refresh">Refresh balances</button>
    <p class="realm-wallet-footnote">Wallet signatures link your wallet only. Never share a recovery phrase or private key.</p>`;
  (document.querySelector('#bar')||document.body).append(launcher);
  document.body.append(dialog);
  const field = name => dialog.querySelector(`[data-field="${name}"]`);
  let busy = false;
  const status = text => { field('status').textContent=text; };
  function controls(value) { busy=value; for(const button of dialog.querySelectorAll('button[data-action]:not([data-action="close"])')) button.disabled=value; }
  async function refresh() {
    const state = await api('/state');
    field('vault').textContent=`${state.vault.units} TEST vault units`;
    field('testTools').hidden=!state.config.testAllocationAvailable&&state.vault.units==='0';
    field('address').textContent=state.wallet.address ? `Linked wallet: ${state.wallet.address}` : 'No linked wallet.';
    field('network').textContent=`${solNetwork(state.config.cluster)} · wallet display only`;
    field('chain').textContent='Checking native SOL wallet balance…';
    field('characters').replaceChildren();
    field('character').textContent=state.characterMoney.available ? 'Realm server snapshot. Online character changes may not appear until saved. TEST money is nonredeemable.' : state.characterMoney.reason;
    if (state.characterMoney.available) {
      for (const character of state.characterMoney.characters) { const item=document.createElement('li'); item.textContent=`${character.name}: ${character.moneyUnits} TEST game units${character.online ? ' · online, last saved' : ' · offline'}`; field('characters').append(item); }
      if (!state.characterMoney.characters.length) field('character').textContent='No characters on this realm account yet.';
    }
    dialog.querySelector('[data-action="allocate"]').hidden=!state.config.testAllocationAvailable;
    const history=await api('/history'); field('history').replaceChildren();
    for(const entry of history.entries) { const item=document.createElement('li'); item.textContent=`${entry.units} TEST · ${entry.kind} · ${new Date(entry.createdAt).toLocaleString()}`; field('history').append(item); }
    if (!history.entries.length) { const item=document.createElement('li'); item.textContent='No account vault activity.'; field('history').append(item); }
    const chain=await api('/wallet/balances');
    field('chain').textContent=solBalanceText(chain,state.config.cluster);
  }
  async function run(action) {
    if (busy) return;
    controls(true); status('Working…');
    try { await action(); status('Wallet information updated.'); }
    catch(error) { status(error.message); }
    finally { controls(false); }
  }
  launcher.onclick=()=>{dialog.showModal();run(refresh);};
  dialog.querySelector('[data-action="close"]').onclick=()=>dialog.close();
  dialog.querySelector('[data-action="refresh"]').onclick=()=>run(refresh);
  dialog.querySelector('[data-action="allocate"]').onclick=()=>run(async()=>{await api('/test-allocation',{});await refresh();});
  dialog.querySelector('[data-action="phantom"]').onclick=()=>run(async()=>{await connectPhantom();await refresh();});
  dialog.querySelector('[data-action="solflare"]').onclick=()=>run(async()=>{await connectSolflare();await refresh();});
}
