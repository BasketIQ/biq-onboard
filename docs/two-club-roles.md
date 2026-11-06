# Club membership roles

Member editing exposes one role: coach or sports_director. The legacy administrator input normalizes to sports_director. New coordinator/player/platform grants are rejected by club contracts. Additional-role arrays remain a compatibility input only when every value equals the primary role; conflicting values reject before member creation.

PUT member and the compatibility role-assignment endpoint call the Core transaction. The route club determines scope. Role DELETE returns409: change the member role instead. Deactivation and physical membership deletion use the same last-director transaction. SDK contention is returned as a retryable503 rather than a business conflict. Member-list role arrays project only the canonical membership value; profile/account data stays in biq-user.

Existing unknown/coordinator/player records remain readable while the migration inventory is classified; no automatic promotion is inferred. Existing roster players retain their sports identities.

## Staging migration

`scripts/migrate_club_roles.py --credentials <registered-staging-robot-key> --report <new-receipt.json>` is read-only by default. Review its classification_required rows. Supply an explicitly approved membership-ID mapping with `--mapping` only for those exceptions. After compatible services are deployed, `--apply` writes each planned role and its projection/audit atomically, verifies readback and preserves the role preimage. The transaction rejects a membership whose primary role changed since inventory. Repeated runs report already_canonical without additional writes. The project is fixed to spain-nextgen-staging; this tool cannot target production.

Preimage receipts retain original assignment IDs/validity. Rollback must restore only this migration's role fields and assignments in a transaction after checking no subsequent role change occurred; never restore whole user/profile documents over later edits. Pending ambiguous cases keep read compatibility and are not modified without an approved mapping.

Core0.31.0 merges role changes without replacing unmodeled membership fields such as team_ids/preferences. Migration requires this preservation fix before apply.
