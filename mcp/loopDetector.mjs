// Evidence only. This module never assigns task.status.

export function detectStateLoop(priorHashes, hash, max) {
    if (!hash) return { detected: false, type: 'REPEATED_STATE', beyond: false, evidence: { stateHash: hash, occurrences: [] } };
    const occurrences = [];
    priorHashes.forEach((h, i) => { if (h === hash) occurrences.push(i); });
    occurrences.push(priorHashes.length);
    const detected = occurrences.length >= 2;
    return {
        detected,
        type: 'REPEATED_STATE',
        beyond: occurrences.length > max,
        evidence: { stateHash: hash, occurrences }
    };
}

export function detectActionLoop(signatures, max) {
    if (!signatures.length) return { detected: false, type: 'REPEATED_ACTION', beyond: false, evidence: { count: 0 } };
    const last = signatures[signatures.length - 1];
    let count = 0;
    for (let i = signatures.length - 1; i >= 0 && signatures[i] === last; i--) count++;
    return {
        detected: count >= max,
        type: 'REPEATED_ACTION',
        beyond: count >= max,
        evidence: { signature: last, count }
    };
}

/** Same intent, same action type, no metric improvement inside the window. */
export function detectSemanticLoop(entries, window) {
    const slice = entries.slice(-window);
    if (slice.length < 3) return { detected: false, type: 'SEMANTIC_INTENT', beyond: false, evidence: {} };
    const last = slice[slice.length - 1];
    const same = slice.filter(e => e.intent === last.intent && e.type === last.type);
    const detected = same.length >= 3 && same.every(e => !e.improved);
    return {
        detected,
        type: 'SEMANTIC_INTENT',
        beyond: detected,
        evidence: { intent: last.intent, type: last.type, count: same.length }
    };
}

/** A-B-A-B over the last four directed messages. */
export function detectCommunicationLoop(messages) {
    if (messages.length < 4) return { detected: false, type: 'COMMUNICATION', beyond: false, evidence: {} };
    const tail = messages.slice(-4);
    const [a, b, c, d] = tail;
    const detected = a.from === c.from && a.to === c.to && b.from === d.from && b.to === d.to
        && a.from && b.from && a.from !== b.from && a.to === b.from && b.to === a.from;
    return {
        detected,
        type: 'COMMUNICATION',
        beyond: detected,
        evidence: detected ? { pair: [a.from, b.from] } : {}
    };
}

/** A failed strategy hash appearing again. */
export function detectReplanLoop(strategyKeys) {
    if (strategyKeys.length < 2) return { detected: false, type: 'REPLANNING', beyond: false, evidence: {} };
    const last = strategyKeys[strategyKeys.length - 1];
    const detected = strategyKeys.slice(0, -1).includes(last);
    return {
        detected,
        type: 'REPLANNING',
        beyond: detected,
        evidence: { strategy: last }
    };
}

export function actionSignature(action) {
    const params = action && action.parameters ? stable(action.parameters) : '';
    return `${(action && action.type) || ''}|${(action && action.target) || ''}|${params}`;
}

function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
