import test from 'node:test';
import assert from 'node:assert/strict';
import {validTransactionError} from '../transaction-errors.mjs';

test('reviewed transaction error serde variants preserve exact u8/u32 payloads and actual transaction bounds',()=>{
 const context={instructionCount:2,accountCount:6};
 for(const value of [null,'BlockhashNotFound','InsufficientFundsForFee',{InstructionError:[0,'InsufficientFunds']},{InstructionError:[1,{Custom:0}]},{InstructionError:[0,{Custom:4294967295}]},{DuplicateInstruction:1},{InsufficientFundsForRent:{account_index:5}},{ProgramExecutionTemporarilyRestricted:{account_index:0}}])assert.equal(validTransactionError(value,context),true,JSON.stringify(value));
 for(const value of [false,[],{},'','InstructionError','NewFutureVariant',{InstructionError:[2,'InsufficientFunds']},{InstructionError:[0,{Custom:4294967296}]},{InstructionError:[0,{BorshIoError:'legacy payload'}]},{DuplicateInstruction:2},{InsufficientFundsForRent:{account_index:6}},{ProgramExecutionTemporarilyRestricted:{account_index:0,extra:1}}])assert.equal(validTransactionError(value,context),false,JSON.stringify(value));
});
