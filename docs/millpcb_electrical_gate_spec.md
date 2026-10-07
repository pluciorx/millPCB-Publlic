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
