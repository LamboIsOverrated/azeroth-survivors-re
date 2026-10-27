import { Buffer } from 'buffer';
import { VersionedTransaction } from '@solana/web3.js';
import { parseUnits, formatUnits } from '../economy.mjs';
globalThis.Buffer ??= Buffer;

const isGame = !document.querySelector('#preview-login');
let root = document.querySelector('#wallet-app');
if (!root) {
  const styles = document.createElement('link'); styles.rel = 'stylesheet'; styles.href = '/style.css'; document.head.append(styles);
  const dialog = document.createElement('dialog'); dialog.className = 'economy-dialog';
  const close = document.createElement('button'); close.className = 'economy-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close wallet');
  close.onclick = () => dialog.close();
  root = document.createElement('div'); root.id = 'wallet-app'; dialog.append(close, root); document.body.append(dialog);
  const launcher = document.createElement('button'); launcher.className = 'economy-launcher'; launcher.textContent = 'Wallet';
  launcher.onclick = () => dialog.showModal(); document.body.append(launcher);
}
root.classList.add('economy-root');
root.innerHTML = `<section class="economy-card">
  <div class="economy-heading"><div><p class="eyebrow">YOUR WALLET</p><h2>Currency for the journey.</h2></div><button id="economy-connect" class="economy-secondary">Connect wallet</button></div>
  <p id="economy-address" class="economy-address">Connect Phantom or Solflare to see your balances.</p>
  <div class="economy-balances"><div class="economy-balance">SOL<strong id="economy-sol">—</strong></div><div class="economy-balance"><span id="economy-symbol">Game token</span><strong id="economy-token">Not launched</strong></div></div>
  <p id="economy-notice" class="economy-notice">SOL ↔ game-token exchange opens after the token launches. Gameplay XP and health are separate from wallet funds.</p>
  <form id="economy-form"><label for="economy-direction">Exchange</label><select id="economy-direction" disabled><option value="buy">SOL → game token</option><option value="sell">Game token → SOL</option></select>
  <label id="economy-amount-label" for="economy-amount">Amount in SOL</label><input id="economy-amount" inputmode="decimal" placeholder="0.00" autocomplete="off" disabled>
  <p class="economy-muted">Live market quotes. Rates vary; network and exchange fees apply.</p><button id="economy-review" type="submit" disabled>Review exchange</button></form>
  <div id="economy-quote" class="economy-quote" hidden><p id="economy-quote-text"></p><p id="economy-quote-fees" class="economy-muted"></p><button id="economy-confirm">Confirm in wallet</button></div>
  <p id="economy-status" class="economy-status" role="status" aria-live="polite"></p>
  <p class="economy-muted">Your wallet holds your funds. This game never requests a recovery phrase or private key.</p>
</section>`;
const $ = id => root.querySelector(`#economy-${id}`);
let config, provider, address, quote, quoteTimer, busy = false;
const status = text => { $('status').textContent = text; };
function clearQuote() { quote = null; clearTimeout(quoteTimer); $('quote').hidden = true; }
function controls() {
  const enabled = !!config?.swapsEnabled && !!address && !busy;
  for (const id of ['direction', 'amount', 'review']) $(id).disabled = !enabled;
  $('connect').disabled = busy;
}
async function api(path, value) {
  const response = await fetch(path, value ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request did not complete.');
  return result;
}
async function balances() {
  if (!address) return;
  const result = await api(`/api/balance?wallet=${encodeURIComponent(address)}`);
  $('sol').textContent = formatUnits(result.sol, 9);
  $('token').textContent = result.token === null ? 'Not launched' : formatUnits(result.token, config.tokenDecimals);
}
async function refresh() {
  config = await api('/api/config');
  document.querySelector('#preview-login')?.setAttribute('hidden', '');
  document.querySelector('#preview-content')?.removeAttribute('hidden');
  $('symbol').textContent = config.tokenMint ? config.tokenSymbol : 'Game token';
  $('direction').options[0].textContent = `SOL → ${config.tokenSymbol}`;
  $('direction').options[1].textContent = `${config.tokenSymbol} → SOL`;
  if (config.swapsEnabled) $('notice').textContent = `Exchange SOL and ${config.tokenSymbol} at the current market rate. Run results do not authorize token payouts.`;
  const gameStatus = document.querySelector('#game-status');
  if (gameStatus) gameStatus.textContent = config.game.message;
  const play = document.querySelector('#play-link');
  if (play) play.hidden = config.game.state !== 'ready';
  controls();
}
$('connect').onclick = async () => {
  try {
    clearQuote();
    if (address) {
      await provider.disconnect(); address = undefined;
      $('address').textContent = 'Wallet disconnected.'; $('connect').textContent = 'Connect wallet';
      $('sol').textContent = '—'; $('token').textContent = config?.tokenMint ? '—' : 'Not launched'; controls(); return;
    }
    provider = window.phantom?.solana || window.solflare || window.solana;
    if (!provider?.connect) throw new Error('Open this page in a browser with Phantom or Solflare installed.');
    const result = await provider.connect(); address = result.publicKey.toString();
    $('address').textContent = address; $('connect').textContent = 'Disconnect'; controls();
    provider.on?.('accountChanged', () => { address = undefined; clearQuote(); $('connect').textContent = 'Connect wallet'; $('address').textContent = 'Wallet account changed. Reconnect to refresh balances.'; $('sol').textContent = '—'; $('token').textContent = '—'; controls(); });
    provider.on?.('disconnect', () => { address = undefined; clearQuote(); $('connect').textContent = 'Connect wallet'; $('address').textContent = 'Wallet disconnected.'; $('sol').textContent = '—'; $('token').textContent = '—'; controls(); });
    await balances(); status('Wallet connected.');
  } catch (error) { status(error.message); }
};
$('amount').addEventListener('input', clearQuote);
$('direction').onchange = () => { clearQuote(); $('amount').value = ''; $('amount-label').textContent = `Amount in ${$('direction').value === 'buy' ? 'SOL' : config.tokenSymbol}`; };
$('form').onsubmit = async event => {
  event.preventDefault(); clearQuote(); busy = true; controls(); status('Finding a market quote…');
  try {
    const direction = $('direction').value;
    const amount = parseUnits($('amount').value, direction === 'buy' ? 9 : config.tokenDecimals);
    quote = await api('/api/swap/order', { wallet: address, direction, amount });
    const receivedSymbol = direction === 'buy' ? config.tokenSymbol : 'SOL';
    $('quote-text').textContent = `Estimated receive: ${formatUnits(quote.outAmount, direction === 'buy' ? config.tokenDecimals : 9)} ${receivedSymbol}`;
    $('quote-fees').textContent = `Exchange fee: ${quote.feeBps ?? quote.platformFee?.feeBps ?? 'see wallet'}${quote.feeBps !== undefined || quote.platformFee?.feeBps !== undefined ? ' basis points' : ''}. Review the final amount and network fees in your wallet.`;
    $('quote').hidden = false; status('Review this quote, then confirm in your wallet.');
    quoteTimer = setTimeout(() => { clearQuote(); status('The quote expired. Request a fresh one.'); }, Math.max(0, quote.expires - Date.now()));
  } catch (error) { status(error.message); }
  finally { busy = false; controls(); }
};
$('confirm').onclick = async () => {
  if (!quote || busy || quote.expires <= Date.now()) { clearQuote(); status('Request a fresh quote.'); return; }
  busy = true; controls(); $('confirm').disabled = true;
  const accepted = quote;
  try {
    status('Waiting for your wallet confirmation…');
    const tx = VersionedTransaction.deserialize(Buffer.from(accepted.transaction, 'base64'));
    const signed = await provider.signTransaction(tx);
    status('Submitting your exchange…');
    const result = await api('/api/swap/execute', { requestId: accepted.requestId, signedTransaction: Buffer.from(signed.serialize()).toString('base64') });
    if (result.status !== 'Success' || result.code !== 0) throw new Error('The exchange did not confirm. Check your wallet before trying again.');
    status('Exchange confirmed.');
    if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(result.signature)) {
      const link = document.createElement('a'); link.href = `https://solscan.io/tx/${result.signature}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = ' View transaction'; $('status').append(link);
    }
    await balances();
  } catch (error) { status(error.message); }
  finally { clearQuote(); busy = false; $('confirm').disabled = false; controls(); }
};
document.querySelector('#preview-login')?.addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/session', { code: document.querySelector('#preview-code').value }); await refresh(); }
  catch (error) { document.querySelector('#login-message').textContent = error.message; }
});
refresh().catch(error => { if (isGame) status(error.message); });
setInterval(() => { if (!document.hidden) { refresh().catch(() => {}); if (address && !busy) balances().catch(error => status(error.message)); } }, 30000);
