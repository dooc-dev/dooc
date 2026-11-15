Objectives describe user-visible results. This example uses a rolling 30-day request window ending **16 November 2026, 09:00 UTC**. The values are synthetic; the targets illustrate a review process rather than a recommendation for a production service.

![Error budgets and observed results](contents/html/reliability.html)

## Objective definitions

| Objective | Good event | Eligible event | Target | Owner |
| --- | --- | --- | --- | --- |
| [API availability](contents/slo/api-availability.slo) | A valid request receives a non-5xx response without timing out | Valid authenticated API request; exclude malformed and unauthorized requests | 99.9% | Platform |
| [Render completion](contents/slo/render-completion.slo) | A render job completes within 60 seconds | Accepted render job; exclude user cancellations | 99.0% | Platform |
| [Search availability](contents/slo/search-availability.slo) | Search returns a non-error response within 2 seconds | Valid search request | 99.5% | Platform |

Availability and latency are not interchangeable. The API objective counts successful responses; a separate investigation still checks response time when customers report slowness.

## Read the budget

```text
observed result = good events / eligible events
allowed bad events = eligible events × (1 − target)
budget consumed = actual bad events / allowed bad events
```

For the API example, 400 of 1,000,000 eligible requests are bad. A 99.9% target allows 1,000 bad requests: 40% of that budget has been consumed. Request-based budgets cannot be converted directly into outage minutes.

![API objective](contents/slo/api-availability.slo)

## Review and alert policy

| Signal | Response in this fictional service |
| --- | --- |
| A short-window failure spike is confirmed by user impact | Page the workload owner and start an incident |
| Render budget consumption reaches 70% | Review queue age and capacity before adding discretionary batch work |
| Any budget is exhausted | Hold discretionary releases; prioritize reliability work |
| One noisy observation without corroborating impact | Check the denominator, exclusions and telemetry before escalating |

An objective over 30 days is a review input. Paging needs shorter windows and workload-specific thresholds, which must be calibrated with real traffic before using this sample operationally.

## Capacity review

![Illustrative capacity review](contents/csv/capacity.csv#H)

The API's minimum replica count is three and its maximum is ten. Scaling the API alone can increase database connection pressure. During a connection incident, inspect pool limits and database headroom together before changing concurrency.

The render worker has concurrency four. If queue age rises while the database or object store is constrained, adding workers may increase contention. [Incident response](contents/md/runbooks.md#render-backlog) starts by identifying the constrained dependency.

## Data retention and restore

| Data | Inventory policy | Review evidence |
| --- | --- | --- |
| Main database | 35-day backup retention | Restore into an isolated target and reconcile tenant ownership and row counts |
| On-premise replica | 7-day backup retention | Confirm replication lag and application read-only behavior |
| Assets | 90-day retention in the sample record | Retrieve a known object and validate its checksum |
| Audit stream | 400-day log retention | Confirm the intended producers are actually connected; the inventory currently leaves this unassigned |

Retention configuration is not proof of recoverability. Record the latest successful restore drill and its observed duration before claiming a recovery objective.
