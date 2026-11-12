# ADR-0035: New cells go to dedicated accounts before shared ones

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR-0024
- Deciders: Dave Roberts (SA)

## Context
Untargeted placement creates a new cell in the first eligible account with a free cell slot, oldest registered first (ADR-024). With ADR-033 an eligible account is either dedicated to the application or shared by all. In a mixed fleet the order decides whether a dedicated account fills up before shared capacity is consumed, or whether registration order wins and a shared account may take cells the dedicated one was meant for.

## Options considered
### Option 1: Dedicated first, then shared, oldest first within each group
Pros: a dedicated account exists to be filled first; shared capacity stays available for applications that have nothing else; the rule is one sort key on data placement already reads. Cons: an operator who wants round-robin cannot have it (no operator has asked).

### Option 2: Registration order, binding ignored
Pros: identical to the single-application rule. Cons: a shared account registered first takes an application's cells while its dedicated account sits empty, which is the opposite of what dedicating an account means.

### Option 3: A placement policy on the account
A `placement` field (prefer, drain, weight) as the §11 seam already describes. Cons: generality nobody has asked for; Option 1 is one fixed instance of it and leaves the seam intact.

## Decision
Option 1, and only for the **create** step. Reuse of an existing cell (the claim step) stays oldest cell first across every eligible account: a cell with room is reused before a new one is created wherever it is (P-7, over-provision rather than fail). When no cell has room, the account loop visits dedicated accounts before shared ones, oldest registered first within each group. A targeted `CreateTenant` names its account and is not ordered.

## Consequences
Spec §7.1 step 3 states the order and §7.2 keeps every tolerated race (the order changes which account is contended first, not the outcome). A unit test places into a fleet with one shared and one dedicated vendor account registered later, and asserts the new cell lands in the dedicated one. The §11 placement-policy seam stays.
