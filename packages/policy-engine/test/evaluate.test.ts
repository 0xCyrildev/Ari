import { Decision, type Decision as EngineDecision, type ReasonCode } from '@ari/schemas';
import { computeDigest } from '@ari/transaction-engine';
import { describe, expect, it } from 'vitest';
import { compilePolicy, evaluate, PolicyCompilationError, type CompiledPolicy, type EvaluationState } from '../src/index.js';
import {
  CAP,
  DAY_CAP,
  ESCALATE_ABOVE,
  MONTH_CAP,
  NOVEL,
  NOW_MS,
  POLICY_ID,
  PERMITTED,
  RECIPIENT,
  UNIT,
  USDC,
  VERSION_ID,
  candidate,
  compiled,
  contractCand,
  doc,
  policyWith,
  risk,
  state,
  transfersBlock,
  unknownCand,
  withCondition,
  withValidity,
} from './fixtures.js';

const NEVER_ESCALATE = withCondition(null);

function decide(over: {
  policy?: CompiledPolicy;
  cand?: ReturnType<typeof candidate>;
  st?: ReturnType<typeof state>;
} = {}): EngineDecision {
  const policy = over.policy ?? compiled();
  const cand = over.cand ?? candidate();
  const st = over.st ?? state();
  const decision = evaluate({ policy, candidate: cand, state: st });
  // Every decision the engine produces must be a decision the schema admits: a
  // reason code outside the closed vocabulary or a missing required field is a
  // broken audit record, not a slightly odd object.
  const parsed = Decision.safeParse(decision);
  if (!parsed.success) throw new Error(`decision is not a Decision: ${parsed.error.message}`);
  return decision;
}

function deniedWith(code: ReasonCode, over: Parameters<typeof decide>[0] = {}): EngineDecision {
  const decision = decide(over);
  expect(decision.outcome, `expected DENY for ${code}`).toBe('DENY');
  if (decision.outcome !== 'DENY') throw new Error('unreachable');
  expect(decision.reasonCodes).toContain(code);
  return decision;
}

function usage(over: Partial<EvaluationState['usage']>): EvaluationState {
  return state({
    usage: { reservedDayRaw: 0n, reservedMonthRaw: 0n, transactionsLastHour: 0, ikaSpentTodayRaw: 0n, ...over },
  });
}

describe('stage 1 — identity', () => {
  it('allows an active agent holding the transaction:request scope', () => {
    expect(decide().outcome).toBe('ALLOW');
  });

  it('denies a revoked agent, and says which', () => {
    deniedWith('AGENT_REVOKED', { st: state({ agentStatus: 'REVOKED' }) });
  });

  it('denies a paused agent distinctly from a revoked one', () => {
    deniedWith('AGENT_PAUSED', { st: state({ agentStatus: 'PAUSED' }) });
  });

  it('denies a credential without the scope rather than reading absence as grant', () => {
    deniedWith('SCOPE_MISSING', { st: state({ scopes: ['policy:read'] }) });
  });
});

describe('stage 2 — what the engine refuses to measure at all', () => {
  it('denies an unknown transaction kind with a reason, not an exception', () => {
    const decision = deniedWith('TRANSACTION_UNKNOWN', { cand: unknownCand() });
    expect(decision.matchedRules.at(-1)?.detail).toContain('sui');
  });

  it('denies a contract call under a policy that forbids contract calls', () => {
    deniedWith('CONTRACTS_NOT_ALLOWED', { cand: contractCand() });
  });

  it('denies an unlisted contract before any amount check runs', () => {
    deniedWith('CONTRACT_NOT_ALLOWED', {
      policy: policyWith({
        transfers: transfersBlock({ perTransaction: { maxRaw: '1', unit: UNIT } }),
        contractCalls: { enabled: true, contracts: [`0x${'a'.repeat(40)}`] },
        newRecipients: { allowed: false, requireApproval: false },
      }),
      cand: contractCand(),
    });
  });

  it('denies a transfer under a transfers-disabled policy', () => {
    deniedWith('TRANSFER_TYPE_DISABLED', {
      policy: policyWith({
        transfers: transfersBlock({ enabled: false, assets: [] }),
        contractCalls: { enabled: false, contracts: [] },
        newRecipients: { allowed: false, requireApproval: false },
      }),
    });
  });
});

describe('stage 3 — time', () => {
  it('denies before the policy is valid', () => {
    deniedWith('POLICY_NOT_YET_VALID', { policy: withValidity({ notBefore: '2027-01-01T00:00:00.000Z' }) });
  });

  it('denies after the policy expires', () => {
    deniedWith('POLICY_EXPIRED', { policy: withValidity({ notAfter: '2026-01-01T00:00:00.000Z' }) });
  });

  it('denies a deadline that has already passed', () => {
    deniedWith('DEADLINE_EXPIRED', { cand: candidate({ deadline: '2026-09-25T10:59:59.000Z' }) });
  });

  it('guards a deadline it was never meant to see, rather than skipping the check', () => {
    // The parser refuses a non-ISO deadline long before this stage, so the path is
    // unreachable through a valid candidate — and `evaluate` is still total, which
    // is what is under test: an impossible input produces a DENY, not a throw.
    const junk = { ...candidate(), deadline: 'tomorrow-ish' } as unknown as ReturnType<typeof candidate>;
    const decision = evaluate({ policy: compiled(), candidate: junk, state: state() });
    expect(decision.outcome).toBe('DENY');
    if (decision.outcome === 'DENY') expect(decision.reasonCodes).toEqual(['INTERNAL_ERROR_FAIL_CLOSED']);
  });
});

describe('stage 4 — what may be moved where', () => {
  it('denies an unsupported chain', () => {
    deniedWith('CHAIN_NOT_SUPPORTED', { cand: candidate({ chain: 'bitcoin' }) });
  });

  it('denies an asset the policy never listed, on a permitted chain', () => {
    deniedWith('ASSET_NOT_ALLOWED', { cand: candidate({ asset: { kind: 'native', chain: 'ethereum' } }) });
  });

  it('denies an unfamiliar contract behind a familiar symbol: two USDCs are not one asset', () => {
    deniedWith('ASSET_NOT_ALLOWED', {
      cand: candidate({
        asset: { kind: 'erc20', chain: 'ethereum', contract: `0x${'7'.repeat(40)}`, symbol: 'USDC', decimals: 6 },
      }),
    });
  });

  it('escalates an unknown recipient when the policy offers approval for new ones', () => {
    expect(decide({ cand: candidate({ recipient: { chain: 'ethereum', address: NOVEL } }) }).outcome).toBe(
      'REQUIRE_HUMAN_APPROVAL',
    );
  });

  it('denies an unknown recipient outright when approval is not offered', () => {
    deniedWith('RECIPIENT_NOT_IN_ALLOWLIST', {
      policy: policyWith({
        transfers: transfersBlock({ assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 }] }),
        newRecipients: { allowed: false, requireApproval: false },
      }),
      cand: candidate({ recipient: { chain: 'ethereum', address: NOVEL } }),
    });
  });
});

describe('stage 5 — money, and the boundaries where an off-by-one moves funds', () => {
  it('refuses a zero amount with a code that does not claim it was too large', () => {
    const decision = deniedWith('AMOUNT_ZERO', { cand: candidate({ amount: { raw: '0', unit: UNIT } }) });
    expect(decision.reasonCodes).not.toContain('AMOUNT_EXCEEDS_PER_TRANSACTION');
  });

  it('allows exactly at the per-transaction cap and denies one unit above', () => {
    expect(decide({ policy: NEVER_ESCALATE, cand: candidate({ amount: { raw: CAP.toString(), unit: UNIT } }) }).outcome).toBe('ALLOW');
    deniedWith('AMOUNT_EXCEEDS_PER_TRANSACTION', { cand: candidate({ amount: { raw: (CAP + 1n).toString(), unit: UNIT } }) });
  });

  it('counts the daily window as reserved plus this request, at the boundary both ways', () => {
    // The second of two requests that exactly fills the cap must be allowed and
    // one unit more must not: that boundary is where a non-atomic implementation
    // is wrong under concurrency.
    expect(
      decide({
        policy: NEVER_ESCALATE,
        st: usage({ reservedDayRaw: DAY_CAP - PERMITTED }),
      }).outcome,
    ).toBe('ALLOW');

    const over = deniedWith('AMOUNT_EXCEEDS_DAILY_LIMIT', {
      policy: NEVER_ESCALATE,
      st: usage({ reservedDayRaw: DAY_CAP - PERMITTED + 1n }),
    });
    expect(over.reasonCodes).toContain('LIMIT_RESERVATION_FAILED');
  });

  it('enforces the monthly ceiling separately from the daily one', () => {
    deniedWith('AMOUNT_EXCEEDS_MONTHLY_LIMIT', { st: usage({ reservedMonthRaw: MONTH_CAP - PERMITTED + 1n }) });
  });

  it('fails closed when the amount speaks a different unit than the limits', () => {
    // Comparing 2,000,000,000 of one unit against 2,000,000,000 of another is the
    // difference between paying $2,000 and $2bn.
    const decision = deniedWith('INTERNAL_ERROR_FAIL_CLOSED', {
      cand: candidate({ amount: { raw: '99999999999999999', unit: 'wei' } }),
    });
    expect(decision.reasonCodes).not.toContain('AMOUNT_EXCEEDS_PER_TRANSACTION');
    expect(decision.matchedRules.at(-1)?.detail).toContain('unit');
  });

  it('denies the 21st transaction in an hour and allows the 20th', () => {
    deniedWith('VELOCITY_EXCEEDS_HOURLY_LIMIT', { st: usage({ transactionsLastHour: 20 }) });
    expect(decide({ st: usage({ transactionsLastHour: 19 }) }).outcome).toBe('ALLOW');
  });
});

describe('stage 6 — deny before the cost is incurred', () => {
  it('denies at the signing budget ceiling', () => {
    deniedWith('SIGNING_BUDGET_EXCEEDED', { st: usage({ ikaSpentTodayRaw: 5000000n }) });
  });

  it('allows at the alert level but records the warning on the allowance', () => {
    const decision = decide({ st: usage({ ikaSpentTodayRaw: 2500000n }) });
    expect(decision.outcome).toBe('ALLOW');
    expect(decision.reasonCodes).toContain('SIGNING_BUDGET_EXCEEDED');
  });
});

describe('stage 7 — risk and simulation may escalate, never grant', () => {
  it('denies a missing risk assessment when the policy says deny-on-unavailable', () => {
    deniedWith('RISK_ENGINE_UNAVAILABLE', {
      policy: compiled({
        fallback: {
          onUnknownTransaction: 'deny',
          onEvaluationError: 'deny',
          onRiskUnavailable: 'deny',
          onSimulationUnavailable: 'allow_advisory',
        },
      }),
    });
  });

  it('denies on a simulation mismatch', () => {
    deniedWith('SIMULATION_MISMATCH', {
      st: state({ simulation: { available: true, success: true, mismatch: true, warningCount: 0 } }),
    });
  });

  it('denies a simulation that reports failure', () => {
    deniedWith('SIMULATION_FAILED', {
      st: state({ simulation: { available: true, success: false, mismatch: false, warningCount: 3 } }),
    });
  });

  it('refuses to read an absent simulation as a passing one when the policy says deny', () => {
    deniedWith('SIMULATION_UNAVAILABLE', {
      policy: compiled({
        fallback: {
          onUnknownTransaction: 'deny',
          onEvaluationError: 'deny',
          onRiskUnavailable: 'escalate',
          onSimulationUnavailable: 'deny',
        },
      }),
      st: state({ simulation: { available: false, success: false, mismatch: false, warningCount: 0 } }),
    });
  });

  it('escalates a missing risk assessment when the policy asked for exactly that', () => {
    // `onRiskUnavailable: 'escalate'` is a promise that an unassessed request goes
    // to a human. A `risk_gte` condition that reported "not triggered" because the
    // assessment is absent would be the quiet version of the same bug.
    const decision = decide({ policy: withCondition({ op: 'risk_gte', level: 'HIGH' }) });
    expect(decision.outcome).toBe('REQUIRE_HUMAN_APPROVAL');
    if (decision.outcome === 'REQUIRE_HUMAN_APPROVAL') {
      expect(decision.reasonCodes).toContain('RISK_ESCALATION_REQUIRED');
    }
  });

  it('a CRITICAL risk assessment never turns a denial into an allowance', () => {
    const cand = candidate({ amount: { raw: (CAP + 1n).toString(), unit: UNIT } });
    expect(decide({ cand }).outcome).toBe('DENY');
    expect(decide({ cand, st: state({ risk: risk('CRITICAL') }) }).outcome).not.toBe('ALLOW');
  });
});

describe('stage 8 — escalation conditions', () => {
  it('escalates strictly above the amount threshold, not at it', () => {
    expect(decide({ cand: candidate({ amount: { raw: ESCALATE_ABOVE.toString(), unit: UNIT } }) }).outcome).toBe('ALLOW');
    expect(decide({ cand: candidate({ amount: { raw: (ESCALATE_ABOVE + 1n).toString(), unit: UNIT } }) }).outcome).toBe(
      'REQUIRE_HUMAN_APPROVAL',
    );
  });

  it('escalates on an asset outside the behavioural baseline', () => {
    const decision = decide({
      policy: withCondition({ op: 'asset_not_in_baseline' }),
      st: state({ history: { knownRecipientAddresses: new Set([RECIPIENT]), baselineAssets: new Set(), baselineChains: new Set(['ethereum']), firstSeenWithinDays: () => false } }),
    });
    expect(decision.outcome).toBe('REQUIRE_HUMAN_APPROVAL');
  });

  it('escalates on a chain outside the baseline', () => {
    const decision = decide({
      policy: withCondition({ op: 'chain_not_in_baseline' }),
      st: state({ history: { knownRecipientAddresses: new Set([RECIPIENT]), baselineAssets: new Set(), baselineChains: new Set(), firstSeenWithinDays: () => false } }),
    });
    expect(decision.outcome).toBe('REQUIRE_HUMAN_APPROVAL');
  });

  it('escalates a recipient seen for the first time within the window', () => {
    const policy = withCondition(
      { op: 'recipient_first_seen_within_days', days: 30 },
      { newRecipients: { allowed: true, requireApproval: false } },
    );
    const st = state({
      history: {
        knownRecipientAddresses: new Set(),
        baselineAssets: new Set([`erc20:ethereum:${USDC}`]),
        baselineChains: new Set(['ethereum']),
        firstSeenWithinDays: () => true,
      },
    });
    const cand = candidate({ recipient: { chain: 'ethereum', address: NOVEL } });
    // Stage 4 admits the novel recipient because the policy permits new ones, so
    // the escalation below is the *condition* firing rather than a refusal two
    // stages earlier — which is the difference between "we never pay new
    // addresses" and "a human sees them first".
    expect(decide({ policy, cand, st }).outcome).toBe('REQUIRE_HUMAN_APPROVAL');
  });

  it('escalates at or above the requested risk level, and not below it', () => {
    const policy = withCondition({ op: 'risk_gte', level: 'HIGH' });
    expect(decide({ policy, st: state({ risk: risk('MEDIUM') }) }).outcome).toBe('ALLOW');
    expect(decide({ policy, st: state({ risk: risk('HIGH') }) }).outcome).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(decide({ policy, st: state({ risk: risk('CRITICAL') }) }).outcome).toBe('REQUIRE_HUMAN_APPROVAL');
  });

  it('treats a missing USD estimate as insufficient evidence, not as a passed threshold', () => {
    const policy = withCondition({ op: 'usd_gte', cents: '100000' });
    expect(decide({ policy }).outcome).toBe('DENY');
    expect(decide({ policy, st: state({ risk: risk('LOW') }) }).outcome).toBe('REQUIRE_HUMAN_APPROVAL');
  });

  it('escalates on a stale or future-dated FX estimate instead of clearing the threshold', () => {
    const policy = withCondition({ op: 'usd_gte', cents: '999999999999' });
    const fresh = candidate({ usdEstimate: { cents: '100000', asOf: '2026-09-25T10:59:30.000Z', source: 'fixture' } });
    expect(decide({ policy, cand: fresh }).outcome).toBe('ALLOW');
    expect(
      decide({ policy, cand: candidate({ usdEstimate: { cents: '100000', asOf: '2026-09-25T09:00:00.000Z', source: 'fixture' } }) }).outcome,
    ).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(
      decide({ policy, cand: candidate({ usdEstimate: { cents: '100000', asOf: '2027-09-25T09:00:00.000Z', source: 'fixture' } }) }).outcome,
    ).toBe('REQUIRE_HUMAN_APPROVAL');
  });

  it('escalates outside business hours, honours the window, and wraps midnight', () => {
    const policy = withCondition({ op: 'time_out_of_hours_window', window: '08:00-18:00' });
    // The fixture clock is 11:00 UTC, inside the window. The deadline is pushed
    // past every "now" used below, because an expired deadline is a DENY that
    // would otherwise arrive before the time-of-day rule is ever consulted.
    const late = candidate({ deadline: '2026-09-26T00:00:00.000Z' });
    expect(decide({ policy, cand: late }).outcome).toBe('ALLOW');
    expect(
      decide({
        policy,
        cand: late,
        st: state({ nowMs: BigInt(Date.parse('2026-09-25T20:00:00.000Z')) }),
      }).outcome,
    ).toBe('REQUIRE_HUMAN_APPROVAL');
    const wrapped = withCondition({ op: 'time_out_of_hours_window', window: '22:00-06:00' });
    expect(
      decide({
        policy: wrapped,
        cand: late,
        st: state({ nowMs: BigInt(Date.parse('2026-09-25T02:00:00.000Z')) }),
      }).outcome,
    ).toBe('ALLOW');
  });

  it('fails closed on a malformed time window instead of skipping the guard', () => {
    deniedWith('INTERNAL_ERROR_FAIL_CLOSED', { policy: withCondition({ op: 'time_out_of_hours_window', window: 'office hours' }) });
  });

  it('escalates on velocity below the hard limit, so a soft ceiling is still a ceiling', () => {
    expect(decide({ policy: withCondition({ op: 'velocity_gt_per_hour', count: 5 }), st: usage({ transactionsLastHour: 6 }) }).outcome).toBe(
      'REQUIRE_HUMAN_APPROVAL',
    );
  });

  it('escalates on a recipient not in the allowlist', () => {
    expect(decide({ policy: withCondition({ op: 'recipient_not_in_allowlist' }), cand: candidate({ recipient: { chain: 'ethereum', address: NOVEL } }) }).outcome).toBe(
      'REQUIRE_HUMAN_APPROVAL',
    );
  });

  it('names the condition as the reason when new recipients are otherwise permitted', () => {
    // The fixture policy forbids novel recipients outright, so the test above
    // escalates at the permission stage. With new recipients allowed, the only
    // thing left that can ask for a human is the condition — and it has to say so,
    // because "a rule wanted a person" and "the allowlist did not contain them"
    // are different answers for whoever reads the trace.
    const decision = decide({
      policy: withCondition({ op: 'recipient_not_in_allowlist' }, { newRecipients: { allowed: true, requireApproval: false } }),
      cand: candidate({ recipient: { chain: 'ethereum', address: NOVEL } }),
    });
    expect(decision.outcome).toBe('REQUIRE_HUMAN_APPROVAL');
    if (decision.outcome !== 'REQUIRE_HUMAN_APPROVAL') return;
    expect(decision.reasonCodes).toContain('RECIPIENT_NOT_ALLOWED');
    expect(decision.matchedRules.at(-1)?.rulePath).toContain('requiredWhen');
  });

  it('denies a contract outside the allowlist, naming the rule that refused', () => {
    const policy = policyWith({
      transfers: transfersBlock(),
      contractCalls: { enabled: true, contracts: [] },
      newRecipients: { allowed: false, requireApproval: false },
    });
    deniedWith('CONTRACT_NOT_ALLOWED', { policy, cand: contractCand() });
  });
});

describe('stage 8 — escalation conditions against a permitted contract call', () => {
  const contractAllowed = { contractCalls: { enabled: true, contracts: [USDC] } };

  it('lets a listed contract call through, with no transfer limit applied to it', () => {
    const decision = decide({
      policy: withCondition(null, contractAllowed),
      cand: contractCand({ value: (CAP * 10n).toString() }),
    });
    // The huge `value` is the point: an ETH amount must not be measured against a
    // USDC ceiling, and comparing them would be the unit bug wearing a different
    // label. Contract-call amounts belong to a limit dimension this fixture
    // policy does not have.
    expect(decision.outcome).toBe('ALLOW');
  });

  it('does not read an amount threshold as satisfied by a transaction with no transfer amount', () => {
    expect(
      decide({
        policy: withCondition({ op: 'amount_gt', raw: '1', unit: UNIT }, contractAllowed),
        cand: contractCand(),
      }).outcome,
    ).toBe('ALLOW');
  });

  it('fails closed when an amount threshold names a unit the policy does not use', () => {
    // Not an oversight in the policy author's file: a comparison between two units
    // has no correct answer, so the rule reports itself as broken.
    deniedWith('INTERNAL_ERROR_FAIL_CLOSED', {
      policy: withCondition({ op: 'amount_gt', raw: '1', unit: 'gwei' }),
      cand: candidate({ amount: { raw: (ESCALATE_ABOVE + 1n).toString(), unit: UNIT } }),
    });
  });

  it('treats a missing USD estimate as unmet evidence even for a contract call', () => {
    expect(
      decide({
        policy: withCondition({ op: 'usd_gte', cents: '1' }, contractAllowed),
        cand: contractCand(),
      }).outcome,
    ).toBe('DENY');
  });

  it('skips the recipient rules for a transaction that has no recipient', () => {
    for (const condition of [
      { op: 'recipient_not_in_allowlist' },
      { op: 'recipient_first_seen_within_days', days: 30 },
    ]) {
      expect(
        decide({ policy: withCondition(condition, contractAllowed), cand: contractCand() }).outcome,
      ).toBe('ALLOW');
    }
  });

  it('does not read a contract call as a novel asset', () => {
    expect(
      decide({ policy: withCondition({ op: 'asset_not_in_baseline' }, contractAllowed), cand: contractCand() }).outcome,
    ).toBe('ALLOW');
  });

  it('compares a contract call against the chain baseline', () => {
    expect(
      decide({
        policy: withCondition({ op: 'chain_not_in_baseline' }, contractAllowed),
        cand: contractCand(),
      }).outcome,
    ).toBe('ALLOW');
  });
});

describe('compilePolicy — the unit mismatches that would otherwise be silent', () => {
  const ids = { policyId: POLICY_ID, versionId: VERSION_ID, versionNumber: 1 };

  function documentWithTransfers(overrides: Record<string, unknown>) {
    const document = doc();
    Object.assign(document.permissions.transfers as unknown as Record<string, unknown>, overrides);
    return document;
  }

  it('refuses a per-day limit in a different unit from the per-transaction limit', () => {
    const document = documentWithTransfers({ perDay: { maxRaw: '25000000000', unit: 'usdc-8dp' } });
    expect(() => compilePolicy(document, ids)).toThrow(PolicyCompilationError);
  });

  it('refuses a per-month limit whose unit disagrees', () => {
    const document = documentWithTransfers({ perMonth: { maxRaw: '200000000000', unit: 'usdc-8dp' } });
    expect(() => compilePolicy(document, ids)).toThrow(/per-month limit unit mismatch/);
  });

  it('compiles an absent monthly limit to nothing rather than to zero', () => {
    const compiledWithout = compilePolicy(documentWithTransfers({ perMonth: null }), ids);
    expect(compiledWithout.transfers.perMonthRaw).toBeNull();
    // A null monthly ceiling means "not bounded", which is a different decision
    // from a ceiling that has already been reached. Same request, same already-
    // spent monthly total: the only thing that changes is whether the policy
    // declared a monthly ceiling at all.
    const cand = candidate({ amount: { raw: PERMITTED.toString(), unit: UNIT } });
    const st = state({
      usage: { reservedDayRaw: 0n, reservedMonthRaw: MONTH_CAP, transactionsLastHour: 0, ikaSpentTodayRaw: 0n },
    });
    expect(evaluate({ policy: compiledWithout, candidate: cand, state: st }).outcome).toBe('ALLOW');
    expect(evaluate({ policy: compiled(), candidate: cand, state: st }).outcome).toBe('DENY');
  });

  it('refuses a policy that enables transfers on no chains at all', () => {
    const document = documentWithTransfers({ chains: [] });
    expect(() => compilePolicy(document, ids)).toThrow(/no permitted chains/);
  });
});

describe('the decision record', () => {
  it('names the rule path it acted on and the version it evaluated under', () => {
    for (const over of [
      {},
      { cand: candidate({ amount: { raw: (CAP + 1n).toString(), unit: UNIT } }) },
      { cand: candidate({ amount: { raw: (ESCALATE_ABOVE + 1n).toString(), unit: UNIT } }) },
    ]) {
      const decision = decide(over);
      expect(decision.policyVersionId).toMatch(/^ppv_/);
      expect(decision.matchedRules.length).toBeGreaterThan(0);
      expect(decision.requestId).toMatch(/^req_/);
      expect(decision.evaluatedAtMs).toBe(NOW_MS);
    }
  });

  it('binds the digest to the candidate it evaluated and the policy version that allowed it', () => {
    const cand = candidate();
    const decision = decide({ cand });
    if (decision.outcome !== 'ALLOW') throw new Error('fixture no longer allows');
    expect(decision.digest).toBe(computeDigest(cand, { policyVersionId: decision.policyVersionId }));
  });

  it('cannot be handed a digest computed over some other transaction', () => {
    // The regression this guards: `evaluate` used to take `state.digest` from the
    // caller, so a composition root could ALLOW against candidate B while sealing
    // candidate A's bytes, and the ticket would inherit whichever it was given.
    // There is no such input now; the two digests below are what used to be
    // conflatable.
    const one = candidate({ amount: { raw: '1', unit: UNIT } });
    const two = candidate({ amount: { raw: '2', unit: UNIT } });
    const a = decide({ cand: one });
    const b = decide({ cand: two });
    if (a.outcome !== 'ALLOW' || b.outcome !== 'ALLOW') throw new Error('fixtures no longer allow');
    expect(a.digest).not.toBe(b.digest);
    expect(b.digest).toBe(computeDigest(two, { policyVersionId: b.policyVersionId }));
  });

  it('separates decisions made under different policy versions', () => {
    const a = decide();
    const b = decide({ policy: atVersion(2) });
    if (a.outcome !== 'ALLOW' || b.outcome !== 'ALLOW') throw new Error('fixtures no longer allow');
    expect(a.digest).not.toBe(b.digest);
  });

  it('escalation carries an expiry derived from the policy TTL, not from a clock', () => {
    const decision = decide({ cand: candidate({ amount: { raw: (ESCALATE_ABOVE + 1n).toString(), unit: UNIT } }) });
    if (decision.outcome !== 'REQUIRE_HUMAN_APPROVAL') throw new Error('fixture no longer escalates');
    expect(BigInt(Date.parse(decision.expiresAt))).toBe(NOW_MS + 900_000n);
  });

  it('still returns a decision when handed input it was not written to expect', () => {
    const decision = evaluate({
      policy: compiled(),
      candidate: candidate(),
      state: { ...state(), scopes: null as unknown as string[] },
    });
    expect(decision.outcome).toBe('DENY');
    if (decision.outcome === 'DENY') expect(decision.reasonCodes).toEqual(['INTERNAL_ERROR_FAIL_CLOSED']);
    expect(Decision.safeParse(decision).success).toBe(true);
  });

  it('does not assume the thing that broke was an Error', () => {
    // A rejection string, a thrown plain object, a panic across a native boundary:
    // the catch has to survive all of them, and the audit line it writes has to
    // admit it could not read a message rather than print "undefined".
    const hostile = {
      ...state(),
      scopes: { includes: () => { throw 'not an error'; } },
    } as unknown as ReturnType<typeof state>;
    const decision = evaluate({ policy: compiled(), candidate: candidate(), state: hostile });
    expect(decision.outcome).toBe('DENY');
    if (decision.outcome === 'DENY') {
      expect(decision.matchedRules.at(-1)?.detail).toBe('non-error thrown');
    }
  });
});

/** The fixture policy content under a different version id, which the digest must follow. */
function atVersion(versionNumber: number): CompiledPolicy {
  return {
    ...compiled(),
    versionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5d',
    versionNumber,
  };
}
