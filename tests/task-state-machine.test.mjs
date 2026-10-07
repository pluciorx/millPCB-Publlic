#!/usr/bin/env node
// Acceptance tests for the MCP task state machine.
import assert from 'node:assert/strict';
import { createTaskManager, transition } from '../mcp/taskManager.mjs';
import { detectCommunicationLoop } from '../mcp/loopDetector.mjs';

function planBody(actions) {
    return {
        goal: 'fix erc',
        actions: actions || [{ type: 'modify_component', target: 'C17', parameters: { value: '100nF' } }],
        expectedEffects: { erc_errors: 0 },
        successCriteria: { erc_errors: 0 },
        resources: ['board'],
        agentId: 'designer-01'
    };
}

function readyTask(mgr, opts = {}) {
    const id = opts.taskId || 'pcb-184';
    const created = mgr.createTask({
        taskId: id,
        goal: 'fix erc',
        successCriteria: { erc_errors: 0 },
        agentId: opts.agentId || 'designer-01',
        metrics: { erc_errors: opts.erc ?? 5 },
        stateHash: opts.stateHash || 'S0',
        limits: opts.limits
    });
    assert.equal(created.task.status, 'CREATED');
    assert.equal(created.task.version, 1);
    assert.equal(created.task.iteration, 0);
    mgr.accept(id);
    const version = mgr.get(id).version;
    const planned = mgr.submitPlan(id, { ...planBody(opts.actions), expectedVersion: version });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.task.status, 'READY');
    return id;
}

function act(mgr, id, action) {
    const task = mgr.get(id);
    return mgr.beginAction(id, {
        expectedVersion: task.version,
        agentId: task.currentAgentId || 'designer-01',
        actionId: action.actionId || 'act-1',
        type: action.type || 'modify_component',
        intent: action.intent || 'lower erc',
        target: action.target || 'C17',
        parameters: action.parameters || { value: '100nF' },
        resource: 'board'
    });
}

function finish(mgr, id, metrics, stateHash) {
    const task = mgr.get(id);
    return mgr.finishAction(id, {
        expectedVersion: task.version,
        metrics,
        stateHash
    });
}

// Test 1 — normal success
{
    const mgr = createTaskManager();
    const id = readyTask(mgr, { erc: 5 });
    let step = act(mgr, id, { actionId: 'a1', intent: 'cut erc' });
    assert.equal(step.task.status, 'EXECUTING');
    step = finish(mgr, id, { erc_errors: 3 }, 'S1');
    assert.equal(step.progress, 'PROGRESS');
    assert.equal(step.task.status, 'READY');
    assert.equal(step.task.noProgressCount, 0);
    assert.equal(mgr.checkpoints(id).length, 1);
    assert.equal(Object.isFrozen(mgr.checkpoints(id)[0]), true);
    step = act(mgr, id, { actionId: 'a2', intent: 'clear erc', type: 'rewire', parameters: { pin: '1' } });
    step = finish(mgr, id, { erc_errors: 0 }, 'S2');
    assert.equal(step.progress, 'SUCCESS');
    assert.equal(step.task.status, 'SUCCESS');
    assert.deepEqual(mgr.transitions(id), [
        'PLANNING', 'READY', 'EXECUTING', 'VERIFYING', 'PROGRESS', 'READY',
        'EXECUTING', 'VERIFYING', 'SUCCESS'
    ]);
}

// Test 2 — no progress, then replan
{
    const mgr = createTaskManager();
    const id = readyTask(mgr, { erc: 4 });
    for (let i = 0; i < 2; i++) {
        act(mgr, id, { actionId: 'n' + i, type: 'noop-' + i, intent: 'try ' + i, parameters: { i } });
        const step = finish(mgr, id, { erc_errors: 4 }, 'H' + i);
        assert.equal(step.progress, 'NO_PROGRESS');
        assert.equal(step.task.status, 'READY');
    }
    act(mgr, id, { actionId: 'n3', type: 'noop-3', intent: 'try 3', parameters: { i: 3 } });
    const third = finish(mgr, id, { erc_errors: 4 }, 'H3');
    assert.equal(third.task.noProgressCount, 3);
    assert.equal(third.task.status, 'REPLANNING');
    assert.equal(third.task.replanCount, 1);
    assert.ok(third.replan);
}

// Test 3 — repeated state is detected
{
    const mgr = createTaskManager();
    const id = readyTask(mgr);
    act(mgr, id, { actionId: 's1', type: 'a', intent: 'one' });
    finish(mgr, id, { erc_errors: 4 }, 'S1');
    act(mgr, id, { actionId: 's2', type: 'b', intent: 'two' });
    finish(mgr, id, { erc_errors: 3 }, 'S2');
    act(mgr, id, { actionId: 's3', type: 'c', intent: 'three' });
    const back = finish(mgr, id, { erc_errors: 2 }, 'S1');
    assert.equal(back.loop.type, 'REPEATED_STATE');
    assert.equal(back.loop.detected, true);
    assert.ok(back.loop.evidence.occurrences.length >= 2);
}

// Test 4 — repeated action forces replanning even when metrics improve
{
    const mgr = createTaskManager();
    const id = readyTask(mgr, { erc: 9 });
    const same = { type: 'nudge', intent: 'nudge C17', parameters: { value: '10nF' }, target: 'C17' };
    let erc = 9;
    let last;
    for (let i = 0; i < 3; i++) {
        erc -= 1;
        act(mgr, id, { actionId: 'rep-' + i, ...same });
        last = finish(mgr, id, { erc_errors: erc }, 'M' + i);
    }
    assert.equal(last.task.status, 'REPLANNING');
    assert.equal(last.loop.type, 'REPEATED_ACTION');
    assert.equal(last.task.noProgressCount, 1);
}

// Test 5 — regression
{
    const mgr = createTaskManager();
    const id = readyTask(mgr, { erc: 2 });
    act(mgr, id, { actionId: 'bad', intent: 'broke it', type: 'delete' });
    const step = finish(mgr, id, { erc_errors: 7 }, 'BAD');
    assert.equal(step.progress, 'REGRESSION');
    assert.equal(step.task.status, 'REPLANNING');
    assert.equal(step.task.regressionCount, 1);
}

// Test 6 — stale agent
{
    const mgr = createTaskManager();
    const id = readyTask(mgr);
    const live = mgr.get(id).version;
    const rejected = mgr.beginAction(id, {
        expectedVersion: live - 1,
        agentId: 'designer-01',
        actionId: 'stale',
        type: 'modify_component',
        intent: 'too old'
    });
    assert.equal(rejected.error, 'STALE_AGENT_STATE');
    assert.equal(mgr.get(id).status, 'READY');
    assert.equal(mgr.get(id).version, live);
}

// Test 7 — terminal protection
{
    const mgr = createTaskManager();
    const id = readyTask(mgr, { erc: 1 });
    act(mgr, id, { actionId: 'done', intent: 'clear', type: 'fix' });
    const ok = finish(mgr, id, { erc_errors: 0 }, 'WIN');
    assert.equal(ok.task.status, 'SUCCESS');
    const version = ok.task.version;
    const again = mgr.beginAction(id, {
        expectedVersion: version,
        agentId: 'designer-01',
        actionId: 'more',
        type: 'modify_component',
        intent: 'should not run'
    });
    assert.equal(again.error, 'TERMINAL');
    assert.equal(mgr.get(id).status, 'SUCCESS');
    assert.equal(mgr.get(id).version, version);
    assert.throws(() => transition(
        { taskId: id, status: 'SUCCESS', version, iteration: 1 },
        'EXECUTING',
        {},
        { appendTransition() {} }
    ), (err) => err.code === 'TERMINAL');
}

// Test 8 — timeout is UNKNOWN until state is inspected
{
    const mgr = createTaskManager();
    const id = readyTask(mgr, { erc: 5 });
    act(mgr, id, { actionId: 'slow', intent: 'wait', type: 'modify_component' });
    const timed = mgr.finishAction(id, { expectedVersion: mgr.get(id).version, timedOut: true });
    assert.equal(timed.progress, 'UNKNOWN');
    assert.equal(timed.execution, 'UNKNOWN');
    assert.equal(timed.task.awaitingInspection, true);
    const retry = mgr.beginAction(id, {
        expectedVersion: timed.task.version,
        agentId: 'designer-01',
        actionId: 'retry-blind',
        type: 'modify_component',
        intent: 'blind retry'
    });
    assert.equal(retry.error, 'MUST_INSPECT');
    const seen = mgr.recover(id, {
        expectedVersion: timed.task.version,
        metrics: { erc_errors: 5 },
        stateHash: 'S0'
    });
    assert.equal(seen.ok, true);
    assert.notEqual(seen.progress, 'UNKNOWN');
    assert.equal(seen.task.awaitingInspection, false);
    assert.equal(seen.task.status, 'READY');
    const after = act(mgr, id, { actionId: 'after-inspect', intent: 'now', type: 'tweak' });
    assert.equal(after.ok, true);
    assert.equal(after.task.status, 'EXECUTING');
}

// Test 9 — one writer
{
    const mgr = createTaskManager();
    const a = readyTask(mgr, { taskId: 'A', agentId: 'designer-01' });
    const b = readyTask(mgr, { taskId: 'B', agentId: 'parts-02', erc: 3 });
    const first = act(mgr, a, { actionId: 'w1' });
    assert.equal(first.ok, true);
    const second = mgr.beginAction(b, {
        expectedVersion: mgr.get(b).version,
        agentId: 'parts-02',
        actionId: 'w2',
        type: 'modify_component',
        intent: 'also write',
        resource: 'board'
    });
    assert.equal(second.error, 'LOCK_HELD');
    assert.equal(mgr.get(a).status, 'EXECUTING');
    assert.equal(mgr.get(b).status, 'READY');
    assert.equal(mgr.get(a).activeResourceLocks.length, 1);
}

// Test 9b — expired lock can be taken
{
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const mgr = createTaskManager({ now: () => new Date(clock), lockTtlMs: 1000 });
    const a = readyTask(mgr, { taskId: 'A', agentId: 'designer-01' });
    const b = readyTask(mgr, { taskId: 'B', agentId: 'parts-02' });
    assert.equal(act(mgr, a, { actionId: 'hold' }).ok, true);
    clock += 5000;
    const second = mgr.beginAction(b, {
        expectedVersion: mgr.get(b).version,
        agentId: 'parts-02',
        actionId: 'take',
        type: 'modify_component',
        intent: 'recovered lock',
        resource: 'board'
    });
    assert.equal(second.ok, true, second.error);
}

// Test 10 — replan replay
{
    const mgr = createTaskManager();
    const id = readyTask(mgr);
    const actions = [{ type: 'modify_component', target: 'C17', parameters: { value: '100nF' } }];
    for (let i = 0; i < 3; i++) {
        act(mgr, id, { actionId: 'p' + i, type: 'alt-' + i, intent: 'attempt ' + i, parameters: { i } });
        finish(mgr, id, { erc_errors: 5 }, 'P' + i);
    }
    assert.equal(mgr.get(id).status, 'REPLANNING');
    const replay = mgr.submitPlan(id, {
        ...planBody(actions),
        expectedVersion: mgr.get(id).version
    });
    assert.equal(replay.error, 'DUPLICATE_STRATEGY');
    assert.equal(mgr.get(id).status, 'REPLANNING');
    const changed = mgr.submitPlan(id, {
        ...planBody([{ type: 'replace_part', target: 'U1', parameters: { footprint: 'TO-92' } }]),
        expectedVersion: mgr.get(id).version
    });
    assert.equal(changed.ok, true, changed.error);
    assert.equal(changed.task.status, 'READY');
}

// Illegal edge and communication loop
{
    assert.throws(() => transition(
        { taskId: 'x', status: 'CREATED', version: 1, iteration: 0 },
        'EXECUTING',
        {},
        { appendTransition() {} }
    ), (err) => err.code === 'ILLEGAL_TRANSITION');

    const loop = detectCommunicationLoop([
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' }
    ]);
    assert.equal(loop.detected, true);
    assert.equal(loop.type, 'COMMUNICATION');
}

// Semantic loop
{
    const mgr = createTaskManager({ });
    const id = readyTask(mgr, { erc: 6, limits: { noProgress: 5 } });
    let last;
    for (let i = 0; i < 3; i++) {
        act(mgr, id, { actionId: 'sem-' + i, type: 'swap', intent: 'same idea', parameters: { n: i } });
        last = finish(mgr, id, { erc_errors: 6 }, 'SEM' + i);
    }
    assert.equal(last.loop.type, 'SEMANTIC_INTENT');
    assert.equal(last.task.status, 'REPLANNING');
}

// Open task blocks board writes until EXECUTING
{
    const mgr = createTaskManager();
    readyTask(mgr, { taskId: 'gate' });
    assert.equal(mgr.writeGate('designer-01').error, 'TASK_NOT_EXECUTING');
    act(mgr, 'gate', { actionId: 'go' });
    assert.equal(mgr.writeGate('designer-01'), null);
    assert.equal(mgr.writeGate('other').error, 'LOCK_HELD');
}

console.log('task state machine tests passed');
