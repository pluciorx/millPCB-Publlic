// Normative defaults. Callers may go lower. Nothing may exceed the hard cap.

export const LIMITS = {
    iterations: { default: 30, hard: 100 },
    replanning: { default: 3, hard: 5 },
    noProgress: { default: 3, hard: 5 },
    regressions: { default: 2, hard: 3 },
    repeatedState: { default: 2, hard: 3 },
    repeatedAction: { default: 3, hard: 5 },
    semanticWindow: { default: 8, hard: 20 },
    maxMessagesPerIteration: { default: 10, hard: 10 },
    maxMessagesPerTask: { default: 200, hard: 200 },
    maxSameIntentMessages: { default: 3, hard: 3 },
    maxConcurrentAgents: { default: 6, hard: 6 },
    maxConcurrentWriters: { default: 1, hard: 1 },
    maxToolRetries: { default: 2, hard: 3 },
    maxRecoveryChecks: { default: 2, hard: 2 },
    toolCallMs: { default: 120000, hard: 120000 },
    verificationMs: { default: 60000, hard: 60000 },
    taskMs: { default: 1800000, hard: 3600000 },
    actionHistory: { default: 100, hard: 100 },
    stateHistory: { default: 100, hard: 100 },
    transitionHistory: { default: 500, hard: 500 },
    checkpoints: { default: 20, hard: 50 }
};

export const MIN_STRATEGY_DIFFERENCE = 0.3;

function cap(spec, value) {
    const n = Number.isFinite(value) ? value : spec.default;
    if (n < 1) return 1;
    if (n > spec.hard) return spec.hard;
    return n;
}

/** Merge overrides. Values above the hard cap are clamped down. */
export function resolveLimits(overrides = {}) {
    return {
        iterations: cap(LIMITS.iterations, overrides.iterations),
        replanning: cap(LIMITS.replanning, overrides.replanning),
        noProgress: cap(LIMITS.noProgress, overrides.noProgress),
        regressions: cap(LIMITS.regressions, overrides.regressions),
        repeatedState: cap(LIMITS.repeatedState, overrides.repeatedState),
        repeatedAction: cap(LIMITS.repeatedAction, overrides.repeatedAction),
        semanticWindow: cap(LIMITS.semanticWindow, overrides.semanticWindow),
        maxRecoveryChecks: cap(LIMITS.maxRecoveryChecks, overrides.maxRecoveryChecks),
        taskMs: cap(LIMITS.taskMs, overrides.taskMs),
        checkpoints: cap(LIMITS.checkpoints, overrides.checkpoints),
        actionHistory: LIMITS.actionHistory.default,
        stateHistory: LIMITS.stateHistory.default,
        transitionHistory: LIMITS.transitionHistory.default,
        maxConcurrentWriters: 1
    };
}
