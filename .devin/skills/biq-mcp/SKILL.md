---
name: biq-mcp
description: Querying and mutating BasketIQ business services (clubs, users, methodologies, teams, plays, cycles) through the biq-mcp MCP server — environments, write gating, known defects and fallbacks
---

# biq-mcp — BasketIQ business services via MCP

Use this skill whenever a task needs to read or write BasketIQ business data (clubs, users, methodologies, season plans, plays, teams, notifications, cycle preparations). Prefer the MCP tools over hand-rolled HTTP calls.

## Environments

- **`staging` is the only served environment.** `prod` is recognised but not implemented — never attempt prod writes.
- All staging services are Cloud Run in `europe-west1` under the staging GCP project.

## Tool surface (by area)

- Discovery: `list_environments`, `list_object_types`, `describe_object`
- Generic CRUD: `list`, `get`, `search`, `create`, `update`, `delete`
- Clubs: `list_clubs`, `search_clubs`, `get_club`, `create_club`, `update_club`, `delete_club`, `list_club_staff`, `onboard_club`, `offboard_club`, `put_club_footprint`
- Users: `list_users`, `find_user_by_email`, `create_user`, `update_user`, `assign_role`, `remove_role`
- Methodologies: `list_methodologies`, `get_methodology`, `create_methodology`, `create_methodology_revision`, `publish_methodology_revision`, `clone_methodology_revision`, `get_revision_diff`, `create_methodology_comment`, `resolve_methodology_comment`, attachments/share/validation variants
- Season/cycle: `get_season`, `set_season`, `list_cycle_preparations`, `get_cycle_preparation`, `delete_cycle_preparation`, `release_cycle`, `approve_cycle_objective`, `propose/confirm/migrate/delete_progression_customization`
- Plays/fields/plans/teams: `list_plays`, `get_play`, `search_plays`, `list_fields`, `get_field`, `list_plans`, `get_plan`, `list_teams`, `get_team`, `get_my_teams`, `update_my_teams`
- Misc: notifications, preferences, questionnaires, staff documents, `decision_sync`, `adopt_policy_decision`, `change_notice`, `impact_review`, `classify_edit`

Use `describe_object` before guessing a payload shape — it returns the schema and the real endpoints behind each object type.

## Write gating

Mutating tools (`create`, `update`, `delete`, `assign_role`, club/user/methodology writes…) require:

- `confirm=true` argument, and
- `BIQ_MCP_ALLOW_WRITES=1` in the MCP server env (already set in the workspace config; if a write is rejected, check `mcp_config.local.json`).

Always `get`/`describe_object` first and show the user what will change before confirming a write.

## Known defects (verify before relying)

- `list_users` → upstream `GET /api/admin/users` returns HTTP 500 even with a valid admin session. **Fallback**: `find_user_by_email`, `list_club_staff`, or read the Firestore `users` registry directly.
- `assign_role` / `remove_role` → 401 `invalid service token`: the onboard roles endpoints now require S2S auth (`Authorization: Bearer $BIQ_ONBOARD_S2S_SECRET` + `X-BIQ-Acting-User-Id` + `X-BIQ-Acting-Email`) that the MCP client does not send. **Workaround**: create the club-bound user with `create_user` passing a `roles` array, which assigns roles at creation time.
- E2E suites repopulate staging with `e2em_*` clubs/users — treat them as disposable artifacts, not real data.

## Conventions

- Club-bound user IDs look like `<prefix>_<club-suffix>` (e.g. `japv_efe043b17860`); global user IDs are numeric.
- Club IDs look like `f1f2_<hex>`.
- Report the exact object IDs used so handoffs are auditable.
