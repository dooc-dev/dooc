name: Sandbox and host plugin architecture
area: Security
status: Planned
priority: Normal
summary: |
  The accepted design separates untrusted sandbox execution from trusted host extensions, with kit as the validated display API. VM isolation, instance policies, brokered network access and renderer migration remain unimplemented. Current service plugins retain their existing trust model.
