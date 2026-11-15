An issue is ready when its owner, outcome and prerequisites are clear. **Done** means the stated result was reviewed; moving a card does not create that evidence automatically.

## Current work

| Issue | Owner | Status | Due | Required result |
| --- | --- | --- | --- | --- |
| [Draft onboarding](contents/issue/draft-onboarding.issue) | Alice | Done | 12 Nov | Reviewed flow and copy for the pilot |
| [Test invitations](contents/issue/test-invitations.issue) | Bob | Doing | 17 Nov | Valid, expired and revoked link results |
| [Define acceptance](contents/issue/define-acceptance.issue) | Alice | Todo | 19 Nov | Criteria attached to the portal beta review |
| [Rehearse migration](contents/issue/rehearse-migration.issue) | Dave | Done | 10 Nov | Reconciled synthetic tenant data |
| [Verify rollback](contents/issue/add-rollback-check.issue) | Erin | Done | 13 Nov | Restore evidence and stop conditions |
| [Collect launch evidence](contents/issue/complete-launch-review.issue) | Erin | Todo | 4 Dec | One evidence list for the launch review |

![Issue dependencies](contents/graphth/issues.graphth)

## State transitions

| Transition | Check before moving | Update with the move |
| --- | --- | --- |
| Todo → Doing | Prerequisites are satisfied; the owner has a concrete next step | Assignee and expected completion date |
| Doing → Done | Acceptance evidence has been reviewed | Related review or decision note |
| Doing → Todo | Work is paused or its scope needs a decision | Due date and the reason in a note |

The schema limits status to these three values. Prerequisite completion and reviewer acceptance are team rules; dooc does not enforce them simply because `blocked_by` contains a path.

## Invitation acceptance checklist

- A valid invitation opens only the intended fictional tenant.
- Expired, revoked and already-used links produce a clear recovery path.
- The invited role matches the intended workspace permission.
- Keyboard users can complete the flow and understand validation errors.
- Screenshots and observed results are available to the reviewer.

## Review one record

![Test invitations and expired links](contents/issue/test-invitations.issue)

The prerequisite is [Draft onboarding](contents/issue/draft-onboarding.issue), which is already done. This means the issue can proceed; it does not mean its own acceptance criteria have passed.
