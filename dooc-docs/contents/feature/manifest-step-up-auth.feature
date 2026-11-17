name: Manifest step-up authorization
area: Security
status: Planned
priority: Normal
summary: |
  Add server-enforced authorization at document.url connections to child dooc.yaml or named manifests, independently of root access. Keep ordinary URLs and iframe login flows outside this feature. The host owns policies and destination-specific credentials; protected content must remain guarded across direct reads, search, assets, history, MCP and exports. No authentication API or YAML keys are implemented. See Planned manifest authorization in the dooc.yaml reference.
