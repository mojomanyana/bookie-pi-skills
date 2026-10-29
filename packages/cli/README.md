# @bookie/cli

Release 0.1 provides read/query-only commands over an explicit local vault:

```text
bookie validate --vault <path> [--base <git-ref>] [--format text|json] [--timeout-ms <integer>]
bookie search --vault <path> <query> [--type <type>] [--project <path>] [--status <status>] [--state <state>] [--sensitivity <class>] [--tag <tag>] [--format text|json] [--timeout-ms <integer>]
bookie inspect --vault <path> (--uid <uid> | --path <path>) [--format yaml|json] [--timeout-ms <integer>]
```

BK-029's explicitly authorized additive deadline refinement (2026-10-28): optional final `--timeout-ms` uses decimal digits, defaults to 300,000 ms and accepts 1–21,600,000 inclusive. Invalid/duplicate/out-of-order values are static `CLI-INVOCATION` exit 2 before work. Existing forms remain valid. This operational setting avoids an ambient or unbounded timeout and adds no writing command.

The parent supervises read-only parsing off its event loop. Deadline/startup/crash failures return static `CLI-OPERATION` exit 1; SIGINT/SIGTERM return static `CLI-CANCELLED` exit 1. Failed operations publish no partial output. Owned worker/Git descendants must terminate before output, with a separate one-second teardown allowance; uncertainty is operation failure, not false success. Terminal failure releases parent references so the CLI can exit; it does not certify that surviving descendants stopped, which requires external operator/supervisor recovery. Command-tagged replies are decoded before formatting, and malformed worker results produce static operation failure with no stdout.

The CLI never searches upward for a vault. Release 0.1 intentionally provides no initialization, canonical mutation, Evidence capture, or file-export command. Those filesystem-writing surfaces remain deferred by ADR-0008.
