"""Staging-only two-role migration. Dry-run by default; never touches profiles.

Run after compatible consumers are deployed. --mapping is an explicitly
approved JSON map of membership IDs to coach/sports_director for exceptions.
Credentials are supplied at runtime; never copied into reports.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from google.cloud import firestore
from google.oauth2 import service_account

from biq_core.org import User
from biq_core.org.registry import FirestoreOrgRegistry
from biq_core.roles import FirestoreRoleRegistry, RoleAuditLog, validate_club_role
from biq_core.roles.membership import replace_member_role
from biq_core.roles.migration import plan_member_role


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--mapping")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    report_path = Path(args.report)
    if report_path.exists():
        parser.error("Use a new report path; previous receipts must be retained")
    mapping = json.loads(Path(args.mapping).read_text()) if args.mapping else {}
    for value in mapping.values():
        validate_club_role(value)
    credentials = service_account.Credentials.from_service_account_file(
        args.credentials
    )
    db = firestore.Client(project="spain-nextgen-staging", credentials=credentials)
    report = {"project": "spain-nextgen-staging", "apply": args.apply, "members": []}
    try:
        org = FirestoreOrgRegistry(db)
        roles = FirestoreRoleRegistry(db)
        audit = RoleAuditLog(db)
        for snap in db.collection("orgs_users").stream():
            raw = snap.to_dict()
            if not raw.get("club_id"):
                continue
            member = User.model_validate(raw)
            scope = f"club:{member.club_id}"
            grants = roles.list_assignments(member.id, scope)
            plan = plan_member_role(member, grants)
            target = mapping.get(member.id) or plan["target_role"]
            row = {**plan, "target_role": target, "outcome": "classification_required"}
            report["members"].append(row)
            if target is None:
                continue
            target = validate_club_role(target)
            if (
                member.role == target
                and len(grants) == 1
                and grants[0].role == target
                and grants[0].valid_from is None
                and grants[0].valid_to is None
            ):
                row["outcome"] = "already_canonical"
                continue
            row["before"] = {
                "role": member.role,
                "assignments": [a.model_dump() for a in grants],
            }
            row["outcome"] = "planned"
            # Persist the exact role preimage before every authorized write.
            report_path.write_text(json.dumps(report, indent=2))
            if args.apply:
                replace_member_role(
                    org,
                    roles,
                    audit,
                    club_id=member.club_id,
                    user_id=member.id,
                    role=target,
                    actor_id="migration:2026-11-06-two-club-roles",
                    expected_role=member.role,
                )
                after = org.get_user(member.id)
                projected = roles.list_assignments(member.id, scope)
                if (
                    after is None
                    or after.role != target
                    or len(projected) != 1
                    or projected[0].role != target
                ):
                    raise RuntimeError("Migration readback mismatch")
                row["outcome"] = "applied_verified"
            report_path.write_text(json.dumps(report, indent=2))
    finally:
        report_path.write_text(json.dumps(report, indent=2))
        db.close()
    counts = {}
    for row in report["members"]:
        counts[row["outcome"]] = counts.get(row["outcome"], 0) + 1
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
