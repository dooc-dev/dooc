A release is a controlled change to a known environment. The inventory contains cloud production, staging and on-premise records; selecting every container is not a deployment policy.

![Release gates](contents/graphth/release.graphth)

## Change record

| Field | Illustrative release |
| --- | --- |
| Candidate | Field Notes API `2.4.2` |
| Current production version | `2.4.1` in [API](contents/container/api.container) |
| Target | Cloud production API only, after staging verification |
| Owner | Platform |
| State at 16 Nov, 09:00 UTC | On hold while the API connection incident is monitored |
| Evidence still needed | Connection headroom, representative tenant checks and rollback rehearsal |

The candidate is a plan. The inventory retains the current image until a release is accepted.

## Release checklist

| Gate | Evidence | Do not proceed when |
| --- | --- | --- |
| Source review | Reviewed diff, explicit image tag and target environment | The target set is ambiguous |
| Staging | Health, tenant isolation, schema compatibility and representative load checks | A check fails or its result is missing |
| Recovery | Previous image and configuration identified; rollback is compatible with data changes | Recovery would lose or corrupt data |
| Limited rollout | Representative traffic and dependency headroom | Error rate, latency or pool pressure worsens |
| Full rollout | Stable user paths through an agreed observation window | The incident lead has not released a hold |
| Close | Inventory updated and evidence attached to the change | A deployment succeeded but user-facing verification did not |

## Database changes

Prefer a migration that the previous and candidate application versions can both use during rollout. If a migration is destructive or incompatible, stop and prepare a separate migration and recovery plan. Reverting an image does not automatically revert data.

## Recovery drill

1. Choose an isolated target and an approved backup; record its timestamp.
2. Restore without changing the production writer or routing.
3. Reconcile tenant boundaries, representative reads and row counts.
4. Record observed data loss and restore duration against the desired recovery objectives.
5. Review the evidence before approving any production recovery action.

| Objective | Exercise assumption | Evidence required |
| --- | --- | --- |
| Recovery point | At most 15 minutes of lost writes | Compare backup or replay position with the last accepted write |
| Recovery time | Read/write service within 60 minutes | Time the full restore, verification and routing rehearsal |

These are fictional drill targets, not measured guarantees. The on-premise replica is a read-only fallback; promoting it requires a plan to prevent concurrent writers and reconcile stale data.

## Document artifacts

Before sharing this handbook, run `dooc check`, build the HTML and review the [record pipeline](contents/md/ci.md). The pipeline's deploy step only prints a proposal and has no credentials or production connection.
