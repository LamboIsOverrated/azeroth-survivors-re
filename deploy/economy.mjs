import { PublicKey } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function validPublicKey(value) {
  try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; }
  catch { return false; }
}

export function readConfig(env) {
  const mint = validPublicKey(env.GAME_TOKEN_MINT) && env.GAME_TOKEN_MINT !== SOL_MINT ? env.GAME_TOKEN_MINT : null;
  const decimals = /^\d$/.test(env.GAME_TOKEN_DECIMALS || '') ? Number(env.GAME_TOKEN_DECIMALS) : null;
  const cluster = env.SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta';
  return {
    tokenMint: mint,
    tokenSymbol: /^[A-Za-z0-9]{1,12}$/.test(env.GAME_TOKEN_SYMBOL || '') ? env.GAME_TOKEN_SYMBOL : 'TOKEN',
    tokenDecimals: decimals,
    cluster,
    swapsEnabled: env.TOKEN_LAUNCHED === 'true' && env.SWAPS_ENABLED === 'true' && !!mint && decimals !== null && cluster === 'mainnet-beta',
  };
}

export function parseUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9 || typeof value !== 'string' ||
      !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error('Enter a positive amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (raw <= 0n || raw > 18446744073709551615n) throw new Error('Amount is outside the supported range.');
  return raw.toString();
}

export function formatUnits(raw, decimals) {
  if (!/^\d+$/.test(String(raw)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('Invalid token amount.');
  const digits = BigInt(raw).toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
