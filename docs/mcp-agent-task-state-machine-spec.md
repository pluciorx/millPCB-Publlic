# MCP Agent Task State Machine & Loop Prevention Specification

**Status:** Implementation Ready  
**Scope:** MCP server / agent orchestration layer  
**Primary implementation target:** `server.mjs` and supporting orchestration modules

---

## 1. Purpose

The MCP server MUST maintain an explicit state machine for every agent task.

The state machine controls:

- task lifecycle
- agent execution
- tool execution
- verification
- progress detection
- replanning
- loop detection
- blocking
- failure
- successful completion
- cancellation
- resource ownership

The LLM MUST NOT directly control task state.

The MCP server is the sole authority capable of committing state transitions.

---

# 2. Core Architecture

```text
                    +-------------------+
                    |       AGENT       |
                    |  proposes action  |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    |    MCP SERVER     |
                    |                   |
                    | Policy            |
                    | Invariants        |
                    | State Machine     |
                    | Loop Detection    |
                    | Progress Control  |
                    | Resource Locks    |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    |       TOOL        |
                    |     EXECUTION     |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    |    VERIFICATION   |
                    | objective result  |
                    +---------+---------+
                              |
                              v
                    +-------------------+
                    | STATE TRANSITION  |
                    +-------------------+
```

### Architectural rule

> **The agent controls the hypothesis. The MCP server controls execution. The verifier controls truth. The state machine controls progression.**

---

# 3. Task State Model

Every task MUST contain:

```typescript
interface TaskState {
    taskId: string;

    status: TaskStatus;

    version: number;

    iteration: number;

    goal: string;

    successCriteria: SuccessCriteria;

    currentStateHash: string;
    previousStateHash?: string;

    noProgressCount: number;
    regressionCount: number;
    replanCount: number;
    repeatedStateCount: number;

    currentAgentId?: string;
    activeActionId?: string;

    activeResourceLocks: ResourceLock[];

    createdAt: string;
    updatedAt: string;
}
```

---

# 4. Task Status Enumeration

```typescript
enum TaskStatus {
    CREATED,
    PLANNING,
    READY,
    EXECUTING,
    VERIFYING,

    PROGRESS,
    NO_PROGRESS,
    REGRESSION,

    REPLANNING,
    BLOCKED,

    SUCCESS,
    FAILED,
    LOOP_DETECTED,
    LIMIT_REACHED,
    CANCELLED
}
```

## Active states

```text
CREATED
PLANNING
READY
EXECUTING
VERIFYING
PROGRESS
NO_PROGRESS
REGRESSION
REPLANNING
```

## Suspended state

```text
BLOCKED
```

## Terminal states

```text
SUCCESS
FAILED
LOOP_DETECTED
LIMIT_REACHED
CANCELLED
```

Terminal states are immutable.

---

# 5. Canonical State Machine

```text
                         +-----------+
                         |  CREATED  |
                         +-----+-----+
                               |
                               v
                         +-----------+
                         | PLANNING  |
                         +-----+-----+
                               |
                         valid plan
                               |
                               v
                         +-----------+
                    +----|   READY   |<------------------+
                    |    +-----+-----+                   |
                    |          |                         |
                    |     action approved                |
                    |          |                         |
                    |          v                         |
                    |    +-----------+                   |
                    |    | EXECUTING |                   |
                    |    +-----+-----+                   |
                    |          |                         |
                    |    execution complete              |
                    |          |                         |
                    |          v                         |
                    |    +-----------+                   |
                    |    | VERIFYING |                   |
                    |    +-----+-----+                   |
                    |          |                         |
                    |     +----+----+----+               |
                    |     |         |    |               |
                    |     v         v    v               |
                    |  PROGRESS  NO_PROGRESS REGRESSION  |
                    |     |         |    |               |
                    |     |         v    v               |
                    |     |     REPLANNING <-------------+
                    |     |         |
                    |     |         v
                    |     +------> READY
                    |
                    +----------------------------------+
```

Terminal exits:

```text
VERIFYING -> SUCCESS
VERIFYING -> LOOP_DETECTED
VERIFYING -> LIMIT_REACHED

EXECUTING -> FAILED
EXECUTING -> BLOCKED

PLANNING -> FAILED
PLANNING -> BLOCKED

READY -> BLOCKED
READY -> CANCELLED

REPLANNING -> FAILED
REPLANNING -> BLOCKED
REPLANNING -> LOOP_DETECTED
REPLANNING -> LIMIT_REACHED

BLOCKED -> PLANNING
BLOCKED -> CANCELLED
```

---

# 6. Legal Transition Matrix

| From | Event / Condition | To |
|---|---|---|
| `CREATED` | task accepted | `PLANNING` |
| `CREATED` | cancellation | `CANCELLED` |
| `PLANNING` | valid plan | `READY` |
| `PLANNING` | dependency unavailable | `BLOCKED` |
| `PLANNING` | planning failure | `FAILED` |
| `READY` | valid action approved | `EXECUTING` |
| `READY` | dependency unavailable | `BLOCKED` |
| `READY` | cancellation | `CANCELLED` |
| `EXECUTING` | action completed | `VERIFYING` |
| `EXECUTING` | unrecoverable error | `FAILED` |
| `EXECUTING` | dependency unavailable | `BLOCKED` |
| `VERIFYING` | success criteria satisfied | `SUCCESS` |
| `VERIFYING` | measurable progress | `PROGRESS` |
| `VERIFYING` | no measurable progress | `NO_PROGRESS` |
| `VERIFYING` | regression | `REGRESSION` |
| `VERIFYING` | loop detected | `LOOP_DETECTED` |
| `VERIFYING` | limit exceeded | `LIMIT_REACHED` |
| `PROGRESS` | more work required | `READY` |
| `PROGRESS` | success criteria satisfied | `SUCCESS` |
| `NO_PROGRESS` | retry allowed | `READY` |
| `NO_PROGRESS` | no-progress limit reached | `REPLANNING` |
| `NO_PROGRESS` | replan limit reached | `LIMIT_REACHED` |
| `REGRESSION` | rollback/replan possible | `REPLANNING` |
| `REGRESSION` | regression limit reached | `LIMIT_REACHED` |
| `REPLANNING` | valid new strategy | `READY` |
| `REPLANNING` | no viable strategy | `FAILED` |
| `REPLANNING` | loop detected | `LOOP_DETECTED` |
| `REPLANNING` | replan limit reached | `LIMIT_REACHED` |
| `BLOCKED` | blocker resolved | `PLANNING` |
| `BLOCKED` | cancellation | `CANCELLED` |

Any transition not listed MUST be rejected.

---

# 7. Explicit Server Invariants

## INV-001 — Server Authority

The MCP server is the authoritative owner of task state.

Agents MUST NOT directly set lifecycle states.

---

## INV-002 — Single Current State

A task MUST have exactly one current lifecycle state.

Invalid:

```text
EXECUTING + REPLANNING
SUCCESS + EXECUTING
```

---

## INV-003 — Terminal State Immutability

Once a task reaches:

```text
SUCCESS
FAILED
LOOP_DETECTED
LIMIT_REACHED
CANCELLED
```

no further action may execute.

---

## INV-004 — Current State Required for Mutation

Every mutation MUST include the state/version against which it was planned.

If the supplied version is stale:

```text
STALE_AGENT_STATE
```

MUST be returned.

---

## INV-005 — Mutation Authorization

Agents MUST NOT directly mutate shared design state.

Every mutation passes through MCP authorization and locking.

---

## INV-006 — Single Writer

A shared mutable resource may have at most one active writer.

Readers may operate concurrently.

---

## INV-007 — Mutation Produces State Observation

Every mutation MUST capture:

```text
state_hash_before
state_hash_after
```

For PCB tasks the state SHOULD additionally include:

```text
schematic_hash
pcb_hash
netlist_hash
erc_hash
drc_hash
bom_hash
```

---

## INV-008 — Every Mutation Has a Result

Every completed mutation MUST be classified:

```text
PROGRESS
NO_PROGRESS
REGRESSION
SUCCESS
```

If classification cannot be established:

```text
UNKNOWN
```

`UNKNOWN` MUST NOT be treated as success.

---

## INV-009 — No-Progress Is Bounded

The server MUST maintain `noProgressCount`.

When the configured maximum is reached, the task MUST replan or terminate.

---

## INV-010 — Repeated State Is Loop Evidence

Returning to a previously observed state for the same goal MUST be recorded.

Repeated occurrence beyond the configured threshold MUST trigger replan or loop termination.

---

## INV-011 — Repeated Actions Are Bounded

Normalized action signatures MUST be tracked.

Repeated actions beyond the configured threshold MUST trigger replan.

---

## INV-012 — Progress Resets No-Progress Counter

On `PROGRESS`:

```text
noProgressCount = 0
```

---

## INV-013 — Regression Is Explicit

A regression MUST never be silently treated as normal progress.

---

## INV-014 — Checkpoints Are Immutable

Verified checkpoints cannot be modified in place.

---

## INV-015 — Reasoning Is Not Progress

The following are NOT evidence of progress:

```text
token count
reasoning length
number of tool calls
agent confidence
agent statement of success
```

Only observable state and verification count.

---

## INV-016 — Timeout Does Not Mean Success

A timed-out mutation is:

```text
UNKNOWN
```

until the actual system state is inspected.

The server MUST NOT blindly retry the mutation.

---

## INV-017 — Every Transition Is Logged

Every state transition MUST create an immutable transition event.

---

## INV-018 — Transitions Are Atomic

A transition must update:

1. task state
2. task version
3. transition history
4. locks

atomically.

---

## INV-019 — Monotonic Task Version

Every state-changing operation increments `task.version`.

Agents must supply the version they observed.

---

## INV-020 — Stale Agents Cannot Overwrite Newer Work

If an agent operates against an older version, the server MUST reject the mutation.

---

# 8. Numeric Defaults

The following are normative defaults.

```yaml
agent_control:

  iterations:
    default: 30
    hard_max: 100

  replanning:
    default_max: 3
    hard_max: 5

  no_progress:
    default_max: 3
    hard_max: 5

  regressions:
    default_max: 2
    hard_max: 3

  repeated_state:
    default_max: 2
    hard_max: 3

  repeated_action:
    default_max: 3
    hard_max: 5

  semantic_loop:
    window: 8
    hard_max_window: 20

  communication:
    max_messages_per_iteration: 10
    max_messages_per_task: 200
    max_same_intent_messages: 3

  concurrency:
    max_concurrent_agents_per_task: 6
    max_concurrent_writers_per_task: 1

  retries:
    max_tool_retries: 2
    hard_max_tool_retries: 3
    max_state_recovery_checks: 2

  timeouts:
    tool_call_seconds: 120
    verification_seconds: 60
    agent_response_seconds: 300
    task_seconds: 1800
    hard_task_seconds: 3600

  history:
    action_history: 100
    state_history: 100
    transition_history: 500

  checkpoints:
    default_max: 20
    hard_max: 50
```

Agents MUST NOT be allowed to raise these limits.

Task-specific overrides may be lower or, where permitted by policy, higher than defaults but MUST NOT exceed hard caps.

---

# 9. State-Specific Rules

## 9.1 CREATED

Initial state.

Required:

```text
version = 1
iteration = 0
replanCount = 0
noProgressCount = 0
regressionCount = 0
```

No tool execution is allowed.

---

## 9.2 PLANNING

The agent may:

- inspect the design;
- search datasheets;
- search components;
- communicate with other agents;
- build a plan.

The agent MUST NOT mutate protected design resources.

A valid plan MUST define:

```text
goal
actions
expected effects
success criteria
resource requirements
```

---

## 9.3 READY

The task has a valid executable plan.

Before entering `EXECUTING`, the server MUST validate:

```text
task version
agent identity
resource locks
action permissions
iteration budget
loop limits
expected design state
```

---

## 9.4 EXECUTING

An approved action is executing.

The server records:

```text
activeActionId
currentAgentId
expectedVersion
resourceLocks
```

Only one writer may operate on a protected resource.

---

## 9.5 VERIFYING

Server-controlled state.

The server evaluates:

1. Did execution complete?
2. Did the state change?
3. Did relevant metrics improve?
4. Was there a regression?
5. Are success criteria satisfied?
6. Was a loop detected?
7. Was a limit exceeded?

The agent does not decide the result.

---

## 9.6 PROGRESS

The task moved materially closer to the goal.

Example:

```text
ERC errors: 5 -> 3
Unconnected nets: 4 -> 2
```

Reset:

```text
noProgressCount = 0
```

Then:

```text
PROGRESS -> SUCCESS
```

if criteria pass, otherwise:

```text
PROGRESS -> READY
```

---

## 9.7 NO_PROGRESS

The latest action did not materially advance the task.

Increment:

```text
noProgressCount++
```

If below limit:

```text
NO_PROGRESS -> READY
```

Otherwise:

```text
NO_PROGRESS -> REPLANNING
```

---

## 9.8 REGRESSION

Relevant design metrics worsened.

Increment:

```text
regressionCount++
```

Then:

```text
REGRESSION -> REPLANNING
```

unless the regression limit is reached:

```text
REGRESSION -> LIMIT_REACHED
```

---

## 9.9 REPLANNING

The current strategy is considered unsuccessful.

The server MUST provide:

```text
failed actions
failed hypotheses
verification results
state history
current state
reason for replan
```

The new plan MUST be materially different.

A trivial replay of the failed strategy MUST be rejected as:

```text
DUPLICATE_STRATEGY
```

---

## 9.10 BLOCKED

The task cannot safely continue because of an external dependency.

Examples:

```text
missing datasheet
tool unavailable
resource unavailable
user decision required
external API unavailable
```

Blocked tasks do not consume normal execution iterations while waiting.

When resolved:

```text
BLOCKED -> PLANNING
```

---

## 9.11 SUCCESS

Terminal.

Only the verifier may establish success.

All success criteria MUST be true.

---

## 9.12 FAILED

Terminal.

Used for unrecoverable execution/planning failures.

`FAILED` means execution failed, not that a safety limit was intentionally reached.

---

## 9.13 LOOP_DETECTED

Terminal.

Used when the system conclusively identifies a loop and no safe replan remains.

Loop evidence MUST be preserved.

---

## 9.14 LIMIT_REACHED

Terminal.

Used when a configured safety/resource limit is exhausted.

The exact limit MUST be recorded.

---

## 9.15 CANCELLED

Terminal.

Triggered by user, administrator, or supervisor.

New mutations MUST immediately be rejected.

---

# 10. Loop Detection

Loop detection MUST be implemented as a separate service.

It MUST return evidence rather than directly changing task state.

Example:

```typescript
{
    detected: true,
    type: "REPEATED_STATE",
    evidence: {
        stateHash: "8A91F3",
        occurrences: [12, 17]
    }
}
```

The state machine decides whether this results in:

```text
REPLANNING
```

or:

```text
LOOP_DETECTED
```

---

# 11. Loop Types

The server MUST support at least:

### Exact state loop

```text
S1 -> S2 -> S1
```

### Repeated action loop

```text
A -> B -> A -> B
```

### Semantic intent loop

```text
same intent
+
same strategy
+
no measurable improvement
```

### Communication loop

```text
Agent A -> Agent B -> Agent A -> Agent B
```

### Replanning loop

```text
Plan A
failed

Plan B
failed

Plan A again
```

---

# 12. Progress Evaluation

Progress evaluation MUST be deterministic where possible.

Example:

```text
before:
ERC = 5

after:
ERC = 3

result:
PROGRESS
```

The verifier SHOULD use task-specific metrics.

For PCB tasks:

```text
ERC errors
DRC errors
unconnected nets
invalid footprints
missing power connections
constraint violations
BOM violations
```

LLM reasoning is not a metric.

---

# 13. Action Contract

Agent actions MUST contain:

```typescript
interface AgentActionRequest {

    taskId: string;

    agentId: string;

    expectedVersion: number;

    actionId: string;

    type: string;

    intent: string;

    target?: string;

    parameters?: Record<string, unknown>;

    expectedEffect?: Record<string, unknown>;
}
```

Example:

```json
{
    "taskId": "pcb-184",
    "agentId": "designer-01",
    "expectedVersion": 44,
    "actionId": "act-912",
    "type": "modify_component",
    "intent": "Improve regulator stability",
    "target": "C17",
    "parameters": {
        "value": "100nF"
    },
    "expectedEffect": {
        "erc_errors": 0
    }
}
```

---

# 14. Action Result Contract

```typescript
interface ActionResult {

    actionId: string;

    execution:
        | "SUCCESS"
        | "FAILED"
        | "UNKNOWN";

    progress:
        | "PROGRESS"
        | "NO_PROGRESS"
        | "REGRESSION"
        | "SUCCESS"
        | "UNKNOWN";

    stateBefore: string;
    stateAfter: string;

    metricsBefore: Record<string, number>;
    metricsAfter: Record<string, number>;

    nextState: TaskStatus;
}
```

---

# 15. Transition Event

Every transition MUST generate:

```typescript
interface StateTransition {

    taskId: string;

    version: number;

    from: TaskStatus;
    to: TaskStatus;

    reason: string;

    iteration: number;

    agentId?: string;
    actionId?: string;

    stateHashBefore?: string;
    stateHashAfter?: string;

    timestamp: string;
}
```

Example:

```json
{
    "taskId": "pcb-184",
    "version": 47,
    "from": "VERIFYING",
    "to": "NO_PROGRESS",
    "reason": "ERC count unchanged",
    "iteration": 12,
    "actionId": "act-912",
    "stateHashBefore": "8A91",
    "stateHashAfter": "8A91"
}
```

---

# 16. Transition Function

All state transitions MUST go through one centralized function.

```javascript
function transition(task, target, context) {

    assertAllowedTransition(
        task.status,
        target
    );

    assertTransitionGuards(
        task,
        target,
        context
    );

    const nextVersion = task.version + 1;

    persistTransition({
        task,
        target,
        version: nextVersion,
        context
    });

    task.status = target;
    task.version = nextVersion;
}
```

No code outside the state machine may directly assign:

```javascript
task.status = ...
```

---

# 17. Execution Cycle

The canonical execution cycle is:

```text
CREATED
   |
   v
PLANNING
   |
   v
READY
   |
   v
EXECUTING
   |
   v
VERIFYING
   |
   +---- SUCCESS ----------> SUCCESS
   |
   +---- PROGRESS ---------> READY
   |
   +---- NO_PROGRESS ------> READY
   |                            |
   |                            +-- limit --> REPLANNING
   |
   +---- REGRESSION -------> REPLANNING
   |
   +---- LOOP -------------> LOOP_DETECTED
   |
   +---- LIMIT ------------> LIMIT_REACHED
```

---

# 18. Concurrency Model

Independent agents SHOULD work concurrently.

Example:

```text
Designer
    |
    +-- modifies schematic

Parts Research Agent
    |
    +-- searches components

Reviewer
    |
    +-- analyses current design

Verifier
    |
    +-- checks current state
```

Only one agent may mutate a shared resource.

Read-only operations may run concurrently.

Default:

```text
maxConcurrentAgents = 6
maxConcurrentWriters = 1
```

---

# 19. Resource Lock

A write lock MUST contain:

```typescript
interface ResourceLock {

    resource: string;

    ownerAgentId: string;

    taskId: string;

    acquiredVersion: number;

    expiresAt: string;
}
```

Locks MUST expire/recover after crashed agents.

---

# 20. Timeouts

Defaults:

```text
Tool call:          120s
Verification:        60s
Agent response:     300s
Task:              1800s
Hard task limit:   3600s
```

A mutation timeout produces:

```text
UNKNOWN
```

The server MUST inspect actual state before allowing a retry.

Maximum state recovery checks:

```text
2
```

---

# 21. Counter Semantics

### iteration

Never resets during a task.

### replanCount

Never resets during a task.

### noProgressCount

Resets to zero after verified progress.

### regressionCount

May reset only after a verified successful strategy transition.

### sameActionCount

Resets when the normalized action signature materially changes.

### sameStateCount

Tracks repeated occurrences of the same state within the active strategy.

---

# 22. Strategy Diversity

After replanning, the new strategy SHOULD differ materially from the failed strategy.

Recommended threshold:

```text
MIN_NEW_STRATEGY_DIFFERENCE = 30%
```

The server SHOULD reject obvious replay of a failed strategy.

---

# 23. Checkpoints

Verified checkpoints SHOULD be created after meaningful progress.

Defaults:

```text
20 checkpoints/task
50 hard maximum
```

Checkpoint creation MUST NOT reset:

```text
iteration
replanCount
regressionCount
```

---

# 24. Recommended Module Structure

```text
server.mjs
|
+-- taskManager.js
|
+-- taskStateMachine.js
|
+-- loopDetector.js
|
+-- progressEvaluator.js
|
+-- resourceLockManager.js
|
+-- verifier.js
|
+-- taskHistory.js
```

### `taskStateMachine.js`

Owns:

- state enumeration
- legal transitions
- transition guards
- invariants
- terminal state enforcement
- version increments

### `loopDetector.js`

Owns:

- repeated state detection
- repeated action detection
- semantic loop detection
- communication loop detection

It MUST NOT directly modify task state.

### `progressEvaluator.js`

Owns:

- before/after comparison
- metric evaluation
- progress classification
- regression detection

### `resourceLockManager.js`

Owns:

- write locks
- read locks
- stale lock recovery
- stale state rejection

### `verifier.js`

Owns:

- objective validation
- success criteria
- PCB/ERC/DRC verification

---

# 25. Minimum Implementation Requirements

The first implementation MUST include:

1. Explicit task state machine.
2. Centralized transition function.
3. Terminal-state enforcement.
4. Task versioning.
5. State hashes.
6. Action history.
7. Repeated-state detection.
8. Repeated-action detection.
9. No-progress counter.
10. Regression counter.
11. Replan counter.
12. Iteration limit.
13. Resource locking.
14. Stale-agent rejection.
15. Verification after mutations.
16. Immutable transition history.
17. Explicit success criteria.
18. Timeout handling.
19. Unknown-result handling.

Semantic intent detection may be added after the deterministic mechanisms are working.

---

# 26. Implementation Acceptance Criteria

The implementation is considered complete when all of the following tests pass.

### Test 1 — Normal success

```text
CREATED
-> PLANNING
-> READY
-> EXECUTING
-> VERIFYING
-> PROGRESS
-> READY
-> EXECUTING
-> VERIFYING
-> SUCCESS
```

### Test 2 — No progress

```text
VERIFYING
-> NO_PROGRESS
-> READY
```

After 3 consecutive failures:

```text
NO_PROGRESS
-> REPLANNING
```

### Test 3 — Repeated state

```text
S1
-> S2
-> S1
```

The server detects the repeated state.

### Test 4 — Repeated action

```text
A
-> A
-> A
```

After the configured threshold the server forces replanning.

### Test 5 — Regression

```text
ERC 2
-> ERC 7
```

Result:

```text
REGRESSION
-> REPLANNING
```

### Test 6 — Stale agent

```text
Agent version = 41
Server version = 44
```

Mutation is rejected.

### Test 7 — Terminal protection

After:

```text
SUCCESS
```

any mutation is rejected.

### Test 8 — Timeout

Mutation times out.

Server returns:

```text
UNKNOWN
```

and verifies state before retry.

### Test 9 — Concurrent writers

Two agents request write access.

Exactly one obtains the write lock.

### Test 10 — Replan replay

Agent proposes the same failed strategy.

Server rejects it as:

```text
DUPLICATE_STRATEGY
```

---

# 27. Final Protocol Rule

The entire orchestration system MUST enforce:

```text
AGENT
  |
  | propose
  v
MCP
  |
  | validate
  v
EXECUTE
  |
  | observe
  v
VERIFY
  |
  | classify
  v
STATE MACHINE
  |
  +--> CONTINUE
  +--> REPLAN
  +--> BLOCK
  +--> SUCCESS
  +--> STOP
```

The agent is never allowed to bypass the state machine.

**The LLM proposes.  
The MCP server authorizes.  
The tools execute.  
The verifier measures.  
The state machine decides.**
