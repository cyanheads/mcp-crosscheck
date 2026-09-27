# Security Policy

## Supported versions

Security fixes land on the latest release of `mcp-crosscheck`. Older versions are not patched — upgrade to the current release.

## Reporting a vulnerability

Please do not open a public issue for security reports. Instead:

- Report privately via GitHub: **Security** tab → **Report a vulnerability**, or
- Email **security@caseyjhand.com**

Include a minimal reproduction where possible. You'll receive an acknowledgment within a few days, and credit in the release notes if the report leads to a fix (unless you prefer otherwise).

## Handling captures and credentials

`mcp-crosscheck` spawns real clients against a server you point it at, and `--artifacts` writes what they produced to disk:

- `ground-truth.json` and `mcpo.openapi.json` contain server-controlled data.
- `codex.request.json` and `claude-code.request.json` are raw client requests and can carry prompt, session, and client metadata.

Treat all of it as local-sensitive. Do not attach raw artifacts to issues, and redact credentials before pasting any output.

Header values passed with `--header` are removed from crosscheck-owned diagnostics and reports. They are **not** removed from raw captures or from server echoes, and the command line itself can be visible through shell history or process inspection — Inspector and mcpo also receive headers in child-process arguments. Use dummy credentials against test servers where you can.
