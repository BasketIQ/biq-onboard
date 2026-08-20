# biq-onboard

BasketIQ Club Onboarding & Org Management service — club/user/role/team CRUD API.

## Run locally

```bash
cd server
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev,firestore]"

# Memory mode (no Firestore needed)
export BIQ_ORG_STORE=memory
export BIQ_ROLES_STORE=memory
export BIQ_ONBOARD_USER=admin
export BIQ_ONBOARD_PASSWORD=T3st1ng!

uvicorn biq_onboard_server.app:app --port 8090
```

## API endpoints

All endpoints under `/api/admin/*` require an authenticated session with the
`administrator` role. Login via `POST /api/auth/login`.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Admin login (session cookie) |
| POST | `/api/auth/logout` | Clear session |
| GET | `/api/auth/me` | Current session user |

### Clubs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/clubs` | Create/upsert a club |
| GET | `/api/admin/clubs` | List all clubs |
| GET | `/api/admin/clubs/{club_id}` | Get a club |
| PUT | `/api/admin/clubs/{club_id}` | Update a club |
| DELETE | `/api/admin/clubs/{club_id}` | Delete a club (cascade) |

### Onboarding

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/clubs/{club_id}/onboard` | One-shot: club + teams + users + roles |
| GET | `/api/admin/clubs/{club_id}/staff` | List club users + roles |
| DELETE | `/api/admin/clubs/{club_id}/offboard` | Delete club + all teams/users/roles |

### Teams

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/clubs/{club_id}/teams` | Create a team |
| GET | `/api/admin/clubs/{club_id}/teams` | List teams |
| PUT | `/api/admin/clubs/{club_id}/teams/{team_id}` | Update a team |
| DELETE | `/api/admin/clubs/{club_id}/teams/{team_id}` | Delete a team |

### Users

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/clubs/{club_id}/users` | Create a user |
| GET | `/api/admin/clubs/{club_id}/users` | List users |
| PUT | `/api/admin/clubs/{club_id}/users/{user_id}` | Update a user |
| DELETE | `/api/admin/clubs/{club_id}/users/{user_id}` | Delete a user |
| POST | `/api/admin/users/{user_id}/reset-password` | Reset password |

### Roles

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/clubs/{club_id}/roles` | Assign a role |
| GET | `/api/admin/clubs/{club_id}/roles` | List role assignments |
| DELETE | `/api/admin/clubs/{club_id}/roles/{assignment_id}` | Remove a role |

### Season

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/season` | Get current season |
| PUT | `/api/admin/season` | Set current season |

## Default staff template

`POST /api/admin/clubs/{id}/onboard` creates 9 default users when no `staff`
is provided:

| Username | Display name | Role |
|----------|-------------|------|
| admin | Administrator | administrator |
| director | Sports Director | sports_director |
| coord1 | Coordinator 1 | coordinator |
| coord2 | Coordinator 2 | coordinator |
| coach1 | Coach 1 | coach |
| coach2 | Coach 2 | coach |
| coach3 | Coach 3 | coach |
| prepa1 | Physical Coach 1 | coach |
| prepa2 | Physical Coach 2 | coach |

User IDs are `{username}_{club_id}`. Default password: `b4sk3t.26`.
