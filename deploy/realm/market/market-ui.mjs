import { createMarketSession,formatUnits } from './client.mjs';
import './market.css';

export function mountMarket(root) {
  if(!root || root.dataset.marketMounted) return null;root.dataset.marketMounted='true';
  root.classList.add('realm-market');
  root.innerHTML=`<h3>Wallet market · SOL ↔ launch token</h3>
    <p data-market="availability" role="status">Checking launch status…</p>
    <p class="realm-market-note">Trade tokens in your linked wallet. Game deposits and withdrawals remain closed.</p>
    <p data-market="wallet" class="realm-market-address"></p>
    <p data-market="mint" class="realm-market-address"></p>
    <div data-market="entry" hidden>
      <label>Swap direction<select data-market="direction"><option value="sol-to-token">SOL → token</option><option value="token-to-sol">Token → SOL</option></select></label>
      <label>Amount to sell<input data-market="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" maxlength="280"></label>
      <button type="button" data-market-action="quote">Review quote</button>
    </div>
    <div data-market="review" class="realm-market-review" hidden><h4>Review your swap</h4><p data-market="summary"></p><p data-market="fees"></p><p data-market="expiry"></p><p>Output is an estimate. Price movement can change the result or cause the transaction to fail. Review the amounts and network fees in your wallet.</p><button type="button" data-market-action="sign">Sign and submit swap</button><button type="button" data-market-action="cancel">Cancel quote</button></div>
    <p data-market="result" role="status" aria-live="polite"></p>
    <a data-market="explorer" target="_blank" rel="noopener noreferrer" hidden>View transaction on Solscan</a>
    <button type="button" data-market-action="check" hidden>Check transaction status</button>
    <button type="button" data-market-action="refresh">Refresh market status</button>`;
  const field=name=>root.querySelector(`[data-market="${name}"]`),button=name=>root.querySelector(`[data-market-action="${name}"]`);
  let error='';
  function render(state) {
    const config=state.config;
    field('availability').textContent=config?.enabled?'Solana mainnet market is open.':config?.reason || 'Checking launch status…';
    field('wallet').textContent=config?.wallet?`Linked wallet: ${config.wallet}`:'Link and verify a wallet above to trade.';
    field('mint').textContent=config?.tokenMint?`Token contract: ${config.tokenMint}`:'Token contract will be announced at launch.';
    field('entry').hidden=!config?.enabled;
    if(config) {field('direction').options[0].textContent=`SOL → ${config.tokenSymbol}`;field('direction').options[1].textContent=`${config.tokenSymbol} → SOL`;}
    field('review').hidden=state.phase!=='review';
    if(state.quote && config) {
      const quote=state.quote,buy=quote.direction==='sol-to-token';
      field('summary').textContent=`Sell ${formatUnits(quote.inAmount,buy?9:config.tokenDecimals)} ${buy?'SOL':config.tokenSymbol} · Estimated receive ${formatUnits(quote.outAmount,buy?config.tokenDecimals:9)} ${buy?config.tokenSymbol:'SOL'}.`;
      field('fees').textContent=`Route: ${quote.router || 'Jupiter'}. ${quote.feeBps===null || quote.feeBps===undefined?'Swap fee shown by your wallet.':`Quoted swap fee: ${quote.feeBps} basis points.`} Network fees and token account rent may also apply.`;
      field('expiry').textContent=`Quote expires at ${new Date(quote.expiresAt).toLocaleTimeString()}.`;
    }
    const pending=state.phase==='pending';
    field('result').textContent=error || (pending?'Confirmation is pending. Check this transaction before starting another swap.':state.result?.status==='Success'?'Swap confirmed.':state.result?.status==='Failed'?'The transaction failed on chain.':state.result?.message || '');
    button('check').hidden=!pending;
    const signature=state.result?.signature;field('explorer').hidden=!signature;
    if(signature) field('explorer').href=`https://solscan.io/tx/${encodeURIComponent(signature)}`;
    for(const control of root.querySelectorAll('button,input,select')) control.disabled=state.busy;
    button('quote').disabled=state.busy || pending || !config?.enabled || !config?.wallet;
    field('direction').disabled=state.busy || pending;field('amount').disabled=state.busy || pending;
  }
  const session=createMarketSession({onChange:render});
  async function run(action) {error='';try {await action();} catch(cause) {error=cause.message;}render(session.state);}
  button('quote').onclick=()=>run(()=>session.requestQuote(field('direction').value,field('amount').value));
  button('sign').onclick=()=>run(()=>session.signAndExecute());
  button('cancel').onclick=()=>{error='';session.cancel();};
  button('check').onclick=()=>run(()=>session.check());
  button('refresh').onclick=()=>run(()=>session.refresh());
  field('amount').oninput=()=>session.cancel();field('direction').onchange=()=>session.cancel();
  root.addEventListener('realm-market:refresh',()=>run(()=>session.refresh()));
  const dialog=root.closest('dialog');dialog?.addEventListener('toggle',()=>{if(dialog.open && !session.state.busy) void run(()=>session.refresh());});
  void run(()=>session.refresh());return session;
}

function mountAll() {for(const root of document.querySelectorAll('[data-realm-market]')) mountMarket(root);}
if(typeof document!=='undefined') {
  if(!document.querySelector('link[data-realm-market-style]')) {const link=document.createElement('link');link.rel='stylesheet';link.href='/realm-market.bundle.css';link.dataset.realmMarketStyle='true';document.head.append(link);}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mountAll,{once:true});else mountAll();
}
