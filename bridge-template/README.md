# ODSH Bridge - directory bridge (template)

Copy this whole directory to your chosen host path (e.g. H:/ODSH-bridge or /srv/odsh-bridge),
then reference it in docker-compose.yml via ODSH_BRIDGE_HOST_DIR, or in your own compose.

| Zone | Purpose | Owner |
|------|---------|-------|
| Input/ | task envelopes (T-*.json) | shared |
| Output/ | results (<taskId>_result.json) | shared |
| DSH-Workspace/ | private DSH identity/drafts/logs/tools | deepseek-harness |
| Openclaw-Workspace/ | private OpenClaw memory/summaries | openclaw |

Protocol docs: docs/BRIDGE-SPEC.md (in the repo).
