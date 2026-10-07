import { classifyProgress, criteriaMet } from './progressEvaluator.mjs';

/** Objective result. The agent does not supply progress. */
export function verifyObservation(input) {
    const progress = classifyProgress(input);
    return {
        execution: input.timedOut ? 'UNKNOWN' : (input.execution || 'SUCCESS'),
        progress,
        criteriaMet: progress === 'SUCCESS' || criteriaMet(input.metricsAfter, input.successCriteria)
    };
}
