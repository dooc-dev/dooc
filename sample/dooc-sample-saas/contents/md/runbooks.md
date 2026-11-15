The primary responder first establishes user impact, then limits the failure and verifies recovery. These procedures refer to the fictional Field Notes inventory; they are a rehearsal guide and do not execute changes.

![API connection incident timeline](contents/html/incident.html)

## Incident register

| Incident | Severity | State at the snapshot | Owner | Follow-up |
| --- | --- | --- | --- | --- |
| [API connection saturation](contents/incident/api-connections.incident) | SEV2 | Monitoring | Platform | Verify pool limits before lifting the release hold |
| [Render backlog](contents/incident/render-backlog.incident) | SEV2 | Resolved | Platform | Bound batch admission and check retry behavior |
| [Search timeouts](contents/incident/search-timeouts.incident) | SEV3 | Resolved | Platform | Review index refresh scheduling |

## Response flow

![Response and handoff](contents/graphth/incident.graphth)

| Role | Owns | Handoff requirement |
| --- | --- | --- |
| Incident lead | Scope, decisions and next checkpoint | Named successor acknowledges the current state |
| Responder | Investigation and reversible mitigation | Record observations, action and result |
| Communicator | Customer-facing impact and updates | State impact and next update time; do not infer recovery |

For this exercise, a SEV2 incident has a 15-minute update cadence. Declare recovery only after the user path and the affected dependencies have been observed through the agreed monitoring window.

## API errors or latency

**Trigger:** valid requests fail or time out on the [API](contents/container/api.container) path.

1. Confirm the affected tenants and endpoints; compare edge errors with [application logs](contents/log/application.log).
2. Inspect database connections, query time and request concurrency together. Check for a recent rollout.
3. Pause discretionary changes. If the latest rollout is implicated, use the agreed rollback gate in [Release and recovery](contents/md/releases.md).
4. Reduce an identified source of excess concurrency before scaling other components. Preserve diagnostic samples without copying customer payloads.
5. Verify representative reads and writes, error rate, pool headroom and queue age. Keep the incident in Monitoring until the checkpoint passes.

**Stop:** if the action could worsen tenant isolation or data integrity, stop the change and involve the incident lead. Do not promote a replica or delete queued work as a generic latency fix.

![Current API incident](contents/incident/api-connections.incident)

## Render backlog

**Trigger:** accepted jobs exceed their completion objective or the oldest job age keeps rising.

1. Compare enqueue and completion rates in [Render jobs](contents/datastore/render-jobs.datastore).
2. Check [Render queue worker](contents/worker/render-queue.worker) failures, concurrency and dependency latency.
3. Pause optional bulk admission while preserving accepted jobs and their identifiers.
4. Confirm retry limits and idempotency before retrying failed work; quarantine poison jobs for investigation.
5. Restore admission gradually after queue age and completion time recover.

**Evidence:** record the oldest job age, pending count, completion rate and actions at each checkpoint. A smaller queue alone does not prove jobs completed successfully.

## Search timeouts

Check [Search](contents/container/search.container), [Search index](contents/datastore/search-index.datastore) and indexing workload together. If a refresh is the cause, defer that optional work and verify query results before declaring recovery. Never rebuild or delete the index without a reviewed recovery plan.

## Close the incident

Record customer impact, the timeline, the accepted recovery evidence and follow-up owners. Keep a distinction between the suspected cause during response and the confirmed cause after review. The sample incident records model that distinction in their summaries.
