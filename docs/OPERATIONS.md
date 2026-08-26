# Operations: Cua Desktop, Security, Troubleshooting

## 7. Windows desktop execution (Cua Driver)

See **`CUA-EXECUTION.md`** for the full guide. Summary:

- **Why**: gives the DSH execution layer real, focus-safe desktop control on the Windows host —
  screenshot, click/type, browser automation (CDP), app launch — without any OpenClaw Desktop or a
  dedicated node process.
- **How it works**: `src/oc-cua.mjs` runs `ssh -i <key> <user>@<host> "cua-driver call <tool> '<json>'"`.
- **Security posture**: SSH is key-only (`BatchMode=yes`), the Windows side whitelists exactly the DSH
  container's public key; the driver operates the real desktop but never steals focus.

---

## 8. Security notes

1. **Never commit tokens**: `OC_TOKEN` lives only in `.env` (gitignored); everything in the repo's
   `.env.example` is a placeholder.
2. **Device pairing**: `deviceId` is a device fingerprint (a hash of the Ed25519 public key); approving it
   grants operator-level permissions — make sure your network is isolated and do not approve unknown devices
   casually.
3. **Origin allowlist**: broad openings lower security; in production only allow the origin you actually use;
   changing the allowlist requires a gateway restart.
4. **Private key permissions**: the JWK file is created `0600` and lives in DSH-Workspace (the other container
   must not modify it).
5. **run-command**: the daemon's `run-command` can execute shell (verbatim check: the first word may not
   start with `;`, `&`, `|`, or a backtick) — only trust envelope sources; in production add a requester
   allowlist (see BRIDGE-SPEC §8).
6. **Cua channel**: SSH key is limited to the DSH identity; keep `CUA_SSH_*` in controlled env vars (never
   commit). Revoke the key immediately if the Windows host or container is compromised.

---

## 9. Troubleshooting (common failures)

| Symptom | Cause | Fix |
|---|---|---|
| `spawn <script> ENOENT` | Command/environment missing when launched through DSH's tool-runner exec channel | Use a long-lived session (`oc-client connect`) + start the daemon from a manual shell; give the full node path (`which node`). ⚠️ verify your DSH runner config. |
| `ECONNREFUSED / ENOTFOUND` | Cannot reach the gateway | Check both containers on the same docker network and the container name (`docker exec openclaw getent hosts openclaw`) |
| `handshake rejected / non-101` | origin not allowed | Add the origin to `gateway.controlUi.allowedOrigins` and restart the gateway (back up openclaw.json first) |
| Connection breaks after container IP swap | An IP was hardcoded | Use container-name DNS everywhere (default `OC_HOST=openclaw`) |
| `device signature invalid` (intermittent) | **Confirmed root cause**: claim signature timestamp and `device.signedAt` used two separate `Date.now()` calls → millisecond mismatch | Use a single `const signedAt = Date.now()` for both (see `gateway-client.mjs`) |
| `PAIRING_REQUIRED` | Device not approved | Approve that deviceId in the Control UI |
| daemon does not process envelopes | Already processed (`.state`) / filename is not `T-*.json` | Clear `.state` or use a new taskId |
| Cua: `Connection refused` on 22 | sshd not running (service-manager start fails) | Use `sshd.exe -d` debug-check; if that works, use the scheduled-task fallback (see CUA-EXECUTION.md §1.2) |
| Cua: `Permission denied (publickey)` | Key not in `administrators_authorized_keys` (Administrators user) | Put the DSH pubkey there with `icacls ... Administrators:F`; see CUA-EXECUTION.md §1.4 |
| Cua: `cua-driver: not recognized` or wrong path | PATH / install location differs | Set `CUA_BIN` to the real full path of `cua-driver.exe` |

---

