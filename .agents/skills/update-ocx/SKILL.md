---
name: update-ocx
description: Update the OpenCodex fork from upstream through a reviewed PR and signed remote release, install its tarball into the local client/proxy, then delegate and monitor the remote Hub GitOps rollout.
---

# Update OCX

Merge `upstream/main` into `custom` in `donadiosolutions/opencodex` through a PR,
publish a signed remote release, install its downloaded tarball through
`global-node-tools`, verify the local client/proxy, then delegate and monitor
the remote Hub's GitOps rollout in the `donadiosolutions/bcdn` Codex project.

A full update includes that deployment handoff and monitoring. Honor explicitly
narrowed requests. Editing this skill alone does not invoke its operational
workflow or create a deployment thread.

The local service is `opencodex-proxy.service` in connected **client** mode.
`ocx service install` manages this local service; startup selects the client
runtime from the saved Hub connection. Preserve that connection and any separate
inference relay. In HTTP Hub-client mode the local listener serves management and
readiness; the existing relay supplies Codex inference. Discover both addresses
independently. Preserve this arrangement rather than enabling a local Hub or
re-pairing.

## CONNECTION-SEVERING TRAP — NEVER SPLIT THE HANDOFF

**The OpenCodex proxy being replaced may be carrying this exact Codex session.**

`global-node-tools` publishes immutable releases and moves its managed
`current` link. Current OpenCodex writes the absolute stable launcher
`current/bin/ocx` into systemd's `ExecStart`; older units may instead contain
baked immutable Bun and CLI paths. Moving `current` does not replace the
already-running process in either case. `ocx service install` must run in the
same shell handoff to reconcile the unit and activate the effective release.

If package installation is terminal/tool call A and service repair is terminal/
tool call B, the session can disappear after A and before B is ever dispatched.
The shell must already own both operations before package publication begins.

The only permitted handoff shape is **one shell invocation** containing both
commands, separated by a literal semicolon:

```bash
global-node-tools install --bypass '<absolute-artifact-path>'; install_rc=$?; ocx service install; service_rc=$?; printf 'install_rc=%s\nservice_rc=%s\n' "$install_rc" "$service_rc"; handoff_rc=0; if [ "$install_rc" -ne 0 ]; then handoff_rc=1; fi; if [ "$service_rc" -ne 0 ]; then handoff_rc=1; fi; exit "$handoff_rc"
```

Replace the placeholder with the literal absolute content-addressed artifact
path before dispatching the whole line in one terminal/tool call.

**Never:**

- Put the two commands in separate terminal/tool calls.
- Use `&&`; service repair must run even when package installation returns
  nonzero.
- Enable `set -e` around the handoff.
- Insert `ocx --version`, logging, status, or any other command between package
  installation and `ocx service install`.
- Stop, restart, uninstall, or kill `opencodex-proxy.service` separately.
- Invent an explicit rollback install. The PATH-selected `ocx service install`
  repairs the service against the effective managed `current` release whether
  the target publication succeeded or failed.
- Treat a disconnected tool call as proof of failure. Its outcome is unknown
  until read back.

| Red flag | Why it is unsafe |
| --- | --- |
| Install now, repair in the next call | The connection can vanish before the repair is dispatched. |
| `install ... && ocx service install` | A failed install skips the repair. Use the exact semicolon command above. |
| `set -e` | A nonzero install exits the shell before repair. |
| Verify the version between operations | That recreates the severed-session window. |
| Stop the service first | It deliberately drops the session before a replacement is ready. |
| Blindly reinstall after reconnect | Disconnect does not reveal which transaction steps completed. |
| Check only `current` or `ocx --version` | Neither proves what immutable path the live service executes. |

## 1. Preflight and resume

1. Read repository instructions and use `lcm-memory`. Find the primary worktree
   with `git worktree list --porcelain` and read its `AGENTS.local.md` if present.
   Require `origin` to target `donadiosolutions/opencodex` for fetch and push,
   and `upstream` to target `lidge-jun/opencodex`, unless explicitly overridden.
   Use `--repo donadiosolutions/opencodex` for GitHub CLI operations.
2. Record worktree/index state and preserve unrelated files. Defer creating an
   isolated branch/worktree until the resume and fresh no-op decisions below;
   reuse the checkpointed worktree on resume. Never update on `main`, `dev`, or
   `preview`. A selected dirty-worktree strategy applies only to its stated scope;
   never infer permission to stash or discard.
3. Check for any unfinished invocation before applying the fresh-update no-op.
   Keep a mode-`0600`, git-ignored checkpoint under the `.tmp/update-ocx/`
   directory in the primary worktree found above, even when the update uses an
   isolated worktree. Verify that directory is ignored before writing. Include the
   intended update, selected upstream commit, branch/PR, completed stage, run ID,
   reserved tag, source/workflow SHAs, artifact hashes/image digest, pre-install
   release/PID, child thread/host/cursor when known, and pending release-dispatch
   or thread-creation intent. Never store credentials. An unfinished checkpoint blocks a
   fresh invocation even if upstream has advanced or the new request selects a
   different upstream tip. Resume it after live readback, or proceed only after
   the user explicitly abandons it; report its recorded PR, reservation, artifact,
   and thread state when abandoned. Inspect unresolved invocations before any
   fresh no-op decision.
4. For a full update, discover the release and Codex thread tools, including
   `list_threads`/`read_thread` for rediscovery, and resolve the
   `donadiosolutions/bcdn` project with `list_projects`. Record its identity but
   create no deployment thread until local verification succeeds. If required
   access/tools are unavailable, report the missing capability rather than
   silently dropping a lifecycle stage or substituting a direct cluster rollout.
5. Record `global-node-tools status`, resolved managed `current`/`previous`,
   launcher, CLI version, and the user service's `ActiveState`, `SubState`,
   `MainPID`, `ExecStart`, and `ControlGroup`. Read its actual local `/readyz`
   address/port and require an active, ready client before installation. Do not
   use a relay or remote Hub endpoint as proof of the local process.
6. Capture private preservation evidence for client role, port, pairing identity,
   token file/fingerprint, Hub connection, Codex configuration, and any relay.
   Verify effective state homes. If the installing shell exports
   `OPENCODEX_API_AUTH_TOKEN`, require it to equal the existing paired service
   token: installation gives the shell's value precedence. Never print tokens
   or replace a mismatching credential automatically.
7. Read the effective Codex configuration and its relevant layer origins through
   `config/read`, filtering output to routing/discovery fields; full config/layers
   can contain secrets. Record the effective Codex home, selected profile/launch
   overrides, user-layer version, and authentication mode from `account/read`
   with `refreshToken: false`. Inspection must not log in/out or refresh tokens.
   Preserve this installation's working contract: root `model_provider` absent
   (built-in `openai`), root `openai_base_url` and
   `experimental_realtime_ws_base_url` equal to the existing loopback inference
   endpoint, ChatGPT login, `features.api_key_model_discovery = true`, no active
   `model_catalog_json` override, and the commented custom-provider block.
   Capture these facts privately without credential values. Investigate a
   different baseline before installing; do not replace a user's newer choices.
   Record the version of the same installed Codex binary used for the fresh
   app-server inspection, rather than an unrelated PATH CLI, for the Hub's
   `codexEntitlementClientVersion` setting; CLI inventory is not a substitute for
   that explicit query-version configuration.
   Capture representative third-party picker entries and reasoning levels using
   the bounded app-server inspection described in section 6.
8. Do not run `ocx connect`, `ocx sync`, or `ocx restore` as routine update repair.
   The current HTTP Hub-client sync reinjects the dedicated `opencodex` provider;
   connected-client service startup does not need that sync. Preserve existing
   authentication, provider/history identities, and the separate inference relay.

## 2. Merge upstream and run focused regressions

For a **fresh invocation**, fetch `origin/custom` and `upstream/main`, recording
both immutable tips. If the selected upstream tip is already an ancestor of
`origin/custom`, report that the upstream merge is already contained and no new
update is initiated, before creating an update commit/PR,
releasing, installing, restarting, or deploying. An unfinished invocation whose
PR already merged resumes at its next unverified stage instead.

Create the update branch from the fetched `origin/custom`. With
`upstream_commit` set to the recorded upstream SHA, create a signed merge even
when it could fast-forward. Capture the original head and leave the merge
uncommitted for semantic review:

```bash
pre_merge_head="$(git rev-parse HEAD)"
git merge --no-ff --no-commit "$upstream_commit"
```

Review the merged tree semantically even when Git reports no textual conflicts.
Resolve conflicts semantically. Preserve the intent of downstream overrides and
fixes; supersede a downstream implementation when upstream provides a superior,
semantically equivalent counterpart. Check moved helpers and changed model
policies before retaining duplicate code or outdated test expectations. Never
use a blanket ours/theirs resolution. Resolve and stage only intended paths.
Require no unresolved index entries or conflict markers, then make the merge
commit with:

```bash
git commit --no-edit --gpg-sign --signoff
```

Verify both parents exactly (`HEAD^1` equals `pre_merge_head`; `HEAD^2` equals
`upstream_commit`), a valid signature and DCO trailer, and a clean
`git diff --check`. Additional fixes also use signed, signed-off commits.
Never rewrite upstream commits to add DCO trailers; use only an existing authorized
exemption if an inherited-commit check rejects them, or report that blocker.

Run focused regressions for conflict resolutions and affected retained or
superseded patches, including relevant tests whose dependencies are files read
as data or subprocesses. Use the repository's exact toolchain pins; reuse the
managed Bun only if its version matches the relevant pin. Install frozen
lockfile dependencies only when needed for those tests. Keep execution bounded
and record actual commands/results; do not rerun passing tests on unchanged code.

Do **not** run `bun run prepush`, `bun run test`, the full suite, standalone
typecheck/lint/privacy gates, or GUI doctor for this update workflow. Focused
regressions, required hosted checks, remote release verification, and live
acceptance are the selected policy. These local waivers do not waive required
hosted checks or authorize changing CI/protections.

## 3. Land the update through a PR

Push only the feature branch, without force, and open a PR targeting `custom`
using the repository template. Assign `bcdonadio`. Describe merge resolutions,
retained/superseded patches, focused validation, and omitted broad local checks.
Address applicable review findings and obtain required current-head checks and
reviews, honoring explicit scoped exceptions already granted by the user.

Keep the PR current with `origin/custom`; prefer `gh pr update-branch` to history
rewrites, and revalidate changed resolutions. If required DCO checks reject its
GitHub-generated branch-update merge, update locally with a signed, signed-off
merge commit and push without force. Merge upstream-update PRs with
`gh pr merge --merge --match-head-commit <reviewed-head>`, never squash or rebase:
the upstream ancestry must survive for the next no-op check. If merge commits
are unavailable, report that blocker rather than weakening ancestry or bypassing
protection. Do not push directly to `custom`.

Fetch `origin/custom` after merge. Verify it contains both the reviewed PR head
and the selected upstream commit; record the PR merge and intended release source
SHA in the checkpoint. Refresh a clean primary `custom` checkout with
`git pull --ff-only origin custom` when safe; preserve newly appearing user work.

## 4. Publish and verify the remote release

Before dispatch, checkpoint `release-dispatch-requested` with the intended source
SHA, workflow ref/revision, selected branch and UTC time. On resume or an ambiguous
response, find matching `workflow_dispatch` runs since that time and adopt only
an unambiguous match; investigate ambiguity before creating another reservation.
Dispatch the existing [numbered release workflow](../../../.github/workflows/bcdn-release.yml)
from the default `custom` workflow revision:

```bash
gh workflow run bcdn-release.yml --repo donadiosolutions/opencodex --ref custom -f source_branch=custom
```

Capture the returned run URL/ID, then its signed reservation, numbered tag,
selected source SHA, workflow SHA, and official upstream tag/commit. Do not
identify the run by merely taking the newest release. Require the selected
source to contain the reviewed update and selected upstream commit. If `custom`
advanced before reservation, inspect and validate the intervening changes under
the same focused policy before accepting that different source. Accept intervening
reviewed, merged changes after validating their interaction and recording them;
reject unreviewed source rather than looping dispatches. Keep that run's source immutable. If a
source/workflow fix lands through a PR and needs a new run, validate the change
under the focused policy, then advance the active checkpoint to the new run ID,
tag, source/workflow SHAs, and artifact/image digests. Retain the failed or
superseded reservation as historical state; never rewrite it.

On resume and before rerunning, compare with newer published numbered `custom`
releases. Do not rerun, install or deploy a superseded release without an explicit
operator choice. For the current release, monitor image/package build, signatures,
attestations, publication and promotion; require complete evidence and confirm the
GHCR `latest` tag resolves to its verified digest. A superseded run is an exception
to this promotion requirement and must never roll back GHCR `latest`.

Diagnose failures and fix the necessary blockers. Transient failures may rerun
the same run, preserving its original source and reservation. Source or workflow
fixes must land through another PR and a new release run; rerunning an old run
cannot load the fix. Preserve failed drafts/reservations and never rewrite a
published numbered tag. After an ambiguous dispatch, find the matching run before
considering another dispatch.

Download all assets from that exact published release into private ignored scratch
space. Run the verification steps in a dedicated subshell (`(...)`) so shell
options such as `set -euo pipefail` cannot affect the later handoff shell. Apply
only the verification steps in the
[verification contract](../../../.github/scripts/bcdn-image-VERIFY.md) and trusted
helper/tool versions from the recorded workflow revision; verify any downloaded
tool's pinned checksum. Do not run that document's global-install instructions:
the `global-node-tools` handoff below is mandatory, and npm/pnpm global installs
are not an alternate path. Check:

- The annotated reservation: extract `.github/scripts/bcdn-release.cjs` from the
  recorded workflow SHA into scratch. Fetch the tag ref and annotated tag with
  `gh api`; call its exported `reservation(message)` with `BCDN_COSIGN` pointing
  to the verified Cosign binary. Require a non-null result, commit/tag binding,
  and run, source, workflow and upstream identities matching the recorded run.
  The helper verifies the `bcdn-release.yml@refs/heads/custom` signer, GitHub OIDC,
  workflow SHA and dispatch trigger. Manifest, checksum, package and image
  signatures instead use VERIFY's `bcdn-image.yml` signer identity.
- Both package hashes, package provenance/release binding, image provenance/release
  binding, runtime SBOMs, and the separate build dependency evidence.
- The source SHA and workflow SHA separately: GitHub provenance names the workflow
  revision, while the signed release predicate and BuildKit materials bind the
  selected source. Require the requested upstream/update ancestry in that source.
- The expected package name/version, safe regular-file inventory, executable
  launcher, dashboard, generated compatibility manifest, and modified source bytes
  against that selected source. Require the tarball and digest to belong to the
  same verified release. Repository-only files and unrelated local files stay out.

Do not install or deploy failed/unverified evidence. No local GUI build, tarball
packing, `npm link`, `bun link`, or repository-linked install replaces the remote
artifact. The internal package version remains upstream; the numbered suffix
identifies this fork's release. Record the verified tarball and immutable image
reference in the checkpoint before proceeding. Fetch that verified index by digest
and record its `linux/amd64` image-manifest digest, excluding attestation manifests;
pass both digest identities to the deployment thread.

## 5. Stage the artifact and perform the handoff

Resolve the managed artifact store from the installed `global-node-tools`
controller, not a hard-coded workstation path. Set `tarball` to the verified
release download. If handoff intent is already checkpointed, preserve its original
baseline and go directly to section 6 recovery; do not re-stage or overwrite it.
Before copying, require a 128-character lowercase hexadecimal
SHA-512 matching the signed release manifest. Inspect an existing destination:
reuse it only if it is a regular, non-symlink, mode-`0600` file with matching bytes;
never overwrite an unexpected file or symlink. For an absent destination:

```bash
digest="$(sha512sum "$tarball" | awk '{print $1}')"
artifact="$gnt_home/artifacts/$(basename "${tarball%.tgz}").sha512-$digest.tgz"
install -m 0600 "$tarball" "$artifact"
test "$(sha512sum "$artifact" | awk '{print $1}')" = "$digest"
```

Require the staged artifact to remain a regular, non-symlink, mode-`0600` file.
Immediately refresh `before_current`, `before_previous`, service PID/readiness,
state homes, token/pairing, and Codex routing preservation evidence, then checkpoint
the handoff intent. Save private evidence outside the package/release assets.

**Submit the exact single-shell command in the handoff section above**, with the
literal absolute content-addressed artifact path substituted before dispatch.
It remains the same command for a connected client/proxy. Both return codes must
be zero for a successful handoff. Do not create the deployment thread yet.

Do not answer or automate a GitHub-star prompt. If OpenCodex emits an agent
deferral, ask the user exactly once near the top of the next response:

```text
Star lidge-jun/opencodex? Yes / No
```

## 6. Recover and verify the local client/proxy

After a disconnected or ambiguous handoff, inspect managed links, transaction and
release metadata, resolved launcher, service state, actual processes/cgroup, and
local `/readyz` before retrying. A lost tool response does not establish failure.

- If the target installation was published but the live runtime is older, run only
  `ocx service install`, then verify again.
- If the target is already live and ready, skip further installation/service
  changes and complete the remaining acceptance checks below.
- If the target runs but remains unready after reconciliation, block deployment
  and diagnose bounded startup evidence. Repair only the missing step within the
  authorized scope; do not loop installation/service commands or invent rollback.
- Retry package installation only when managed metadata proves the target
  transaction did not complete, using the same indivisible handoff.

Require all of the following before delegating deployment:

1. Managed `current` is the target installation, with `previous` equal to the
   checkpoint's pre-install `current`. Release metadata records `install`,
   `bypass: true`, and the expected direct `@bitkyc08/opencodex` version.
2. The actual package-manager backend locks the exact content-addressed tarball
   and matching SHA-512 integrity. For npm inspect `package-lock.json`; for pnpm
   inspect `pnpm-lock.yaml`'s direct importer/resolution and the managed hidden
   npm lock when present. Resolve relative `file:` references against the release
   directory. Do not require a root npm lock on a pnpm installation.
3. The CLI version and launcher resolve into the target installation. For a stable
   launcher unit, resolve its `current/bin/ocx` target; do not replace that design
   with baked paths. For older baked units, verify their actual executable paths.
4. The user service is `active/running`; its actual Bun runtime and OpenCodex
   entry point execute from the target immutable release in its exact cgroup.
   If `MainPID` is a Node/shell supervisor, inspect the Bun child too. Redact
   credential-bearing arguments from process evidence.
5. Local `/readyz` reports `opencodex`, the expected version, configured port,
   `role: client`, `status: ready`, and that verified runtime PID. A relay/Hub
   response, version equality, or `current` alone is insufficient proof.
6. Installed package files, including source and every packaged dashboard file,
   match the downloaded tarball's bytes and executable bits; check other modes
   against the effective package backend's normalization. Compare source with the
   recorded selected source, not a moving checkout; no local dashboard build is
   needed. Fetch a static dashboard asset from the local client and compare bytes.
7. Pairing, service token/fingerprint, remote Hub connection, client role/port,
   Codex configuration, and any relay remain preserved. Examine changes rather
   than ignoring a hash difference; catalog cache refreshes may be legitimate.
   Unrelated worktree state still matches the preservation inventory.

### Preserve Codex routing and model discovery

Read back the routing contract from preflight after the service handoff. Matching
configuration needs no write. Keep the inference relay URL separate from local
`/readyz`; a healthy management listener does not prove inference or discovery.

If the update introduced known routing drift, use Codex's supported
`config/read` and `config/batchWrite` APIs with the latest user-layer
`expectedVersion` and `reloadUserConfig: false`. Restore only the captured root
URL fields and remove an update-introduced root `model_provider` selection
(`value: null`, `mergeStrategy: replace`) to recover the built-in default.
Remove a provider block or catalog override only if this update introduced it
and it was absent in the baseline. Preserve the commented block, other provider
definitions, feature settings, and all unrelated configuration. Reread/reconcile
on a version conflict; investigate an overriding profile or managed requirement
rather than overwriting another layer. Validate TOML and effective readback, and
compare unrelated settings with the checkpoint. Never restore the whole old file
over concurrent edits, replace login credentials, or retag conversations.

Use a fresh instance of the installed Codex app-server with the intended home and
launch settings to verify what a future launch loads. Run it in a dedicated
transient user unit/cgroup; record its identity, stop only that unit afterward,
and verify the cgroup is empty. Where unavailable, record its process group and
descendant PID/start-time inventory and verify their exit. Never pattern-kill or
restart the GUI, or claim an existing app-server changed its startup provider.
Initialize the RPC connection, check filtered `config/read` and `account/read`
results with `refreshToken: false`, without login/logout or token refresh, then paginate
`model/list` with `includeHidden: false` until `nextCursor` is null. Require
representative third-party models advertised by this Hub to be picker-visible,
with their advertised reasoning levels. Capture the model IDs before installation
and compare after; investigate disappearance or reasoning regression. A plain
proxy `/v1/models` response alone cannot establish Codex picker compatibility.
Provider credential fields, effective authentication, and catalog settings affect
discovery; selecting `openai` alone does not guarantee it. Keep inspection bounded.

Checkpoint successful local verification. A failed or unproven local recovery
or Codex routing/discovery check blocks the deployment handoff.

## 7. Delegate and monitor the Hub's GitOps rollout

For the full workflow, use the Codex harness tools to create **one new thread**
in the project named `donadiosolutions/bcdn`. Resolve the current project ID with
`list_projects`; never hard-code a UUID, host, or checkout path. Use the project's
configured local environment and default model; omit model/reasoning overrides.
Keep cluster implementation and operational recovery with that repository.

Before calling `create_thread`, checkpoint a `deployment-thread-requested` stage
with the release tag, run ID, and immutable image digest. Include the release tag
and run ID as correlation markers in the initial prompt. If resuming this stage,
search threads in the resolved project for those markers before creating
anything; discover and continue an existing matching thread. After creation,
checkpoint the returned thread and host IDs, or retain the pending client ID until
thread discovery resolves it.
If supported discovery cannot resolve an ambiguous or pending creation, report
the correlation markers and request the thread identity; do not create a duplicate.

The initial human-readable prompt must provide:

- The verified `ghcr.io/donadiosolutions/opencodex@sha256:<digest>`, numbered
  release/run URLs, source and workflow SHAs, verified `linux/amd64` manifest digest,
  and relevant verification evidence.
- The numbered release tag and workflow run ID as explicit correlation markers
  for thread discovery and resume.
- Confirmation that the downloaded tarball is installed and the local client/proxy
  has recovered; this is the image from that same release.
- The verified Codex client version. Have the destination repository maintain the
  headless Hub's `codexEntitlementClientVersion` accordingly and verify fresh,
  version-matching account evidence without fabricating local CLI inventory.
- The instruction to read the target repository's guidance and complete its
  GitOps update, required review/merge, reconciliation, replacement Pod startup,
  and service acceptance. Delegate implementation decisions to that repository.
- The acceptance evidence required below, and a request to continue through
  recoverable failures under its policies and report any concrete blocker.

Immediately checkpoint the returned thread ID and host ID. If creation is still
pending, retain the returned client ID and resolve it through thread discovery;
do not pass a client ID to tools requiring a thread ID. If the response is lost,
look for the matching project/release task before creating another. On resume,
continue monitoring the same thread rather than creating a duplicate rollout.

Use `wait_threads` with that one thread/host, its latest cursor, and bounded waits
of at most 60 seconds. Read additional thread detail only when needed. Send scoped
follow-ups for incomplete evidence or corrective work within this image rollout.
Report meaningful progress or real blockers; do not leave monitoring to a scheduled
automation or finish at a merged PR or healthy reconciliation alone.

Require the child to report the GitOps PR/commit and reconciliation, replacement
Pod identity/startup and readiness, and the actual running image identity. Accept
a Pod `imageID` only if it equals the verified image index digest or the
digest of that index's `linux/amd64` image manifest, matched to the node platform.
Reject attestation manifests and all other platform digests. Require an actual
service operation proving recovery under the destination repository's acceptance
policy. If the image was already deployed when resuming, verify the recorded
replacement and current health without forcing a redundant restart.

A rollback may restore service but does not complete deployment of the requested
image. Continue remediation/monitoring within the authorized scope or report the
concrete blocker and restored/failed state; never label that target deployed.
After an interrupted connection, rediscover/read the child and service evidence
before deciding which work remains.

## 8. Completion and public/private boundary

Mark the invocation complete only after both local verification and the delegated
image rollout have succeeded, unless the user explicitly narrowed the requested
scope. Report the update PR, release/run, tarball, immutable image reference,
deployment thread, GitOps PR, and separate local and remote live proof. Include
the harness's created-thread link/directive when applicable.

The deployment project's name is permitted in this public skill. Keep credentials,
internal endpoints, cluster topology, workstation paths, checkpoints, and private
operational evidence out of public files, PRs, release assets, and build logs.
Do not commit scratch evidence or change registry visibility. Failures remain
recoverable through their recorded PR, reservation, artifact, and thread identity;
do not claim a successful whole update while a required stage is incomplete.
