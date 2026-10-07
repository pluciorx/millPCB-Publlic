// Server-owned task lifecycle. Agents propose; this module commits status.
// Spec: docs/mcp-agent-task-state-machine-spec.md

import crypto from 'node:crypto';
import { TERMINAL, isLegal, seedCreated, transition } from './taskStateMachine.mjs';
import { resolveLimits, MIN_STRATEGY_DIFFERENCE } from './taskLimits.mjs';
import { createHistory } from './taskHistory.mjs';
import { createLockManager } from './resourceLockManager.mjs';
import { verifyObservation } from './verifier.mjs';
import {
    actionSignature, detectActionLoop, detectCommunicationLoop,
    detectReplanLoop, detectSemanticLoop, detectStateLoop
} from './loopDetector.mjs';

function stamp(now) {
    const t = now();
    return t instanceof Date ? t.toISOString() : new Date(t).toISOString();
}

function strategyKeys(actions) {
    return (actions || []).map(actionSignature).sort();
}

function difference(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const union = A.size + B.size - inter;
    if (!union) return 1;
    return 1 - inter / union;
}

export function createTaskManager(options = {}) {
    const now = options.now || (() => new Date());
    const locks = options.locks || createLockManager({
        now: () => {
            const t = now();
            return t instanceof Date ? t.getTime() : Number(t);
        },
        ttlMs: options.lockTtlMs ?? 120000
    });
    const tasks = new Map();

    function fail(code, extra) {
        return { ok: false, error: code, ...extra };
    }

    function getTask(taskId) {
        const task = tasks.get(taskId);
        if (!task) return null;
        return task;
    }

    function go(task, target, ctx = {}) {
        if (target === 'NO_PROGRESS') task.noProgressCount += 1;
        if (target === 'PROGRESS') task.noProgressCount = 0;
        if (target === 'REGRESSION') task.regressionCount += 1;
        if (target === 'REPLANNING') task.replanCount += 1;
        if (target === 'EXECUTING') task.iteration += 1;
        if (target === 'READY' && task.status === 'REPLANNING') {
            task.regressionCount = 0;
            task.repeatedStateCount = 0;
            task.sameActionCount = 0;
        }
        try {
            return transition(task, target, {
                ...ctx,
                timestamp: stamp(now),
                agentId: ctx.agentId || task.currentAgentId
            }, task.history);
        } catch (err) {
            if (target === 'NO_PROGRESS') task.noProgressCount -= 1;
            if (target === 'REGRESSION') task.regressionCount -= 1;
            if (target === 'REPLANNING') task.replanCount -= 1;
            if (target === 'EXECUTING') task.iteration -= 1;
            throw err;
        }
    }

    function release(task) {
        locks.releaseAll(task.taskId);
        task.activeResourceLocks = [];
    }

    function stale(task, expectedVersion) {
        if (expectedVersion == null || expectedVersion !== task.version) {
            return fail('STALE_AGENT_STATE', { version: task.version, status: task.status });
        }
        return null;
    }

    function expired(task) {
        const start = Date.parse(task.createdAt);
        const t = now();
        const ms = t instanceof Date ? t.getTime() : Number(t);
        return ms - start > task.limits.taskMs;
    }

    function rememberStrategy(task) {
        if (task.strategy && task.strategy.length) task.failedStrategies.push(task.strategy.slice());
    }

    function replanPacket(task, reason) {
        task.replanContext = {
            failedActions: task.history.actions().slice(-10),
            failedStrategies: task.failedStrategies.map(s => s.slice()),
            verification: task.lastVerification || null,
            stateHistory: task.history.states().slice(-20),
            reason
        };
    }

    function settle(task, progress, ctx) {
        const forceReplan = ctx.forceReplan;
        if (progress === 'SUCCESS' && !forceReplan) {
            go(task, 'SUCCESS', ctx);
            release(task);
            return done(task, 'SUCCESS');
        }
        if (task.iteration >= task.limits.iterations || expired(task)) {
            go(task, 'LIMIT_REACHED', { ...ctx, reason: ctx.reason || 'limit exceeded' });
            release(task);
            return done(task, 'LIMIT_REACHED');
        }
        if (progress === 'PROGRESS') {
            go(task, 'PROGRESS', ctx);
            task.history.addCheckpoint({
                version: task.version,
                stateHash: task.currentStateHash,
                metrics: { ...(task.metrics || {}) },
                at: task.updatedAt
            });
            go(task, 'READY', { ...ctx, reason: 'more work required' });
            release(task);
            return done(task, 'PROGRESS');
        }
        if (progress === 'REGRESSION') {
            go(task, 'REGRESSION', ctx);
            if (task.regressionCount >= task.limits.regressions) {
                go(task, 'LIMIT_REACHED', { ...ctx, reason: 'regression limit' });
                release(task);
                return done(task, 'LIMIT_REACHED');
            }
            rememberStrategy(task);
            replanPacket(task, ctx.reason || 'regression');
            go(task, 'REPLANNING', { ...ctx, reason: ctx.reason || 'regression' });
            release(task);
            return done(task, 'REGRESSION');
        }
        const reason = progress === 'UNKNOWN' ? 'unclassified result' : (ctx.reason || 'no measurable progress');
        go(task, 'NO_PROGRESS', { ...ctx, reason });
        const needReplan = forceReplan || task.noProgressCount >= task.limits.noProgress;
        if (needReplan) {
            if (task.replanCount >= task.limits.replanning) {
                go(task, 'LIMIT_REACHED', { ...ctx, reason: 'replan limit' });
                release(task);
                return done(task, 'LIMIT_REACHED');
            }
            rememberStrategy(task);
            replanPacket(task, reason);
            go(task, 'REPLANNING', { ...ctx, reason });
            release(task);
            return done(task, 'NO_PROGRESS');
        }
        go(task, 'READY', { ...ctx, reason: 'retry allowed' });
        release(task);
        return done(task, 'NO_PROGRESS');
    }

    function done(task, progress) {
        return {
            ok: true,
            progress,
            execution: task.lastVerification ? task.lastVerification.execution : 'SUCCESS',
            nextState: task.status,
            task: snapshot(task),
            loop: task.lastLoop || null,
            replan: task.status === 'REPLANNING' ? task.replanContext : undefined
        };
    }

    function classifyAndSettle(task, input) {
        const stateBefore = input.stateBefore ?? task.currentStateHash ?? '';
        const stateAfter = input.stateHash || input.stateAfter || task._obsAfter || stateBefore;
        task.previousStateHash = stateBefore;
        task.currentStateHash = stateAfter;
        if (input.metrics) task.metrics = { ...task.metrics, ...input.metrics };

        const signature = actionSignature(task.pendingAction || {});
        if (signature === task.lastActionSignature) task.sameActionCount += 1;
        else task.sameActionCount = 1;
        task.lastActionSignature = signature;
        task.history.appendAction({
            actionId: task.pendingAction && task.pendingAction.actionId,
            signature,
            intent: task.pendingAction && task.pendingAction.intent,
            type: task.pendingAction && task.pendingAction.type,
            at: stamp(now)
        });
        task.history.appendState(stateAfter);
        task.semanticLog.push({
            intent: (task.pendingAction && task.pendingAction.intent) || '',
            type: (task.pendingAction && task.pendingAction.type) || '',
            improved: false
        });

        const metricsBefore = input.metricsBefore || task.metricsBefore || {};
        const observation = verifyObservation({
            metricsBefore,
            metricsAfter: task.metrics,
            successCriteria: task.successCriteria,
            execution: input.execution || 'SUCCESS',
            timedOut: false
        });
        task.lastVerification = observation;
        const lastSem = task.semanticLog[task.semanticLog.length - 1];
        if (lastSem) lastSem.improved = observation.progress === 'PROGRESS' || observation.progress === 'SUCCESS';

        const signatures = task.history.actions().map(a => a.signature);
        const stateLoop = detectStateLoop(task.history.states().slice(0, -1), stateAfter, task.limits.repeatedState);
        const actionLoop = detectActionLoop(signatures, task.limits.repeatedAction);
        const semanticLoop = detectSemanticLoop(task.semanticLog, task.limits.semanticWindow);
        if (stateLoop.detected) task.repeatedStateCount = stateLoop.evidence.occurrences.length;
        const loops = [stateLoop, actionLoop, semanticLoop].filter(l => l.detected);
        task.lastLoop = loops[0] || null;

        const terminate = loops.some(l => l.beyond) && task.replanCount >= task.limits.replanning;
        if (terminate) {
            go(task, 'LOOP_DETECTED', { reason: loops.find(l => l.beyond).type, actionId: task.pendingAction && task.pendingAction.actionId, stateHashBefore: stateBefore, stateHashAfter: stateAfter });
            release(task);
            return done(task, observation.progress);
        }

        let progress = observation.progress;
        const forceReplan = loops.some(l => l.beyond);
        if (forceReplan && progress !== 'SUCCESS') progress = 'NO_PROGRESS';
        if (progress === 'UNKNOWN') progress = 'NO_PROGRESS';

        task.metricsBefore = { ...task.metrics };
        task._obsBefore = undefined;
        task._obsAfter = undefined;
        task.pendingAction = undefined;
        task.awaitingInspection = false;

        return settle(task, progress, {
            reason: input.reason || observation.progress,
            actionId: input.actionId,
            stateHashBefore: stateBefore,
            stateHashAfter: stateAfter,
            forceReplan: forceReplan && observation.progress !== 'SUCCESS'
        });
    }

    function snapshot(task) {
        return {
            taskId: task.taskId,
            status: task.status,
            version: task.version,
            iteration: task.iteration,
            goal: task.goal,
            successCriteria: task.successCriteria,
            currentStateHash: task.currentStateHash,
            previousStateHash: task.previousStateHash,
            noProgressCount: task.noProgressCount,
            regressionCount: task.regressionCount,
            replanCount: task.replanCount,
            repeatedStateCount: task.repeatedStateCount,
            sameActionCount: task.sameActionCount,
            currentAgentId: task.currentAgentId,
            activeActionId: task.activeActionId,
            activeResourceLocks: task.activeResourceLocks.map(l => ({ ...l })),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            metrics: { ...(task.metrics || {}) },
            awaitingInspection: task.awaitingInspection
        };
    }

    return {
        createTask({ taskId, goal, successCriteria, agentId, limits, metrics, stateHash } = {}) {
            if (!goal) return fail('GOAL_REQUIRED');
            const id = taskId || `task-${crypto.randomBytes(4).toString('hex')}`;
            if (tasks.has(id)) return fail('TASK_EXISTS', { taskId: id });
            const resolved = resolveLimits(limits);
            const at = stamp(now);
            const history = createHistory(resolved);
            const task = {
                taskId: id,
                iteration: 0,
                goal,
                successCriteria: successCriteria || null,
                currentStateHash: stateHash || '',
                previousStateHash: undefined,
                noProgressCount: 0,
                regressionCount: 0,
                replanCount: 0,
                repeatedStateCount: 0,
                sameActionCount: 0,
                lastActionSignature: null,
                currentAgentId: agentId,
                activeActionId: undefined,
                activeResourceLocks: [],
                createdAt: at,
                updatedAt: at,
                limits: resolved,
                history,
                metrics: metrics ? { ...metrics } : {},
                metricsBefore: metrics ? { ...metrics } : {},
                failedStrategies: [],
                strategy: null,
                semanticLog: [],
                messages: [],
                awaitingInspection: false,
                recoveryChecks: 0,
                pendingAction: null,
                lastVerification: null,
                lastLoop: null,
                replanContext: null,
                _obsBefore: undefined,
                _obsAfter: undefined
            };
            seedCreated(task);
            tasks.set(id, task);
            return { ok: true, task: snapshot(task) };
        },

        accept(taskId, ctx = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (task.status !== 'CREATED') return fail('WRONG_STATE', { status: task.status });
            try {
                go(task, 'PLANNING', { reason: 'task accepted', agentId: ctx.agentId || task.currentAgentId });
            } catch (err) {
                return fail(err.code || 'ILLEGAL_TRANSITION', { status: task.status });
            }
            return { ok: true, task: snapshot(task) };
        },

        submitPlan(taskId, plan = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (TERMINAL.has(task.status)) return fail('TERMINAL', { status: task.status });
            const staleErr = stale(task, plan.expectedVersion);
            if (staleErr) return staleErr;
            if (task.status !== 'PLANNING' && task.status !== 'REPLANNING') {
                return fail('WRONG_STATE', { status: task.status });
            }
            if (plan.blocked) {
                try { go(task, 'BLOCKED', { reason: plan.reason || 'dependency unavailable', agentId: plan.agentId }); }
                catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
                release(task);
                return { ok: true, task: snapshot(task) };
            }
            const actions = plan.actions;
            const criteria = plan.successCriteria || task.successCriteria;
            if (!plan.goal && !task.goal) return this._failPlan(task, plan, 'planning failure');
            if (!Array.isArray(actions) || !actions.length) return this._failPlan(task, plan, 'planning failure');
            if (!plan.expectedEffects) return this._failPlan(task, plan, 'planning failure');
            if (!criteria || !Object.keys(criteria).length) return this._failPlan(task, plan, 'planning failure');
            if (!plan.resources || !plan.resources.length) return this._failPlan(task, plan, 'planning failure');

            const keys = strategyKeys(actions);
            if (task.failedStrategies.length) {
                const tooClose = task.failedStrategies.some(prev => difference(prev, keys) < MIN_STRATEGY_DIFFERENCE);
                const replay = detectReplanLoop([...task.failedStrategies.map(s => s.join('|')), keys.join('|')]);
                if (tooClose || replay.detected) return fail('DUPLICATE_STRATEGY', { status: task.status, version: task.version });
            }
            task.successCriteria = criteria;
            if (plan.goal) task.goal = plan.goal;
            task.strategy = keys;
            task.resources = plan.resources.slice();
            try {
                go(task, 'READY', { reason: 'valid plan', agentId: plan.agentId, expectedVersion: plan.expectedVersion });
            } catch (err) {
                return fail(err.code || 'ILLEGAL_TRANSITION', { status: task.status, version: task.version });
            }
            return { ok: true, task: snapshot(task) };
        },

        _failPlan(task, plan, reason) {
            try { go(task, 'FAILED', { reason, agentId: plan.agentId }); }
            catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
            release(task);
            return { ok: false, error: 'FAILED', reason, task: snapshot(task) };
        },

        beginAction(taskId, action = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (TERMINAL.has(task.status)) return fail('TERMINAL', { status: task.status, version: task.version });
            if (task.awaitingInspection) return fail('MUST_INSPECT', { progress: 'UNKNOWN', status: task.status, version: task.version });
            const staleErr = stale(task, action.expectedVersion);
            if (staleErr) return staleErr;
            if (task.status !== 'READY') return fail('WRONG_STATE', { status: task.status });
            if (!action.agentId) return fail('AGENT_REQUIRED');
            if (!action.type || !action.intent || !action.actionId) return fail('ACTION_INVALID');

            if (task.iteration >= task.limits.iterations || expired(task)) {
                try {
                    go(task, 'EXECUTING', { reason: 'budget check', agentId: action.agentId, actionId: action.actionId });
                    go(task, 'VERIFYING', { reason: 'budget check', agentId: action.agentId });
                    go(task, 'LIMIT_REACHED', { reason: expired(task) ? 'task timeout' : 'iteration limit', agentId: action.agentId });
                } catch (err) {
                    return fail(err.code || 'ILLEGAL_TRANSITION', { status: task.status });
                }
                release(task);
                return { ok: false, error: 'LIMIT_REACHED', task: snapshot(task) };
            }

            const resource = action.resource || (task.resources && task.resources[0]) || 'board';
            if (task.activeResourceLocks.length >= task.limits.maxConcurrentWriters) {
                return fail('LOCK_HELD', { status: task.status });
            }
            const lock = locks.acquire({
                resource,
                ownerAgentId: action.agentId,
                taskId: task.taskId,
                acquiredVersion: task.version
            });
            if (!lock.ok) return fail('LOCK_HELD', { status: task.status, lock: lock.lock });

            task.pendingAction = {
                actionId: action.actionId,
                type: action.type,
                intent: action.intent,
                target: action.target,
                parameters: action.parameters || {},
                expectedEffect: action.expectedEffect
            };
            task.activeResourceLocks = [{ ...lock.lock }];
            try {
                go(task, 'EXECUTING', {
                    reason: 'action approved',
                    agentId: action.agentId,
                    actionId: action.actionId,
                    expectedVersion: action.expectedVersion
                });
            } catch (err) {
                release(task);
                task.pendingAction = null;
                return fail(err.code || 'ILLEGAL_TRANSITION', { status: task.status });
            }
            return { ok: true, task: snapshot(task) };
        },

        finishAction(taskId, input = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (TERMINAL.has(task.status)) return fail('TERMINAL', { status: task.status, version: task.version });
            if (task.awaitingInspection) return fail('MUST_INSPECT', { progress: 'UNKNOWN', status: task.status, version: task.version });
            const staleErr = stale(task, input.expectedVersion);
            if (staleErr) return staleErr;
            if (task.status !== 'EXECUTING') return fail('WRONG_STATE', { status: task.status });

            if (input.timedOut) {
                task.awaitingInspection = true;
                task.lastVerification = { execution: 'UNKNOWN', progress: 'UNKNOWN', criteriaMet: false };
                const stateBefore = task._obsBefore || task.currentStateHash || '';
                try {
                    go(task, 'VERIFYING', { reason: 'timeout', agentId: input.agentId, actionId: task.activeActionId, stateHashBefore: stateBefore });
                } catch (err) {
                    return fail(err.code || 'ILLEGAL_TRANSITION');
                }
                return {
                    ok: true,
                    execution: 'UNKNOWN',
                    progress: 'UNKNOWN',
                    nextState: task.status,
                    task: snapshot(task)
                };
            }
            if (input.unrecoverable) {
                try { go(task, 'FAILED', { reason: input.reason || 'unrecoverable error', agentId: input.agentId }); }
                catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
                release(task);
                return { ok: false, error: 'FAILED', execution: 'FAILED', task: snapshot(task) };
            }
            if (input.blocked) {
                try { go(task, 'BLOCKED', { reason: input.reason || 'dependency unavailable', agentId: input.agentId }); }
                catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
                release(task);
                return { ok: true, task: snapshot(task) };
            }

            try {
                go(task, 'VERIFYING', { reason: 'execution complete', agentId: input.agentId, actionId: task.activeActionId });
            } catch (err) {
                return fail(err.code || 'ILLEGAL_TRANSITION');
            }
            return classifyAndSettle(task, {
                metrics: input.metrics,
                metricsBefore: task.metricsBefore,
                stateHash: input.stateHash,
                stateBefore: task._obsBefore || task.previousStateHash || task.currentStateHash,
                execution: input.execution || 'SUCCESS',
                reason: input.reason
            });
        },

        recover(taskId, input = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (TERMINAL.has(task.status)) return fail('TERMINAL', { status: task.status });
            if (!task.awaitingInspection) return fail('NOT_AWAITING', { status: task.status });
            const staleErr = stale(task, input.expectedVersion);
            if (staleErr) return staleErr;
            if (task.status !== 'VERIFYING') return fail('WRONG_STATE', { status: task.status });
            if (task.recoveryChecks >= task.limits.maxRecoveryChecks) {
                try { go(task, 'LIMIT_REACHED', { reason: 'recovery checks exhausted', agentId: input.agentId }); }
                catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
                release(task);
                task.awaitingInspection = false;
                return { ok: false, error: 'LIMIT_REACHED', task: snapshot(task) };
            }
            task.recoveryChecks += 1;
            return classifyAndSettle(task, {
                metrics: input.metrics,
                metricsBefore: task.metricsBefore,
                stateHash: input.stateHash,
                stateBefore: task._obsBefore || task.currentStateHash,
                execution: 'SUCCESS',
                reason: 'state inspected after timeout'
            });
        },

        cancel(taskId, input = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (TERMINAL.has(task.status)) return fail('TERMINAL', { status: task.status });
            const staleErr = stale(task, input.expectedVersion);
            if (staleErr) return staleErr;
            if (!isLegal(task.status, 'CANCELLED')) return fail('ILLEGAL_TRANSITION', { status: task.status });
            try { go(task, 'CANCELLED', { reason: input.reason || 'cancelled', agentId: input.agentId }); }
            catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
            release(task);
            return { ok: true, task: snapshot(task) };
        },

        resolveBlock(taskId, input = {}) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            const staleErr = stale(task, input.expectedVersion);
            if (staleErr) return staleErr;
            if (task.status !== 'BLOCKED') return fail('WRONG_STATE', { status: task.status });
            try { go(task, 'PLANNING', { reason: 'blocker resolved', agentId: input.agentId }); }
            catch (err) { return fail(err.code || 'ILLEGAL_TRANSITION'); }
            return { ok: true, task: snapshot(task) };
        },

        noteMessage(taskId, message) {
            const task = getTask(taskId);
            if (!task) return fail('NOT_FOUND');
            if (TERMINAL.has(task.status)) return fail('TERMINAL', { status: task.status });
            task.messages.push({ from: message.from, to: message.to, intent: message.intent || '' });
            if (task.messages.length > 200) task.messages.shift();
            const loop = detectCommunicationLoop(task.messages);
            return { ok: true, loop };
        },

        observe(agentId, hash) {
            for (const task of tasks.values()) {
                if (task.status !== 'EXECUTING' || task.currentAgentId !== agentId) continue;
                if (!task._obsBefore) task._obsBefore = task.currentStateHash || hash;
                task._obsAfter = hash;
            }
        },

        writeGate(agentId) {
            const open = [...tasks.values()].filter(t => !TERMINAL.has(t.status));
            if (!open.length) return null;
            const mine = open.find(t => t.status === 'EXECUTING' && t.currentAgentId === agentId);
            if (mine) return null;
            const other = open.find(t => t.status === 'EXECUTING');
            if (other) return { ok: false, error: 'LOCK_HELD', status: 'EXECUTING', owner: other.currentAgentId, taskId: other.taskId };
            const task = open[0];
            return { ok: false, error: 'TASK_NOT_EXECUTING', status: task.status, taskId: task.taskId };
        },

        hasOpenTask() {
            return [...tasks.values()].some(t => !TERMINAL.has(t.status));
        },

        get(taskId) {
            const task = getTask(taskId);
            return task ? snapshot(task) : null;
        },

        transitions(taskId) {
            const task = getTask(taskId);
            return task ? task.history.transitions().map(e => e.to) : [];
        },

        events(taskId) {
            const task = getTask(taskId);
            return task ? task.history.transitions().map(e => ({ ...e })) : [];
        },

        checkpoints(taskId) {
            const task = getTask(taskId);
            return task ? task.history.checkpoints() : [];
        }
    };
}

export { hashState } from './taskHistory.mjs';
export { transition, isLegal } from './taskStateMachine.mjs';
