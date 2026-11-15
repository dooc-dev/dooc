Every workload names its responsible team in the inventory. Incident leadership and customer communication must still be assigned explicitly for each response.

| Team | Owns | Escalate when |
| --- | --- | --- |
| [Experience](contents/team/experience.team) | Web experience, customer-facing explanations and read-only fallback UX | Customers cannot access or understand their workspace |
| [Platform](contents/team/platform.team) | Networks, API, workers, storage, observability and recovery | Reliability, data integrity or a dependency is affected |

![Experience team](contents/team/experience.team)

![Platform team](contents/team/platform.team)

## Handoff packet

| Include | Example |
| --- | --- |
| Scope and time | Cloud API, synthetic incident starting 08:10 UTC |
| User impact | Valid requests timed out during connection saturation |
| Current state | Error rate recovered; connection headroom is being observed |
| Actions taken | Discretionary rollout paused; optional batch admission reduced |
| Next checkpoint | 09:15 UTC, with Platform as incident lead |
| Open risks | Cause not yet confirmed; release hold remains in place |

All names and `example.org` contacts are illustrative. Replace the roster and escalation destination before adapting the handbook for a real team.
