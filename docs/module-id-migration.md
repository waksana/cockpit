# One-time module ID migration

`migrate-id` changes a module's **host-owned** identity once, without an alias.
It neither relabels installed archives nor modifies native Copilot session
history/configuration. Session IDs, role IDs and module business-data contents
remain unchanged.

## Offline procedure

Use the intended isolated `COCKPIT_HOME` and the new host CLI. Stop **every**
process using that root first, including older hosts and CLI writers. Keep their
automatic restart mechanisms stopped throughout migration and recovery.
`--offline` explicitly acknowledges this operational responsibility; an HTTP
failure or unused port is not proof that a host is stopped.

1. Install the new-ID package **without `--enable`**:
   ```sh
   pnpm module install /absolute/path/new-module.tgz --trust-local-code
   ```
2. Review a plan (the default; no metadata/data cutover):
   ```sh
   pnpm module migrate-id old-module new-module --version 1.0.0 --digest <sha256> --offline
   ```
3. Apply explicitly with identical IDs and verified target version/digest:
   ```sh
   pnpm module migrate-id old-module new-module --version 1.0.0 --digest <sha256> --offline --apply
   ```
4. Only after successful completion, start the new host.

The destination must already be installed and pass full installation integrity
verification. It must have no selected entry, data directory or persisted role
references. The source must be selected. The operation preserves source
enabled/config values, removes its selection, moves its data directory by
same-filesystem rename, and refreshes migrated host role labels from the target
manifest while keeping their role IDs. Missing target roles, duplicate roles,
unexpected/corrupt metadata, links and conflicting stores are refused before
cutover. An absent source data directory is explicitly reported and no new
directory is created. Unrelated role records remain byte-for-byte unchanged.
No business-data files are inspected or transformed.

## Interruption and recovery

Before the first cutover, a bounded private `modules/.migration.json` journal
records exact before/after host metadata and the data directory identity.
It contains configuration values: **do not publish it**. The host refuses
startup while the journal exists, even if its contents are corrupt.
Install/enable/disable also refuse writes.

Complete an interrupted cutover explicitly:

```sh
pnpm module migrate-id old-module new-module --version 1.0.0 --digest <sha256> --offline --resume
```

Resume requires the original parameters and re-verifies both installations,
the complete role-file inventory, exact recorded before/after contents and
the original data directory inode/device at exactly one expected location.
Unexpected drift is an error, not something to overwrite or merge.
Do not remove the journal to bypass an error. There is no automatic retry or
rollback, and an error does not mean earlier changes were undone.

After an abrupt CLI death, the existing storage-writer `modules/.lock`
directory may remain. After explicitly stopping **all** hosts and CLI writers,
an operator may remove **only that empty directory** using
`rmdir "$COCKPIT_HOME/modules/.lock"` before running `--resume`. Do not
recursively remove storage or discard the migration journal. A nonempty lock,
unexpected permissions, or unresolved metadata/data drift requires investigation.

On success the journal is retained as
`modules/.migration-completed-<uuid>.json` (0600, inside private module storage).
It preserves metadata originals, not a second copy of business data. Each
journal is capped at 16 MiB and inventories at most 2,048 role files. Completed
journals are not aliases and are never consulted during normal startup.
The operation cannot be applied a second time to the removed source selection.

## Cooperative fencing boundary

The new Linux host and migrator share a root-specific kernel abstract Unix
socket lease, acquired **before native runtime construction** and retained
through host process exit. Startup and migration therefore cannot race in the
same network namespace; SIGKILL releases the lease without a stale startup
lock. A pending journal continues to block boot after a crash.

Migration currently requires Linux and a shared network namespace for every
process accessing the root; its CLI rejects other platforms before writing.
Ordinary macOS/Windows host startup remains available and checks the pending
journal, but explicitly reports that migration fencing is unavailable. It does
not acquire or claim a lease. A pending journal blocks startup on every platform.
Different roots are independent. This is cooperative fencing, **not authentication** or protection
against arbitrary local filesystem writers, older binaries, or containers in
different network namespaces. Those processes cannot be technically fenced by
this new code and must remain stopped under the explicit offline acknowledgment.
