Field Notes is a fictional SaaS product for writing and sharing team knowledge. This is its operations handbook: service topology, ownership, reliability objectives, response procedures and release evidence in one workspace. All measurements and incidents are **synthetic**, captured at **16 November 2026, 09:00 UTC**.

![Operations review](contents/html/operations.html)

## Find the next action

| Situation | Open | First question |
| --- | --- | --- |
| A request fails or becomes slow | [Architecture](contents/md/architecture.md) | Which service and datastore are on the affected path? |
| An objective is at risk | [Reliability](contents/md/reliability.md) | What failed, over which window, and how much budget remains? |
| An alert needs a response | [Incident response](contents/md/runbooks.md) | Who owns the incident and which action is reversible? |
| A release or recovery is planned | [Release and recovery](contents/md/releases.md) | What evidence allows the change to proceed? |
| A handoff is unclear | [Ownership](contents/md/ownership.md) | Which team owns the workload and communication? |

## Follow a complete example

1. Open [API](contents/container/api.container) to find its network, dependencies and logs.
2. Inspect the [API availability objective](contents/slo/api-availability.slo).
3. Read the [API connection incident](contents/incident/api-connections.incident) and its response timeline.
4. Follow the [runbook](contents/md/runbooks.md#api-errors-or-latency) and the release hold it triggers.

The sidebar boards expose the underlying records. Diagrams, HTML charts and tables are authored snapshots: they do not poll a monitoring service and must be updated when the fictional inventory or measurements change.

## Open, check and share

From the repository root:

```sh
dooc editor run node --client --server --project sample/dooc-sample-saas/dooc.yaml
dooc check sample/dooc-sample-saas/dooc.yaml
dooc build html sample/dooc-sample-saas/dooc.yaml build/saas
```

You can copy this entire directory into a separate repository. It includes all local schemas, records and figures; run `dooc editor run node --client --server` from the copied folder. The pipeline script is optional and its dependencies are listed in [Record pipeline](contents/md/ci.md).
