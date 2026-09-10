# Development and production delivery

One complete goal has one owner. The discussion session sets scope, authorization
and real dependencies; the owner implements and delivers that whole goal.
Research-only tasks do not authorize commits or deployment.

## Isolated development

Fetch `origin/main` and create a short-lived branch in a separate worktree.
Never develop by applying deltas to the legacy shared working directory. A
worktree isolates files, not the running service, credentials or session data.
Use synthetic data and separate state directories/ports for tests.

Finish the change and run the smallest relevant existing checks. Fetch main
again, integrate any new commits in your own worktree, resolve conflicts, and
validate the resulting code. Commit the final result. There is no mandatory PR,
remote pre-merge CI, second integration round, or long-lived integration driver.

When production delivery is authorized, include this trailer on the final commit:

```text
Cockpit-Owner-Session: <original-owner-session-uuid>
```

It associates the eventual deployment result with the same owner. It does not
authorize new work or change who owns the goal.

## Integrate once, build after main

From the clean owner worktree, after local validation:

```sh
node scripts/release/integrate.mjs --publish-main
```

This fetches main, requires the candidate to contain it, and pushes the exact
commit to main without force. A racing main update not contained in the
candidate is rejected: integrate it locally and validate again. Do not force
push main or edit another owner's worktree to resolve the race.

**Updating main requests production delivery once the deployment route is
enabled.** Actions then checks and builds that fixed SHA. CI does not hold an
integration lock, and another owner can integrate while this build runs.

Main is desired source, not a claim about the version actually serving users.
Post-merge CI can fail. On failure, no release is promoted and the last healthy
production version stays online. The responsible owner fixes forward or uses
an authorized revert commit; do not rewrite history to hide the failure.

## Acceptance and cleanup

The deployment route reports distinct states: built, received, pending-idle,
activating, healthy, failed, or rolled-back. CI success, SSH acceptance, and a
restart acknowledgement are not production acceptance.

If the goal includes production delivery, confirm the active `/health` release
identity and the required behavior. A healthy descendant that contains and
preserves the final integrated change satisfies delivery; every intermediate
commit need not deploy separately. Reverted changes do not satisfy acceptance
merely because their commit remains an ancestor.

Owners hosted by Cockpit must not keep an active turn or background tool waiting
for Cockpit to restart. After submitting, finish the active turn without claiming
the task complete. The external deployment process can notify the original
owner after health confirmation. If delivery is uncertain, read deployment
state at the next real entry; never blindly replay callback prompts.

Only after the authorized result is delivered, send the actual caller a concise
final result and clean up precisely owned worktrees/branches/test resources that
have no unmerged or in-flight work. Do not delete production releases, user
uploads, native sessions, or another owner's resources during worktree cleanup.

The general work-owner skill owns responsibility and isolation principles.
This document owns repository-specific commands and branch policy. Actions and
release scripts enforce executable checks, identity and cutover; prose alone
does not enforce them. Private Free repositories may lack server-side branch
protection: the integration script is not a substitute for that security
boundary, and no paid upgrade is assumed.
