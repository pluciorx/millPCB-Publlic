import crypto from 'node:crypto';

function deepFreeze(obj) {
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
    }
    return obj;
}

export function hashState(value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
}

export function createHistory(limits) {
    const transitions = [];
    const actions = [];
    const states = [];
    const checkpoints = [];
    const cap = (arr, n) => { while (arr.length > n) arr.shift(); };

    return {
        appendTransition(event) {
            transitions.push(event);
            cap(transitions, limits.transitionHistory);
        },
        appendAction(action) {
            actions.push(Object.freeze({ ...action }));
            cap(actions, limits.actionHistory);
        },
        appendState(hash) {
            states.push(hash);
            cap(states, limits.stateHistory);
        },
        addCheckpoint(checkpoint) {
            if (checkpoints.length >= limits.checkpoints) return false;
            checkpoints.push(deepFreeze({ ...checkpoint, metrics: { ...(checkpoint.metrics || {}) } }));
            return true;
        },
        transitions: () => transitions,
        actions: () => actions,
        states: () => states,
        checkpoints: () => checkpoints
    };
}
