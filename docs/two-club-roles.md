# Club membership roles

Member editing exposes one role: coach or sports_director. The legacy administrator input normalizes to sports_director. New coordinator/player/platform grants are rejected by club contracts. Additional-role arrays remain a compatibility input only when every value equals the primary role; conflicting values reject before member creation.

PUT member and the compatibility role-assignment endpoint call the Core transaction. The route club determines scope. Role DELETE returns409: change the member role instead. Deactivation and physical membership deletion use the same last-director transaction. SDK contention is returned as a retryable503 rather than a business conflict. Member-list role arrays project only the canonical membership value; profile/account data stays in biq-user.

Existing unknown/coordinator/player records remain readable while the migration inventory is classified; no automatic promotion is inferred. Existing roster players retain their sports identities.
