Atlas is a fictional team preparing a customer portal launch. This workspace connects the delivery plan to the people doing the work, the criteria for acceptance and the decisions behind the plan. All records are illustrative; the snapshot date is **16 November 2026**.

![Delivery review](contents/html/delivery.html)

## Start with the question

| Question | Open | What to inspect |
| --- | --- | --- |
| What are we delivering? | [Roadmap](contents/md/roadmap.md) | Outcomes, milestones, owners and dates |
| What can move this week? | [Work and acceptance](contents/md/workflow.md) | Issues, prerequisites and review evidence |
| Why did we choose this approach? | [Decisions](contents/md/decisions.md) | Kickoff, migration decision and launch requirements |
| How is the information connected? | [Record model](contents/md/records.md) | Schemas and references across the five types |

## One working loop

![Plan, deliver and review](contents/graphth/delivery.graphth)

At the weekly review, start with an outcome and follow it to a milestone, an issue and its decision record. Change the underlying record when status or ownership changes; the board reflects the saved file. The HTML overview is an authored snapshot and should be refreshed separately.

## Try it

1. Open **Issues** and switch between cards and list view.
2. Open [Test invitations](contents/issue/test-invitations.issue) and inspect its project, milestone and prerequisite.
3. Read [Customer portal kickoff](contents/note/portal-kickoff.note) for the intent behind that work.
4. In edit mode, save a change to a fictional record, then inspect its references.

This directory is a complete document workspace. From the repository root:

```sh
dooc editor run node --client --server --project sample/dooc-sample-project/dooc.yaml
dooc check sample/dooc-sample-project/dooc.yaml
dooc build html sample/dooc-sample-project/dooc.yaml build/project
```

If you copy this directory out of the repository, run `dooc editor run node --client --server`, `dooc check` and `dooc build html` from the copied folder instead.
