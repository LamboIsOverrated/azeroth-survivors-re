import {createHash} from 'node:crypto';
import {address,signingAddress,rawAtoms,TOKEN_PROGRAM} from '../../economy/settlement/protocol.mjs';

export const U64=18446744073709551615n;
export const GAME_MAX=2147483646n;
// Full getGenesisHash result, not the shortened CAIP-2 network reference.
export const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const atoms=value=>rawAtoms(value,{zero:true});
export function units(value){
 if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,9})$/.test(value)||BigInt(value)>GAME_MAX)throw Error('Canonical bounded game units required');
 return BigInt(value);
}
export function positive(value){const n=atoms(value);if(n===0n)throw Error('Positive atoms required');return n;}
export function gameAtoms(value,config){const n=units(value)*positive(config.atomsPerGameUnit);if(n>U64)throw Error('Conversion exceeds raw u64');return n.toString();}
export function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw Error('Canonical JSON data required');
}
export const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function identifier(value,label='identifier'){
 if(typeof value!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(value))throw Error('Invalid '+label);
 return value;
}
export function account(value){if(!Number.isSafeInteger(value)||value<1||value>4294967295)throw Error('Invalid account');return value;}
export function configuration(input){
 if(!input||input.phase!=='LIVE')throw Error('Dedicated LIVE configuration required');
 if(input.assetKind==='native-sol'){
  if(input.cluster!=='devnet'||input.genesisHash!==DEVNET_GENESIS||input.decimals!==9||typeof input.namespaceId!=='string'||!/^devnet-sol[-:.]/.test(input.namespaceId)||['mint','tokenProgram','treasuryTokenAccount'].some(key=>input[key]!==undefined)||(input.withdrawalFeePolicy!==undefined&&input.withdrawalFeePolicy!=='gross-includes-network-fee'))throw Error('Explicit isolated devnet native SOL configuration required');
  const cfg={phase:'LIVE',assetKind:'native-sol',cluster:'devnet',namespaceId:identifier(input.namespaceId,'namespace'),genesisHash:DEVNET_GENESIS,decimals:9,treasuryWallet:signingAddress(input.treasuryWallet),atomsPerGameUnit:positive(input.atomsPerGameUnit).toString(),reserveFloorLamports:positive(input.reserveFloorLamports).toString(),withdrawalFeePolicy:'gross-includes-network-fee'};
  return Object.freeze({...cfg,hash:hash(cfg)});
 }
 if(input.assetKind!==undefined)throw Error('Unsupported accounting asset kind');
 if(!Number.isInteger(input.decimals)||input.decimals<0||input.decimals>18)throw Error('Invalid mint decimals');
 if(input.tokenProgram!==undefined&&input.tokenProgram!==TOKEN_PROGRAM)throw Error('Conventional SPL only');
 const cfg={phase:'LIVE',namespaceId:identifier(input.namespaceId,'namespace'),genesisHash:address(input.genesisHash),mint:address(input.mint),tokenProgram:TOKEN_PROGRAM,decimals:input.decimals,treasuryWallet:address(input.treasuryWallet),treasuryTokenAccount:address(input.treasuryTokenAccount),atomsPerGameUnit:positive(input.atomsPerGameUnit).toString()};
 if(new Set([cfg.mint,cfg.treasuryWallet,cfg.treasuryTokenAccount,cfg.tokenProgram]).size!==4)throw Error('Distinct reserve addresses required');
 return Object.freeze({...cfg,hash:hash(cfg)});
}
