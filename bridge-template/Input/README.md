# Input/ - task entry (SHARED)
Drop task envelopes here as T-*.json (see docs/BRIDGE-SPEC.md for the schema).
Both containers read/write this directory; use atomic .tmp -> rename writes.
Example envelope:

{ "schema":"odsh-envelope/v1", "taskId":"T-000101-01", "type":"execute", "status":"queued", "requester":"human", "target":"dsh", "payload":{ "kind":"echo", "text":"hello" } }
