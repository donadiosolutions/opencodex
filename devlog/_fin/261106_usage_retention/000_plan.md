# Seven-day usage history

Approved objective: retain request details for seven days, preserve older daily
accounting and lifetime token totals, and load the complete utilization page in
less than 15 seconds on the existing dataset after migration.

## Delivery

1. Versioned numeric daily snapshots, exact existing filter semantics, and
   minimal recent accounting inputs. Historical estimates freeze on compaction.
2. Bounded worker compaction with owner-controlled atomic publication. Unknown
   or unaccountable records fail closed. Preserve incomplete trailing bytes.
3. One rebuildable SQLite accounting view shared by reports and timeline.
4. Seven-day detail reads, history metadata, localized precision notices.
5. Isolated dataset parity and cold browser timing; only then install/migrate.

## Contracts

- Daily summaries retain no individual request identities or diagnostic traces.
- Reporting uses the migration timezone. Older custom bounds require complete
  reporting days; recent precise bounds remain supported.
- API-key admission, combo overlap, coverage, cache and throughput semantics
  remain intact. Diagnostic consumers are limited to retained detail.
- No new package dependency. No change to optional Lab activation.
- Never claim completion until live parity and three cold page timings pass.

## Verification

Focused accounting, compaction, read-view, API and GUI regressions; typecheck,
privacy/structure checks, GUI build/i18n, bounded changed/full test coverage.
Use a private snapshot for migration tests and preserve a temporary recovery
copy through live verification. Do not place user data or credentials here.

## Verified implementation

- Versioned daily snapshots and accounting projection preserve scalar totals,
  combo overlap, attribution and frozen pricing. The worker publishes under
  the serving owner after validating source bytes and generated records.
- Private 6.8 GiB ledger compacted by about 91%; lifetime, 30-day and seven-day
  numeric summaries reconciled. Three cold browser runs took 1.50–1.57 seconds.
- Focused accounting/retention/API tests and GUI tests pass. Broader checks
  retain pre-existing type errors, structure budget debt, and credential/log
  regressions verified separately against the starting commit.
- Never downgrade against compacted data. Restore a matching pre-migration
  ledger and reconcile later appends before using an older reader.

Live deployment and accounting reconciliation completed. Old request-history
index was rebuilt from retained details and temporary recovery data removed
after verification. Cold and live page loads met the 15-second target.
