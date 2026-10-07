// Legal task lifecycle. Only transition() may assign task.status.
// Spec: docs/mcp-agent-task-state-machine-spec.md

export const TASK_STATUS = [
    'CREATED', 'PLANNING', 'READY', 'EXECUTING', 'VERIFYING',
    'PROGRESS', 'NO_PROGRESS', 'REGRESSION', 'REPLANNING', 'BLOCKED',
    'SUCCESS', 'FAILED', 'LOOP_DETECTED', 'LIMIT_REACHED', 'CANCELLED'
];

export const TERMINAL = new Set(['SUCCESS', 'FAILED', 'LOOP_DETECTED', 'LIMIT_REACHED', 'CANCELLED']);

const EDGES = {
    CREATED: ['PLANNING', 'CANCELLED'],
    PLANNING: ['READY', 'BLOCKED', 'FAILED'],
    READY: ['EXECUTING', 'BLOCKED', 'CANCELLED'],
    EXECUTING: ['VERIFYING', 'FAILED', 'BLOCKED'],
    VERIFYING: ['SUCCESS', 'PROGRESS', 'NO_PROGRESS', 'REGRESSION', 'LOOP_DETECTED', 'LIMIT_REACHED'],
    PROGRESS: ['READY', 'SUCCESS'],
    NO_PROGRESS: ['READY', 'REPLANNING', 'LIMIT_REACHED'],
    REGRESSION: ['REPLANNING', 'LIMIT_REACHED'],
    REPLANNING: ['READY', 'FAILED', 'LOOP_DETECTED', 'LIMIT_REACHED', 'BLOCKED'],
    BLOCKED: ['PLANNING', 'CANCELLED']
};

export function isLegal(from, to) {
    return (EDGES[from] || []).includes(to);
}

/** Birth of a task. The only status write outside transition(). */
export function seedCreated(task) {
    task.status = 'CREATED';
    task.version = 1;
}

export function transitionError(code) {
    const err = new Error(code);
    err.code = code;
    return err;
}

/** One atomic status change: guard, version++, immutable history event, then status. */
export function transition(task, target, context, history) {
    if (TERMINAL.has(task.status)) throw transitionError('TERMINAL');
    if (!isLegal(task.status, target)) throw transitionError('ILLEGAL_TRANSITION');
    if (context && context.expectedVersion != null && context.expectedVersion !== task.version) {
        throw transitionError('STALE_AGENT_STATE');
    }
    const nextVersion = task.version + 1;
    const event = Object.freeze({
        taskId: task.taskId,
        version: nextVersion,
        from: task.status,
        to: target,
        reason: (context && context.reason) || '',
        iteration: task.iteration,
        agentId: context && context.agentId,
        actionId: context && context.actionId,
        stateHashBefore: context && context.stateHashBefore,
        stateHashAfter: context && context.stateHashAfter,
        timestamp: (context && context.timestamp) || new Date().toISOString()
    });
    if (history) history.appendTransition(event);
    task.status = target;
    task.version = nextVersion;
    task.updatedAt = event.timestamp;
    if (target === 'EXECUTING') {
        task.activeActionId = context && context.actionId;
        task.currentAgentId = (context && context.agentId) || task.currentAgentId;
    }
    if (target === 'READY' || target === 'PLANNING' || target === 'REPLANNING' || target === 'BLOCKED' || TERMINAL.has(target)) {
        task.activeActionId = undefined;
    }
    return event;
}
