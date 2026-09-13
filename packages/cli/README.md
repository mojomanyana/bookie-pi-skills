# @bookie/cli

Release 0.1 provides read/query-only commands over an explicit local vault:

```text
bookie validate --vault <path> [--base <git-ref>] [--format text|json]
bookie search --vault <path> <query> [--type <type>] [--project <path>] [--status <status>] [--state <state>] [--sensitivity <class>] [--tag <tag>] [--format text|json]
bookie inspect --vault <path> (--uid <uid> | --path <path>) [--format yaml|json]
```

The CLI never searches upward for a vault. Release 0.1 intentionally provides no initialization, canonical mutation, Evidence capture, or file-export command. Those filesystem-writing surfaces remain deferred by ADR-0008.
