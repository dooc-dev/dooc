Notes preserve the reason behind a plan. A meeting record captures agreement, a decision records a choice and its consequences, and a memo can list evidence still needed.

## Decision register

| Date | Record | Type | Consequence |
| --- | --- | --- | --- |
| 9 Nov | [Portal kickoff](contents/note/portal-kickoff.note) | Meeting | Pilot scope and invitation review ownership are explicit |
| 10 Nov | [Migration rehearsal](contents/note/migration-decision.note) | Decision | Synthetic tenant data and an exercised rollback are required |
| 12 Nov | [Launch evidence](contents/note/launch-evidence.note) | Memo | The launch gate remains open pending reviewed evidence |

## The choice that constrains the rollout

![Migration decision](contents/note/migration-decision.note)

The team chose a synthetic pilot cohort so it can rehearse and inspect recovery without changing customer data. A later production migration needs a separate decision based on the actual environment and its evidence.

## Required evidence is not approval

![Launch evidence](contents/note/launch-evidence.note)

Before the launch review, replace each requested item with a reference to its reviewed result. If an exception is accepted, record who accepted it, the impact and the next review date. Do not mark the milestone closed only because all notes exist.

## Write a useful note

| Field | Include |
| --- | --- |
| Context | The project, milestone and issues affected |
| Choice | What was selected and who owns it |
| Reason | Evidence and constraints that drove the choice |
| Consequence | What changes, what remains uncertain and when to revisit |

Use the **Notes** board to filter by Meeting, Decision or Memo. Record references make the explanation discoverable from the affected work.
