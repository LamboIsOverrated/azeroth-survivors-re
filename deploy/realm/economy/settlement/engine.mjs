import { randomBytes } from "node:crypto";
import { SettlementStore, accountId } from "./store.mjs";
import {
  address,
  signingAddress,
  rawAtoms,
  safeInteger,
  decodeMint,
  decodeTokenAccount,
  transferTransaction,
  signedTransaction,
  signatureOf,
  signatureText,
  verifyDepositReceipt,
  TOKEN_PROGRAM,
} from "./protocol.mjs";

function validatedConfig(input) {
  if (!input || typeof input !== "object")
    throw new Error("Explicit settlement configuration required");
  const config = {
    version: 1,
    namespace: "LIVE_ATOMS",
    genesisHash: address(input.genesisHash),
    mint: address(input.mint),
    tokenProgram: TOKEN_PROGRAM,
    decimals: input.decimals,
    treasuryWallet: signingAddress(input.treasuryWallet),
    treasuryTokenAccount: address(input.treasuryTokenAccount),
  };
  if (
    !Number.isInteger(config.decimals) ||
    config.decimals < 0 ||
    config.decimals > 18 ||
    new Set([
      config.mint,
      config.treasuryWallet,
      config.treasuryTokenAccount,
      TOKEN_PROGRAM,
    ]).size !== 4
  )
    throw new Error("Invalid settlement configuration");
  return Object.freeze(config);
}
const terminal = (state) => ["settled", "failed", "expired"].includes(state);
function view(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    atoms: row.atoms,
    wallet: row.wallet,
    destinationTokenAccount: row.destination_token_account,
    state: row.state,
    signature: row.signature,
    signedTransaction: row.signed_transaction,
    blockhash: row.blockhash,
    lastValidBlockHeight: row.last_valid_block_height,
    blockhashSlot: row.blockhash_slot,
  };
}

export class SettlementEngine {
  static async open({
    dbPath,
    config: input,
    rpc,
    archiveRpc,
    signer,
    resolveWallet,
    now = Date.now,
  }) {
    const config = validatedConfig(input);
    if (
      typeof dbPath !== "string" ||
      !dbPath ||
      typeof rpc?.call !== "function" ||
      typeof resolveWallet !== "function"
    )
      throw new Error(
        "Durable path, trusted RPC and bound wallet resolver required",
      );
    if ((await rpc.call("getGenesisHash", [])) !== config.genesisHash)
      throw new Error("RPC network does not match pinned genesis hash");
    if (archiveRpc) {
      if (
        typeof archiveRpc.call !== "function" ||
        typeof rpc.sourceId !== "string" ||
        typeof archiveRpc.sourceId !== "string" ||
        !rpc.sourceId ||
        !archiveRpc.sourceId ||
        rpc.sourceId === archiveRpc.sourceId
      )
        throw new Error("Independent archival RPC source identity required");
      if ((await archiveRpc.call("getGenesisHash", [])) !== config.genesisHash)
        throw new Error("Archival RPC network mismatch");
    }
    const mint = await rpc.call("getAccountInfo", [
      config.mint,
      { encoding: "base64", commitment: "finalized" },
    ]);
    safeInteger(mint?.context?.slot);
    const mintState = decodeMint(mint.value, config.decimals);
    const treasury = await rpc.call("getAccountInfo", [
      config.treasuryTokenAccount,
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot: mint.context.slot,
      },
    ]);
    safeInteger(treasury?.context?.slot);
    if (
      treasury.context.slot < mint.context.slot ||
      BigInt(
        decodeTokenAccount(treasury.value, config.mint, config.treasuryWallet)
          .atoms,
      ) > BigInt(mintState.supply)
    )
      throw new Error("Treasury snapshot inconsistent with mint");
    const store = new SettlementStore(dbPath, config);
    return new SettlementEngine({
      config,
      rpc,
      archiveRpc,
      signer,
      resolveWallet,
      now,
      store,
    });
  }
  constructor({ config, ...state }) {
    Object.assign(this, state);
    Object.defineProperty(this, "config", { value: config, enumerable: true });
    this.db = state.store.db;
  }
  async wallet(id) {
    return signingAddress(await this.resolveWallet(accountId(id)));
  }
  balance(id) {
    return this.store.balance(id);
  }
  history(id) {
    return this.store.history(id);
  }
  getWithdrawal({ accountId: id, withdrawalId }) {
    return view(this.store.withdrawal(withdrawalId, id));
  }
  pendingWithdrawals() {
    return this.db
      .prepare(
        "SELECT * FROM live_withdrawals WHERE state IN ('reserved','signed','pending') ORDER BY created_at LIMIT 100",
      )
      .all()
      .map(view);
  }
  async tokenSnapshot(token, wallet, minSlot = 0, rpc = this.rpc) {
    const result = await rpc.call("getAccountInfo", [
      address(token),
      { encoding: "base64", commitment: "finalized", minContextSlot: minSlot },
    ]);
    safeInteger(result?.context?.slot);
    if (result.context.slot < minSlot) throw new Error("Stale token snapshot");
    return {
      ...decodeTokenAccount(result.value, this.config.mint, wallet),
      slot: result.context.slot,
    };
  }
  async assertReserveSolvent(minSlot = 0) {
    const treasury = await this.tokenSnapshot(
      this.config.treasuryTokenAccount,
      this.config.treasuryWallet,
      minSlot,
    );
    if (this.store.liabilities() > BigInt(treasury.atoms))
      throw new Error(
        "Treasury reserve reconciliation failed; payouts are frozen",
      );
    return treasury;
  }
  async createDepositIntent({ accountId: id, atoms, sourceTokenAccount }) {
    accountId(id);
    rawAtoms(atoms);
    address(sourceTokenAccount);
    const wallet = await this.wallet(id);
    if (
      sourceTokenAccount === this.config.treasuryTokenAccount ||
      wallet === this.config.treasuryWallet
    )
      throw new Error("Treasury cannot deposit to itself");
    const createdSlot = safeInteger(
      await this.rpc.call("getSlot", [{ commitment: "finalized" }]),
    );
    await this.tokenSnapshot(sourceTokenAccount, wallet, createdSlot);
    const nonce = randomBytes(32).toString("hex"),
      createdAt = safeInteger(this.now()),
      expiresAt = createdAt + 300000,
      memo = `realm:v1:deposit:${nonce}`;
    this.db
      .prepare(
        "INSERT INTO live_deposit_intents(id,account_id,wallet,source_token_account,atoms,memo,created_slot,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        nonce,
        id,
        wallet,
        sourceTokenAccount,
        atoms,
        memo,
        createdSlot,
        createdAt,
        expiresAt,
      );
    return {
      id: nonce,
      accountId: id,
      wallet,
      sourceTokenAccount,
      atoms,
      memo,
      createdSlot,
      createdAt,
      expiresAt,
    };
  }
  async confirmDeposit({ accountId: id, intentId, signature }) {
    accountId(id);
    signatureText(signature);
    const row = this.db
      .prepare("SELECT * FROM live_deposit_intents WHERE id=? AND account_id=?")
      .get(intentId, id);
    if (!row) throw new Error("Deposit intent not found for account");
    if (row.signature) {
      if (row.signature !== signature)
        throw new Error("Deposit intent already consumed");
      return this.balance(id);
    }
    const status = await this.status(this.rpc, signature, row.created_slot);
    if (status?.confirmationStatus !== "finalized" || status.err !== null)
      throw new Error("Deposit must finalize successfully");
    const receipt = await this.rpc.call("getTransaction", [
      signature,
      {
        encoding: "base64",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    const intent = {
      id: row.id,
      accountId: id,
      wallet: row.wallet,
      sourceTokenAccount: row.source_token_account,
      atoms: row.atoms,
      memo: row.memo,
      createdSlot: row.created_slot,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    const proof = verifyDepositReceipt({
      receipt,
      signature,
      intent,
      config: this.config,
    });
    if (proof.slot !== status.slot)
      throw new Error("Deposit RPC status and receipt disagree");
    const treasury = await this.tokenSnapshot(
      this.config.treasuryTokenAccount,
      this.config.treasuryWallet,
      proof.slot,
    );
    return this.store.transaction(() => {
      const prior = this.db
        .prepare("SELECT signature FROM live_deposit_intents WHERE id=?")
        .get(intentId);
      if (prior.signature) {
        if (prior.signature !== signature)
          throw new Error("Deposit intent already consumed");
        return this.balance(id);
      }
      if (
        this.store.liabilities() + rawAtoms(row.atoms) >
        BigInt(treasury.atoms)
      )
        throw new Error("Deposit is not backed by observed treasury reserve");
      this.db
        .prepare(
          "UPDATE live_deposit_intents SET signature=? WHERE id=? AND signature IS NULL",
        )
        .run(signature, intentId);
      this.store.append({
        operationId: `deposit:${signature}`,
        accountId: id,
        available: rawAtoms(row.atoms),
        kind: "deposit-finalized",
        now: this.now(),
      });
      return this.balance(id);
    });
  }
  async reserveWithdrawal({
    accountId: id,
    idempotencyKey,
    atoms,
    destinationTokenAccount,
  }) {
    accountId(id);
    const amount = rawAtoms(atoms);
    address(destinationTokenAccount);
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(idempotencyKey)
    )
      throw new Error("Stable withdrawal idempotency key required");
    const wallet = await this.wallet(id);
    if (
      wallet === this.config.treasuryWallet ||
      destinationTokenAccount === this.config.treasuryTokenAccount
    )
      throw new Error("Withdrawal destination cannot be treasury");
    await this.tokenSnapshot(destinationTokenAccount, wallet);
    const treasury = await this.tokenSnapshot(
      this.config.treasuryTokenAccount,
      this.config.treasuryWallet,
    );
    return this.store.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT * FROM live_withdrawals WHERE account_id=? AND request_key=?",
        )
        .get(id, idempotencyKey);
      if (prior) {
        if (
          prior.atoms !== atoms ||
          prior.wallet !== wallet ||
          prior.destination_token_account !== destinationTokenAccount
        )
          throw new Error("Withdrawal idempotency conflict");
        return view(prior);
      }
      if (this.store.liabilities() > BigInt(treasury.atoms))
        throw new Error("Treasury reserve reconciliation failed");
      const nonce = randomBytes(32).toString("hex"),
        time = this.now();
      this.store.append({
        operationId: `reserve:${nonce}`,
        accountId: id,
        available: -amount,
        reserved: amount,
        kind: "withdrawal-reserved",
        now: time,
      });
      this.db
        .prepare(
          "INSERT INTO live_withdrawals(id,account_id,request_key,wallet,destination_token_account,atoms,state,created_at) VALUES(?,?,?,?,?,?,'reserved',?)",
        )
        .run(
          nonce,
          id,
          idempotencyKey,
          wallet,
          destinationTokenAccount,
          atoms,
          time,
        );
      this.store.event(nonce, "reserved", time);
      return view(this.store.withdrawal(nonce, id));
    });
  }
  async prepareWithdrawal({ accountId: id, withdrawalId }) {
    const row = this.store.withdrawal(withdrawalId, id);
    if (row.state !== "reserved") return view(row);
    if (typeof this.signer?.signTransaction !== "function")
      throw new Error("Approved transaction-only signer is unavailable");
    const destination = await this.tokenSnapshot(
        row.destination_token_account,
        row.wallet,
      ),
      treasury = await this.assertReserveSolvent(destination.slot);
    const latest = await this.rpc.call("getLatestBlockhash", [
      { commitment: "finalized", minContextSlot: treasury.slot },
    ]);
    safeInteger(latest?.context?.slot);
    address(latest?.value?.blockhash);
    safeInteger(latest.value.lastValidBlockHeight);
    if (latest.context.slot < treasury.slot)
      throw new Error("Stale withdrawal blockhash");
    const tx = transferTransaction({
      wallet: this.config.treasuryWallet,
      source: this.config.treasuryTokenAccount,
      mint: this.config.mint,
      destination: row.destination_token_account,
      atoms: row.atoms,
      decimals: this.config.decimals,
      memo: `realm:v1:withdrawal:${row.id}`,
      blockhash: latest.value.blockhash,
    });
    const message = tx.serializeMessage(),
      unsigned = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
    const signed = signedTransaction(
      await this.signer.signTransaction(Uint8Array.from(unsigned)),
    );
    if (
      !signed.serializeMessage().equals(message) ||
      signed.signatures[0].publicKey.toBase58() !== this.config.treasuryWallet
    )
      throw new Error("Signer changed withdrawal transaction");
    const raw = signed.serialize().toString("base64"),
      signature = signatureOf(signed);
    return this.store.transaction(() => {
      const current = this.store.withdrawal(withdrawalId, id);
      if (current.state !== "reserved") return view(current);
      this.db
        .prepare(
          "UPDATE live_withdrawals SET state='signed',signed_transaction=?,signature=?,blockhash=?,last_valid_block_height=?,blockhash_slot=? WHERE id=? AND state='reserved'",
        )
        .run(
          raw,
          signature,
          latest.value.blockhash,
          latest.value.lastValidBlockHeight,
          latest.context.slot,
          withdrawalId,
        );
      this.store.event(withdrawalId, "signed", this.now());
      return view(this.store.withdrawal(withdrawalId, id));
    });
  }
  async broadcastWithdrawal({ accountId: id, withdrawalId }) {
    const snapshot = this.store.withdrawal(withdrawalId, id);
    if (terminal(snapshot.state)) return view(snapshot);
    if (!["signed", "pending"].includes(snapshot.state))
      throw new Error("Withdrawal has no durable signed transaction");
    await this.assertReserveSolvent(snapshot.blockhash_slot);
    const row = this.store.transaction(() => {
      const current = this.store.withdrawal(withdrawalId, id);
      if (terminal(current.state)) return current;
      if (
        !["signed", "pending"].includes(current.state) ||
        !current.signed_transaction ||
        !current.signature
      )
        throw new Error("Withdrawal has no durable signed transaction");
      if (current.state === "signed") {
        this.db
          .prepare("UPDATE live_withdrawals SET state='pending' WHERE id=?")
          .run(withdrawalId);
        this.store.event(withdrawalId, "pending", this.now());
      }
      return this.store.withdrawal(withdrawalId, id);
    });
    if (terminal(row.state)) return view(row);
    try {
      const result = await this.rpc.call("sendTransaction", [
        row.signed_transaction,
        {
          encoding: "base64",
          skipPreflight: false,
          maxRetries: 0,
          preflightCommitment: "finalized",
          minContextSlot: row.blockhash_slot,
        },
      ]);
      if (result !== row.signature)
        throw new Error("RPC returned a different signature");
    } catch {
      /* Timeout, preflight errors and mismatched responses cannot prove non-execution. Keep reserved. */
    }
    return this.getWithdrawal({ accountId: id, withdrawalId });
  }
  async status(rpc, signature, minSlot = 0) {
    const result = await rpc.call("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    safeInteger(result?.context?.slot);
    if (
      result.context.slot < minSlot ||
      !Array.isArray(result.value) ||
      result.value.length !== 1
    )
      throw new Error("Invalid/stale signature status");
    const status = result.value[0];
    if (status !== null) {
      safeInteger(status.slot);
      if (
        status.slot > result.context.slot ||
        status.slot < minSlot ||
        !["processed", "confirmed", "finalized"].includes(
          status.confirmationStatus,
        ) ||
        !Object.hasOwn(status, "err")
      )
        throw new Error("Malformed transaction status");
    }
    return status;
  }
  async expiryWitness(rpc, row) {
    const height = safeInteger(
      await rpc.call("getBlockHeight", [
        { commitment: "finalized", minContextSlot: row.blockhash_slot },
      ]),
    );
    if (height <= row.last_valid_block_height) return false;
    const validity = await rpc.call("isBlockhashValid", [
      row.blockhash,
      { commitment: "finalized", minContextSlot: row.blockhash_slot },
    ]);
    safeInteger(validity?.context?.slot);
    if (validity.context.slot < row.blockhash_slot || validity.value !== false)
      return false;
    const floor = safeInteger(await rpc.call("getFirstAvailableBlock", []));
    if (floor > row.blockhash_slot) return false;
    if ((await this.status(rpc, row.signature, validity.context.slot)) !== null)
      return false;
    const receipt = await rpc.call("getTransaction", [
      row.signature,
      {
        encoding: "base64",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    return receipt === null;
  }
  async reconcileWithdrawal({ accountId: id, withdrawalId }) {
    const row = this.store.withdrawal(withdrawalId, id);
    if (terminal(row.state) || row.state === "reserved") return view(row);
    let state;
    try {
      const status = await this.status(
        this.rpc,
        row.signature,
        row.blockhash_slot,
      );
      if (status?.confirmationStatus === "finalized")
        state = status.err === null ? "settled" : "failed";
      else if (
        status === null &&
        this.archiveRpc &&
        (await this.expiryWitness(this.rpc, row)) &&
        (await this.expiryWitness(this.archiveRpc, row))
      )
        state = "expired";
    } catch {
      return view(this.store.withdrawal(withdrawalId, id));
    }
    if (!state) return view(this.store.withdrawal(withdrawalId, id));
    return this.store.transaction(() => {
      const current = this.store.withdrawal(withdrawalId, id);
      if (terminal(current.state)) return view(current);
      const amount = rawAtoms(current.atoms),
        release = state !== "settled";
      this.store.append({
        operationId: `${release ? "release" : "settle"}:${row.id}`,
        accountId: id,
        available: release ? amount : 0n,
        reserved: -amount,
        kind: `withdrawal-${state}`,
        now: this.now(),
      });
      this.db
        .prepare("UPDATE live_withdrawals SET state=? WHERE id=?")
        .run(state, withdrawalId);
      this.store.event(withdrawalId, state, this.now());
      return view(this.store.withdrawal(withdrawalId, id));
    });
  }
  close() {
    this.store.close();
  }
}
