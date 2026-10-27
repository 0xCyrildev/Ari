/**
 * The simulation boundary (§13), and what an advisory answer is allowed to say.
 *
 * A simulation is a question asked of a chain that has not been asked to do
 * anything: `eth_call` runs the transaction against a real state root and throws
 * the result away. That makes it evidence about mechanics — does this calldata
 * decode, does this transfer revert, what would it cost — and *not* evidence about
 * broadcast, fee, nonce or finality. A10 is the rule this file is built around: an
 * advisory plane may refuse, may escalate, and may say nothing; it may never grant.
 * Nothing here can widen a policy, and the kernel reads exactly four booleans out
 * of it (`packages/policy-engine`'s `state.simulation`).
 *
 * The failure mode worth designing against is not a wrong answer, it is a *missing
 * answer read as a clean one*. So every shape here is distinguished: `SIMULATED_OK`
 * means the chain said this call would succeed; `SIMULATED_UNAVAILABLE` means nobody
 * answered, which is not the same sentence and is never allowed to become the same
 * value. `MockSimulationProvider` carries `trustworthy: false` on the type for the
 * same reason `MockSigningProvider` does — an absent feature is a smaller error than
 * a fake one presented as real.
 */

import type { CanonicalDigest, CandidateTransaction } from '@ari/schemas';

/** What the chain answered, in the vocabulary Ari keeps. */
export type SimulationStatus =
  /** The call executed and returned. The only status that may be read as "this would work". */
  | 'SIMULATED_OK'
  /** The call executed and reverted. A fact about the candidate, not about the infrastructure. */
  | 'SIMULATED_REVERT'
  /** This provider cannot express the candidate at all — a bitcoin request, an asset with no contract. */
  | 'SIMULATED_UNSUPPORTED'
  /** The provider was reachable and declined to answer: no block, a timeout, a chain it is not. */
  | 'SIMULATED_UNAVAILABLE';

/**
 * Why there is no answer, from a closed list.
 *
 * The list is closed because the reason is what a *policy* can act on: an operator
 * choosing `onSimulationUnavailable: deny` should know whether that means "our node is
 * down" or "this wallet has no address on file", and a free-text field cannot be
 * branched on without someone eventually branching on a substring of a node's error
 * message. Provider text is mapped onto this list in `describeError`, never trusted
 * inside it.
 */
export type UnavailableReason =
  | 'NOT_SUPPORTED_BY_PROVIDER'
  | 'WALLET_ADDRESS_UNKNOWN'
  /**
   * The amount cannot become an ABI word — it does not fit a `uint256`. Not a question about the
   * chain: `amount.raw` is an unbounded non-negative bigint, and the encoder used to answer with a
   * 68.5-byte calldata for it, which a node reports on as a revert. A malformed call we produced must
   * never be readable as a fact the chain asserted, so it is refused here, before any `eth_call`.
   */
  | 'VALUE_NOT_UINT256'
  /**
   * The address being called has no code on this chain. `eth_call` answers `0x` for a
   * call to a plain account, which is indistinguishable from a token that returns nothing
   * on success — so without this check a payment to an EOA, or to a contract that was
   * never deployed here, reads as a simulation that succeeded.
   */
  | 'TARGET_HAS_NO_CODE'
  | 'CHAIN_ID_MISMATCH'
  | 'BLOCK_UNRESOLVED'
  | 'BLOCK_STALE'
  | 'RPC_UNREACHABLE'
  | 'RPC_TIMEOUT'
  | 'RPC_ERROR'
  /** The provider answered, and the answer was not something this file can interpret. */
  | 'RPC_UNPARSEABLE';

export interface SimulationResult {
  readonly status: SimulationStatus;
  readonly provider: string;
  /**
   * False for any result produced by a mock, on the type. A dashboard, an export or a
   * report that renders a simulation must read this to render it honestly; the same
   * invariant S12 enforces on a signature.
   */
  readonly trustworthy: boolean;
  /**
   * The digest this answer is *about*, derived by the canonicaliser itself rather than
   * accepted from a caller. The pipeline compares it against the digest the kernel
   * evaluated, and the Phase 7 gate is that comparison: simulate bytes A and sign bytes
   * B is T10 with a network call in the middle.
   */
  readonly digest: CanonicalDigest | null;
  /** The projection the kernel reads. Derived here once, so no consumer re-derives it. */
  readonly available: boolean;
  readonly success: boolean;
  readonly mismatch: boolean;
  readonly warningCount: number;
  /** Named things worth seeing that the status does not carry: a non-standard return, a gas figure. */
  readonly warnings: readonly string[];
  /** Only ever one of the codes in `UnavailableReason`. */
  readonly reason: UnavailableReason | null;
  /** What reverted, classified. Never a node's own sentence — see `describeError`. */
  readonly revert: string | null;
  readonly gasUsed: string | null;
  readonly returnData: string | null;
  readonly chainId: string | null;
  readonly blockNumber: string | null;
  readonly blockTimestampSeconds: number | null;
  /** Set only when the answer is about *this* candidate, which is what `digest` binds. */
  readonly requestedAt: number;
}

export interface SimulationSubject {
  /** Already parsed by the gateway's schema, so it is a `CandidateTransaction` and not a request body. */
  readonly candidate: CandidateTransaction;
  /** The digest is derived with the policy version in it, exactly as the kernel's is. */
  readonly policyVersionId: string;
  /**
   * The wallet's chain address, or null when nobody has recorded one. An ERC-20
   * `transfer` is `from` an address, so without this there is nothing to simulate —
   * and "no address on file" is a different answer from "the chain says no".
   */
  readonly walletAddress: string | null;
}

export interface SimulationProvider {
  readonly name: string;
  /**
   * Asked before the network *and* before any wallet row is read, because the pipeline has
   * to be able to learn "this provider has nothing to say about a bitcoin request" without
   * paying for either. It is a claim about the candidate's shape, not about whether this
   * particular wallet can be simulated — that distinction is what keeps a bitcoin tenant
   * from paying a grant read per request to find out.
   */
  supports(candidate: CandidateTransaction): boolean;
  simulate(subject: SimulationSubject): Promise<SimulationResult>;
}

/** The four fields the kernel's `state.simulation` holds, and nothing else. */
export function kernelProjection(result: SimulationResult): {
  available: boolean;
  success: boolean;
  mismatch: boolean;
  warningCount: number;
} {
  return {
    available: result.available,
    success: result.success,
    mismatch: result.mismatch,
    warningCount: result.warningCount,
  };
}

function result(input: Omit<SimulationResult, 'trustworthy'> & { readonly trustworthy?: boolean }): SimulationResult {
  return { trustworthy: false, ...input };
}

/**
 * The provider for "no chain is configured", which is a different thing from the mock.
 *
 * `NoneSimulationProvider` answers `SIMULATED_UNSUPPORTED` for everything, which a
 * policy's `onSimulationUnavailable` then decides — the composition root's absence is
 * not allowed to become a silent pass *or* a silent deny. The counter is the witness
 * (A9): a test that claims "a denied request never reached the simulation plane" needs
 * to be able to ask whether it was called, and an absence is invisible to a log line.
 */
export class NoneSimulationProvider implements SimulationProvider {
  readonly name = 'none';
  invocations = 0;

  supports(): boolean {
    return false;
  }

  async simulate(_subject: SimulationSubject): Promise<SimulationResult> {
    this.invocations += 1;
    return unavailable({ provider: this.name, digest: null, reason: 'NOT_SUPPORTED_BY_PROVIDER' });
  }
}

/**
 * Records what it was asked and says the candidate would succeed.
 *
 * It cannot say anything else, which is the point: a fixture that always agrees is the
 * right tool for wiring tests and the wrong tool for claims about a chain, so the type
 * carries `trustworthy: false` and every consumer has to look at it. `MockSigningProvider`
 * works the same way for the same reason.
 */
export class MockSimulationProvider implements SimulationProvider {
  readonly name = 'mock';
  invocations = 0;
  readonly digests: CanonicalDigest[] = [];

  /**
   * `derive` is required, and that is the design rather than an inconvenience. The mock
   * must be able to say *which candidate* it answered about, and the only honest way for it
   * to know is to be given the canonicaliser — one implementation, in
   * `@ari/transaction-engine`, the same one the kernel and the signer use. A mock that
   * invented a digest would let a test pass the binding check against a value nothing
   * derived, which is the hole the check exists to close.
   */
  constructor(private readonly derive: (subject: SimulationSubject) => CanonicalDigest) {}

  supports(): boolean {
    return true;
  }

  async simulate(subject: SimulationSubject): Promise<SimulationResult> {
    this.invocations += 1;
    const digest = this.derive(subject);
    this.digests.push(digest);
    return result({
      status: 'SIMULATED_OK',
      provider: this.name,
      trustworthy: false,
      digest,
      available: true,
      success: true,
      mismatch: false,
      warnings: ['produced by a mock; no chain was consulted'],
      warningCount: 1,
      reason: null,
      revert: null,
      gasUsed: '0',
      returnData: '0x',
      chainId: null,
      blockNumber: null,
      blockTimestampSeconds: null,
      requestedAt: Date.now(),
    });
  }
}



/**
 * No answer, and a `SIMULATED_UNAVAILABLE` shape that cannot be misread as a clean one.
 *
 * `success` is false and `mismatch` is false together, which is deliberate: the kernel's
 * arms run on `available` first (`SIMULATION_UNAVAILABLE` via the policy's fallback), so
 * a false `success` here never reaches the `SIMULATION_FAILED` denial. What matters is
 * that neither field can be read as "the chain approved it".
 */
export function unavailable(input: {
  provider: string;
  digest: CanonicalDigest | null;
  reason: UnavailableReason;
  warnings?: readonly string[];
  gasUsed?: string | null;
  returnData?: string | null;
  chainId?: string | null;
  blockNumber?: string | null;
  blockTimestampSeconds?: number | null;
}): SimulationResult {
  return result({
    status: 'SIMULATED_UNAVAILABLE',
    provider: input.provider,
    digest: input.digest,
    available: false,
    success: false,
    mismatch: false,
    warningCount: (input.warnings ?? []).length,
    warnings: input.warnings ?? [],
    reason: input.reason,
    revert: null,
    gasUsed: input.gasUsed ?? null,
    returnData: input.returnData ?? null,
    chainId: input.chainId ?? null,
    blockNumber: input.blockNumber ?? null,
    blockTimestampSeconds: input.blockTimestampSeconds ?? null,
    requestedAt: Date.now(),
  });
}

export { EvmForkProvider } from './evm.js';
export type { EvmProviderConfig } from './evm.js';
