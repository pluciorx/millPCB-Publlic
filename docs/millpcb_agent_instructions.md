# millPCB Agent Instructions --- Electrical-First Design and Routing

## Purpose

These instructions define the required behavior for an AI agent working
with the millPCB MCP server.

The goal is to prevent a physically valid PCB from being produced when
the underlying electrical design is wrong or insufficiently validated.

The MCP currently distinguishes between a schematic/netlist being
**present** and the circuit being **electrically validated**. Treat
these as two different states.

**A schematic existing is NOT sufficient to start routing.**

The agent must establish that the intended circuit is electrically valid
before creating copper.

------------------------------------------------------------------------

# 1. Core Design Rules

millPCB designs:

-   SINGLE-LAYER PCBs.
-   One copper sheet only.
-   No second copper layer.
-   No vias as a solution to routing crossings.
-   A net crossing cannot be solved by routing through another copper
    layer.
-   If two nets need to cross, solve it by:
    1.  moving components/altering placement, or
    2.  inserting a two-pad JP wire jumper that is soldered over the
        crossing trace.

The router does not invent or insert jumpers automatically. The agent
must deliberately place them when required.

Use REAL component footprints only.

Before selecting a footprint:

1.  Call `millpcb_list_footprints`.
2.  Prefer a real built-in or imported KiCad footprint.
3.  Never invent footprint geometry.
4.  If a required part is missing, import the genuine KiCad library data
    with `millpcb_import_kicad`.

For hand assembly, prefer the largest practical package:

1.  THT
2.  1206
3.  0805
4.  0603 only when space genuinely requires it

Examples:

-   Prefer R_1206 over R_0805 over R_0603.
-   Prefer axial THT resistors where practical.
-   Prefer D_DO-35 diodes.
-   Prefer TO-92 transistors.
-   Prefer pin headers over unnecessarily small SMD connectors.

------------------------------------------------------------------------

# 2. The Most Important Rule: Electrical Validation Is a HARD GATE

Do NOT confuse these states:

``` text
SCHEMATIC_DECLARED
SCHEMATIC_VALIDATED
ROUTING_ALLOWED
```

They are different.

A schematic/netlist becomes **declared** when `millpcb_set_netlist` or
schematic wires exist.

It becomes **validated** only after the electrical/circuit checks have
passed.

Copper routing is allowed only after electrical validation.

The following are NOT proof of electrical correctness:

-   DRC PASS
-   no overlapping components
-   successful autorouting
-   all nets physically connected
-   a visually nice schematic
-   a schematic/netlist merely existing

DRC validates physical design rules. It does not prove that the circuit
implements the intended electrical function.

------------------------------------------------------------------------

# 3. Required Workflow

Always begin with:

``` text
millpcb_workflow
```

Then follow the guided process.

## Phase A --- Understand the Requirements

The `requirements` are the design contract.

Before placing or routing, establish:

-   board function
-   board dimensions
-   inputs
-   outputs
-   power source
-   voltage/current requirements
-   required connectors
-   important signal nets
-   current requirements and resulting trace widths
-   special net rules
-   required components
-   any intentionally unused pins

Do not invent missing electrical requirements.

If the user has not specified something essential, ask or explicitly
identify the assumption.

------------------------------------------------------------------------

# 4. Phase B --- Components and Placement

Use:

``` text
millpcb_list_footprints
```

before selecting components.

Then:

``` text
millpcb_set_plan
millpcb_place_by_plan
millpcb_check type="plan"
```

Placement must be validated before routing.

Check:

-   components are inside the board
-   components are inside their assigned zones
-   components do not overlap
-   connectors are physically accessible
-   orientation makes sense for assembly
-   high-current paths are short
-   sensitive signal paths are sensible
-   power and ground distribution is practical
-   there is enough room for traces and jumpers
-   components are large enough for practical hand assembly

After placement:

``` text
millpcb_screenshot view="board"
```

Review the actual board image.

Do not continue simply because the placement tool returned `ok: true`.

------------------------------------------------------------------------

# 5. Phase C --- Build the Schematic / Netlist BEFORE Copper

The circuit must be declared before physical copper.

Use:

``` text
millpcb_set_netlist
```

or, when appropriate:

``` text
millpcb_add_schem_wire
```

Then:

``` text
millpcb_layout_schematic
millpcb_screenshot view="schematic"
```

The schematic should represent the intended electrical circuit, not
merely a list of convenient connections for routing.

------------------------------------------------------------------------

# 6. Electrical Validation Checklist

Before any copper operation, validate ALL of the following.

## 6.1 Every component pin

Every relevant pin must be:

-   connected to the correct net, or
-   explicitly identified as intentionally unused / NC.

Do not leave pins floating accidentally.

Pay particular attention to:

-   IC power pins
-   IC ground pins
-   enable pins
-   reset pins
-   reference pins
-   analog inputs
-   communication pins
-   connector pins
-   transistor gates/bases
-   diode polarity
-   LED polarity
-   potentiometer terminals and wipers

------------------------------------------------------------------------

## 6.2 Power pins

Verify that every power pin is connected to the intended supply.

Do not assume pin numbers from memory.

Use the actual component definition / imported KiCad symbol / known pin
mapping.

Verify:

-   VCC/VDD/VIN/etc.
-   GND/VSS
-   analog supply pins
-   digital supply pins
-   reference voltages
-   power-entry polarity

A physically routable connection is not necessarily the correct power
connection.

------------------------------------------------------------------------

## 6.3 Ground

Verify that every required ground pin is actually on the intended GND
net.

Check:

-   IC grounds
-   sensor grounds
-   connector grounds
-   shield/ground pins where applicable
-   return paths for high-current loads

------------------------------------------------------------------------

## 6.4 Connector pinouts

Connector pinouts are part of the electrical contract.

Explicitly verify:

-   pin number
-   signal name
-   supply
-   ground
-   polarity
-   direction where relevant

Never assume that a connector's physical ordering matches the intended
signal order.

------------------------------------------------------------------------

## 6.5 No unintended net merges

Check that unrelated signals have not accidentally been placed on the
same net.

Especially verify:

-   VCC vs GND
-   analog vs digital signals
-   TX vs RX
-   separate sensor signals
-   control outputs
-   power rails
-   pull-up/pull-down nodes

A netlist that is internally consistent can still represent the wrong
circuit.

------------------------------------------------------------------------

## 6.6 Required nets

Every required net from the design contract must exist.

For example:

``` text
VCC
GND
SIGNAL_A
SIGNAL_B
I2C_SDA
I2C_SCL
UART_TX
UART_RX
```

Do not route only the nets that are convenient.

------------------------------------------------------------------------

## 6.7 Circuit topology

Check that the circuit topology matches the intended function.

Examples:

-   resistor really is in series where intended
-   pull-up resistor really connects to the correct signal and supply
-   LED resistor is in the correct current path
-   transistor control pin is not accidentally tied to a supply
-   sensor power is not confused with signal pins
-   potentiometer wiper is connected correctly
-   decoupling capacitor connects between the intended supply and GND
-   protection diode has the intended polarity

------------------------------------------------------------------------

# 7. Circuit Contract

The circuit contract must be treated as an acceptance criterion.

Before routing, run:

``` text
millpcb_check type="circuit"
```

Do not interpret a missing circuit contract as a successful validation.

If circuit validation reports violations:

1.  Stop routing.
2.  Identify the violation.
3.  Fix the schematic/netlist or requirements.
4.  Run the circuit check again.
5.  Repeat until the circuit check passes.

Do not route around a circuit error.

Do not postpone electrical correctness until after routing.

------------------------------------------------------------------------

# 8. HARD ROUTING GATE

Before calling any of these:

``` text
millpcb_connect_pins
millpcb_route_rail
millpcb_add_trace
millpcb_autoroute
```

verify:

``` text
PLAN_VALID
AND
SCHEMATIC_DECLARED
AND
ELECTRICAL_VALIDATED
```

If any condition is false, do not route.

Conceptually:

``` text
if (!planValid)
    STOP

if (!schematicDeclared)
    STOP

if (!electricalValidated)
    STOP

ONLY THEN:
    route copper
```

------------------------------------------------------------------------

# 9. Routing

Once electrical validation has passed:

``` text
millpcb_route_rail
millpcb_connect_pins
millpcb_autoroute
```

Use the actual pin references returned by the MCP.

Do not guess pin coordinates.

Do not manually reconstruct rotated component pin coordinates when the
MCP provides them.

Prefer:

-   wider traces for higher current
-   short power paths
-   sensible return paths
-   practical hand-soldering clearances
-   clean routing
-   minimal unnecessary meanders

Remember that this is a single-layer board.

If a crossing occurs:

1.  First consider moving components.
2.  If placement cannot solve it, use a deliberate JP wire.
3.  Never assume a via can solve the crossing.

------------------------------------------------------------------------

# 10. Verify the Routed Board

After routing:

``` text
millpcb_screenshot view="board"
millpcb_render_map
```

Inspect the result.

Check:

-   every required net is routed
-   no net is accidentally missing
-   no unintended connections exist
-   crossings are resolved correctly
-   jumpers are intentional
-   traces do not run through component bodies
-   trace widths are appropriate
-   connector access remains practical
-   power paths make sense
-   routing matches the schematic

Do not trust autoroute success by itself.

------------------------------------------------------------------------

# 11. Post-Routing Validation

After routing:

``` text
millpcb_check type="circuit"
millpcb_check type="quality"
millpcb_check type="drc"
```

All relevant checks must pass.

Important distinction:

``` text
Circuit check
    = Is this the intended electrical circuit?

Quality check
    = Is the design physically/structurally acceptable?

DRC
    = Does it obey physical design rules?
```

A DRC pass cannot replace a circuit check.

------------------------------------------------------------------------

# 12. Schematic Visual Verification

After wiring and before final acceptance:

``` text
millpcb_layout_schematic
millpcb_screenshot view="schematic"
```

The schematic layout should be readable.

Do not manually invent `schemX` / `schemY` positions unless the tool
explicitly requires it.

The human-facing renderer is responsible for the schematic layout.

Look for:

-   readable signal flow
-   obvious power rails
-   clear ground connections
-   no unexplained crossings
-   no disconnected-looking components
-   correct topology
-   correct component relationships

------------------------------------------------------------------------

# 13. Final Acceptance

The project is not complete until ALL of the following are true:

``` text
Requirements defined
        AND
Real footprints used
        AND
Placement check PASS
        AND
Schematic declared
        AND
Electrical/circuit validation PASS
        AND
All required copper connections exist
        AND
Circuit check PASS after routing
        AND
Quality check PASS
        AND
DRC PASS
        AND
Board screenshot reviewed
        AND
Schematic screenshot reviewed
        AND
No unresolved intentional/accidental violations
```

Only then:

``` text
millpcb_export
```

------------------------------------------------------------------------

# 14. Do Not Use These Invalid Shortcuts

Never do this:

``` text
set_netlist
→ autoroute
→ DRC
→ done
```

Never assume:

``` text
DRC PASS = circuit correct
```

Never assume:

``` text
autoroute success = circuit correct
```

Never assume:

``` text
schematic exists = schematic validated
```

Never route a pin simply because it is physically close.

Never infer IC pin functions from pin numbers when the actual component
definition is available.

Never invent footprint geometry.

Never invent electrical connections just to make the autorouter succeed.

------------------------------------------------------------------------

# 15. Multi-Agent Collaboration

When multiple agents share a session:

``` text
millpcb_agent_join
```

must be called by each agent.

Use explicit roles, for example:

``` text
schematic
placement
routing
DRC
```

Roles should not overlap unintentionally.

At the beginning of every turn and before every mutating action:

``` text
millpcb_agent_inbox
```

Read and act on peer messages.

After each meaningful work chunk:

``` text
millpcb_agent_say
```

with a short status:

``` text
Placed components and passed plan check.
Next: validate the schematic/netlist.
```

or:

``` text
Electrical validation passed.
Next: routing the power rails.
```

Do not silently work in parallel on conflicting parts of the design.

If another agent asks you to perform a task, either perform it or
explicitly explain why it cannot be done.

Do not assume silence means the other agent has finished.

------------------------------------------------------------------------

# 16. Two-Agent Completion Rule

When working as a pair:

Both agents must agree on the final result.

The project is not complete merely because one agent believes it is
complete.

Use the shared chat to reach a common verdict:

``` text
complete
```

or:

``` text
failed
```

The other agent must confirm the same verdict.

One agent must not unilaterally close the project.

------------------------------------------------------------------------

# 17. Required Visual Feedback Loop

After placement:

``` text
millpcb_screenshot view="board"
```

After schematic creation:

``` text
millpcb_screenshot view="schematic"
```

After routing:

``` text
millpcb_screenshot view="board"
```

Before final acceptance:

``` text
millpcb_screenshot view="schematic"
millpcb_screenshot view="board"
```

Use:

``` text
millpcb_render_map
```

when exact component/trace positions are easier to reason about as text.

The screenshots are not decoration. They are part of the verification
loop.

------------------------------------------------------------------------

# 18. Recommended Agent State Machine

Use this mental state machine:

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
  +---- FAIL ----> FIX_PLACEMENT
  |
  v
SCHEMATIC_DECLARATION
  |
  v
SCHEMATIC_LAYOUT
  |
  v
ELECTRICAL_VALIDATION
  |
  +---- FAIL ----> FIX_SCHEMATIC
  |
  v
ROUTING_ALLOWED
  |
  v
COPPER_ROUTING
  |
  v
CIRCUIT_CHECK
  |
  +---- FAIL ----> FIX_ROUTING_OR_SCHEMATIC
  |
  v
QUALITY_CHECK
  |
  +---- FAIL ----> FIX
  |
  v
DRC
  |
  +---- FAIL ----> FIX
  |
  v
VISUAL_REVIEW
  |
  +---- FAIL ----> FIX
  |
  v
EXPORT
  |
  v
COMPLETE
```

The critical transition is:

``` text
ELECTRICAL_VALIDATION
        |
        | PASS
        v
ROUTING_ALLOWED
```

There must be no alternate path around this gate.

------------------------------------------------------------------------

# 19. Final Principle

The correct priority is:

``` text
Electrical correctness
        ↓
Placement correctness
        ↓
Physical routability
        ↓
Manufacturing quality
```

Not:

``` text
Can the autorouter connect everything?
        ↓
Does DRC pass?
        ↓
Call it finished
```

A PCB that routes successfully but implements the wrong circuit is a
failed design.

**Never trade electrical correctness for routing convenience.**
