The launch has three workstreams. A closed migration rehearsal provides evidence for the next gate; it does not close the customer portal or approve the launch.

![Milestones and review gates](contents/html/roadmap.html)

## Outcome ownership

| Project | Owner | Target | Outcome | Current state |
| --- | --- | --- | --- | --- |
| [Customer portal](contents/project/customer-portal.project) | Alice · Product | 27 Nov | Pilot customers can accept an invitation and finish onboarding | Active |
| [Tenant migration](contents/project/tenant-migration.project) | Dave · Platform | 11 Dec | Pilot tenant data can move and be restored with evidence | Active |
| [Launch readiness](contents/project/launch-readiness.project) | Erin · Platform | 18 Dec | A reviewer can make a launch decision from recorded evidence | Planned |

## Milestones

![Migration rehearsal](contents/milestone/migration-rehearsal.milestone)

![Portal beta](contents/milestone/portal-beta.milestone)

![Launch review](contents/milestone/launch-review.milestone)

## Gates and stop conditions

| Gate | Accept when | Stop when | Decision owner |
| --- | --- | --- | --- |
| Migration rehearsal | Tenant ownership and row counts reconcile; rollback has been exercised | Any cross-tenant result or unexplained mismatch | Dave |
| Portal beta | Valid, expired and revoked invitations have reviewed outcomes | An invitation exposes another workspace or cannot be revoked | Alice |
| Launch review | Acceptance results, recovery evidence and support ownership are linked | Any high-priority issue lacks a disposition | Erin |

The dates form a plan, not a deployment schedule. Changes to scope or a gate belong in a [decision note](contents/md/decisions.md) before the affected milestone is moved.

## Review agenda

1. Compare issue progress with milestone acceptance, not just issue counts.
2. Confirm an owner for each unresolved prerequisite.
3. Record scope changes and their effect on the target date.
4. Keep the launch review open until its evidence is accepted.
