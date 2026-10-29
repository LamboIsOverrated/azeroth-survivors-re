// Closed reviewed serde variants, 2026-10-28. Unknown/future variants keep funds held.
// Primary enums: https://github.com/anza-xyz/solana-sdk/tree/master/transaction-error
// and https://github.com/anza-xyz/solana-sdk/tree/master/instruction-error
const transactionUnits=new Set(`AccountInUse AccountLoadedTwice AccountNotFound ProgramAccountNotFound InsufficientFundsForFee InvalidAccountForFee AlreadyProcessed BlockhashNotFound CallChainTooDeep MissingSignatureForFee InvalidAccountIndex SignatureFailure InvalidProgramForExecution SanitizeFailure ClusterMaintenance AccountBorrowOutstanding WouldExceedMaxBlockCostLimit UnsupportedVersion InvalidWritableAccount WouldExceedMaxAccountCostLimit WouldExceedAccountDataBlockLimit TooManyAccountLocks AddressLookupTableNotFound InvalidAddressLookupTableOwner InvalidAddressLookupTableData InvalidAddressLookupTableIndex InvalidRentPayingAccount WouldExceedMaxVoteCostLimit WouldExceedAccountDataTotalLimit MaxLoadedAccountsDataSizeExceeded InvalidLoadedAccountsDataSizeLimit ResanitizationNeeded UnbalancedTransaction ProgramCacheHitMaxLimit CommitCancelled BailOut`.split(' '));
const instructionUnits=new Set(`GenericError InvalidArgument InvalidInstructionData InvalidAccountData AccountDataTooSmall InsufficientFunds IncorrectProgramId MissingRequiredSignature AccountAlreadyInitialized UninitializedAccount UnbalancedInstruction ModifiedProgramId ExternalAccountLamportSpend ExternalAccountDataModified ReadonlyLamportChange ReadonlyDataModified DuplicateAccountIndex ExecutableModified RentEpochModified NotEnoughAccountKeys AccountDataSizeChanged AccountNotExecutable AccountBorrowFailed AccountBorrowOutstanding DuplicateAccountOutOfSync InvalidError ExecutableDataModified ExecutableLamportChange ExecutableAccountNotRentExempt UnsupportedProgramId CallDepth MissingAccount ReentrancyNotAllowed MaxSeedLengthExceeded InvalidSeeds InvalidRealloc ComputationalBudgetExceeded PrivilegeEscalation ProgramEnvironmentSetupFailure ProgramFailedToComplete ProgramFailedToCompile Immutable IncorrectAuthority BorshIoError AccountNotRentExempt InvalidAccountOwner ArithmeticOverflow UnsupportedSysvar IllegalOwner MaxAccountsDataAllocationsExceeded MaxAccountsExceeded MaxInstructionTraceLengthExceeded BuiltinProgramsMustConsumeComputeUnits BailOut`.split(' '));
const uint=(value,maximum)=>Number.isInteger(value)&&value>=0&&value<=maximum;
const exact=(value,keys)=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const index=(value,count)=>uint(value,255)&&value<count;
function instructionError(value){return typeof value==='string'?instructionUnits.has(value):exact(value,['Custom'])&&uint(value.Custom,4294967295);}

export function validTransactionError(value,{instructionCount=256,accountCount=256}={}){
 if(value===null)return true;
 if(typeof value==='string')return transactionUnits.has(value);
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==1)return false;
 if(Object.hasOwn(value,'InstructionError')){
  const tuple=value.InstructionError;return Array.isArray(tuple)&&tuple.length===2&&Object.keys(tuple).length===2&&index(tuple[0],instructionCount)&&instructionError(tuple[1]);
 }
 if(Object.hasOwn(value,'DuplicateInstruction'))return index(value.DuplicateInstruction,instructionCount);
 for(const tag of ['InsufficientFundsForRent','ProgramExecutionTemporarilyRestricted'])if(Object.hasOwn(value,tag))return exact(value[tag],['account_index'])&&index(value[tag].account_index,accountCount);
 return false;
}
