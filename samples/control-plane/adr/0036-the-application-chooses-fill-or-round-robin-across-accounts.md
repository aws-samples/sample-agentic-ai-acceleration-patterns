# ADR-0036: The application chooses fill or round robin across accounts

- Status: Accepted
- Date: 2026-11-11
- Amends: ADR-0035
- Deciders: Dave Roberts (SA)

## Context
When no cell of an application has room, placement creates a new cell in an eligible account, dedicated accounts before shared ones and oldest registered first within each group (ADR-035). That fills one account before touching the next. Some vendors want the opposite: spread an application's cells over every open account so a single account's failure or limit touches fewer tenants. The choice depends on the application and may change after the application is live, so it must not be a deployment input or a stamp on the cell.

## Options considered
### Option 1: A `placementStrategy` on the application record
`FILL` (oldest registered first, the ADR-035 order) or `ROUND_ROBIN` (the eligible account with the fewest cells first, ties oldest first). Default `FILL`. Replaceable through `PutApplication`; read at placement time; never stamped. Pros: one field on a record placement already reads; changeable without a redeploy; round robin needs no cursor or state because `cellCount` on the account records already says where the next cell should go; dedicated-before-shared stays the outer order. Cons: "round robin" is approximated by "fewest cells", so two concurrent placements that read the same counts can land in the same account (a tolerated race under P-5, corrected by the next placement).

### Option 2: A control-plane-wide setting
One strategy for every application, as a deployment input. Cons: a redeploy to change it; two applications with different needs cannot differ.

### Option 3: A cursor per application for true round robin
A `nextAccount` pointer advanced in the placement transaction. Cons: one more field with its own concurrency rules; stale after accounts are added, removed or filled; buys nothing over fewest-cells-first that an operator could observe.

### Option 4: Load-aware placement
Choose by what the cells are doing (utilisation, cost). Cons: needs a signal the control plane does not hold (P-3); recorded as a seam (§11) instead.

## Decision
Option 1. `Application.placementStrategy ∈ {FILL, ROUND_ROBIN}`, default `FILL`, written by `PutApplication` and owned by it (R-29). It orders accounts only inside the dedicated and shared groups of ADR-035 and only in the create step: reuse of an existing cell stays oldest cell first, and a targeted `CreateTenant` is not ordered. The order is a nomination; the account's conditional cell-slot claim remains the only guard.

## Consequences
Spec §4.1, §5.4, §7.1 and §7.2 carry the field, the two orders and the new tolerated race; §1.2 and §11 record load-aware placement as not built. A unit test places two applications with different strategies into two shared accounts at 1/2 and 0/2 and asserts `FILL` picks the first and `ROUND_ROBIN` the second. Revisit when a strategy needs a signal the account record does not carry; that is Option 4 and a new value of the enum.
