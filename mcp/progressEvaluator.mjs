// Lower-is-better unless a criterion says min (higher is better) or eq.

function specOf(criteria, key) {
    const raw = criteria && criteria[key];
    if (typeof raw === 'number') return { max: raw };
    if (raw && typeof raw === 'object') return raw;
    return { max: Infinity };
}

export function criteriaMet(metrics, criteria) {
    if (!criteria || !Object.keys(criteria).length) return false;
    if (!metrics) return false;
    for (const key of Object.keys(criteria)) {
        const value = metrics[key];
        if (typeof value !== 'number') return false;
        const spec = specOf(criteria, key);
        if (spec.eq != null && value !== spec.eq) return false;
        if (spec.max != null && value > spec.max) return false;
        if (spec.min != null && value < spec.min) return false;
    }
    return true;
}

function direction(criteria, key) {
    const spec = specOf(criteria, key);
    if (spec.min != null && spec.max == null) return 1;
    return -1;
}

/**
 * PROGRESS | NO_PROGRESS | REGRESSION | SUCCESS | UNKNOWN
 * Missing after-metrics, or a timed-out execution, is UNKNOWN.
 */
export function classifyProgress({ metricsBefore, metricsAfter, successCriteria, execution, timedOut }) {
    if (timedOut || execution === 'UNKNOWN') return 'UNKNOWN';
    if (execution === 'FAILED') return 'UNKNOWN';
    if (!metricsAfter || typeof metricsAfter !== 'object') return 'UNKNOWN';
    if (criteriaMet(metricsAfter, successCriteria)) return 'SUCCESS';
    const before = metricsBefore || {};
    const keys = new Set([...Object.keys(before), ...Object.keys(metricsAfter)]);
    let better = false;
    let worse = false;
    let comparable = false;
    for (const key of keys) {
        if (typeof before[key] !== 'number' || typeof metricsAfter[key] !== 'number') continue;
        comparable = true;
        const delta = metricsAfter[key] - before[key];
        if (delta === 0) continue;
        const improved = delta * direction(successCriteria, key) > 0;
        if (improved) better = true;
        else worse = true;
    }
    if (!comparable) return 'NO_PROGRESS';
    if (worse) return 'REGRESSION';
    if (better) return 'PROGRESS';
    return 'NO_PROGRESS';
}
