# millPCB Electrical-First Routing Gate Specification

## Purpose

This specification defines the required implementation for an
electrical-first design flow in millPCB.

The goal is simple:

> **Copper routing must never be allowed merely because a
> schematic/netlist exists. Routing is allowed only after the logical
> electrical design has passed validation.**

The existing code already contains most of the required logic. In
particular, `plan.js` contains:

-   `Plan.electricalCheck(project, contract)` --- logical circuit
    validation before copper.
-   `Plan.circuitCheck(project, contract)` --- physical copper vs
    circuit contract validation after routing.
-   `Plan.qualityCheck(project)` ---
    single-layer/crossing/disconnected-net quality checks.

Therefore, **do not create a second generic electrical validator in
`host.mjs` unless a specific missing validation is identified**. The
preferred implementation is to use and strengthen the existing
`Plan.electricalCheck()`.

------------------------------------------------------------------------

# 1. Current architecture

## 1.1 Existing schematic gate

`server.mjs` currently defines:

``` js
function schematicReady(project) {
    const nets = (project && project.netlist) || {};
    let pins = 0;
    for (const name of Object.keys(nets)) pins += (nets[name] || []).length;
    const wires = ((project && project.traces) || []).filter(t => t.schemWire).length;
    return pins >= 2 || wires >= 1;
}
```

This is only a **schematic-declared gate**.

It must NOT be treated as electrical validation.

A netlist with two pins can currently unlock copper even if:

-   other pins are floating;
-   a pin is assigned to the wrong net;
-   two nets are accidentally merged;
-   a required net is missing from the circuit contract;
-   a pin is supposed to be unused but is not declared as such;
-   the contract does not match the netlist.

------------------------------------------------------------------------

# 2. Required state machine

The design flow must become:

``` text
START
  |
  v
REQUIREMENTS
  |
  v
COMPONENT_SELECTION
  |
  v
PLACEMENT
  |
  v
PLAN_CHECK
  |
  v
SCHEMATIC_DECLARED
  |
  v
SCHEMATIC_LAYOUT
  |
  v
ELECTRICAL_VALIDATED
  |
  v
ROUTING_ALLOWED
  |
  v
COPPER_ROUTING
  |
  v
COPPER_VALIDATED
  |
  v
QUALITY_CHECK
  |
  v
DRC
  |
  v
VISUAL_REVIEW
  |
  v
EXPORT
  |
  v
COMPLETE
```

The important distinction is:

``` text
SCHEMATIC_DECLARED != ELECTRICAL_VALIDATED
```

and:

``` text
ELECTRICAL_VALIDATED != COPPER_VALIDATED
```

------------------------------------------------------------------------

# 3. Existing Plan.electricalCheck() is the pre-routing validator

`plan.js` already contains:

``` js
Plan.electricalCheck(project, contract)
```

This function is the foundation of the new electrical gate.

It currently validates:

### 3.1 Circuit contract exists

It rejects a missing contract:

``` text
missing-contract
```

A netlist alone is explicitly not considered sufficient validation.

### 3.2 Net assignment

It builds a pin-to-net mapping from:

-   `project.netlist`
-   schematic wires (`schemWire`)

It detects pins assigned to multiple nets:

``` text
net-merge
```

### 3.3 Unused pins

The contract supports:

``` js
unused: [{ compId, pin }]
```

The validator checks:

-   unused pin actually exists;
-   unused pin is not assigned to a net;
-   connected pin is not simultaneously marked unused.

Errors include:

``` text
unknown-pin
unused-assigned
```

### 3.4 Floating pins

Every real component pin is checked.

A pin must either:

-   belong to a net, or
-   be explicitly listed in `contract.unused`.

Otherwise:

``` text
floating-pin
```

is generated.

### 3.5 Contract coverage

Every declared net with at least two members must be represented in the
circuit contract.

Otherwise:

``` text
uncovered-net
```

is generated.

### 3.6 Expected pin/net relationships

The validator checks that contract references actually belong to the
declared net.

Errors include:

``` text
disconnected
wrong-net
unknown-pin
unknown-net
```

### 3.7 Rails

Rails must:

-   have a net name;
-   have at least two pins when explicitly declared;
-   reference pins that actually belong to that net.

### 3.8 Branches

Branches must contain:

``` text
net
from
to
```

and both endpoints must belong to the specified net.

### 3.9 Ties

Ties must:

-   have a net;
-   contain at least two pins;
-   contain pins from one component;
-   have every referenced pin on the specified net.

This produces:

``` text
tie-split
```

when a tie spans multiple components.

------------------------------------------------------------------------

# 4. Do NOT replace Plan.electricalCheck()

The implementation should use:

``` js
Plan.electricalCheck(session.project, contract)
```

rather than creating a parallel implementation in `server.mjs`.

Reason:

`plan.js` already implements the required logical validation and is
shared by the browser/kernel and MCP host.

Duplicating this logic would create two sources of truth.

------------------------------------------------------------------------

# 5. Add an explicit electrical validation state

The project must record the result of electrical validation.

Recommended structure:

``` js
project.electricalValidation = {
    revision: session.revision,
    valid: true,
    violations: [],
    validatedAt: Date.now()
};
```

When validation fails:

``` js
project.electricalValidation = {
    revision: session.revision,
    valid: false,
    violations,
    validatedAt: Date.now()
};
```

The exact timestamp field is optional.

The critical fields are:

``` text
revision
valid
violations
```

------------------------------------------------------------------------

# 6. Any mutation invalidates electrical validation

A previous electrical PASS must never survive a later design mutation.

The preferred implementation is in `ProjectSession.mutate()` in
`host.mjs`.

Before executing the mutation:

``` js
delete this.project.electricalValidation;
```

Then:

``` js
const result = fn(this.project);
this.revision++;
return result;
```

This guarantees:

``` text
electrical PASS
    |
    v
any project mutation
    |
    v
electrical validation becomes invalid/stale
```

Examples:

-   moving a component;
-   changing its rotation;
-   changing the netlist;
-   adding/removing a component;
-   changing schematic wires;
-   changing the circuit contract.

All must require electrical validation again.

------------------------------------------------------------------------

# 7. Implement electricalGate() in server.mjs

Add:

``` js
function electricalGate(entry) {
    const p = entry.session.project;

    if (!schematicReady(p)) {
        return {
            ok: false,
            gated: 'schematic',
            status: 'SCHEMATIC_REQUIRED',
            error:
                'Declare the schematic/netlist before electrical validation.'
        };
    }

    const validation = p.electricalValidation;

    if (!validation || validation.revision !== entry.session.revision) {
        return {
            ok: false,
            gated: 'electrical',
            status: 'NETLIST_NOT_VALIDATED',
            error:
                'Electrical validation is required before routing. ' +
                'Call millpcb_check type="circuit" and fix all violations.'
        };
    }

    if (!validation.valid) {
        return {
            ok: false,
            gated: 'electrical',
            status: 'NETLIST_INVALID',
            violations: validation.violations || [],
            error:
                'Electrical validation failed. Fix the schematic/netlist before routing.'
        };
    }

    return null;
}
```

The exact wording may differ, but the semantics must remain.

------------------------------------------------------------------------

# 8. `millpcb_check type="circuit"` must become the electrical validation command

This tool currently stores the contract and calls:

``` js
Plan.circuitCheck(session.project, contract)
```

That function is the **physical copper check**.

The new behavior must distinguish two phases.

## Before copper

`millpcb_check type="circuit"` must:

1.  store the circuit contract;
2.  call `Plan.electricalCheck(project, contract)`;
3.  store `electricalValidation`;
4.  return `NETLIST_VALID` only when there are zero electrical
    violations.

Conceptually:

``` js
const violations =
    Plan.electricalCheck(session.project, contract);

session.project.electricalValidation = {
    revision: session.revision,
    valid: violations.length === 0,
    violations
};

return {
    ok: violations.length === 0,
    status: violations.length ? 'NETLIST_INVALID' : 'NETLIST_VALID',
    violations,
    revision: session.revision
};
```

------------------------------------------------------------------------

# 9. Circuit check after routing

After physical copper exists, `millpcb_check type="circuit"` must also
run:

``` js
Plan.circuitCheck(session.project, contract)
```

This remains important.

The two checks have different purposes:

  -----------------------------------------------------------------------
  Check                               Function
  ----------------------------------- -----------------------------------
  `Plan.electricalCheck()`            Does the logical schematic/netlist
                                      match the circuit contract?

  `Plan.circuitCheck()`               Does the physical copper implement
                                      the circuit contract?
  -----------------------------------------------------------------------

Do not remove `Plan.circuitCheck()`.

------------------------------------------------------------------------

# 10. Recommended `millpcb_check circuit` semantics

The command should work as follows:

``` text
millpcb_check circuit
        |
        v
Validate contract + netlist
        |
        +---- violations ----> NETLIST_INVALID
        |
        v
NETLIST_VALID
        |
        v
If physical copper exists:
        |
        v
Plan.circuitCheck()
        |
        +---- violations ----> COPPER_INVALID
        |
        v
COPPER_VALID
```

Before routing, a clean result should be:

``` text
NETLIST_VALID
```

After routing, a clean result should be:

``` text
NETLIST_VALID
COPPER_VALID
```

------------------------------------------------------------------------

# 11. Required routing gates

Every tool capable of creating physical copper must call
`electricalGate()`.

This includes at minimum:

``` text
millpcb_connect_pins
millpcb_route_rail
millpcb_autoroute
millpcb_add_trace
```

The order must be:

``` js
const schem = schematicGate(entry);
if (schem) return schem;

const electrical = electricalGate(entry);
if (electrical) return electrical;

const gate = planGate(entry);
if (gate) return gate;
```

Then, and only then:

``` js
session.mutate(...)
```

------------------------------------------------------------------------

# 12. Freehand trace must not bypass the gate

`millpcb_add_trace` is especially important.

It currently has only a schematic gate.

It must also use:

``` js
electricalGate(entry)
```

Otherwise an agent could bypass the electrical gate by drawing a
freehand copper trace instead of using the autorouter.

------------------------------------------------------------------------

# 13. Autorouter must not bypass the gate

`millpcb_autoroute` must require:

``` text
schematic
+
electrical validation
+
plan/DRC gate
```

before calling:

``` js
Autoroute.route(...)
```

Routing success is never proof of electrical correctness.

------------------------------------------------------------------------

# 14. `millpcb_route_rail` must not bypass the gate

A rail is physical copper.

Therefore it also requires:

``` text
SCHEMATIC_DECLARED
ELECTRICAL_VALIDATED
PLAN_VALID
```

before creating traces.

------------------------------------------------------------------------

# 15. `millpcb_add_via`

millPCB is a single-layer board.

The agent instructions already prohibit vias.

The preferred long-term behavior is for `millpcb_add_via` to reject the
operation entirely:

``` js
return {
    ok: false,
    error: 'millPCB is single-layer. Vias are not supported.'
};
```

This is separate from electrical validation.

------------------------------------------------------------------------

# 16. Netlist requirements

`millpcb_set_netlist` must remain the authoritative logical connectivity
declaration.

The validator must ensure:

-   every referenced component exists;
-   every referenced pin exists;
-   no pin belongs to multiple nets;
-   every required pin is accounted for;
-   unused pins are explicitly declared;
-   contract references match the netlist;
-   every declared multi-pin net is covered by the contract.

Do not infer circuit intent from physical copper.

------------------------------------------------------------------------

# 17. Unused / NC pins

The existing `Plan.electricalCheck()` uses the contract field:

``` js
unused: [{ compId, pin }]
```

Therefore the MCP circuit contract schema should expose `unused`.

Recommended schema addition:

``` js
unused: z.array(
    z.object({
        compId: z.number(),
        pin: z.union([z.string(), z.number()])
    })
).optional()
```

The exact project field name should remain consistent with
`Plan.electricalCheck()`.

Do not introduce a second incompatible `noConnect` representation unless
the kernel is changed consistently.

------------------------------------------------------------------------

# 18. Workflow changes

`millpcb_workflow` must report electrical validation as a separate step.

Recommended order:

``` text
plan
place
planCheck
schematic
electrical
route
circuit
qualityCheck
drc
export
```

The current route status must NOT become `pass` merely because:

``` js
schematicReady(project)
```

is true.

Instead:

``` text
schematic exists
+
electricalValidation.valid === true
+
electricalValidation.revision === session.revision
```

must be true before routing is considered available.

------------------------------------------------------------------------

# 19. Recommended workflow status

Example:

``` json
{
    "step": "electrical",
    "status": "pass",
    "detail": "electrical/netlist validation passed"
}
```

or:

``` json
{
    "step": "electrical",
    "status": "fail",
    "detail": "3 electrical violation(s) — run millpcb_check type=\"circuit\""
}
```

Route status when blocked:

``` json
{
    "step": "route",
    "status": "blocked",
    "detail": "electrical validation required before copper routing"
}
```

------------------------------------------------------------------------

# 20. Requirements for the agent

The MCP instructions must explicitly tell the agent:

1.  Declare the complete schematic/netlist.
2.  Declare the circuit contract.
3.  Run:

``` text
millpcb_check type="circuit"
```

4.  Do not route if the result is not `NETLIST_VALID`.
5.  Fix every electrical violation before routing.
6.  Route only after the electrical gate opens.
7.  Run circuit validation again after routing.
8.  Run quality and DRC checks.
9.  Visually inspect the board and schematic.
10. Export only after all gates pass.

------------------------------------------------------------------------

# 21. Correct agent sequence

The canonical agent sequence is:

``` text
millpcb_workflow
        |
        v
millpcb_set_plan
        |
        v
millpcb_place_by_plan
        |
        v
millpcb_check plan
        |
        v
millpcb_set_netlist
        |
        v
millpcb_layout_schematic
        |
        v
millpcb_screenshot view=schematic
        |
        v
millpcb_check circuit
        |
        +---- FAIL ----> fix netlist/contract
        |
        v
NETLIST_VALID
        |
        v
millpcb_route_rail / millpcb_connect_pins / millpcb_autoroute
        |
        v
millpcb_check circuit
        |
        +---- FAIL ----> fix copper
        |
        v
millpcb_check quality
        |
        v
millpcb_check drc
        |
        v
millpcb_screenshot view=board
        |
        v
millpcb_export
```

------------------------------------------------------------------------

# 22. Physical copper is never allowed to define the circuit

The following must be treated as invalid reasoning:

``` text
"The autorouter connected everything, therefore the circuit is correct."
```

Also invalid:

``` text
"DRC passed, therefore the circuit is correct."
```

And:

``` text
"The schematic exists, therefore routing is allowed."
```

Correct reasoning is:

``` text
Circuit intent
    ↓
Circuit contract
    ↓
Logical netlist validation
    ↓
Routing
    ↓
Physical copper validation
    ↓
DRC / quality
```

------------------------------------------------------------------------

# 23. Do not confuse DRC with electrical validation

DRC validates physical manufacturing constraints such as:

-   clearance;
-   trace width;
-   drill rules.

Electrical validation validates:

-   logical net membership;
-   floating pins;
-   wrong-net pins;
-   duplicate/net-merged pins;
-   unused pins;
-   contract coverage;
-   rails;
-   branches;
-   ties.

These are separate gates.

------------------------------------------------------------------------

# 24. Do not confuse Plan.electricalCheck with Plan.circuitCheck

This distinction must be preserved in code comments.

### `Plan.electricalCheck()`

Logical pre-routing validation.

``` text
NETLIST + SCHEMATIC + CONTRACT
```

### `Plan.circuitCheck()`

Physical post-routing validation.

``` text
NETLIST + CONTRACT + COPPER
```

Both are required.

------------------------------------------------------------------------

# 25. Quality check remains a separate gate

After copper routing:

``` js
Plan.qualityCheck(project)
```

must still run.

It catches, among other things:

-   vias on a single-layer board;
-   cross-net trace crossings;
-   disconnected copper groups.

A circuit can therefore be:

``` text
electrically correct
```

but still:

``` text
manufacturing/quality invalid
```

Those are separate conditions.

------------------------------------------------------------------------

# 26. Export gate

Export must require all relevant gates:

``` text
PLAN PASS
+
ELECTRICAL PASS
+
COPPER/CIRCUIT PASS
+
QUALITY PASS
+
DRC PASS
```

Export must not be unlocked merely because:

``` text
Plan.planCheck()
```

and DRC pass.

------------------------------------------------------------------------

# 27. Revision safety

Electrical validation is valid only for the exact project revision
against which it was calculated.

Required invariant:

``` js
validation.revision === session.revision
```

If not:

``` text
NETLIST_NOT_VALIDATED
```

must be returned.

This protects against stale validation after any mutation.

------------------------------------------------------------------------

# 28. Error model

Use machine-readable states.

Recommended:

``` text
SCHEMATIC_REQUIRED
NETLIST_NOT_VALIDATED
NETLIST_INVALID
CIRCUIT_CONTRACT_INVALID
NETLIST_VALID
COPPER_INVALID
COPPER_VALID
QUALITY_INVALID
DRC_INVALID
EXPORT_ALLOWED
```

The existing violation objects should be preserved rather than replaced
by generic error strings.

------------------------------------------------------------------------

# 29. Implementation files

### `plan.js`

Use and preserve:

``` js
Plan.electricalCheck()
Plan.circuitCheck()
Plan.qualityCheck()
```

No duplicate electrical validator unless a concrete missing requirement
is demonstrated.

### `host.mjs`

Implement validation state handling and invalidate electrical validation
on mutation.

### `server.mjs`

Implement:

``` js
electricalGate(entry)
```

and enforce it in every physical copper mutation.

Update:

``` text
millpcb_check
millpcb_workflow
```

accordingly.

### Agent MD instructions

Explicitly describe:

``` text
schematic declaration
→ electrical validation
→ routing
→ physical circuit validation
```

------------------------------------------------------------------------

# 30. Acceptance tests

The implementation is not complete until these cases behave correctly.

## Test 1 --- empty netlist

Expected:

``` text
routing blocked
NETLIST_NOT_VALIDATED or NETLIST_INVALID
```

## Test 2 --- two pins declared, other pins floating

Expected:

``` text
NETLIST_INVALID
floating-pin
```

## Test 3 --- pin assigned to two nets

Expected:

``` text
NETLIST_INVALID
net-merge
```

## Test 4 --- contract references wrong net

Expected:

``` text
NETLIST_INVALID
wrong-net
```

## Test 5 --- declared net missing from contract

Expected:

``` text
NETLIST_INVALID
uncovered-net
```

## Test 6 --- unused pin correctly declared

Expected:

``` text
no floating-pin violation
```

## Test 7 --- electrical validation passes

Expected:

``` text
NETLIST_VALID
```

and copper tools become available.

## Test 8 --- component moved after validation

Expected:

``` text
previous electrical validation invalidated
routing blocked
```

## Test 9 --- copper routes wrong

Expected:

``` text
COPPER_INVALID
```

from `Plan.circuitCheck()`.

## Test 10 --- cross-net crossing

Expected:

``` text
QUALITY_INVALID
```

from `Plan.qualityCheck()`.

## Test 11 --- DRC violation

Expected:

``` text
DRC_INVALID
```

and export blocked.

## Test 12 --- all checks pass

Expected:

``` text
EXPORT_ALLOWED
```

------------------------------------------------------------------------

# 31. Final architectural principle

The critical rule is:

> **The netlist describes connectivity. The circuit contract describes
> intent. `Plan.electricalCheck()` validates that the two agree before
> routing. `Plan.circuitCheck()` validates that physical copper
> implements the intended circuit after routing.**

Therefore:

``` text
SCHEMATIC_EXISTS
        ≠
ELECTRICALLY_CORRECT
        ≠
PHYSICALLY_ROUTED
        ≠
MANUFACTURING_VALID
```

All four stages must be explicitly validated.

Never trade electrical correctness for routing convenience.

------------------------------------------------------------------------

# 27. Multi-Agent Parallel Execution and Communication Protocol

This section defines how an MCP agent must behave when it connects to a
shared millPCB server together with other agents.

The primary objective is to maximize useful parallel work while keeping
shared PCB state safe and communication efficient.

The fundamental rule is:

> **The edit lock serializes mutations; it does not serialize thinking.**
>
> An agent that cannot currently mutate the PCB must continue with useful
> read-only work whenever possible.

The PCB therefore has one mutation stream, but may have many parallel
analysis/research/review streams.

------------------------------------------------------------------------

# 28. Mutation versus non-blocking work

Every agent must distinguish between:

``` text
MUTATING WORK
```

and:

``` text
NON-BLOCKING WORK
```

## 28.1 Mutating work

Mutating work changes shared project state and therefore requires mutation
ownership / edit-lock access.

Examples:

- moving components;
- rotating components;
- adding/removing components;
- changing the plan;
- changing the netlist;
- changing schematic wires;
- changing circuit-contract state;
- creating copper traces;
- routing rails;
- running operations that modify project geometry.

Only one agent may perform these operations at a time.

## 28.2 Non-blocking work

Non-blocking work does not modify shared project state and should normally
be performed without the edit lock.

Examples:

- searching for real electronic parts;
- verifying part numbers;
- verifying pin numbering;
- checking datasheets;
- finding genuine KiCad footprints;
- comparing packages;
- checking THT / 1206 / 0805 / 0603 alternatives;
- analysing the electrical design;
- reviewing the netlist;
- reviewing the circuit contract;
- checking whether pins are correctly accounted for;
- reviewing component placement;
- identifying likely routing conflicts;
- identifying likely single-layer crossings;
- suggesting jumper locations;
- reviewing DRC/quality results;
- preparing the next mutation;
- checking another agent's work.

An agent must not acquire the edit lock merely to perform these tasks.

------------------------------------------------------------------------

# 29. Startup protocol when an agent connects

When an agent connects to the millPCB MCP server, it must follow this
startup sequence.

## Step 1 — Establish / reuse the session

If the user supplied an existing millPCB session ID, call
`millpcb_use_session` before any other millPCB tool.

If session attachment fails, stop and return exactly:

``` text
sorry but there is no active session
```

Do not continue with other millPCB operations.

## Step 2 — Join the collaboration

Call `millpcb_agent_join` and identify the agent's intended role when
possible.

Useful roles include, conceptually:

``` text
LEAD / DESIGNER
PARTS / FOOTPRINT RESEARCH
ELECTRICAL REVIEW
PLACEMENT REVIEW
ROUTING REVIEW
QUALITY / DRC REVIEW
```

The role is a working responsibility, not permission to bypass the shared
mutation rules.

## Step 3 — Read the inbox immediately

Call `millpcb_agent_inbox` at the beginning of every turn.

The agent must inspect:

- current agents;
- roles;
- views;
- edit-lock state;
- recent messages;
- active requests;
- reported blockers;
- decisions already made.

The agent must not start substantial work based only on assumptions from an
earlier turn when shared state may have changed.

## Step 4 — Inspect the current workflow

Call `millpcb_workflow` to understand the current design stage and identify
the next useful work.

The agent must determine whether the project is currently in:

``` text
planning
placement
schematic
logical electrical validation
routing
physical circuit validation
quality/DRC
review
export
```

## Step 5 — Decide whether the agent is a mutator or a parallel worker

If the agent owns the current mutation task, it may proceed with mutation
work, subject to the lock.

If another agent currently owns the mutation stream, the default behaviour is
NOT to wait.

Instead, immediately choose a useful non-blocking task.

------------------------------------------------------------------------

# 30. Default behaviour when another agent is editing

When the edit lock is owned by another agent:

> **Do not wait unless there is no independent useful work remaining.**

The agent should choose one or more of the following:

``` text
PART RESEARCH
FOOTPRINT VERIFICATION
ELECTRICAL REVIEW
PLACEMENT REVIEW
ROUTING ANALYSIS
QUALITY REVIEW
NEXT-STEP PREPARATION
DESIGN REVIEW
```

For example:

``` text
Agent A: placing components

Agent B: verifies all remaining footprints
Agent C: reviews the netlist and contract
Agent D: analyses likely single-layer routing crossings
```

Agent B/C/D should continue without acquiring the edit lock.

When Agent A completes the mutation, those agents should already have the
information needed for the next decision.

This is the preferred operating mode.

------------------------------------------------------------------------

# 31. Do not hold the edit lock during research

The edit lock must be held for the shortest practical period.

Bad pattern:

``` text
acquire lock
  -> search for components
  -> inspect footprints
  -> analyse routing
  -> read inbox
  -> decide what to do
  -> mutate PCB
release lock
```

Correct pattern:

``` text
research / analyse / prepare
        |
        v
read inbox
        |
        v
acquire lock
        |
        v
perform smallest practical mutation batch
        |
        v
release lock
```

Research and analysis should happen before the mutation lock whenever
possible.

------------------------------------------------------------------------

# 32. Prepare work before the lock becomes available

Agents should proactively prepare their next action while another agent is
editing.

Example:

``` text
Agent A owns placement mutation.

Agent B reviews the current design and determines:
  R7 should move 3 mm north.

Agent C verifies:
  the move stays inside the assigned zone.

Agent D verifies:
  the move does not create an electrical problem.

Agent A finishes.

Agent A reads the inbox and can immediately apply the prepared change.
```

The objective is to minimize idle time between mutation batches.

------------------------------------------------------------------------

# 33. One mutation owner, multiple reviewers

At any point there should be one clear mutation owner for the shared PCB
state.

Other agents may inspect the same state and provide recommendations.

The normal pattern is:

``` text
MUTATION OWNER
      |
      +----> applies design change
      |
      +----> reads review findings
      |
      +----> decides next mutation

REVIEWERS
      |
      +----> inspect
      +----> verify
      +----> identify problems
      +----> recommend fixes
```

A reviewer must not silently modify the project merely because it found an
error. It should report the finding unless mutation ownership has explicitly
been transferred.

------------------------------------------------------------------------

# 34. Handoffs

Mutation ownership may be transferred deliberately when another agent is
better positioned to perform the next mutation.

A useful handoff message is:

``` text
[HANDOFF]
Current state: placement complete for power section.
Next mutation: move J3 5 mm east.
Reason: avoids expected single-layer crossing near U2.
Reviewer findings: none blocking.
```

After a handoff, the receiving agent must:

1. read the inbox;
2. verify the current project state;
3. confirm the requested change is still valid;
4. acquire mutation ownership;
5. perform the change;
6. release ownership;
7. report the resulting milestone.

Do not assume the project is unchanged merely because the handoff was recent.

------------------------------------------------------------------------

# 35. Task ownership

For substantial parallel tasks, agents should avoid duplicating work.

Examples of explicit task ownership:

``` text
TASK: Verify U3 footprint
OWNER: Agent B
STATUS: ACTIVE
```

``` text
TASK: Review power-rail connectivity
OWNER: Agent C
STATUS: DONE
```

``` text
TASK: Analyse routing conflicts around U2
OWNER: Agent D
STATUS: ACTIVE
```

The collaboration protocol should avoid two agents independently performing
the same expensive research unless a second opinion is intentionally
requested.

Read-only review of another task is still allowed and encouraged.

------------------------------------------------------------------------

# 36. Message protocol

Communication must be concise and actionable.

Preferred message prefixes are:

``` text
[REQUEST]
[PART]
[REVIEW]
[WARNING]
[DECISION]
[HANDOFF]
[DONE]
[BLOCKED]
```

Examples:

``` text
[PART][U2]
Verified MCP6002 DIP-8 pinout.
Recommended footprint: Package_DIP:DIP-8_W7.62mm.
Pin 1=OUTA, 2=INA-, 3=INA+, 4=VSS,
5=INB+, 6=INB-, 7=OUTB, 8=VDD.
```

``` text
[WARNING][ROUTING]
J2 and R5 are likely to force a single-layer crossing.
Recommend keeping the jumper position available between J2 and U1.
```

``` text
[REVIEW][ELECTRICAL]
C3 pin 2 is assigned to GND and is consistent with the circuit contract.
No electrical issue found.
```

``` text
[BLOCKED]
Cannot verify U4 footprint because the exact part number is missing.
```

Messages should communicate a result, decision, request, or blocker.

------------------------------------------------------------------------

# 37. Avoid progress-noise messages

Do not send messages such as:

``` text
[starting]
[checking]
[still working]
[almost done]
```

unless they contain a meaningful dependency or state change.

The shared inbox should contain useful information, not a stream of status
noise.

For long-running work, report only meaningful milestones or blockers.

------------------------------------------------------------------------

# 38. BLOCKED versus WAITING

These states have different meanings.

## BLOCKED

Use `[BLOCKED]` when the agent cannot make meaningful progress without an
action or decision from another agent.

Example:

``` text
[BLOCKED]
Need exact U4 part number before footprint verification can continue.
```

## WAITING

Use the agent wait mechanism only when:

- all useful independent work has been completed;
- the agent has no pending review/research task;
- the agent is genuinely waiting for a new task or dependency.

Never use waiting merely because another agent currently holds the edit lock.

------------------------------------------------------------------------

# 39. Inbox discipline

The inbox must be checked:

1. when the agent starts a turn;
2. before acquiring mutation ownership;
3. after completing a significant mutation;
4. before deciding that the agent is blocked or should wait.

An agent must account for new messages that may change the planned action.

------------------------------------------------------------------------

# 40. Parallel work by design phase

The following parallelization model is recommended.

## 40.1 Planning

``` text
LEAD
  -> requirements and design plan

PARTS
  -> component selection and footprint verification

ELECTRICAL
  -> netlist + circuit-contract analysis

PCB REVIEW
  -> placement/routing risk analysis
```

These tasks should run in parallel whenever they do not depend on each other.

## 40.2 Placement

``` text
LEAD
  -> performs placement mutations

REVIEWER
  -> checks clearances / zones / orientation

PARTS
  -> resolves outstanding footprint questions

ELECTRICAL
  -> verifies logical connectivity remains correct

ROUTING REVIEW
  -> predicts difficult single-layer connections
```

## 40.3 Schematic and electrical validation

``` text
MUTATION OWNER
  -> updates schematic/netlist/contract

ELECTRICAL REVIEWER
  -> checks logical correctness

PARTS REVIEWER
  -> verifies pin numbering and packages

DESIGN REVIEWER
  -> looks for missing requirements
```

The mutation owner then runs the authoritative electrical validation gate.

## 40.4 Routing

``` text
ROUTING OWNER
  -> creates actual copper

ROUTING REVIEWER
  -> identifies possible crossings / difficult areas

ELECTRICAL REVIEWER
  -> checks intended topology

QUALITY REVIEWER
  -> looks for physical/DRC risks
```

Reviewers remain read-only unless ownership is explicitly transferred.

------------------------------------------------------------------------

# 41. Routing-specific parallel workflow

Routing should be treated as an iterative loop rather than one blocking task.

Recommended pattern:

``` text
              +----------------------+
              | Routing owner        |
              | performs mutation    |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | Other agents review  |
              | resulting state      |
              +----------+-----------+
                         |
              +----------+----------+
              |                     |
              v                     v
       no issue found          issue found
              |                     |
              |              [WARNING]/[REVIEW]
              |                     |
              +----------+----------+
                         |
                         v
                 next mutation batch
```

The reviewer should report the exact geometry/problem and, when possible,
propose a concrete correction.

------------------------------------------------------------------------

# 42. Electrical validation remains a hard synchronization point

Parallel work must never weaken the electrical gate.

The required synchronization point is:

``` text
NETLIST + SCHEMATIC + CIRCUIT CONTRACT
                |
                v
     Plan.electricalCheck()
                |
       +--------+--------+
       |                 |
       v                 v
    INVALID            VALID
       |                 |
       v                 v
    FIX IT          ROUTING MAY START
```

Agents may research, review, and prepare routing in parallel before this
point, but no agent may create physical copper until the electrical gate is
valid for the current project revision.

------------------------------------------------------------------------

# 43. Mutation invalidates previous validation

Parallel agents must assume that any mutation may invalidate a previous
validation result.

The project revision is authoritative.

Example:

``` text
revision 41
    |
    +--> electrical validation PASS
    |
    +--> Agent B reviews routing
    |
    +--> Agent A moves U2
             |
             v
         revision 42
             |
             v
     previous electrical PASS is stale
```

After a mutation, agents must not continue as though the old validation were
still current.

The next routing mutation must obey the current electrical gate.

------------------------------------------------------------------------

# 44. Communication priority

Not all messages have equal urgency.

Agents should prioritize messages in this order:

``` text
1. [BLOCKED]
2. [WARNING]
3. [REQUEST]
4. [DECISION]
5. [HANDOFF]
6. [REVIEW]
7. [PART]
8. [DONE]
```

This is guidance for triage, not a requirement to ignore lower-priority
messages.

A newly discovered electrical or geometry problem should interrupt an
otherwise routine review.

------------------------------------------------------------------------

# 45. Agent role recommendations

Roles should be used to reduce duplication of effort.

## Lead / Designer

Responsible for:

- overall design progression;
- mutation ownership when appropriate;
- integrating findings from other agents;
- deciding between alternatives;
- ensuring the workflow gates are respected.

The lead does not need to perform every research task itself.

## Parts / Footprint Research

Responsible primarily for:

- finding real components;
- validating part numbers;
- verifying pinouts;
- selecting practical packages;
- verifying genuine KiCad footprints;
- finding substitutes.

This role should be highly parallel and rarely needs the edit lock.

## Electrical Review

Responsible primarily for:

- netlist review;
- contract review;
- floating-pin detection;
- power/connectivity review;
- pin-number verification;
- electrical consistency checks.

This role is mostly read-only until an explicit correction is required.

## Placement / Routing Review

Responsible primarily for:

- placement quality;
- clearance concerns;
- orientation concerns;
- expected single-layer conflicts;
- crossing analysis;
- jumper strategy.

This role should prepare recommendations for the mutation owner.

## Quality / DRC Review

Responsible primarily for:

- physical quality;
- routing quality;
- crossing risks;
- disconnected copper risks;
- DRC review;
- final visual review.

------------------------------------------------------------------------

# 46. Agent decision tree after connecting

An agent should be able to follow this decision tree mechanically:

``` text
CONNECT
   |
   v
USE/ATTACH SESSION
   |
   v
JOIN AGENT COLLABORATION
   |
   v
READ INBOX
   |
   v
READ WORKFLOW
   |
   v
Is another agent currently mutating?
   |
   +-------------------+
   | YES               | NO
   v                   v
Do not wait            Determine next
   |                   mutation task
   v                   |
Find useful            v
non-blocking work      Prepare change
   |                   |
   v                   v
Research/review        Read inbox again
   |                   |
   v                   v
Report useful result   Acquire mutation lock
   |                   |
   +--------+----------+
            |
            v
       Perform smallest
       practical mutation
            |
            v
        Release lock
            |
            v
       Report milestone
            |
            v
       Continue useful work
```

The only normal path to `millpcb_agent_wait` is:

``` text
NO MUTATION TASK
+
NO USEFUL INDEPENDENT WORK
+
NO PENDING REVIEW
+
NO ACTIONABLE REQUEST
```

------------------------------------------------------------------------

# 47. Anti-patterns

The following behaviours are explicitly discouraged.

## 47.1 Lock waiting

``` text
Agent B sees Agent A editing
    -> Agent B waits
```

Incorrect.

Agent B should research, review, verify, or prepare the next action.

## 47.2 Lock hogging

``` text
Agent A acquires lock
    -> performs long research
    -> analyses options
    -> finally mutates
```

Incorrect.

Research should happen before acquiring the lock.

## 47.3 Duplicate research

``` text
Agent B researches U3
Agent C independently researches U3
```

Avoid unless a second opinion is deliberately requested.

## 47.4 Silent correction

``` text
Reviewer discovers wrong placement
Reviewer directly changes PCB
```

Avoid unless mutation ownership has explicitly been transferred.

## 47.5 Progress spam

``` text
[checking]
[still checking]
[still working]
[almost done]
```

Avoid.

Messages should carry information.

## 47.6 Treating routing preparation as permission to route

An agent may prepare a routing strategy before electrical validation, but it
must not create copper until the electrical gate is valid.

------------------------------------------------------------------------

# 48. Recommended optimized communication pattern

For a typical design, the desired behaviour is:

``` text
T0
|
+-- Lead: analyse requirements
|
+-- Parts: research components
|
+-- Electrical: prepare netlist/contract review
|
+-- PCB reviewer: analyse placement/routing risks
|
T1
|
+-- Lead: place components
|
+-- Parts: continue resolving outstanding parts
+-- Electrical: review placement against intended connectivity
+-- Routing: prepare likely connection strategy
|
T2
|
+-- Lead: schematic/netlist mutation
+-- Reviewers: inspect in parallel
|
T3
|
+-- Lead: electrical validation
|
+-- Reviewers: prepare routing recommendations
|
T4
|
+-- Routing owner: copper mutation
+-- Electrical reviewer: inspect connectivity
+-- Routing reviewer: inspect geometry
+-- Quality reviewer: inspect physical risks
|
T5
|
+-- Routing owner: apply fixes
|
+-- Others: continue review/research
|
T6
|
+-- circuit validation
+-- quality check
+-- DRC
+-- visual review
+-- export
```

The goal is not to have every agent active at all times. The goal is to avoid
having an agent idle when it could perform useful independent work.

------------------------------------------------------------------------

# 49. Core multi-agent principles

All connected agents must follow these principles:

1. **One shared PCB mutation stream.**
2. **Many parallel read-only work streams.**
3. **Never wait merely because another agent owns the lock.**
4. **Do research and analysis without the lock.**
5. **Hold the mutation lock only for actual state changes.**
6. **Read the inbox before every meaningful mutation.**
7. **Send findings, not progress noise.**
8. **Use explicit blockers and handoffs.**
9. **Prepare the next operation while another agent is editing.**
10. **Treat project revision as authoritative; old validation may become stale.**
11. **Never bypass the electrical gate.**
12. **Wait only when no useful independent work remains.**

The resulting operating principle is:

> **Serialize changes, parallelize everything that does not change the PCB.**

This should be treated as a core millPCB agent protocol whenever multiple
agents are connected to the same session.
