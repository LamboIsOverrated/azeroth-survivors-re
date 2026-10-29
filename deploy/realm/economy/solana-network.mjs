export const SOL_CURRENCY = Object.freeze({symbol:'SOL',name:'Solana',assetKind:'native-sol',decimals:9,requiresMint:false});

// Full genesis hashes, not the shortened CAIP-2 network identifiers.
const GENESIS = Object.freeze({
  devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2dN',
});

export function genesisFor(cluster) {
  if(typeof cluster!=='string'||!Object.hasOwn(GENESIS,cluster))throw new Error('Supported explicit Solana cluster required');
  return GENESIS[cluster];
}
