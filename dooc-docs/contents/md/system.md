A design for a fictional system, **Field Notes**, written entirely as records. Six runtime record types describe where things run, how traffic reaches them, what they need, and where their logs go. The same types describe the cloud side and the on-premise side.

## Architecture

Field Notes serves pages from a cloud network and from an on-premise site. The on-premise site reads from a database replica and keeps serving if the cloud side is unreachable.

![Field Notes runtime](contents/graphth/system.graphth)

## Record types

| Type                                                   | Storage | Describes                                            | Board grouped by |
| ------------------------------------------------------ | ------- | ---------------------------------------------------- | ---------------- |
| [vpc](contents/json/vpc.schema.json)                   | TOML    | A network: provider, location, CIDR, subnets, peers  | Provider         |
| [loadbalancer](contents/json/loadbalancer.schema.json) | YAML    | Listeners, targets, health check                     | Scheme           |
| [container](contents/json/container.schema.json)       | YAML    | A long-running service: image, CPU, memory, replicas | Runtime          |
| [worker](contents/json/worker.schema.json)             | JSON    | A background job: trigger, concurrency, timeout      | Trigger          |
| [datastore](contents/json/datastore.schema.json)       | TOML    | A database, cache, queue, object store, or index     | Kind             |
| [log](contents/json/log.schema.json)                   | YAML    | A log stream: format, level, retention, sink         | Category         |

Their boards are the pages below this one in the tree.

![Runtime model](contents/schemath/runtime.schemath)

## One structure for cloud and on-premise

Only the network record says where something runs. Every other record points at a network with `network` and at one of its subnets with `subnet`, so a workload record has the same fields on both sides.

| Field                 | Cloud                                           | On-premise                                            |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Network               | [Production cloud](contents/vpc/prod-cloud.vpc) | [Production on-premise](contents/vpc/prod-onprem.vpc) |
| `provider`            | `Cloud`                                         | `On-premise`                                          |
| `location`            | A region                                        | A datacenter and rack row                             |
| Subnet `zone`         | Availability zone                               | Omitted                                               |
| Container `runtime`   | `Kubernetes`, `Managed containers`              | `Docker host`                                         |
| Container `replicas`  | `min` below `max`: autoscaled                   | `min` equals `max`: fixed hosts                       |
| Load balancer `layer` | `L7`                                            | `L4`                                                  |

The same service on each side:

![API in the cloud](contents/container/api.container)

![API on-premise](contents/container/api-onprem.container)

## Shared definitions

[runtime.schema.json](contents/json/runtime.schema.json) is not a record type. It holds the definitions that every runtime schema reuses.

| Definition                               | Meaning                                  | Used by                                    |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| `runtime.schema.json#/$defs/provider`    | `Cloud` or `On-premise`                  | vpc                                        |
| `runtime.schema.json#/$defs/environment` | `Production`, `Staging`, `Development`   | vpc                                        |
| `runtime.schema.json#/$defs/cidr`        | IPv4 CIDR block                          | vpc                                        |
| `runtime.schema.json#/$defs/port`        | Integer from 1 to 65535                  | loadbalancer, container                    |
| `runtime.schema.json#/$defs/image`       | Image name with an explicit tag          | container, worker                          |
| `runtime.schema.json#/$defs/resources`   | `cpu`, `memory_mb`, optional `disk_gb`   | container, worker, datastore               |
| `runtime.schema.json#/$defs/replicas`    | `min` and `max`                          | container                                  |
| `runtime.schema.json#/$defs/dependency`  | A container path or a datastore path     | container, worker                          |
| `vpc.schema.json#/$defs/ref`             | Path of a network record                 | every other runtime type except log        |
| `vpc.schema.json#/$defs/subnet_name`     | Subnet name inside a network             | loadbalancer, container, worker, datastore |
| `container.schema.json#/$defs/ref`       | Path of a container record               | loadbalancer, `dependency`                 |
| `datastore.schema.json#/$defs/ref`       | Path of a datastore record               | worker, log, datastore, `dependency`       |
| `log.schema.json#/$defs/ref`             | Path of a log stream record              | loadbalancer, container, worker            |
| `team.schema.json#/$defs/ref`            | Path of a [team](contents/md/records.md) | vpc, container, worker                     |

![Runtime definitions](contents/json/runtime.schema.json)

`provider` and `environment` are enums behind a `$ref`. The network board still offers them as columns.

## Networks

| Network                                               | Provider   | Environment | CIDR           | Subnets                 |
| ----------------------------------------------------- | ---------- | ----------- | -------------- | ----------------------- |
| [Production cloud](contents/vpc/prod-cloud.vpc)       | Cloud      | Production  | `10.20.0.0/16` | `public`, `app`, `data` |
| [Production on-premise](contents/vpc/prod-onprem.vpc) | On-premise | Production  | `10.40.0.0/16` | `dmz`, `app`, `data`    |
| [Staging cloud](contents/vpc/staging-cloud.vpc)       | Cloud      | Staging     | `10.30.0.0/16` | `app`                   |

![Production cloud](contents/vpc/prod-cloud.vpc)

## Traffic

| Load balancer                                                     | Scheme   | Layer | Listens on | Target                                                      |
| ----------------------------------------------------------------- | -------- | ----- | ---------- | ----------------------------------------------------------- |
| [Public edge](contents/loadbalancer/public-edge.loadbalancer)     | Public   | L7    | 443, 80    | [Web](contents/container/web.container)                     |
| [Internal API](contents/loadbalancer/internal-api.loadbalancer)   | Internal | L7    | 8443       | [API](contents/container/api.container)                     |
| [On-premise edge](contents/loadbalancer/onprem-edge.loadbalancer) | Public   | L4    | 443        | [Web (on-premise)](contents/container/web-onprem.container) |

![Public edge](contents/loadbalancer/public-edge.loadbalancer)

## Compute

| Container                                                   | Network    | CPU  | Memory   | Replicas |
| ----------------------------------------------------------- | ---------- | ---- | -------- | -------- |
| [Web](contents/container/web.container)                     | Cloud      | 0.5  | 512 MiB  | 2–6      |
| [API](contents/container/api.container)                     | Cloud      | 1    | 1024 MiB | 3–10     |
| [Search](contents/container/search.container)               | Cloud      | 2    | 4096 MiB | 2        |
| [Web (on-premise)](contents/container/web-onprem.container) | On-premise | 1    | 1024 MiB | 2        |
| [API (on-premise)](contents/container/api-onprem.container) | On-premise | 2    | 2048 MiB | 2        |
| [API (staging)](contents/container/api-staging.container)   | Staging    | 0.25 | 256 MiB  | 0–1      |

| Worker                                                    | Trigger  | Source or schedule                                      | Concurrency |
| --------------------------------------------------------- | -------- | ------------------------------------------------------- | ----------- |
| [Render queue](contents/worker/render-queue.worker)       | Queue    | [Render jobs](contents/datastore/render-jobs.datastore) | 4           |
| [Search indexer](contents/worker/search-indexer.worker)   | Stream   | [Render jobs](contents/datastore/render-jobs.datastore) | 2           |
| [Nightly export](contents/worker/nightly-export.worker)   | Schedule | `0 18 * * *` UTC                                        | 1           |
| [Replica lag check](contents/worker/replica-check.worker) | Schedule | `*/5 * * * *` UTC                                       | 1           |

![Render queue](contents/worker/render-queue.worker)

## State

| Datastore                                                             | Kind       | Engine         | Network    | Backups |
| --------------------------------------------------------------------- | ---------- | -------------- | ---------- | ------- |
| [Main database](contents/datastore/main-db.datastore)                 | Relational | PostgreSQL 17  | Cloud      | 35 days |
| [Main database replica](contents/datastore/main-db-replica.datastore) | Relational | PostgreSQL 17  | On-premise | 7 days  |
| [Session cache](contents/datastore/session-cache.datastore)           | Cache      | Valkey 8       | Cloud      | none    |
| [Render jobs](contents/datastore/render-jobs.datastore)               | Queue      | NATS JetStream | Cloud      | none    |
| [Search index](contents/datastore/search-index.datastore)             | Search     | OpenSearch 2   | Cloud      | none    |
| [Assets](contents/datastore/assets.datastore)                         | Object     | Object storage | Cloud      | 90 days |
| [Log archive](contents/datastore/log-archive.datastore)               | Object     | Object storage | Cloud      | none    |

The replica names its primary with `replica_of`:

![Main database replica](contents/datastore/main-db-replica.datastore)

## Logs

A workload names its log stream with `logs`. The stream record holds the format, the minimum level, the retention, and the datastore that keeps it.

| Log stream                                  | Category    | Level | Retention | Sink                                                      | Written by               |
| ------------------------------------------- | ----------- | ----- | --------- | --------------------------------------------------------- | ------------------------ |
| [Edge access](contents/log/edge-access.log) | Access      | Info  | 90 days   | [Log archive](contents/datastore/log-archive.datastore)   | All three load balancers |
| [Application](contents/log/application.log) | Application | Info  | 30 days   | [Search index](contents/datastore/search-index.datastore) | Web, API, Search         |
| [Jobs](contents/log/jobs.log)               | Job         | Warn  | 30 days   | [Search index](contents/datastore/search-index.datastore) | All four workers         |
| [Audit](contents/log/audit.log)             | Audit       | Info  | 400 days  | [Log archive](contents/datastore/log-archive.datastore)   | Not yet assigned         |

![Edge access](contents/log/edge-access.log)

## Follow one request

1. A reader connects to [Public edge](contents/loadbalancer/public-edge.loadbalancer) on port 443. The request is written to [Edge access](contents/log/edge-access.log).
2. The listener forwards to [Web](contents/container/web.container) on port 8080.
3. Web calls [API](contents/container/api.container) through [Internal API](contents/loadbalancer/internal-api.loadbalancer).
4. API reads [Main database](contents/datastore/main-db.datastore) and [Session cache](contents/datastore/session-cache.datastore), and puts a job on [Render jobs](contents/datastore/render-jobs.datastore).
5. [Render queue](contents/worker/render-queue.worker) takes the job and writes the result to [Assets](contents/datastore/assets.datastore).

A schema checks that each reference has the shape of a path for the right record type. It does not check that the file exists or that a subnet name belongs to the named network.
