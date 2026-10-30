/**
 * biq-onboard-app — Club Details, branding, and profile UI.
 *
 * This is a remote web component loaded by the biq-app shell. It provides:
 *   - Club Details screen (website editing, branding state machine)
 *   - Per-verdict Spanish copy (ADDENDUM-04 §5)
 *   - Theme preview (light/dark swatches)
 *   - Manual colour picker
 *   - Logo rights affirmation (ADDENDUM-06 §C3)
 *   - User profile section
 *
 * Module contract: the shell injects `el.org`, `el.user`, and
 * `el.remoteConfig` (ADR-009). The module uses the shell's same-origin
 * BFF for API calls — it never calls biq-onboard directly.
 */

import styles from './styles.css?inline';
import chispaHeadCompactSvg from './assets/chispa-head-compact-v2.svg?raw';

// ─── Types ──────────────────────────────────────────────────────────────

interface MembershipInfo {
  club_id: string;
  club_name?: string;
  role: string;
}

interface OrgContext {
  club: { id: string; name?: string; website?: string } | null;
  team?: unknown;
  teams?: unknown[];
  season?: unknown;
  role?: string;
  // ADDENDUM-07 §6 — identity + memberships for the club step
  email?: string;
  display_name?: string;
  memberships?: MembershipInfo[];
}

interface ClubTheme {
  schemaVersion?: number;
  status: 'active' | 'draft' | 'rejected' | 'pending';
  source?: {
    kind: string;
    homepageUrl: string;
    extractedAt: string;
    confidence: number;
  };
  seed?: {
    brand: string;
    brandAlt: string | null;
    detectedFrom: string;
    variant?: string;
  };
  logo?: {
    url: string | null;
    onLight: string | null;
    onDark?: string | null;
    rightsConfirmedAt: string | null;
    status: 'awaiting_rights' | 'confirmed' | 'rejected';
  } | null;
  tokens?: {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
  gate?: {
    passed: boolean;
    failures: Array<{
      error?: string;
      fg?: string;
      bg?: string;
      ratio?: number;
      required?: number;
      fgHex?: string;
      bgHex?: string;
    }>;
  };
  activation?: {
    themeStatus: string;
    reason: string;
  };
}

interface ThemeJob {
  revision?: string;
  previousTheme?: ClubTheme | null;
  // Canonical states (B10) — the server has no "completed" vocabulary.
  status: 'pending' | 'running' | 'succeeded' | 'uncertain' |
    'rejected_not_a_club' | 'unsupported_source' | 'unreachable' |
    'failed' | 'reverted';
  sourceUrl: string;
  requestedAt: string;
  finishedAt: string | null;
  attempts: number;
  verdict?: {
    verdict: string;
    score: number;
  } | null;
}

// B14: themeJob state matrix — presentation + action per canonical state
const THEME_JOB_COPY: Record<string, { title: string; description: string; action?: string }> = {
  pending: {
    title: 'Personalización en cola',
    description: 'Tu estilo se generará automáticamente en unos segundos.',
  },
  running: {
    title: 'Analizando la web del club',
    description: 'Extrayendo colores y generando el estilo.',
  },
  succeeded: {
    title: 'Propuesta disponible',
    description: 'Revisa los colores y el escudo antes de aplicar la identidad.',
    action: 'adjust/regenerate/revert',
  },
  uncertain: {
    title: 'Revisión necesaria',
    description: 'La web parece legítima pero no tenemos suficiente confianza para aplicar los colores automáticamente.',
    action: 'Sí, usarlo / cambiar URL',
  },
  rejected_not_a_club: {
    title: 'No parece un club',
    description: 'La URL indicada no corresponde a un club de baloncesto.',
    action: 'Corregir URL / estilo manual',
  },
  unsupported_source: {
    title: 'Fuente no soportada',
    description: 'No podemos extraer colores de este tipo de página.',
    action: 'Añadir web / estilo manual',
  },
  unreachable: {
    title: 'No se pudo acceder',
    description: 'La web del club no respondió después de varios intentos.',
    action: 'Reintentar / cambiar URL',
  },
  failed: {
    title: 'Error técnico',
    description: 'Se produjo un error al generar el estilo.',
    action: 'Reintentar / estilo manual',
  },
  reverted: {
    title: 'Estilo BasketIQ por defecto',
    description: 'El estilo se ha revertido al BasketIQ por defecto.',
    action: 'Generar de nuevo',
  },
};

// F12: Canonical category taxonomy (mirrors shell.js CATEGORY_ORDER)
const CATEGORY_ORDER = ['babybasket', 'prebenjamin', 'benjamin', 'alevin', 'infantil', 'cadete', 'junior', 'senior', 'veteranos'];
const CATEGORY_LABELS: Record<string, string> = {
  babybasket: 'Babybasket', prebenjamin: 'Prebenjamín', benjamin: 'Benjamín',
  alevin: 'Alevín', infantil: 'Infantil', cadete: 'Cadete',
  junior: 'Junior', senior: 'Senior', veteranos: 'Veteranos',
};

// Competition level dropdown — the same 7-option list the retired A-04
// questionnaire used (biq-methodology, removed in d8b33e6). Stored value is
// the option code; the wire format stays a free string.
const COMPETITIVE_LEVEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: 'No compite' },
  { value: 'local', label: 'Local' },
  { value: 'provincial', label: 'Provincial' },
  { value: 'regional', label: 'Regional' },
  { value: 'regional_top', label: 'Regional máximo' },
  { value: 'autonomic', label: 'Autonómico' },
  { value: 'national', label: 'Nacional' },
];
const COMPETITIVE_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  COMPETITIVE_LEVEL_OPTIONS.map((o) => [o.value, o.label]),
);

// F12: Inline SVG icons (stroke currentColor, same style as biq-methodology / STT).
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20h9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7h18M5 7v12h14V7M10 11h4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3v5h5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M8 6V4h8v2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="m19 6-1 14H6L5 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CANCEL = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
// Plantilla — roster icon (two person silhouettes)
const ICON_USERS = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 19.5c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="16.5" cy="9" r="2.4" stroke="currentColor" stroke-width="1.7"/><path d="M16 14.7c2.4.2 4 1.7 4.5 4.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ─── Helpers ────────────────────────────────────────────────────────────

const escapeHtml = (s: string): string =>
  String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Options markup for the competitive_level <select>: placeholder for the
// unset state; a stored value outside the canonical list (legacy free text)
// is preserved as an extra selected option rather than silently dropped.
function competitiveLevelOptionsHtml(current: string): string {
  const opts = COMPETITIVE_LEVEL_OPTIONS.map(
    (o) => `<option value="${o.value}"${current === o.value ? ' selected' : ''}>${o.label}</option>`,
  );
  const known = COMPETITIVE_LEVEL_OPTIONS.some((o) => o.value === current);
  if (current && !known) {
    opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
  }
  return `<option value=""${!current ? ' selected' : ''}>Selecciona…</option>${opts.join('')}`;
}

// F-CL-3 (PD-5): Categoría/Género select options for the club team editor.
// Categoría uses the canonical biq-core CATEGORIES vocabulary (same list
// PERSONAL_CATEGORIES mirrors); Género is Femenino/Masculino/Mixto. A
// stored value outside the list is preserved as an extra selected option
// — the same rule competitiveLevelOptionsHtml applies to legacy levels.
// "" maps to «Selecciona…» and clears the field on save.
function categoryOptionsHtml(current: string): string {
  const opts = PERSONAL_CATEGORIES.map(
    (c) => `<option value="${c.key}"${current === c.key ? ' selected' : ''}>${c.label}</option>`,
  );
  if (current && !PERSONAL_CATEGORIES.some((c) => c.key === current)) {
    opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
  }
  return `<option value=""${!current ? ' selected' : ''}>Selecciona…</option>${opts.join('')}`;
}

const TEAM_GENDER_OPTIONS = [
  { value: 'F', label: 'Femenino' },
  { value: 'M', label: 'Masculino' },
  { value: 'X', label: 'Mixto' },
] as const;

function genderOptionsHtml(current: string): string {
  const opts = TEAM_GENDER_OPTIONS.map(
    (o) => `<option value="${o.value}"${current === o.value ? ' selected' : ''}>${o.label}</option>`,
  );
  if (current && !TEAM_GENDER_OPTIONS.some((o) => o.value === current)) {
    opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
  }
  return `<option value=""${!current ? ' selected' : ''}>Selecciona…</option>${opts.join('')}`;
}

// Roles that may create clubs (ADDENDUM-07 §6.3 — mirrors the server rule;
// here it drives presentation only, the server enforces with 403).
const ADMIN_ROLES = ['administrator', 'sports_director', 'super_administrator'];

// Consolidated Equipos tab (2026-09-19 design): who may pick their own teams
// via the self-scoped /api/org/my-teams contract. Management stays behind
// ADMIN_ROLES (the server's club.teams.manage gate enforces it).
const PICK_ROLES = ['administrator', 'super_administrator', 'sports_director', 'coordinator', 'coach'];

function canCreateClub(memberships: MembershipInfo[] | undefined): boolean {
  const ms = memberships || [];
  return ms.length === 0 || ms.some((m) => ADMIN_ROLES.includes(m.role));
}

// F7: Pure function for tab/membership-state mapping. Extracted from
// renderClubStep for unit testing without a browser.
interface ClubTab {
  id: string;
  label: string;
}

// F12: A club team-catalog row as returned by GET /api/clubs/{id}/teams.
// Plantilla — roster row (name + shirt number) as served by the team
// catalog (biq-core TeamPlayer). Plain reference data, no account.
interface RosterPlayer {
  name: string;
  number: number | null;
  // Stable roster identity (biq-core 0.25.0 `TeamPlayer.player_id`,
  // `pl_<16 hex>`). Optional: rows created locally have none until the
  // server assigns one on save. Every roster writer preserves it — the
  // personal roster PUT echoes it back verbatim (rows without one keep
  // working: backfill is the server's job, never client-generated).
  player_id?: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  category: string | null;
  gender: string | null;
  label: string | null;
  archived: boolean;
  competitive_level?: string;
  players?: RosterPlayer[];
}

// Mi Club Phase 4 (Miembros tab): member roster row from
// GET /api/clubs/{id}/users — `roles` carries secondary RoleAssignments.
interface MemberRow {
  id: string;
  display_name: string | null;
  email: string | null;
  role: string;
  roles: string[];
  status: string;
}

// Geometría aprobada en club-members-icons.json (paquete UX v2, 18/10):
// trazo 24×24 a currentColor; el target ≥44px lo da el botón contenedor.
const MEMBER_ICONS = {
  edit: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 15 12-12 5 5L9 20l-6 1ZM13 6l5 5"/></svg>',
  deactivate: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M17 4v16"/></svg>',
  reactivate: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 3 14 9-14 9Z"/></svg>',
  delete: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>',
} as const;

interface MemberAssignment {
  id: string;
  user_id: string;
  role: string;
  club_id: string;
}

const ROLE_LABELS: Record<string, string> = {
  administrator: 'Administrador',
  sports_director: 'Director deportivo',
  coordinator: 'Coordinador',
  coach: 'Entrenador',
  player: 'Jugador',
  super_administrator: 'Super administrador',
};

// Assignable club-scope roles for administrators (server enforces F9).
const ASSIGNABLE_ROLES = ['administrator', 'sports_director', 'coordinator', 'coach', 'player'];
// Sports directors are bounded to sporting roles only (server enforces).
const SPORTING_ASSIGNABLE_ROLES = ['coordinator', 'coach', 'player'];

function clubTabsForMembershipState(memberships: MembershipInfo[] | undefined): ClubTab[] {
  const ms = memberships || [];
  const showCreate = canCreateClub(ms);
  const tabs: ClubTab[] = [
    ...(ms.length ? [{ id: 'memberships', label: 'Mis clubes' }] : []),
    { id: 'join', label: 'Unirme a un club' },
    ...(showCreate ? [{ id: 'create', label: 'Crear un club' }] : []),
  ];
  return tabs;
}

function defaultClubTab(memberships: MembershipInfo[] | undefined): string {
  const ms = memberships || [];
  return ms.length ? 'memberships' : 'join';
}

// Normalise a club website: prepend https:// to bare domains ("cbnorte.es"),
// reject non-https schemes (ADDENDUM-03 §5.2 / ADDENDUM-02 §9.1). Returns
// null when the value is invalid; "" when empty/optional.
function normaliseWebsiteUrl(raw: string): string | null {
  const v = (raw || '').trim();
  if (!v) return '';
  if (/^https:\/\//i.test(v)) return v;
  if (/^[a-z]+:\/\//i.test(v)) return null;
  return 'https://' + v;
}

// ─── Working-context entry (BIQ-PERSONAL-CLUB-CONTEXT/1.0.0) ────────────
// The shell injects `el.context` when a context-aware module runs inside an
// active working context. Without it (or while the bootstrap resolves) the
// module falls back to the legacy club step.

interface OwnerScope {
  kind: string;
  workspace_id?: string;
  account_id?: string;
  club_id?: string;
}

interface ContextDescriptor {
  token?: string;
  context_id: string;
  context_epoch: number;
  owner_scope: OwnerScope;
  team_ids: string[];
  archived_team_ids?: string[];
  working_team_ids: string[];
  active_team_id?: string;
  status?: string;
}

interface ContextCandidate {
  kind: string;
  owner_scope: Record<string, string>;
  name?: string;
  requires_verification: boolean;
}

interface BootstrapPayload {
  schema_version: string;
  state: string;
  account_id: string;
  identity_verified: boolean;
  identity_scope?: string;
  contexts: ContextCandidate[];
  active: ContextDescriptor | null;
  entry_actions: Record<string, { allowed: boolean; requires_verification: boolean }>;
}

interface PersonalTeamRow {
  team_id: string;
  name: string;
  category_key: string;
  category_label: string;
  age_band: string;
  gender: string;
  section_applicability: string;
  timezone: string;
  season: string;
  archived: boolean;
  team_revision: number;
}

// ─── Entry intent (entry-login §4.2) ────────────────────────────────────
// Frozen at click: the bootstrap account, the entry generation, the access
// kind and the chosen club/team. Exactly one intent may be in flight; a
// stale completion paints nothing, emits nothing and releases nothing —
// only the owning intent releases the busy state.
interface EntryIntent {
  id: number;
  gen: number;
  account_id: string;
  kind: 'personal' | 'personal-team' | 'club' | 'create-team' | 'create-club' | 'redeem';
  club_id?: string;
  team_id?: string;
  emitted: boolean;
  mutated: boolean;
  /** Ticket de la pantalla única (T1) — inyectado por la carcasa; null
   * si la carcasa no soporta el contrato o no hay productor. */
  navTicket?: { id: string; close: () => boolean } | null;
}

// Recovery surfaces after an applied-or-uncertain mutation:
//   narrowing — activate POST applied but the working-teams PUT failed
//     (Reintentar equipo retries the PUT only; Entrar con todos emits the
//     plain activation path). No rollback is claimed.
//   uncertain — transport failed after the mutation may have been sent
//     (Comprobar resynchronizes with a bootstrap GET; never an auto-POST).
//   confirm   — the activated event was emitted but the shell never
//     confirmed within the bounded window (Reintentar = bootstrap GET).
type EntryRecovery =
  | { kind: 'narrowing'; team_id: string; message: string }
  | { kind: 'uncertain'; message: string }
  | { kind: 'confirm'; message: string };

// The request may have reached the server — never auto-retried.
class EntryUncertainTransport extends Error {
  constructor() {
    super('No sabemos si la entrada se completó');
    this.name = 'EntryUncertainTransport';
  }
}

// The activate POST applied but the working-teams narrowing failed.
class EntryNarrowingFailure extends Error {
  team_id: string;
  constructor(teamId: string, message: string) {
    super(message);
    this.name = 'EntryNarrowingFailure';
    this.team_id = teamId;
  }
}

// ─── SF1 §5: shared roster editor — normalized model + context port ─────
// ONE editor renderer/controller for club and personal teams; the data
// adapter is chosen from the authoritative working context
// (`_context.owner_scope.kind`), never from UI mode strings, id prefixes
// or caller-supplied ownership. `version` is the opaque CAS handle —
// `team_revision` for the personal roster API, null for the club PUT
// contract which carries no CAS.

interface TeamEditorModel {
  id: string;
  name: string;
  competitive_level: string;
  players: RosterPlayer[];
  version: number | null;
  permissions: { read: boolean; edit: boolean };
  // F-CL-3 club-team fields — present only when the port serves the club
  // team catalog. The personal roster API has no category/gender contract,
  // so `undefined` also marks the editor as "personal": the Categoría /
  // Género selects render only when defined.
  category?: string | null;
  gender?: string | null;
}

type TeamEditorLoad =
  | { kind: 'ok'; model: TeamEditorModel }
  | { kind: 'not-found' }
  | { kind: 'denied' }
  | { kind: 'unavailable'; message: string };

type TeamEditorSave =
  | { kind: 'saved'; model: TeamEditorModel }
  | { kind: 'conflict' }
  | { kind: 'not-found' }
  | { kind: 'denied' }
  | { kind: 'unavailable'; message: string };

interface TeamEditorPort {
  load(teamId: string): Promise<TeamEditorLoad>;
  save(
    teamId: string,
    draft: {
      name: string;
      category?: string | null;
      gender?: string | null;
      competitive_level: string;
      players: RosterPlayer[];
    },
    version: number | null,
  ): Promise<TeamEditorSave>;
}

// Editor roster draft row — raw strings so typing never needs a re-render
// (innerHTML rebuild would wipe in-flight input values). `birth_date`
// (F-CL-3/PD-2) is player-profile data: minors' personal data live in
// biq-player `player_profiles/{player_id}`, keyed by the scouting id —
// never on the team record, so the roster PUT never carries it. The row
// captures it in the draft and a separate profile PUT (X-Biq-Module:
// onboard — `player.profile.manage` is an onboard action) persists it
// once the row has a `player_id`. `birth_loaded`/`birth_dirty` guard the
// write path: a profile never written stays unknown (not "empty"), and
// only user-edited values are ever sent.
interface RosterDraftRow {
  name: string;
  number: string;
  birth_date: string;
  birth_loaded: boolean;
  birth_dirty: boolean;
  existing: boolean;
  player_id: string | null;
}

// Category vocabulary mirrors biq-core CATEGORIES (slug → display label).
const PERSONAL_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'babybasket', label: 'Babybasket' },
  { key: 'prebenjamin', label: 'Prebenjamín' },
  { key: 'benjamin', label: 'Benjamín' },
  { key: 'alevin', label: 'Alevín' },
  { key: 'infantil', label: 'Infantil' },
  { key: 'cadete', label: 'Cadete' },
  { key: 'junior', label: 'Junior' },
  { key: 'senior', label: 'Senior' },
  { key: 'veteranos', label: 'Veteranos' },
];

// ─── Entry screen v1 (entry-login lot, 2026-10-23) ─────────────────────
// «Mi equipo» shows the teams the user coaches (the personal-teams feed —
// the bootstrap carries no per-club role or coached-team catalog,
// README §PD-ENTRY). «Mi club» is ALWAYS shown (Director 2026-10-24,
// superseding the 2026-10-23 PD-ENTRY coach-hiding): a user with no club
// gets the «Crear club» action whenever the server allows `club.create`.
// Director 2026-10-26: the «Mi equipo» head carries the «Salir» action
// (not a role chip), and each club card states «Entrar como <rol>» from
// the memberships feed — PD-CLUBS' no-role rule is superseded by an
// authoritative per-club role.
// PD-CLUBS (Director 2026-10-23): 2 clubs → two cards; ≥3 → one main
// access (the «Club reciente» when a valid datum bound to the current
// user exists — the server's active context, else the account-bound
// last-club marker written on a successful club entry) + «Elegir club»
// searchable picker; never an arbitrary club as the main access.
const ENTRY_LAST_CLUB_KEY_PREFIX = 'biq.entry.lastClub.';
const normEntryText = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
// Compact Chispa model, bundled from the module-local asset
// (app/src/assets/chispa-head-compact-v2.svg, sha256 1b1c51a6…e9c9 —
// pinned by tests/entry-selector.test.mjs). Module-local by design: this
// help action does not depend on shell-hosted asset resolution.
const CHISPA_HEAD_COMPACT_URI = `data:image/svg+xml,${encodeURIComponent(chispaHeadCompactSvg)}`;
const ENTRY_ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ENTRY_CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const ENTRY_TEAM_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 3 4 3 4-3 5 5-3 3-2-2v12H8V9l-2 2-3-3 5-5Z"/><path d="M10 12h4M12 10v6"/></svg>';
const ENTRY_CLUB_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 4 5v6c0 5 8 10 8 10s8-5 8-10V5l-8-3Z"/><path d="m9 11 2 2 4-4"/></svg>';
const ENTRY_PLUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

// ─── Main component ─────────────────────────────────────────────────────

class BiqOnboardApp extends HTMLElement {
  private shadow: ShadowRoot;
  private _org: OrgContext | null = null;
  private _user: string | null = null;
  // Declaraciones de hospedaje inyectadas por la carcasa (assign-only —
  // `declare` para no emitir un campo que pise lo inyectado):
  // shellHosted=true declara el hosting; requestLogout es el puente al
  // cierre de sesión canónico del shell (opcional en documentos viejos).
  declare shellHosted: boolean;
  declare requestLogout?: () => Promise<void> | void;
  // `el.remoteConfig` (ADR-009): la carcasa inyecta `{ baseUrl, token }` —
  // el token es la prueba de actor de contexto emitida para el módulo
  // `onboard`; biq-player la acepta con la cabecera `X-Biq-Module:
  // onboard` (`player.profile.manage` está registrada para onboard).
  declare remoteConfig: { baseUrl?: string; token?: string } | undefined;
  // `el.navReady` (pantalla de transición unificada, misión
  // 2026-10-24-unified-transition-screen): la carcasa lo inyecta al
  // montar; el módulo lo invoca UNA vez por destino cuando los datos
  // esenciales de la sub-ruta alcanzan un estado terminal renderizado.
  // Best-effort — sin carcasa/ticket la llamada es no-op.
  declare navReady?: (result: {
    state: 'content' | 'empty' | 'degraded' | 'blocked' | 'error';
  }) => unknown;
  // Test seam: base URL explícita del servicio biq-player (saltándose el
  // descubrimiento por /modules.json). '' = mismo origen.
  declare playerApiBase: string | undefined;
  // Working-context entry state (BIQ-PERSONAL-CLUB-CONTEXT)
  private _context: ContextDescriptor | null = null;
  private _bootstrap: BootstrapPayload | null = null;
  private _bootstrapLoading = false;
  private _bootstrapFailed = false;
  private _personalTeams: PersonalTeamRow[] | null = null;
  // OB60-3: the feed is a real state machine — 'uninitialized' means never
  // attempted (first load may trigger), 'loading' in flight, 'error' failed
  // (bounded — explicit retry only), 'ready' confirmed data (incl. empty).
  private _personalTeamsStatus: 'uninitialized' | 'loading' | 'error' | 'ready' = 'uninitialized';
  private _personalTeamsError: string | null = null;
  private _personalTeamsSeq = 0; // response fence — stale completions drop
  private _personalTeamsAbort: AbortController | null = null;
  private _editingPersonalTeamId: string | null = null;
  private _inviteToken = '';
  private _invitePreview: { club_id: string; club_name: string } | null = null;
  private _inviteLoading = false;
  private _helpOpen = false;
  // PD-CLUBS ≥3-club picker: open state + live search query. The query
  // persists across re-renders so a busy repaint never un-hides rows the
  // user already filtered out; row visibility is also mirrored in the DOM
  // without re-rendering so typing never loses focus.
  private _clubPickerOpen = false;
  private _clubPickerQuery = '';
  private _clubCreateOpen = false;
  private _teamCreateOpen = false;
  private _entryError: string | null = null;
  private _entryBusy = false;
  // Entry-login §4.2 — intent fencing. `gen` marks the entry scope: every
  // fresh bootstrap (first load, account change, re-entry through
  // #/onboard/spaces, explicit resync) bumps it, retiring the in-flight
  // intent and its continuations. `_entryIntent` is the single-flight
  // owner of `_entryBusy`; `_entryConfirmMs` bounds the post-emission
  // «Entrando…» wait (15 s default, field for test override).
  private _entryGen = 0;
  private _entryIntent: EntryIntent | null = null;
  private _entryIntentSeq = 0;
  private _entryRecovery: EntryRecovery | null = null;
  private _entryConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private _entryConfirmMs = 15000;
  private _subRoute = '';
  // navReady: último destino acreditado (`<subRoute>:<clubId>`) — una
  // señal por destino; entrar en otra pestaña habilita una emisión nueva.
  private _navReadySent = '';
  // Club cuya primera carga de tema ya resolvió — la reentrada en
  // caliente a Estilo/landing acredita sin esperar un refetch inexistente.
  private _themeReadyClub = '';
  private _identityColours: Record<string, { brand: string; alt: string }> = {};
  private _theme: ClubTheme | null = null;
  private _themeJob: ThemeJob | null = null;
  private _loading = false;
  private _error: string | null = null;
  // Club step (ADDENDUM-07 §6) per-card feedback
  private _stepError: { scope: 'join' | 'create'; message: string } | null = null;
  private _stepMessage = '';
  private _activeClubTab = '';
  private _clubSubmitLocked = false;
  private _clubSubmitSeq = 0;
  private _clubSubmitAbort: AbortController | null = null;
  // D20: typed field values survive re-renders (validation/error/loading).
  private _clubForm: { joinId: string; createName: string; createWebsite: string } = {
    joinId: '', createName: '', createWebsite: '',
  };
  // F2: stable per-submission idempotency key so a retry after a network
  // failure never creates a duplicate club. Regenerated per accepted attempt.
  private _createIdempotencyKey = '';
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _pollingClubId: string | null = null;
  private _pollBackoff = 3000; // C11: starts at 3s, backs off
  private _polling = false; // C11: prevent overlap
  // F5: Staleness timeout — if a theme_job has been pending/running for
  // longer than this threshold without a terminal callback, treat it as
  // stale and show the retry button. Cloud Tasks retries asynchronously
  // and may never reach a terminal state from the caller's perspective
  // (maxAttempts: 0 = unbounded retries). Without this, the UI hangs on
  // "Procesando…" indefinitely with no escape except a full page reload.
  private _pollStartedAt = 0; // timestamp (ms) when polling began
  private _staleThresholdMs = 180_000; // 3 minutes
  private _isStale = false;
  // F5: When true, suppress rendering of old theme data fetched by
  // loadThemeData() — the user triggered a new generation/retry and the
  // backend still returns the previous theme until the new job completes.
  private _awaitingNewJob = false;
  private _visibilityHandler: (() => void) | null = null; // C11: visibility handling
  // F12: Team catalog management
  private _teams: TeamRow[] = [];
  private _teamsLoading = false;
  private _teamsError: string | null = null;
  private _editingTeamId: string | null = null;
  // Edit-team modal draft: name/level are plain fields; the roster draft
  // holds raw strings so typing never needs a re-render (innerHTML would
  // wipe in-flight input values). Synced from the DOM before every
  // re-render/save.
  private _editNameDraft = '';
  // F-CL-3 club-team fields — only the club editor model carries them
  // (personal rosters have no category/gender contract). Select values:
  // '' = unset («Selecciona…»), cleared server-side on save.
  private _editCategoryDraft = '';
  private _editGenderDraft = '';
  private _editLevelDraft = '';
  // `existing` marca filas que venían persistidas al abrir el editor — un
  // nombre borrado sobre una fila persistida NUNCA es una baja implícita
  // (la baja solo la produce su acción explícita de quitar).
  // `player_id` (F-CL-3): stable club-roster identity carried through the
  // draft — edits keep it, a removed row drops it, a new row starts with
  // null and adopts the id the server returns on save. `birth_date` is the
  // biq-player profile field (PD-2) — see RosterDraftRow.
  private _rosterDraft: RosterDraftRow[] = [];
  // PD-2: per-player profile cache (player_id → {birth_date, revision}) as
  // last confirmed by biq-player; feeds the link-existing offer and the
  // post-save profile sync diff.
  private _playerProfiles: Record<string, { birth_date: string; revision: number }> = {};
  // biq-player service base URL — discovered once from the shell's
  // /modules.json (the `player` module entry origin). `undefined` =
  // unresolved, `null` = unavailable (standalone / unconfigured shell).
  // PD-2 «+ Añadir jugadora» offer — the link-existing chooser is open.
  private _addPlayerPickerOpen = false;
  // SF1: the loaded editor model + async load state. `_editSeq` fences
  // load/save completions (a stale response for a closed modal or a
  // changed context never paints); `_editFence` binds the open editor to
  // the context id+epoch+owner+team it was opened under.
  private _editModel: TeamEditorModel | null = null;
  private _editLoading = false;
  private _editSeq = 0;
  private _editFence = '';
  // Stored fingerprint of the last injected context descriptor — detects
  // a re-injected or in-place-mutated object that identity comparison
  // against `this._context` would miss (prev === value).
  private _contextFingerprint = '';
  // Save/validation errors render INSIDE the modal — the overlay is
  // z-index 1000, so the section-level _teamsError banner would sit behind
  // it invisible. Cleared on open/close/success.
  private _editError: string | null = null;
  // UX v2 autosave (TEAM-AUTOSAVE): sin «Guardar»/«Cancelar» — cada edición
  // encola un guardado con debounce ~600ms en una cadena serial; el chip
  // discreto es el único indicador (pendiente/guardando/guardado/error).
  // `_editSaveSeq`-style fencing lo dan `_editSeq`+`_editFence`: una
  // respuesta fuera de orden o de otra generación nunca libera ni altera
  // la operación nueva.
  private _editDirty = false;
  private _editSaveStatus: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict' = 'idle';
  private _editSaveMessage: string | null = null;
  // El innerHTML de render() suelta focusout sobre los inputs que destruye
  // — una pasada de sync sobre ese DOM moribundo resembraría filas que el
  // borrador ya eliminó (p. ej. quitar jugador). Mientras _paint corre, el
  // borrador es la única autoridad: sync no puede releer el DOM viejo.
  private _editDomFreeze = false;
  private _editSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private _editSaveChain: Promise<void> = Promise.resolve();
  private _editSaveQueued = false;
  private _editFlush: Promise<boolean> | null = null;
  private _editSavedChanges = false; // refrescar catálogos al salir, nunca con el editor abierto
  private _pendingRouteValue: string | null = null; // última intención de sub-ruta
  // Ownership de salidas (R2-D3-2): no booleanos globales — cada operación
  // lleva su propio token. Retirar el editor libera el token del trabajo
  // viejo para que la nueva operación no espere una petición colgada de la
  // anterior; el finally tardío solo lo suelta si sigue siendo el suyo.
  private _routeFlushOp: object | null = null;
  private _closingEditOp: object | null = null;
  // Grant de admisión ligado a la salida concreta: la carcasa pasa un token
  // a requestLeave y lo repite en commitLeave — un commit de una admisión
  // vieja nunca retira un editor abierto después en el mismo elemento.
  // `_admittedDraftJson` fija el estado del borrador EN la admisión: un
  // commit no cierra cambios tecleados tras la preparación — primero se
  // vacían, y solo se retira si el servidor confirma.
  private _admittedLeaveGrant: unknown = null;
  private _admittedDraftJson: string | null = null;
  private _admittedSeq = 0; // generación admitida — una reapertura la invalida
  // R2-D3-1: reconciliación de contenido tras 409/resultado incierto.
  // `_editSentSnapshot` es el payload JSON del último PUT despachado — si
  // la lectura de reconciliación lo encuentra ya persistido (ACK perdido),
  // no hay ningún PUT extra por el mismo snapshot. `_editNeedsReconcile`
  // bloquea todo reenvío automático hasta que la lectura decida.
  private _editSentSnapshot: string | null = null;
  private _editNeedsReconcile = false;
  private _editConflictServer: TeamEditorModel | null = null;
  // Set by the «Plantilla» row action and by «Añadir jugador»: focus lands
  // on the roster editor after the next render, then the flag clears.
  private _rosterFocus = false;
  // Deep-link intent from `#/onboard/teams?edit=<id>`: a pending request to
  // open the team edit modal once the catalogs finish loading. Cleared on
  // drain (success or not) — the modal never reopens on a later render.
  private _pendingEditTeamId: string | null = null;
  private _addingTeamCategory: string | null = null;
  private _teamsFilter: 'active' | 'all' = 'active';
  private _deleteConfirmTeamId: string | null = null;
  // Consolidated Equipos tab: self-scoped selection via /api/org/my-teams.
  // _myTeamsCatalog is the selectable universe (and its order); _teams is the
  // management feed (archived flag, competition level, seeding) loaded only
  // for ADMIN_ROLES — coaches/coordinators must never hit those endpoints.
  private _myTeamsCatalog: TeamRow[] = [];
  private _myTeamsLoaded = false;
  private _myTeamsLoading = false;
  private _myTeamsError: string | null = null;
  private _selectedIds = new Set<string>();
  private _confirmedSelected = new Set<string>();
  private _failedSelection: string[] | null = null; // last unsaved intent (retry)
  private _selectionStatus: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
  private _selectionSaveChain: Promise<void> = Promise.resolve();
  private _selectionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  // Deep link `teams?return=<route>` from the mandatory-selection gate.
  private _returnRoute = '';
  // F12: Team-catalog seeding job state (Club.team_seeding_job, Phase 1).
  private _teamSeedingJob: { status?: string; reason?: string | null } | null = null;
  private _seedingLoading = false; // reseed POST in-flight
  private _seedingStale = false; // polled past _staleThresholdMs without terminal state
  private _seedingPollTimer: ReturnType<typeof setTimeout> | null = null;
  private _seedingPolling = false; // prevent overlap
  private _seedingPollBackoff = 3000;
  private _seedingPollStartedAt = 0;
  private _seedingPollingClubId: string | null = null;
  // Mi Club Phase 4: Miembros tab — member roster + role assignments.
  private _members: MemberRow[] | null = null;
  private _memberAssignments: MemberAssignment[] | null = null;
  private _membersLoading = false;
  private _membersError: string | null = null;
  private _membersRequestId = 0;
  private _editingMemberId: string | null = null;
  private _deleteConfirmUserId: string | null = null;
  private _inviteState: { sending: boolean; error: string | null; sent: string | null } = {
    sending: false, error: null, sent: null,
  };
  // Mi Club Phase 3: club profile summary (Perfil tab).
  private _clubSummary: {
    club: { id: string; name: string; status: string };
    team_count: number;
    member_count: number;
    methodology_present: boolean | null;
    season_plan_present: boolean | null;
  } | null = null;
  private _clubSummaryLoading = false;
  private _clubSummaryError: string | null = null;
  // Watches body[data-shell-chrome] (global nav contract §2) so the section
  // subhead's sticky offset follows the shell chrome's shown/collapsed state.
  private _shellChromeObserver: MutationObserver | null = null;
  // UX v2: aviso beforeunload best-effort con autosave pendiente — nunca se
  // promete persistencia en cierre forzado (ni sendBeacon como garantía).
  private _beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    this.shadow.appendChild(styleEl);
    // Entry dialogs: Escape closes from any focus inside (the listener
    // lives on the host so re-renders never have to rewire it).
    this.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (this._clubPickerOpen) {
        ev.preventDefault();
        this._closeClubPicker();
      } else if (this._helpOpen) {
        ev.preventDefault();
        this._closeEntryHelp();
      }
    });
  }

  // Member-management gate — the server enforces F9 authorization; this is
  // defense-in-depth so unauthorized identities never even issue member
  // requests and never see a cached roster from a previous context.
  private _canManageMembers(): boolean {
    return ADMIN_ROLES.includes(this._org?.role || '');
  }

  // Drop every cached member-scope value and invalidate in-flight fetches.
  // Call BEFORE render on any club/session/role change — a previous context's
  // roster must never paint under the new one.
  private _clearMembersState(): void {
    this._members = null;
    this._memberAssignments = null;
    this._membersError = null;
    this._membersLoading = false;
    this._membersRequestId++; // invalidate any in-flight roster fetch
    this._editingMemberId = null;
    this._deleteConfirmUserId = null;
  }

  // Shell-injected properties (ADR-009)
  set org(value: OrgContext | null) {
    const prevClubId = this._org?.club?.id;
    const prevRole = this._org?.role || '';
    const newClubId = value?.club?.id;
    const newRole = value?.role || '';
    const clubChanged = newClubId !== prevClubId;
    const roleChanged = newRole !== prevRole;
    // Invalidate member scope BEFORE the first render under the new context:
    // club change (including logout/no-club) or ANY role change alters
    // member-management scope (e.g. administrator → sports_director keeps
    // ADMIN_ROLES but loses admin-tier edit rights) — the old roster,
    // assignments and edit/delete controls must be dropped synchronously and
    // in-flight reads invalidated; an async response guard cannot stop that
    // paint. A fresh fetch under the new tier repopulates below.
    if (clubChanged || roleChanged) {
      this._clearMembersState();
      // The club edit surface is org-scoped — a different club or a role
      // transition retires an open editor and its drafts synchronously.
      this._retireEditor();
    }
    this._org = value;
    this.render();
    // Only reload theme data when the club actually changes — prevents
    // infinite loop when shell refreshes org context after theme state event
    if (newClubId && clubChanged) {
      this.loadThemeData(newClubId);
      // Reset seeding state — the previous club's job must not leak across.
      this._teamSeedingJob = null;
      this._seedingStale = false;
      this._stopSeedingPolling();
      // Phase 3: club summary belongs to the previous club — drop it.
      this._clubSummary = null;
      this._clubSummaryError = null;
      // Consolidated Equipos: selection + management catalog are club-scoped.
      this._teams = [];
      this._teamsError = null;
      this._myTeamsCatalog = [];
      this._myTeamsLoaded = false;
      this._myTeamsError = null;
      this._selectedIds = new Set();
      this._confirmedSelected = new Set();
      this._failedSelection = null;
      this._selectionStatus = 'idle';
    }
    // F12: If the shell deep-linked straight to the Equipos route, the tab
    // renders before any nav click — load the catalog on org arrival too.
    // Role-aware: managers also pull the management feed; pickers/read-only
    // roles only ever call the self-scoped /api/org/my-teams.
    if (newClubId && this._subRoute === 'teams') {
      this._ensureTeamsData(newClubId);
    }
    // Phase 3: same for the Perfil club summary.
    if (newClubId && this._subRoute === 'profile' && !this._clubSummary && !this._clubSummaryLoading) {
      this.loadClubSummary(newClubId);
    }
    // Phase 4: same for the Miembros roster.
    if (newClubId && this._subRoute === 'members') {
      this._ensureMembersData(newClubId);
    }
  }
  get org(): OrgContext | null { return this._org; }

  set user(value: string | null) {
    const changed = value !== this._user;
    if (changed) {
      // User/session scope changed — the previous subject's roster and
      // role assignments must not survive into the new context.
      this._clearMembersState();
      // Personal teams are account-scoped too: abort the in-flight feed,
      // drop loaded/error state and close any open editor from the
      // previous account. A still-pending ?edit= intent survives — the
      // drain is fail-closed against the freshly reloaded feed, so a
      // foreign team id can never open; clearing it here would kill
      // deep links that land before the session attribute is set.
      this._resetPersonalFeed();
      this._editingPersonalTeamId = null;
      this._retireEditor();
      // Entry scope belongs to the principal too: a different account
      // retires the in-flight intent, its busy hold and the bootstrap
      // projection — the new scope refetches on the next render. The
      // null→user first bind has no prior scope to retire.
      if (this._user !== null) this._invalidateEntryScope();
    }
    this._user = value;
    this.render();
    if (changed && this._subRoute === 'members') {
      const clubId = this._org?.club?.id;
      if (clubId) this._ensureMembersData(clubId);
    }
  }
  get user(): string | null { return this._user; }

  // Working context (BIQ-PERSONAL-CLUB-CONTEXT): the shell injects the
  // active-context descriptor before connecting the element.
  set context(value: ContextDescriptor | null) {
    // Fingerprint the whole authoritative identity — a re-injected or
    // in-place-mutated descriptor must still retire the editor (comparing
    // `value` against `this._context` misses same-object mutation).
    const fp = value
      ? JSON.stringify([
          value.context_id, value.context_epoch, value.owner_scope ?? null,
          value.team_ids ?? [], value.working_team_ids ?? [],
          value.active_team_id ?? null, value.status ?? null,
        ])
      : '';
    const scopeChanged = fp !== this._contextFingerprint;
    this._contextFingerprint = fp;
    this._context = value;
    if (scopeChanged) {
      // Scope/logout/epoch/working-set moved — any in-flight editor load
      // or save response is stale for the new scope; drop it plus drafts.
      this._retireEditor();
    }
    // A pending spaces?edit intent gated on context knowledge drains now
    // that the scope is known (forward to the canonical editor route).
    if (this._pendingEditTeamId && this._subRoute === 'spaces') {
      this._maybeOpenPendingPersonalEdit();
    }
    this.render();
  }
  get context(): ContextDescriptor | null { return this._context; }

  // Bootstrap the entry surface: decides whether this module renders the
  // context entry selector or the legacy club step. A failed/absent
  // endpoint means the context feature is off — legacy path preserved.
  private async loadBootstrap(): Promise<void> {
    if (this._bootstrapLoading || this._bootstrap || this._bootstrapFailed) return;
    this._bootstrapLoading = true;
    // Every fresh bootstrap opens a new entry scope: the generation bump
    // retires in-flight intents and fences this fetch's own continuations
    // (a response that lands after an account switch or a resync paints
    // nothing and releases nothing).
    const gen = (this._entryGen += 1);
    const current = () => gen === this._entryGen && this.isConnected;
    try {
      const res = await fetch('/api/context/v1/bootstrap', { credentials: 'include', cache: 'no-store' });
      if (!current()) return;
      if (!res.ok) { this._bootstrapFailed = true; return; }
      const data = await res.json().catch(() => null);
      if (!current()) return;
      if (!data || typeof data.state !== 'string') { this._bootstrapFailed = true; return; }
      this._bootstrap = data as BootstrapPayload;
      // Mi equipo lists the account's private teams — prefetch only when
      // this session actually holds personal authority. A member-scope
      // credential is denied the endpoint outright (403 by design), so a
      // guaranteed-rejected fetch would only produce a console error and
      // a retry control that can never succeed.
      if (this._personalReadAllowed()) this.loadPersonalTeams();
    } catch (err) {
      if (current()) this._bootstrapFailed = true;
    } finally {
      if (current()) {
        this._bootstrapLoading = false;
        this.render();
        this._maybeSpacesNavReady();
      }
    }
  }

  // Drop every cached feed value, invalidate in-flight fetches and abort
  // the pending request — on account switch or disconnect nothing from the
  // previous scope may complete into the new one.
  private _resetPersonalFeed(): void {
    this._personalTeamsSeq += 1;
    if (this._personalTeamsAbort) {
      this._personalTeamsAbort.abort();
      this._personalTeamsAbort = null;
    }
    this._personalTeams = null;
    this._personalTeamsStatus = 'uninitialized';
    this._personalTeamsError = null;
  }

  // Personal-authority gate (R1): GET /personal-teams requires a verified
  // or account-scope session — member credentials are denied (403) even
  // before a context is activated. The bootstrap already advertises that
  // verdict (`entry_actions['personal.team.read'].allowed === false`, the
  // personal candidate marked requires_verification). When no bootstrap is
  // loaded the caller is the personal panel under an ACTIVE personal
  // context — authority is already proven, so the read is allowed.
  private _personalReadAllowed(): boolean {
    const boot = this._bootstrap;
    if (!boot) return true;
    const read = boot.entry_actions?.['personal.team.read'];
    if (read && typeof read.allowed === 'boolean') return read.allowed;
    const personal = (boot.contexts || []).find((c) => c.kind === 'personal');
    return personal ? personal.requires_verification !== true : true;
  }

  // ─── SF1 §5: context-bound team-editor ports ──────────────────────────
  // The adapter is selected from the authoritative working context —
  // `_context.owner_scope.kind` as injected by the shell — never from the
  // route, a UI mode string or a caller-supplied owner field.

  private _isPersonalContext(): boolean {
    return this._context?.owner_scope?.kind === 'personal';
  }

  // Operation-scope identity for the shared editor: principal, org
  // identity+role, the complete owner union, context epoch, working set,
  // active team and the target team. Any transition of ANY component
  // retires in-flight load/save completions — a late response can never
  // paint or close the new generation's editor.
  private _editFenceNow(teamId: string): string {
    const c = this._context;
    return [
      this._user ?? '',
      this._org?.club?.id ?? '',
      this._org?.role ?? '',
      c?.context_id ?? '',
      c?.context_epoch ?? '',
      JSON.stringify(c?.owner_scope ?? null),
      (c?.working_team_ids ?? []).join(','),
      c?.active_team_id ?? '',
      teamId,
    ].join('|');
  }

  private _retireEditor(): void {
    this._editSeq += 1;
    this._editModel = null;
    this._editLoading = false;
    this._editingTeamId = null;
    this._editNameDraft = '';
    this._editCategoryDraft = '';
    this._editGenderDraft = '';
    this._editLevelDraft = '';
    this._rosterDraft = [];
    this._addPlayerPickerOpen = false;
    this._editError = null;
    this._editFence = '';
    this._rosterFocus = false;
    // Purga de autosave: un cambio de principal/contexto nunca arrastra el
    // borrador ni deja mutaciones en cola — la cadena reiniciada suelta las
    // tareas pendientes y el seq bump entierra la respuesta en vuelo.
    if (this._editSaveTimer) {
      clearTimeout(this._editSaveTimer);
      this._editSaveTimer = null;
    }
    this._editSaveChain = Promise.resolve();
    this._editSaveQueued = false;
    this._editDirty = false;
    this._editSaveStatus = 'idle';
    this._editSaveMessage = null;
    this._editFlush = null;
    this._editSavedChanges = false;
    // El retiro libera los tokens de las operaciones colgadas del editor
    // viejo (Volver/flush de ruta que nunca resolvieron) — la siguiente
    // operación no espera a una petición de un editor muerto.
    this._routeFlushOp = null;
    this._closingEditOp = null;
    this._admittedLeaveGrant = null;
    this._admittedDraftJson = null;
    this._editSentSnapshot = null;
    this._editNeedsReconcile = false;
    this._editConflictServer = null;
  }

  private _teamEditorPort(): TeamEditorPort {
    return this._isPersonalContext()
      ? this._personalTeamEditorPort()
      : this._clubTeamEditorPort();
  }

  private _clubTeamEditorPort(): TeamEditorPort {
    const clubId = this._org?.club?.id || '';
    return {
      load: async (teamId) => {
        // Only a confirmed roster-bearing management read is editable:
        // the self-scoped /api/org/my-teams projection omits players by
        // design — treating a metadata row as an empty roster would make
        // Save send players:[] under full-replace semantics and erase
        // the real roster. Missing players = unavailable, never a
        // known-empty draft; only an explicit players:[] opens empty.
        const t = this._teams.find((r) => r.id === teamId);
        if (t && Array.isArray(t.players)) {
          const players: RosterPlayer[] = [];
          for (const p of t.players as unknown[]) {
            const row = p as Record<string, unknown> | null;
            if (!row || typeof row.name !== 'string') {
              return { kind: 'unavailable', message: 'Respuesta de plantilla inválida' };
            }
            const n = row.number;
            if (
              n !== null && n !== undefined &&
              (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 99)
            ) {
              return { kind: 'unavailable', message: 'Respuesta de plantilla inválida' };
            }
            const pid = row.player_id;
            if (
              pid !== null && pid !== undefined &&
              (typeof pid !== 'string' || !/^pl_[0-9a-f]{16}$/.test(pid))
            ) {
              return { kind: 'unavailable', message: 'Respuesta de plantilla inválida' };
            }
            players.push({ name: row.name, number: n ?? null, player_id: pid ?? null });
          }
          return {
            kind: 'ok',
            model: {
              id: t.id,
              name: t.name,
              category: t.category,
              gender: t.gender,
              competitive_level: t.competitive_level ?? '',
              players,
              version: null,
              permissions: { read: true, edit: true },
            },
          };
        }
        if (t || this._myTeamsCatalog.some((r) => r.id === teamId)) {
          // Known team, unconfirmed roster — the management feed failed
          // or returned a metadata row. Unavailable, not empty.
          return { kind: 'unavailable', message: 'No se pudo cargar la plantilla' };
        }
        return { kind: 'not-found' };
      },
      save: async (teamId, draft) => {
        let res: Response;
        try {
          res = await fetch(`/api/clubs/${clubId}/teams/${teamId}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draft),
          });
        } catch {
          return { kind: 'unavailable', message: 'No se pudo guardar el equipo' };
        }
        if (res.status === 403) return { kind: 'denied' };
        if (res.status === 404) return { kind: 'not-found' };
        if (!res.ok) return { kind: 'unavailable', message: `HTTP ${res.status}` };
        // The PUT response echoes the canonical team — rebuild the model
        // from it so the draft adopts server-assigned player_id values
        // (F-CL-3). A malformed echo is 'unavailable', not a silent echo
        // of the sent draft: reconciliation reloads the truth.
        const data = await res.json().catch(() => null);
        const team = (data as Record<string, unknown> | null)?.team as
          Record<string, unknown> | null | undefined;
        if (!team || typeof team.name !== 'string' || !Array.isArray(team.players)) {
          return { kind: 'unavailable', message: 'Respuesta inválida tras guardar' };
        }
        const players: RosterPlayer[] = [];
        for (const p of team.players as unknown[]) {
          const row = p as Record<string, unknown> | null;
          if (!row || typeof row.name !== 'string') {
            return { kind: 'unavailable', message: 'Respuesta inválida tras guardar' };
          }
          const n = row.number;
          if (
            n !== null && n !== undefined &&
            (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 99)
          ) {
            return { kind: 'unavailable', message: 'Respuesta inválida tras guardar' };
          }
          const pid = row.player_id;
          if (
            pid !== null && pid !== undefined &&
            (typeof pid !== 'string' || !/^pl_[0-9a-f]{16}$/.test(pid))
          ) {
            return { kind: 'unavailable', message: 'Respuesta inválida tras guardar' };
          }
          players.push({ name: row.name, number: n ?? null, player_id: pid ?? null });
        }
        return {
          kind: 'saved',
          model: {
            id: teamId,
            name: team.name,
            category: typeof team.category === 'string' ? team.category : null,
            gender: typeof team.gender === 'string' ? team.gender : null,
            competitive_level:
              typeof team.competitive_level === 'string' ? team.competitive_level : '',
            players,
            version: null,
            permissions: { read: true, edit: true },
          },
        };
      },
    };
  }

  // Own-workspace roster API (SF1 §4): GET/PUT
  // /api/context/v1/personal-teams/{id}/roster — the server derives the
  // workspace/account from the live personal context; the wire shape is
  // the editor contract verbatim plus the team_revision CAS.
  private _personalTeamEditorPort(): TeamEditorPort {
    const url = (teamId: string) =>
      `/api/context/v1/personal-teams/${encodeURIComponent(teamId)}/roster`;
    // Echo validation (SF1 review A3): a well-shaped response for the
    // WRONG team, context, epoch or owner must never populate a live
    // editor. Every envelope field is checked against the currently
    // authorized descriptor before a model exists — no coercion.
    const toModel = (data: unknown, teamId: string): TeamEditorModel | null => {
      const body = data as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return null;
      const ctx = this._context;
      if (body.schema_version !== '1.0') return null;
      if (body.context_id !== ctx?.context_id) return null;
      if (body.context_epoch !== ctx?.context_epoch) return null;
      const owner = body.owner_scope as Record<string, unknown> | null;
      const expected = ctx?.owner_scope;
      if (
        !owner || !expected ||
        owner.kind !== expected.kind ||
        owner.workspace_id !== expected.workspace_id ||
        owner.account_id !== expected.account_id
      ) {
        return null;
      }
      const t = body.team as Record<string, unknown> | null;
      if (!t || typeof t !== 'object') return null;
      if (t.id !== teamId || typeof t.name !== 'string') return null;
      if (typeof t.competitive_level !== 'string') return null;
      if (
        typeof t.team_revision !== 'number' ||
        !Number.isSafeInteger(t.team_revision) ||
        t.team_revision <= 0
      ) {
        return null;
      }
      if (!Array.isArray(t.players)) return null;
      const players: RosterPlayer[] = [];
      for (const p of t.players as unknown[]) {
        const row = p as Record<string, unknown> | null;
        if (!row || typeof row.name !== 'string') return null;
        const n = row.number;
        if (
          n !== null &&
          (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 99)
        ) {
          return null;
        }
        // Scouting identity (F-CL-3): when the own-workspace API serves a
        // row id, the editor carries it so the PUT preserves it — ''/null/
        // absent all mean "no id yet" (server-side ensure/backfill assigns
        // them on write; the client never mints ids).
        const pid = row.player_id;
        if (
          pid !== null && pid !== undefined && pid !== '' &&
          (typeof pid !== 'string' || !/^pl_[0-9a-f]{16}$/.test(pid))
        ) {
          return null;
        }
        players.push({
          name: row.name,
          number: n as number | null,
          player_id: typeof pid === 'string' && pid ? pid : null,
        });
      }
      // GET success is not edit authority: the server intentionally serves
      // reads for an own team outside the working set. Only working-set
      // membership makes the draft writable.
      const writable = (ctx?.working_team_ids ?? []).includes(teamId);
      return {
        id: t.id,
        name: t.name,
        competitive_level: t.competitive_level,
        players,
        version: t.team_revision,
        permissions: { read: true, edit: writable },
      };
    };
    return {
      load: async (teamId) => {
        let res: Response;
        try {
          res = await fetch(url(teamId), {
            credentials: 'include',
            cache: 'no-store',
          });
        } catch {
          return { kind: 'unavailable', message: 'No se pudo cargar la plantilla' };
        }
        if (res.status === 403) return { kind: 'denied' };
        if (res.status === 404) return { kind: 'not-found' };
        if (!res.ok) {
          return { kind: 'unavailable', message: `No se pudo cargar la plantilla (${res.status})` };
        }
        const model = toModel(await res.json().catch(() => null), teamId);
        return model
          ? { kind: 'ok', model }
          : { kind: 'unavailable', message: 'Respuesta de plantilla inválida' };
      },
      save: async (teamId, draft, version) => {
        let res: Response;
        try {
          res = await fetch(url(teamId), {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expected_revision: version ?? 0,
              name: draft.name,
              competitive_level: draft.competitive_level,
              // F-CL-3 identity preservation: a row id the read served is
              // echoed back verbatim — stripping it would orphan the
              // scouting identity on every edit. Rows without one send no
              // `player_id` key at all (the server assigns/backfills it;
              // the client never mints ids).
              players: draft.players.map((p) => {
                const row: { name: string; number: number | null; player_id?: string } = {
                  name: p.name,
                  number: p.number,
                };
                if (p.player_id) row.player_id = p.player_id;
                return row;
              }),
            }),
          });
        } catch {
          return { kind: 'unavailable', message: 'No se pudo guardar la plantilla' };
        }
        if (res.status === 409) return { kind: 'conflict' };
        if (res.status === 403) return { kind: 'denied' };
        if (res.status === 404) return { kind: 'not-found' };
        if (!res.ok) {
          return { kind: 'unavailable', message: `No se pudo guardar la plantilla (${res.status})` };
        }
        const model = toModel(await res.json().catch(() => null), teamId);
        return model
          ? { kind: 'saved', model }
          : { kind: 'unavailable', message: 'Respuesta de plantilla inválida' };
      },
    };
  }

  // ─── biq-player profiles (F-CL-3/PD-2: birth dates) ──────────────────
  // Minors' personal data live in biq-player `player_profiles/{player_id}`,
  // never on the team record or in `el.org`. The editor talks to
  // `/api/player/v1/players/{id}/profile` directly with the onboard context
  // actor token (`X-Biq-Module: onboard`; `player.profile.manage` is an
  // onboard-registered action). Every failure is typed as "unavailable" —
  // a profile that could not be read is unknown, never empty.

  // Base URL del servicio biq-player: la pasarela same-origin
  // `/api/m/player` (2026-10-26-module-gateway) — sin descubrimiento en
  // /modules.json ni llamada cross-origin. `playerApiBase` override en
  // tests/standalone.
  private async _playerApiBase(): Promise<string | null> {
    if (this.playerApiBase !== undefined) return this.playerApiBase;
    return '/api/m/player';
  }

  private _playerHeaders(): Record<string, string> | null {
    // Pasarela: sin Bearer — la pasarela acuña la credencial de onboard;
    // X-Biq-Module conserva la audiencia onboard en biq-player y el
    // contexto declarado liga la petición al descriptor vigente.
    const headers: Record<string, string> = {
      'X-Biq-Module': 'onboard',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this._context?.context_id) {
      headers['X-BIQ-Context-Id'] = this._context.context_id;
      headers['X-BIQ-Context-Epoch'] = String(this._context.context_epoch ?? '');
    }
    return headers;
  }

  // null = unavailable/unknown — the profile is never treated as empty.
  private async _fetchPlayerProfile(
    teamId: string,
    playerId: string,
  ): Promise<{ birth_date: string; revision: number } | null> {
    const headers = this._playerHeaders();
    if (!headers) return null;
    const base = await this._playerApiBase();
    if (base === null) return null;
    try {
      const res = await fetch(
        `${base}/api/player/v1/players/${encodeURIComponent(playerId)}/profile?team_id=${encodeURIComponent(teamId)}`,
        { headers, cache: 'no-store' },
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') return null;
      const rev = data.revision;
      return {
        birth_date: typeof data.birth_date === 'string' ? data.birth_date : '',
        revision: typeof rev === 'number' && Number.isInteger(rev) ? rev : 0,
      };
    } catch {
      return null;
    }
  }

  // Persist one row's birth date via the profile API. Returns false on any
  // failure (unconfigured service, transport, 4xx/5xx, CAS conflict) — the
  // caller reports it as a pending change, never as saved.
  private async _writePlayerBirthDate(
    teamId: string,
    playerId: string,
    birthDate: string,
  ): Promise<boolean> {
    const headers = this._playerHeaders();
    if (!headers) return false;
    const base = await this._playerApiBase();
    if (base === null) return false;
    const path =
      `${base}/api/player/v1/players/${encodeURIComponent(playerId)}/profile` +
      `?team_id=${encodeURIComponent(teamId)}`;
    try {
      // Fresh read for the CAS revision — a stale expected_revision would
      // conflict on every save after the first.
      const current = await this._fetchPlayerProfile(teamId, playerId);
      if (!current) return false;
      if (current.birth_date === birthDate) {
        this._playerProfiles[playerId] = current;
        return true;
      }
      const res = await fetch(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          birth_date: birthDate || null,
          expected_revision: current.revision,
        }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      const rev = data?.revision;
      this._playerProfiles[playerId] = {
        birth_date: birthDate,
        revision: typeof rev === 'number' && Number.isInteger(rev) ? rev : current.revision + 1,
      };
      return true;
    } catch {
      return false;
    }
  }

  // Lazily fills `birth_date` on draft rows that carry a player_id. Runs
  // after the editor model lands (and after conflict/reconcile adoptions);
  // stale generations and moved rows drop their result. A typed value is
  // never overwritten — only untouched empty fields are filled.
  private async _loadPlayerProfiles(teamId: string, seq: number): Promise<void> {
    const rows = this._rosterDraft;
    await Promise.all(rows.map(async (row, i) => {
      if (!row.player_id) return;
      const pid = row.player_id;
      const profile = await this._fetchPlayerProfile(teamId, pid);
      if (seq !== this._editSeq || this._editingTeamId !== teamId) return;
      const live = this._rosterDraft[i];
      if (!live || live.player_id !== pid) return;
      if (!profile) return; // unknown stays unknown — never an empty fill
      this._playerProfiles[pid] = profile;
      live.birth_loaded = true;
      if (!live.birth_dirty && !live.birth_date && profile.birth_date) {
        live.birth_date = profile.birth_date;
        const input = this.shadow.querySelector(
          `[data-player-birth="${i}"]`,
        ) as HTMLInputElement | null;
        if (input) input.value = profile.birth_date;
      }
    }));
  }

  // Lazy fill for a just-linked player: reads her profile against the
  // team she was linked FROM (the profile read is team-scoped in
  // biq-player). A failure leaves the field unknown — never a write.
  private async _fillLinkedBirthDate(playerId: string, fromTeamId: string): Promise<void> {
    const profile = await this._fetchPlayerProfile(fromTeamId, playerId);
    if (!profile) return;
    this._playerProfiles[playerId] = profile;
    const i = this._rosterDraft.findIndex((r) => r.player_id === playerId);
    if (i < 0) return;
    const row = this._rosterDraft[i];
    row.birth_loaded = true;
    if (!row.birth_dirty && !row.birth_date && profile.birth_date) {
      row.birth_date = profile.birth_date;
      const input = this.shadow.querySelector(
        `[data-player-birth="${i}"]`,
      ) as HTMLInputElement | null;
      if (input) input.value = profile.birth_date;
    }
  }

  // Post-save profile sync: writes every birth_date the user edited on
  // rows that already hold a player_id (a fresh row adopts its id from the
  // roster save that just landed). Returns the number of failed writes —
  // they stay `birth_dirty` so the next pass retries them.
  private async _syncPlayerBirthDates(
    owner: { teamId: string | null; seq: number; fence: string },
  ): Promise<number> {
    const teamId = owner.teamId;
    if (!teamId || !this._editModel || this._editModel.category === undefined) {
      return 0; // personal rosters have no profile channel
    }
    let failed = 0;
    for (const row of this._rosterDraft) {
      if (!this._isEditOwner(owner)) return failed;
      if (!row.player_id || !row.birth_dirty) continue;
      const ok = await this._writePlayerBirthDate(teamId, row.player_id, row.birth_date.trim());
      if (!this._isEditOwner(owner)) return failed;
      if (ok) {
        row.birth_dirty = false;
      } else {
        failed += 1;
      }
    }
    return failed;
  }

  private async loadPersonalTeams(): Promise<void> {
    if (!this._personalReadAllowed()) return;
    if (this._personalTeamsStatus === 'loading') return;
    this._personalTeamsStatus = 'loading';
    this._personalTeamsError = null;
    const seq = ++this._personalTeamsSeq;
    this._personalTeamsAbort?.abort();
    const controller = new AbortController();
    this._personalTeamsAbort = controller;
    const isCurrent = () => seq === this._personalTeamsSeq;
    try {
      const res = await fetch('/api/context/v1/personal-teams', {
        credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (!isCurrent()) return; // stale/aborted response — drop it
      const teams = res.ok ? this._validPersonalTeams(data) : null;
      if (res.ok && teams !== null) {
        this._personalTeams = teams;
        this._personalTeamsStatus = 'ready';
      } else {
        // Non-OK status AND malformed payloads both land here — a broken
        // feed is an error, never a healthy empty roster.
        this._personalTeams = null;
        this._personalTeamsStatus = 'error';
        this._personalTeamsError = res.ok
          ? 'Respuesta de equipos inválida'
          : `No se pudieron cargar los equipos (${res.status})`;
      }
    } catch (err) {
      if (!isCurrent()) return;
      this._personalTeams = null;
      this._personalTeamsStatus = 'error';
      this._personalTeamsError = 'No se pudieron cargar los equipos';
    } finally {
      if (isCurrent()) {
        if (this._personalTeamsAbort === controller) this._personalTeamsAbort = null;
        this._maybeOpenPendingPersonalEdit();
        this._maybeOpenPendingEdit();
        this.render();
        this._maybeTeamsNavReady();
        this._maybeSpacesNavReady();
      }
    }
  }

  // Fail-closed row validation (OB60-3): the WHOLE collection must be
  // well-formed before `ready` — a single corrupt row ({teams:[null]},
  // missing ids, wrong types, duplicate identities) means the feed itself
  // is untrustworthy, never a reason to filter rows into a "healthy" list.
  // Legitimate empty arrays stay ready/empty.
  private _validPersonalTeams(data: unknown): PersonalTeamRow[] | null {
    const rows = (data as { teams?: unknown } | null)?.teams;
    if (!Array.isArray(rows)) return null;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const t = row as Record<string, unknown>;
      if (typeof t.team_id !== 'string' || !t.team_id.trim()) return null;
      if (ids.has(t.team_id)) return null;
      ids.add(t.team_id);
      // `archived` drives the active/archived split and the edit drain;
      // `team_revision` is the CAS input for edits — both must be real.
      if (typeof t.archived !== 'boolean') return null;
      if (typeof t.team_revision !== 'number' || !Number.isFinite(t.team_revision)) return null;
      for (const key of [
        'name', 'category_key', 'category_label', 'age_band',
        'gender', 'section_applicability', 'timezone', 'season',
      ] as const) {
        if (typeof t[key] !== 'string') return null;
      }
    }
    return rows as PersonalTeamRow[];
  }

  // Drains `?edit=<id>` on the spaces route — SF1: the legacy personal
  // edit deep link forwards to the CANONICAL shared-editor route
  // `#/onboard/teams?edit=<id>` under an active personal context (same
  // renderer/adapter as the footer «Plantilla» action — never the old
  // name/category/gender-only form). Without personal context the intent
  // is consumed silently: the selector has no edit surface.
  private _maybeOpenPendingPersonalEdit(): void {
    const teamId = this._pendingEditTeamId;
    if (!teamId || this._subRoute !== 'spaces') return;
    if (this._isPersonalContext()) {
      // Under an active personal context the alias reaches the canonical
      // shared-editor route — same surface the footer «Plantilla» targets.
      const hash = window.location.hash || '';
      const qIdx = hash.indexOf('?');
      const params = qIdx >= 0
        ? new URLSearchParams(hash.slice(qIdx + 1))
        : new URLSearchParams();
      params.set('edit', teamId);
      history.replaceState(null, '', `#/onboard/teams?${params.toString()}`);
      this._subRoute = 'teams';
      this._reportAppliedRoute();
      this._maybeOpenPendingEdit();
      return;
    }
    if (this._context) {
      // A confirmed non-personal context has no personal edit surface —
      // consume the intent rather than leaving it lingering.
      this._pendingEditTeamId = null;
      return;
    }
    // No context yet — the shell injects it before connecting; a servable
    // id waits. A confirmed-dead intent (unknown/archived id once the feed
    // settles) is still consumed once, never left lingering.
    if (this._personalTeamsStatus === 'loading') return;
    if (this._personalTeams === null) {
      if (this._personalTeamsStatus === 'uninitialized') this.loadPersonalTeams();
      return;
    }
    const row = this._personalTeams.find((t) => t.team_id === teamId);
    if (!row || row.archived) this._pendingEditTeamId = null;
  }

  // ─── Entry intent engine (entry-login §4.2) ───────────────────────────
  // A click freezes an EntryIntent (generation, account, kind, club/team).
  // One intent in flight: further clicks are ignored. Every async
  // continuation re-checks `isConnected`, the generation and the intent
  // identity — a stale completion paints nothing, emits nothing and
  // releases nothing. Only the owning intent releases the busy state, and
  // create→enter / redeem→activate chains run inside ONE intent scope.

  private _invalidateEntryScope(): void {
    this._entryGen += 1;
    // Invalidar el scope retira cualquier ticket no cedido aún.
    try {
      this._entryIntent?.navTicket?.close();
    } catch { /* sin ticket */ }
    this._entryIntent = null;
    this._entryBusy = false;
    this._entryRecovery = null;
    this._entryError = null;
    if (this._entryConfirmTimer) {
      clearTimeout(this._entryConfirmTimer);
      this._entryConfirmTimer = null;
    }
    this._bootstrap = null;
    this._bootstrapFailed = false;
    this._bootstrapLoading = false;
  }

  // Bounded resync: drop the cached projection and refetch bootstrap.
  // Recovery state is preserved — the resync reflects server truth while
  // the recovery actions remain available (entry-login §4.2).
  private _resyncBootstrap(): void {
    this._invalidateEntryScope();
    this._resetPersonalFeed();
    if (this.isConnected) this.render();
  }

  private _beginEntryIntent(
    kind: EntryIntent['kind'],
    extra: { club_id?: string; team_id?: string } = {},
  ): EntryIntent | null {
    if (this._entryIntent) return null; // single flight — double clicks deduped
    const intent: EntryIntent = {
      id: (this._entryIntentSeq += 1),
      gen: this._entryGen,
      account_id: this._bootstrap?.account_id || '',
      kind,
      emitted: false,
      mutated: false,
      ...extra,
    };
    this._entryIntent = intent;
    this._entryBusy = true;
    this._entryError = null;
    this._entryRecovery = null;
    // Pantalla única de transición (T1): la carcasa cubre el selector
    // desde la admisión del gesto hasta que Inicio acredita readiness.
    // Null = carcasa antigua o sin productor — el flujo legacy no cambia.
    try {
      intent.navTicket =
        (
          this as unknown as {
            navBegin?: (spec: unknown) => { id: string; close: () => boolean } | null;
          }
        ).navBegin?.({
          journey: 't1',
          target: {
            module: 'home',
            kind,
            club_id: extra.club_id,
            team_id: extra.team_id,
          },
        }) ?? null;
    } catch {
      intent.navTicket = null;
    }
    // An entry mutation dismisses the club picker — a failure surfaces on
    // the main screen where the error and recovery affordances live.
    this._clubPickerOpen = false;
    this.render();
    return intent;
  }

  private _intentCurrent(intent: EntryIntent): boolean {
    return (
      this.isConnected &&
      this._entryIntent === intent &&
      intent.gen === this._entryGen &&
      (this._bootstrap?.account_id || '') === intent.account_id
    );
  }

  // Only the owner releases — a stale intent's finally is a no-op here.
  private _finishEntryIntent(intent: EntryIntent): void {
    if (this._entryIntent !== intent) return;
    this._entryIntent = null;
    this._entryBusy = false;
  }

  private _intentAccess(): 'personal' | 'club' | null {
    const kind = this._entryIntent?.kind;
    if (!kind) return null;
    return kind === 'club' || kind === 'create-club' || kind === 'redeem' ? 'club' : 'personal';
  }

  private async _entryMutation(
    url: string,
    payload: unknown,
    method: 'POST' | 'PUT' = 'POST',
    idempotencyKey?: string,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // The mutation may have been sent — never auto-retried; the caller
      // surfaces the uncertain-transport recovery instead.
      throw new EntryUncertainTransport();
    }
  }

  private async _postActivate(kind: 'personal' | 'club', clubId?: string): Promise<void> {
    const res = await this._entryMutation(
      '/api/context/v1/activate',
      clubId ? { kind, club_id: clubId } : { kind },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `No se pudo activar el contexto (${res.status})`);
    }
  }

  private async _putWorkingTeams(teamId: string): Promise<void> {
    const res = await this._entryMutation(
      '/api/context/v1/active/working-teams',
      { working_team_ids: [teamId] },
      'PUT',
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new EntryNarrowingFailure(
        teamId,
        body?.detail || `No se pudo seleccionar el equipo (${res.status})`,
      );
    }
  }

  private _emitActivated(intent: EntryIntent): void {
    intent.emitted = true;
    // El ticket pasa a la carcasa: una vez emitida la activación, el
    // desmontaje de este elemento no debe cerrar la pantalla de
    // transición — la cierra el productor destino (navReady) o la propia
    // carcasa. Seguimos guardando la referencia solo para el camino de
    // recuperación «No se pudo confirmar la entrada».
    const ceded = intent.navTicket ?? null;
    intent.navTicket = null;
    // PD-CLUBS «Club reciente»: a successful club entry is the datum that
    // feeds the main access on the next visit — stored per account, only
    // ever honored while the club still appears in the entry feed.
    if (this._intentAccess() === 'club' && intent.club_id) {
      this._writeLastClub(intent.club_id);
    }
    // Same event contract as before; the detail is additive — the shell
    // must not depend on it.
    this.dispatchEvent(
      new CustomEvent('biq-context:activated', {
        bubbles: true,
        composed: true,
        detail: {
          kind: this._intentAccess(),
          club_id: intent.club_id ?? null,
          team_id: intent.team_id ?? null,
        },
      }),
    );
    this.render(); // busy stays «Entrando…» until unmount, fresh bootstrap or the bounded wait
    this._entryConfirmTimer = setTimeout(() => {
      this._entryConfirmTimer = null;
      if (!this._intentCurrent(intent)) return;
      // La activación nunca se confirmó: retiramos la transición cedida
      // para que la recuperación del selector no quede oculta bajo ella.
      // close() es idempotente — no-op si el destino ya publicó navReady.
      try {
        ceded?.close();
      } catch { /* ticket ya cerrado o carcasa ausente */ }
      this._finishEntryIntent(intent);
      this._entryRecovery = { kind: 'confirm', message: 'No se pudo confirmar la entrada' };
      this.render();
    }, this._entryConfirmMs);
  }

  private _runEntryIntent(intent: EntryIntent, work: () => Promise<void>): void {
    void (async () => {
      try {
        await work();
        if (!this._intentCurrent(intent)) return; // stale: paint/emit nothing
        this._emitActivated(intent);
      } catch (err) {
        if (!this._intentCurrent(intent)) return; // stale: release/recover nothing
        this._finishEntryIntent(intent);
        // La entrada falló: la pantalla de transición se retira y el
        // selector muestra su error/recuperación honesta.
        intent.navTicket?.close();
        // The resync clears entry state — recovery/error are set AFTER it
        // so they survive the refresh.
        if (err instanceof EntryNarrowingFailure) {
          // POST applied, narrowing failed — recovery without claiming
          // rollback, plus a bounded resync of the projection.
          this._resyncBootstrap();
          this._entryRecovery = { kind: 'narrowing', team_id: err.team_id, message: err.message };
          this.render();
          return;
        }
        if (err instanceof EntryUncertainTransport) {
          this._entryRecovery = { kind: 'uncertain', message: err.message };
          this.render();
          return;
        }
        // A chain that already mutated (create→activate, redeem→activate)
        // resynchronizes so the projection reflects what was applied.
        if (intent.mutated) this._resyncBootstrap();
        this._entryError = (err as Error).message || 'No se pudo completar la entrada';
        this.render();
      }
    })();
  }

  // Recovery actions — each is an explicit user gesture, never an
  // automatic retry of an uncertain mutation.
  private _retryNarrowing(teamId: string): void {
    const intent = this._beginEntryIntent('personal-team', { team_id: teamId });
    if (!intent) return;
    this._runEntryIntent(intent, async () => {
      await this._putWorkingTeams(teamId); // PUT only — the POST applied already
    });
  }

  private _enterPersonal(teamId?: string): void {
    const intent = this._beginEntryIntent(teamId ? 'personal-team' : 'personal', { team_id: teamId });
    if (!intent) return;
    this._runEntryIntent(intent, async () => {
      await this._postActivate('personal');
      intent.mutated = true;
      if (teamId) {
        if (!this._intentCurrent(intent)) return;
        await this._putWorkingTeams(teamId);
      }
    });
  }

  private _enterClub(clubId: string): void {
    const intent = this._beginEntryIntent('club', { club_id: clubId });
    if (!intent) return;
    this._runEntryIntent(intent, async () => {
      await this._postActivate('club', clubId);
      intent.mutated = true;
    });
  }

  // PD-CLUBS «Club reciente» datum — account-bound session marker. It is
  // only a presentation hint: read back only while the id still appears
  // among the entry feed's club candidates, so a revoked membership or a
  // different account can never leak a club into the main access.
  private _lastClubKey(): string {
    return `${ENTRY_LAST_CLUB_KEY_PREFIX}${this._bootstrap?.account_id || ''}`;
  }

  private _writeLastClub(clubId: string): void {
    try {
      sessionStorage.setItem(this._lastClubKey(), clubId);
    } catch { /* storage unavailable — reciente is a hint, not a gate */ }
  }

  private _readLastClubId(): string {
    try {
      return sessionStorage.getItem(this._lastClubKey()) || '';
    } catch {
      return '';
    }
  }

  set route(value: string) {
    // Autosave: una sub-ruta nueva con el editor sucio espera a vaciar la
    // cola antes de aplicarse. Una ruta que apunta al MISMO editor abierto
    // (teams?edit=<id>) no es una transición — pasa directa.
    const raw = value || '';
    const qIdx = raw.indexOf('?');
    const targetSub = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const targetParams = qIdx >= 0 ? new URLSearchParams(raw.slice(qIdx + 1)) : null;
    const keepsEditor =
      targetSub === 'teams' && (targetParams?.get('edit') || '') === this._editingTeamId;
    if (
      !keepsEditor &&
      this._editingTeamId && this._editModel?.permissions.edit &&
      (this._editDirty || this._editSaveStatus === 'pending' ||
        this._editSaveStatus === 'saving' || this._editSaveStatus === 'error' ||
        this._editSaveStatus === 'conflict')
    ) {
      this._applyRouteAfterFlush(value);
      return;
    }
    this._applyRoute(value);
  }

  private _applyRouteAfterFlush(value: string): void {
    this._pendingRouteValue = value; // última intención manda
    if (this._routeFlushOp) return;
    // Token de operación, no booleano: el finally solo lo suelta si sigue
    // siendo el suyo — una liberación tardía de la operación retirada no
    // puede apagar el busy de la ruta del editor nuevo.
    const op: object = {};
    this._routeFlushOp = op;
    const owner = this._editOwnerNow();
    void (async () => {
      try {
        const ok = await this._flushEditorQueue(owner);
        if (!ok) {
          // El editor queda — restaura su ruta canónica y repinta. Pero
          // solo si sigue siendo el mismo editor que inició el flush:
          // una retirada+reapertura durante el await pasa el mando al
          // editor vigente, no a esta continuación.
          if (!this._isEditOwner(owner)) return;
          const teamId = this._editingTeamId;
          if (teamId) {
            history.replaceState(
              null, '',
              `#/onboard/teams?edit=${encodeURIComponent(teamId)}`,
            );
          }
          this._subRoute = 'teams';
          this.render();
          this._reportAppliedRoute();
          return;
        }
        if (!this._isEditOwner(owner)) return;
        this._retireEditor();
        const pending = this._pendingRouteValue;
        this._pendingRouteValue = null;
        this._applyRoute(pending ?? '');
      } finally {
        if (this._routeFlushOp === op) this._routeFlushOp = null;
      }
    })();
  }

  private _applyRoute(value: string): void {
    // Deep links may carry a query ("teams?return=cycle" from the mandatory
    // selection gate). Path and query are parsed separately — _subRoute is
    // always the bare tab id; _returnRoute preserves the continuation intent
    // until a successful selection save lets the user navigate there.
    const raw = value || '';
    const qIdx = raw.indexOf('?');
    const prevSub = this._subRoute;
    this._subRoute = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const params = qIdx >= 0 ? new URLSearchParams(raw.slice(qIdx + 1)) : null;
    this._returnRoute = params?.get('return') || '';
    // `edit=<teamId>` (from Home «Plantilla») asks for the edit modal; any
    // route without it drops a stale pending request.
    this._pendingEditTeamId = params?.get('edit') || null;
    // `invite=<token>` — invitation links arrive by email; the token rides
    // the deep link and the Mi club block shows the confirm card.
    const invite = params?.get('invite') || '';
    if (invite) {
      this._inviteToken = invite;
      this._invitePreview = null;
    }
    // Re-entry through #/onboard/spaces opens a fresh bootstrap scope:
    // the generation bump retires any in-flight intent and the resync
    // reflects whatever context the server currently reports.
    if (this._subRoute === 'spaces' && prevSub !== 'spaces') {
      this._resyncBootstrap();
    }
    this.render();
    // F12: Deep-linking to #/onboard/teams bypasses the nav click that loads
    // the catalog — trigger the load here when club context is already set.
    const clubId = this._org?.club?.id;
    if (this._subRoute === 'teams' && clubId) {
      this._ensureTeamsData(clubId);
      // Catalog may already be warm (no load started) — drain immediately.
      this._maybeOpenPendingEdit();
    }
    // SF1: under a personal context the same canonical route drains into
    // the shared roster editor — readiness is the personal-teams feed.
    if (this._subRoute === 'teams' && this._isPersonalContext()) {
      this._maybeOpenPendingEdit();
    }
    // «Plantilla» on a personal team — the legacy #/onboard/spaces?edit=<id>
    // alias forwards to the canonical teams route under a personal context.
    if (this._subRoute === 'spaces') {
      this._maybeOpenPendingPersonalEdit();
    }
    // Phase 3: same for the Perfil club summary.
    if (this._subRoute === 'profile' && clubId && !this._clubSummary && !this._clubSummaryLoading) {
      this.loadClubSummary(clubId);
    }
    // Phase 4: same for the Miembros roster.
    if (this._subRoute === 'members' && clubId) {
      this._ensureMembersData(clubId);
    }
    // La aplicación de la sub-ruta puede haber sido asíncrona (flush previo
    // en el setter): la confirmación a la carcasa va tras aplicar — nunca
    // antes; su bookkeeping sigue la ruta realmente vigente.
    this._reportAppliedRoute();
    // Reentrada en caliente: si los datos esenciales de la pestaña ya
    // estaban cargados, el destino acredita ahora — las cargas que sí se
    // dispararon emitirán en su finally.
    this._navReadyNow();
  }
  get route(): string { return this._subRoute; }

  // ─── Data loading ─────────────────────────────────────────────────────

  private async loadThemeData(clubId: string): Promise<void> {
    // Don't set _loading on data refreshes — only generateTheme/revertTheme
    // set it. This prevents the "Generar estilo" button from flashing
    // "Generando…" on every poll or org context refresh.
    this._error = null;
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const prevJobStatus = this._themeJob?.status;
      const prevThemeStatus = this._theme?.status;
      const jobStatus = data.themeJob?.status || '';
      if (this._awaitingNewJob && (jobStatus === 'pending' || jobStatus === 'running')) {
        // Issue #31: Keep previous theme preview displayed during polling
        this._theme = this._theme || data.theme || null;
        this._themeJob = data.themeJob || null;
      } else {
        // Job reached terminal state (or no job) — show the theme
        this._awaitingNewJob = false;
        this._loading = false; // reset loading on terminal state
        this._theme = data.draftTheme || data.theme || null;
        this._themeJob = data.themeJob || null;
      }
      // B14: start polling if pending/running
      this._maybeStartPolling(clubId);
      // B15: emit state event to shell ONLY when status actually changes
      // (prevents infinite loop: shell refreshes org → loadThemeData → emit → shell refresh)
      const newJobStatus = this._themeJob?.status;
      const newThemeStatus = this._theme?.status;
      if (prevJobStatus !== newJobStatus || prevThemeStatus !== newThemeStatus) {
        this._emitThemeStateEvent(clubId);
      }
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this.render();
      // Primera resolución del tema para este club — habilita la
      // acreditación inmediata en reentradas; la señal solo sale si el
      // destino vigente es Estilo/landing (transición unificada).
      this._themeReadyClub = clubId;
      const sub = this._subRoute;
      if (sub === '' || sub === 'club-details') {
        this._emitNavReady(this._error ? 'error' : 'content', sub, clubId);
      }
    }
  }

  // Mi Club Phase 3: load the club profile summary (id, counts, presence).
  private async loadClubSummary(clubId: string): Promise<void> {
    this._clubSummaryLoading = true;
    this._clubSummaryError = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/summary`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._clubSummary = await res.json();
    } catch (err) {
      this._clubSummaryError = (err as Error).message;
    } finally {
      this._clubSummaryLoading = false;
      this.render();
      this._maybeProfileNavReady(clubId);
    }
  }

  // Shared tab entry: every navigation path (nav clicks on any tab, the
  // route setter and org-context arrival) funnels through here so no tab
  // can render without its data load being triggered.
  private _selectTab(nav: string, clubId: string): void {
    const prevSub = this._subRoute;
    this._subRoute = nav;
    if (nav === 'spaces' && prevSub !== 'spaces') {
      // Re-entry into the selector opens a fresh bootstrap scope — same
      // rule as the #/onboard/spaces route.
      this._resyncBootstrap();
      return;
    }
    if (nav === 'teams') {
      this._ensureTeamsData(clubId);
    } else if (nav === 'profile' && !this._clubSummary && !this._clubSummaryLoading) {
      this.loadClubSummary(clubId);
    } else {
      if (nav === 'members') {
        this._ensureMembersData(clubId);
      }
      this.render();
    }
    // Click de pestaña con datos ya presentes: acredita en caliente (una
    // señal por destino — 'spaces' acredita al asentar el resync).
    this._navReadyNow();
  }

  // Mi Club Phase 4: roster is loaded on first entry and retried after a
  // failed fetch; a confirmed roster (even an empty one) is kept while the
  // club context is unchanged.
  private _ensureMembersData(clubId: string): void {
    if (!this._canManageMembers()) {
      // Unauthorized identity — no member requests; make sure no cached
      // roster/assignments survive to render under this context either.
      this._clearMembersState();
      return;
    }
    if (this._membersLoading) return;
    if (this._members !== null && !this._membersError) return;
    this.loadMembers(clubId);
  }

  // Load the member roster + role assignments together — assignments are
  // needed to resolve a removable role to its id. Results only apply while
  // the requesting club/session context is still current.
  private async loadMembers(clubId: string): Promise<void> {
    if (!this._canManageMembers()) return; // never fetch member data unauthorized
    const requestId = ++this._membersRequestId;
    const isCurrent = () =>
      requestId === this._membersRequestId &&
      this._org?.club?.id === clubId &&
      this._canManageMembers(); // role may downgrade while in flight
    this._membersLoading = true;
    this._membersError = null;
    this.render();
    try {
      const headers = { 'Content-Type': 'application/json' };
      const [usersRes, rolesRes] = await Promise.all([
        fetch(`/api/clubs/${clubId}/users`, { credentials: 'include', headers }),
        fetch(`/api/clubs/${clubId}/roles`, { credentials: 'include', headers }),
      ]);
      if (!usersRes.ok) throw new Error(`HTTP ${usersRes.status}`);
      const data = await usersRes.json();
      const users = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : null;
      if (!users) throw new Error('Respuesta de miembros inválida');
      // Roles are part of the contract: a failed or malformed response is
      // "unavailable", never an empty assignment list — otherwise the roster
      // would expose edit/remove controls from non-authoritative state.
      if (!rolesRes.ok) throw new Error(`HTTP ${rolesRes.status}`);
      const rolesData = await rolesRes.json();
      if (!Array.isArray(rolesData?.assignments)) {
        throw new Error('Respuesta de roles inválida');
      }
      // Every assignment must carry the upstream scope contract
      // (scope === "club:<requested club>") and must not conflict with an
      // explicit club_id. A foreign or malformed row is non-authoritative —
      // fail closed instead of wiring another club's assignment id into this
      // club's controls. Rows for users outside the member roster are valid
      // scope state (cross-scope grants, assignments outliving membership) and
      // can never back a member-row control — filter them, don't fail.
      const memberIds = new Set(
        (users as { id?: unknown }[])
          .map((u) => u?.id)
          .filter((id): id is string => typeof id === 'string'),
      );
      const assignments: MemberAssignment[] = rolesData.assignments.map((a: Record<string, unknown>) => {
        const valid = a !== null && typeof a === 'object'
          && a.scope === `club:${clubId}`
          && (a.club_id === undefined || a.club_id === clubId)
          && typeof a.id === 'string' && a.id.length > 0
          && typeof a.user_id === 'string' && a.user_id.length > 0
          && typeof a.role === 'string' && a.role.length > 0;
        if (!valid) throw new Error('Respuesta de roles inválida');
        return {
          id: a.id as string,
          user_id: a.user_id as string,
          role: a.role as string,
          club_id: clubId,
        };
      }).filter((a: MemberAssignment) => memberIds.has(a.user_id));
      if (!isCurrent()) return; // late response from another club/user — drop it
      this._members = users as MemberRow[];
      this._memberAssignments = assignments;
    } catch (err) {
      if (isCurrent()) this._membersError = (err as Error).message;
    } finally {
      if (requestId === this._membersRequestId) {
        this._membersLoading = false;
        this.render();
        this._maybeMembersNavReady(clubId);
      }
    }
  }

  // Consolidated Equipos: load whichever data the role is entitled to.
  // Everyone (incl. read-only roles) gets the self-scoped selection feed;
  // only ADMIN_ROLES additionally pull the management feed + seeding job.
  private _canPickTeams(): boolean {
    return PICK_ROLES.includes(this._org?.role || '');
  }

  private _canManageTeams(): boolean {
    return ADMIN_ROLES.includes(this._org?.role || '');
  }

  private _ensureTeamsData(clubId: string): void {
    if (!this._myTeamsLoaded && !this._myTeamsLoading) {
      this.loadTeamSelection();
    }
    if (this._canManageTeams() && this._teams.length === 0 && !this._teamsLoading) {
      this.loadTeams(clubId);
    }
  }

  // Self-scoped selection feed (biq-app BFF, same origin): returns the club
  // catalog plus the current user's selected team ids. Self-scoped means any
  // role may call it — no management capability is exercised.
  private async loadTeamSelection(): Promise<void> {
    this._myTeamsLoading = true;
    this._myTeamsError = null;
    this.render();
    try {
      const res = await fetch(`${window.location.origin}/api/org/my-teams`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._myTeamsCatalog = Array.isArray(data.catalog) ? data.catalog : [];
      const selected = Array.isArray(data.selected) ? data.selected : [];
      this._selectedIds = new Set(selected);
      this._confirmedSelected = new Set(selected);
      this._failedSelection = null;
      this._selectionStatus = 'idle';
      this._myTeamsLoaded = true;
    } catch (err) {
      this._myTeamsError = (err as Error).message;
    } finally {
      this._myTeamsLoading = false;
      this.render();
      this._maybeOpenPendingEdit();
      this._maybeTeamsNavReady();
    }
  }

  // Selection save: optimistic chips + writes serialized through
  // _selectionSaveChain so a slow earlier response can never overwrite a
  // newer intent. The debounce batches rapid toggles into one PUT.
  private _scheduleSelectionSave(): void {
    if (this._selectionSaveTimer) clearTimeout(this._selectionSaveTimer);
    this._selectionSaveTimer = setTimeout(() => { this._queueSelectionSave(); }, 350);
  }

  private _queueSelectionSave(): Promise<void> {
    this._selectionSaveChain = this._selectionSaveChain
      .catch(() => {})
      .then(() => this._saveSelection());
    return this._selectionSaveChain;
  }

  private async _saveSelection(): Promise<void> {
    const sent = this._orderedSelectedIds();
    this._selectionStatus = 'saving';
    this._updateSelectionDom();
    try {
      const res = await fetch(`${window.location.origin}/api/org/my-teams`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_ids: sent }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      const serverSelected = Array.isArray(data.selected) ? data.selected : sent;
      this._confirmedSelected = new Set(serverSelected);
      this._failedSelection = null;
      // If the intent moved while this PUT was in flight, the chained
      // follow-up save persists it — only reconcile the view when the set
      // we sent is still what the user wants.
      if (this._orderedSelectedIds().join('|') === sent.join('|')) {
        this._selectedIds = new Set(serverSelected);
        this._selectionStatus = 'saved';
        this._emitSelectionChanged(serverSelected);
      }
      this._updateSelectionDom();
    } catch {
      // Honest failure: record the unsaved intent for retry. When the user
      // has not moved on, restore the last confirmed state — the optimistic
      // set was never persisted and must not pretend otherwise.
      this._failedSelection = sent;
      if (this._orderedSelectedIds().join('|') === sent.join('|')) {
        this._selectedIds = new Set(this._confirmedSelected);
      }
      this._selectionStatus = 'error';
      this._updateSelectionDom();
    }
  }

  // Public contract for the shell: fired only after a successful save, from
  // the host element so it crosses the shadow boundary (bubbles + composed).
  private _emitSelectionChanged(selected: string[]): void {
    try {
      this.dispatchEvent(new CustomEvent('biq-teams:selection-changed', {
        detail: { selected: [...selected], catalog: this._mergedCatalog() },
        bubbles: true,
        composed: true,
      }));
    } catch { /* CustomEvent unavailable */ }
  }

  // Targeted DOM refresh for selection toggles — avoids a full shadow-DOM
  // rebuild so the checkbox that fired the change keeps its focus.
  private _updateSelectionDom(): void {
    const chips = this.shadow.querySelector('[data-myteams-chips]');
    if (chips) chips.innerHTML = this._myTeamsChipsHtml();
    const status = this.shadow.querySelector('[data-selection-status]');
    if (status) {
      status.textContent = this._selectionStatusText();
      status.classList.toggle('onboard-save-status-error', this._selectionStatus === 'error');
    }
    const retry = this.shadow.querySelector('[data-retry-save]') as HTMLElement | null;
    if (retry) retry.hidden = !(this._selectionStatus === 'error' && this._failedSelection);
    const cont = this.shadow.querySelector('[data-continue]') as HTMLButtonElement | null;
    if (cont) cont.disabled = !this._canContinue();
  }

  // F12: Load the club's team catalog from the teams API.
  private async loadTeams(clubId: string): Promise<void> {
    this._teamsLoading = true;
    this._teamsError = null;
    this.render();
    try {
      const [res] = await Promise.all([
        fetch(`/api/clubs/${clubId}/teams`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        }),
        // Degrade to null on failure — the tab must still work if the
        // seeding endpoint is unreachable.
        this._loadTeamSeeding(clubId).catch(() => {
          this._teamSeedingJob = null;
        }),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._teams = data.teams || [];
      this._maybeStartSeedingPolling(clubId);
    } catch (err) {
      this._teamsError = (err as Error).message;
    } finally {
      this._teamsLoading = false;
      this.render();
      this._maybeOpenPendingEdit();
      this._maybeTeamsNavReady(clubId);
    }
  }

  // F12: Fetch the club's team_seeding_job status (null job = pre-tracking club).
  private async _loadTeamSeeding(clubId: string): Promise<void> {
    const res = await fetch(`/api/clubs/${clubId}/team-seeding`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this._teamSeedingJob = data.team_seeding_job ?? null;
  }

  // Edit-team modal lifecycle — the draft fields carry name/level/roster so
  // add/remove-player re-renders never lose typed input (innerHTML re-render
  // discards live input values). The model loads through the context port —
  // actual roster readiness, never `players ?? []` on a metadata row.
  private _openEditModal(teamId: string, rosterFocus: boolean): void {
    // Re-entrega de la misma ruta (p.ej. restauración del hash tras una
    // retención de requestLeave): el editor ya está montado sobre este
    // equipo — reabrirlo descartaría el borrador y su feedback.
    if (this._editingTeamId === teamId) {
      this._pendingEditTeamId = null;
      return;
    }
    this._editingTeamId = teamId;
    this._editModel = null;
    this._editNameDraft = '';
    this._editCategoryDraft = '';
    this._editGenderDraft = '';
    this._editLevelDraft = '';
    this._rosterDraft = [];
    this._addPlayerPickerOpen = false;
    this._rosterFocus = rosterFocus;
    this._addingTeamCategory = null;
    this._deleteConfirmTeamId = null;
    this._teamsError = null;
    this._editError = null;
    this._editLoading = true;
    // Autosave: la nueva apertura arranca limpia — sin cola ni borrador
    // heredado del equipo/contexto anterior.
    if (this._editSaveTimer) {
      clearTimeout(this._editSaveTimer);
      this._editSaveTimer = null;
    }
    this._editSaveChain = Promise.resolve();
    this._editSaveQueued = false;
    this._editDirty = false;
    this._editSaveStatus = 'idle';
    this._editSaveMessage = null;
    this._editFlush = null;
    this._editSavedChanges = false;
    this._pendingRouteValue = null;
    // La reapertura es una identidad nueva: los tokens de salida, el grant
    // de admisión y el estado de reconciliación del editor anterior no se
    // heredan — un commit/flush tardío del viejo no puede cerrar el nuevo.
    this._routeFlushOp = null;
    this._closingEditOp = null;
    this._admittedLeaveGrant = null;
    this._admittedDraftJson = null;
    this._editSentSnapshot = null;
    this._editNeedsReconcile = false;
    this._editConflictServer = null;
    this._editFence = this._editFenceNow(teamId);
    const seq = ++this._editSeq;
    this.render();
    void this._loadEditorModel(teamId, seq);
  }

  private async _loadEditorModel(teamId: string, seq: number): Promise<void> {
    const res = await this._teamEditorPort().load(teamId);
    if (
      seq !== this._editSeq ||
      this._editFence !== this._editFenceNow(teamId) ||
      this._editingTeamId !== teamId
    ) {
      return; // stale — the subject, context or scope moved on
    }
    this._editLoading = false;
    if (res.kind === 'ok') {
      const m = res.model;
      this._editModel = m;
      this._editNameDraft = m.name;
      this._editCategoryDraft = m.category ?? '';
      this._editGenderDraft = m.gender ?? '';
      this._editLevelDraft = m.competitive_level;
      this._rosterDraft = m.players.map((p) => ({
        name: p.name,
        number: p.number === null || p.number === undefined ? '' : String(p.number),
        birth_date: '',
        birth_loaded: false,
        birth_dirty: false,
        existing: true,
        player_id: p.player_id ?? null,
      }));
      // Club rosters: pull each player's profile (birth_date) from
      // biq-player. Skipped for personal models (no category/gender
      // contract → no profile anchor) and read-only views.
      if (m.category !== undefined && m.permissions.edit) {
        void this._loadPlayerProfiles(teamId, seq);
      }
    } else {
      // Typed failure fails closed: no empty draft opens over a denied or
      // missing read — the intent closes and the host surfaces the error.
      this._editingTeamId = null;
      this._editModel = null;
      const message = res.kind === 'unavailable'
        ? res.message
        : res.kind === 'denied'
          ? 'No tienes permiso para editar este equipo.'
          : 'Equipo no encontrado.';
      if (this._isPersonalContext()) this._entryError = message;
      else this._teamsError = message;
    }
    this.render();
  }

  // ─── UX v2: autosave del editor de equipo ──────────────────────────────
  private _editSaveStatusLabel(): string {
    const labels: Record<string, string> = {
      idle: '', pending: 'Cambios pendientes', saving: 'Guardando…',
      saved: 'Guardado', error: 'No se pudo guardar',
      conflict: 'El equipo cambió en otro lugar',
    };
    return labels[this._editSaveStatus] || '';
  }

  // El draft que sale al servidor: valida el SNAPSHOT COMPLETO — ninguna
  // fila se descarta en silencio. La plantilla persiste por reemplazo total,
  // así que omitir una fila sería una baja implícita: el nombre borrado de
  // un jugador persistido lo conserva y exige corrección o su acción
  // explícita de quitar; una fila nueva incompleta (vacía o solo dorsal)
  // queda pendiente — ni Guardado ni requestLeave pueden afirmar cierre
  // mientras exista. El nivel no se revalida contra el vocabulario — el
  // <select> solo ofrece opciones canónicas + el valor almacenado
  // (texto legacy preservado por contrato, competitiveLevelOptionsHtml).
  private _editDraftPayload():
    | {
        ok: true;
        name: string;
        category: string;
        gender: string;
        competitive_level: string;
        players: { name: string; number: number | null; player_id: string | null }[];
      }
    | { ok: false; message: string } {
    const name = this._editNameDraft.trim();
    if (!name) return { ok: false, message: 'El nombre es obligatorio.' };
    const competitive_level = this._editLevelDraft.trim();
    const players: { name: string; number: number | null; player_id: string | null }[] = [];
    for (const p of this._rosterDraft) {
      const pname = p.name.trim();
      if (!pname) {
        // Fila nueva totalmente vacía — edición incompleta, espera.
        if (!p.existing && !p.number.trim() && !p.birth_date.trim()) {
          return { ok: false, message: 'Completa o quita la fila nueva del jugador.' };
        }
        // Fila persistida o con dorsal pero sin nombre — conserva al
        // jugador guardado; la baja es solo por su acción explícita.
        return { ok: false, message: 'Cada jugador necesita un nombre — quita la fila para darlo de baja.' };
      }
      const numStr = p.number.trim();
      const num = numStr === '' ? null
        : /^-?\d+$/.test(numStr) ? Number.parseInt(numStr, 10) : Number.NaN;
      if (num !== null && (!Number.isInteger(num) || num < 0 || num > 99)) {
        return { ok: false, message: 'El dorsal debe ser un número entero entre 0 y 99.' };
      }
      players.push({ name: pname, number: num, player_id: p.player_id ?? null });
    }
    return {
      ok: true,
      name,
      category: this._editCategoryDraft,
      gender: this._editGenderDraft,
      competitive_level,
      players,
    };
  }

  // Canonical snapshot of an editor payload/model — the exact shape used
  // for content comparison (sent vs. now vs. server, and the three-way
  // reconcile). `player_id` is intentionally NOT part of it: the id is
  // server-assigned metadata that the user cannot edit, so adopting it
  // after a save must not count as a pending change.
  private _editSnapshotJson(fields: {
    name: string;
    category?: string | null;
    gender?: string | null;
    competitive_level: string;
    players: { name: string; number: number | null; player_id?: string | null }[];
  }): string {
    return JSON.stringify({
      name: fields.name,
      // '' (draft "Selecciona…"), null and undefined are the same "unset"
      // state for comparison — a model (null/undefined) and a draft ('')
      // must produce the identical snapshot.
      category: fields.category || null,
      gender: fields.gender || null,
      competitive_level: fields.competitive_level,
      players: fields.players.map((p) => ({ name: p.name, number: p.number ?? null })),
    });
  }

  // Identidad del dueño de un job/cola: equipo + generación de editor +
  // fence de contexto/principal. Se captura AL ENCOLAR — un callback
  // encolado bajo A que despierta sobre B nunca muta ni libera nada.
  private _editOwnerNow(): { teamId: string | null; seq: number; fence: string } {
    return { teamId: this._editingTeamId, seq: this._editSeq, fence: this._editFence };
  }

  private _isEditOwner(owner: { teamId: string | null; seq: number; fence: string }): boolean {
    return owner.teamId !== null && owner.teamId === this._editingTeamId &&
      owner.seq === this._editSeq && owner.fence === this._editFence;
  }

  // Marca trabajo pendiente y programa el guardado; `accelerated` (select,
  // blur, quitar jugador) salta el debounce.
  private _scheduleEditorSave(accelerated = false): void {
    if (!this._editingTeamId || !this._editModel?.permissions.edit) return;
    this._syncEditDraftFromDom();
    this._editDirty = true;
    // Un conflicto sin decidir no se diluye a «pendiente»: el usuario sigue
    // viendo la decisión explícita — ningún autosave escribe hasta elegir.
    if (!this._editConflictServer) {
      this._editSaveStatus = 'pending';
      this._editSaveMessage = null;
    }
    this._updateEditStatusDom();
    if (this._editSaveTimer) clearTimeout(this._editSaveTimer);
    if (accelerated) {
      this._editSaveTimer = null;
      this._queueEditorSave();
      return;
    }
    this._editSaveTimer = setTimeout(() => {
      this._editSaveTimer = null;
      this._queueEditorSave();
    }, 600);
  }

  // Cadena serial: nunca dos PUT en vuelo y como mucho UN envío en
  // espera — mientras haya una pasada encolada, las nuevas ediciones solo
  // marcan dirty (la pasada viva lee el DOM al ejecutarse). El dueño se
  // fija al encolar: una pasada nacida en un editor ya retirado no
  // ejecuta ni libera flags del editor vigente.
  private _queueEditorSave(): void {
    if (this._editSaveQueued) return;
    this._editSaveQueued = true;
    const owner = this._editOwnerNow();
    this._editSaveChain = this._editSaveChain
      .then(() => this._saveEditorOnce(owner))
      .catch(() => { /* los estados tipados ya reflejan el fallo */ });
  }

  private async _saveEditorOnce(owner: { teamId: string | null; seq: number; fence: string }): Promise<void> {
    // Job nacido bajo otro editor/principal — nunca muta ni libera el
    // estado del editor vigente (incluido `_editSaveQueued`).
    if (!this._isEditOwner(owner)) return;
    this._editSaveQueued = false;
    const teamId = owner.teamId as string;
    if (!this._editModel) return;
    // R2-D3-1: tras un 409 o un resultado incierto NINGÚN PUT posterior va a
    // ciegas — autosave, flush, Volver y reintentos pasan primero por la
    // lectura de reconciliación (detecta ACK perdido, mezcla cambios
    // disjuntos o exige decisión explícita de conflicto).
    if (this._editNeedsReconcile) {
      const reconciled = await this._reconcileEditor(owner);
      if (!this._isEditOwner(owner)) return;
      if (reconciled === 'already-persisted') {
        this._finishSavedEquivalent();
        return;
      }
      if (reconciled !== 'resolved') return; // conflicto a la vista o fallo de lectura
    }
    this._syncEditDraftFromDom();
    const draft = this._editDraftPayload();
    if (!draft.ok) {
      // La validación se queda pendiente — no hay escritura posible.
      this._editSaveStatus = 'pending';
      this._editSaveMessage = draft.message;
      this._updateEditStatusDom();
      return;
    }
    const version = this._editModel.version;
    const sent = {
      name: draft.name,
      category: draft.category,
      gender: draft.gender,
      competitive_level: draft.competitive_level,
      players: draft.players,
    };
    const sentJson = this._editSnapshotJson(sent);
    this._editSaveStatus = 'saving';
    this._editSaveMessage = null;
    this._updateEditStatusDom();
    const port = this._teamEditorPort();
    this._editSentSnapshot = sentJson; // payload realmente despachado — clave del detector de ACK perdido
    const res = await port.save(teamId, sent, version);
    if (!this._isEditOwner(owner)) {
      return; // respuesta fuera de orden u otro principal — se descarta
    }
    if (res.kind === 'saved') {
      // Solo el handle CAS del modelo se actualiza: los inputs del DOM
      // pueden llevar texto nuevo tecleado durante el vuelo.
      this._editModel = res.model;
      this._editSavedChanges = true;
      // F-CL-3: adopta los player_id que el servidor acaba de asignar, para
      // que el siguiente autosave los reenvíe (estabilidad de identidad —
      // una fila reenviada sin id recibiría uno nuevo). El roster viaja
      // por reemplazo total en el mismo orden, así que la fila i del
      // borrador adopta el id devuelto para la fila i — solo cuando la
      // fila sigue coincidiendo con lo enviado (una fila eliminada o
      // renombrada en vuelo no hereda un id ajeno).
      if (res.model.players.length === sent.players.length) {
        for (let i = 0; i < sent.players.length; i++) {
          const row = this._rosterDraft[i];
          const sentRow = sent.players[i];
          const savedRow = res.model.players[i];
          if (!row || !sentRow || !savedRow) continue;
          const numStr = row.number.trim();
          const rowNum = numStr === '' ? null
            : /^-?\d+$/.test(numStr) ? Number.parseInt(numStr, 10) : Number.NaN;
          if (
            row.name.trim() === sentRow.name &&
            rowNum === sentRow.number &&
            savedRow.name === sentRow.name &&
            (savedRow.number ?? null) === sentRow.number
          ) {
            row.player_id = savedRow.player_id ?? null;
          }
        }
      }
      this._syncEditDraftFromDom();
      // PD-2: birth dates persist through biq-player profiles keyed by
      // player_id (the roster save just adopted any server-assigned ids;
      // the DOM was just flushed so birth edits typed during the flight
      // are included). A failed profile write stays dirty and reports
      // honestly — never a silent loss nor a blocked roster save.
      const birthFailures = await this._syncPlayerBirthDates(owner);
      if (!this._isEditOwner(owner)) return;
      const now = this._editDraftPayload();
      const nowJson = now.ok ? this._editSnapshotJson(now) : null;
      if (nowJson === sentJson) {
        this._editDirty = birthFailures > 0;
        if (birthFailures > 0) {
          this._editSaveStatus = 'error';
          this._editSaveMessage =
            'La plantilla se guardó; no se pudieron guardar las fechas de nacimiento. Reintentar las vuelve a enviar.';
        } else {
          this._editSaveStatus = 'saved';
          this._editSaveMessage = null;
        }
      } else {
        // Hay ediciones posteriores — se encola el siguiente envío.
        this._editSaveStatus = 'pending';
        this._editSaveMessage = now.ok ? null : now.message;
        this._queueEditorSave();
      }
      this._updateEditStatusDom();
      return;
    }
    this._editSaveStatus = res.kind === 'conflict' ? 'conflict' : 'error';
    // Todo resultado no-confirmado exige reconciliación antes del siguiente
    // PUT — incluidos autosave, flush y Volver (pasan por la misma cadena).
    this._editNeedsReconcile = true;
    this._editSaveMessage = res.kind === 'conflict'
      ? 'El equipo cambió fuera de este editor. Reintenta para comparar con la versión actual.'
      : res.kind === 'denied'
        ? 'No tienes permiso para guardar este equipo.'
        : res.kind === 'not-found'
          ? 'El equipo ya no existe.'
          // Resultado incierto (transporte, 5xx, respuesta inválida): la
          // escritura pudo aplicarse en el servidor — nunca se reenvía a
          // ciegas; Reintentar primero reconcilia con una lectura.
          : `${res.message} Reintentar comprueba el estado actual antes de reenviar.`;
    this._updateEditStatusDom();
  }

  // Snapshot canónico de un modelo — la misma forma que _editSnapshotJson
  // produce para un draft, para comparar contenido (no el CAS).
  private _editModelSnapshot(model: TeamEditorModel): string {
    return this._editSnapshotJson({
      name: model.name,
      category: model.category,
      gender: model.gender,
      competitive_level: model.competitive_level,
      players: model.players,
    });
  }

  // El servidor ya contiene el snapshot cuyo ACK se perdió: adopta el
  // handle de revisión fresco y repite la lógica de post-guardado (cero
  // PUT extra por el mismo snapshot; las ediciones posteriores se
  // procesan aparte, con la revisión nueva).
  private _finishSavedEquivalent(): void {
    this._syncEditDraftFromDom();
    const now = this._editDraftPayload();
    const nowJson = now.ok ? this._editSnapshotJson(now) : null;
    if (nowJson !== null && nowJson === this._editSentSnapshot) {
      this._editDirty = false;
      this._editSavedChanges = true; // el servidor ya lo persistió — catálogos pendientes de refresco
      this._editSaveStatus = 'saved';
      this._editSaveMessage = null;
    } else {
      this._editSaveStatus = 'pending';
      this._editSaveMessage = now.ok ? null : now.message;
      this._queueEditorSave();
    }
    this._updateEditStatusDom();
  }

  // Lectura de reconciliación (R2-D3-1). Resultados:
  //  - 'already-persisted': el servidor YA tiene exactamente el snapshot
  //    enviado — el ACK se perdió; se adopta la revisión y NO hay PUT.
  //  - 'resolved': mezcla segura — campos que solo cambiaron en el
  //    servidor se adoptan (draft+DOM), los campos que editó el usuario
  //    se conservan; el siguiente PUT va sobre la revisión fresca.
  //  - 'conflict': el mismo campo divergió en ambos lados — decisión
  //    explícita con la información del servidor a la vista.
  //  - 'failed': la lectura no pudo — estado de error con feedback.
  private async _reconcileEditor(
    owner: { teamId: string | null; seq: number; fence: string },
  ): Promise<'already-persisted' | 'resolved' | 'conflict' | 'failed'> {
    const teamId = owner.teamId as string;
    // Conflicto ya expuesto y sin decidir: NUNCA se re-analiza contra un
    // base ya actualizado — con la versión del servidor como nuevo base el
    // draft del usuario parecería un cambio unilateral y reenviarlo sería
    // el sobreescribir a ciegas que esta reconciliación existe para evitar.
    // El estado es pegajoso hasta «Mantener mis cambios» / «Cargar versión
    // actual» (si el servidor se mueve otra vez, el PUT con la decisión
    // recibirá un 409 real y reconciliará de nuevo).
    if (this._editConflictServer) {
      // El conflicto está expuesto y sin decidir: restituye estado y
      // controles — Volver/requestLeave/commitLeave ponen 'saving' antes
      // del flush y _updateEditStatusDom oculta ambas decisiones; sin el
      // restablecimiento el editor queda retenido en Guardando sin poder
      // elegir (R3-D3-3). Cero PUT hasta la elección explícita.
      this._editSaveStatus = 'conflict';
      this._updateEditStatusDom();
      return 'conflict';
    }
    this._editSaveStatus = 'saving';
    this._editSaveMessage = null;
    this._updateEditStatusDom();
    if (!this._isPersonalContext()) {
      // El puerto club lee la caché del feed de gestión — una
      // reconciliación real exige refetch primero (limitación sin CAS
      // declarada: la comparación es de contenido, no de revisión).
      const clubId = this._org?.club?.id;
      if (clubId) await this.loadTeams(clubId);
      if (!this._isEditOwner(owner)) return 'failed';
    }
    const res = await this._teamEditorPort().load(teamId);
    if (!this._isEditOwner(owner)) return 'failed';
    if (res.kind !== 'ok') {
      this._editSaveStatus = 'error';
      this._editSaveMessage = res.kind === 'denied'
        ? 'No tienes permiso para editar este equipo.'
        : res.kind === 'not-found'
          ? 'El equipo ya no existe.'
          : res.message;
      this._updateEditStatusDom();
      return 'failed';
    }
    const server = res.model;
    const serverSnap = this._editModelSnapshot(server);
    // ¿El servidor ya persistió justo lo que enviamos? ACK perdido.
    if (this._editSentSnapshot !== null && serverSnap === this._editSentSnapshot) {
      this._editModel = server;
      this._editNeedsReconcile = false;
      return 'already-persisted';
    }
    // Mezcla a tres bandas por campo: base = último snapshot confirmado
    // por el servidor (el modelo vigente), draft = lo que el usuario ve.
    const base = this._editModel;
    const baseSnap = base ? this._editModelSnapshot(base) : null;
    const baseObj = baseSnap
      ? (JSON.parse(baseSnap) as {
          name: string;
          category: string | null;
          gender: string | null;
          competitive_level: string;
          players: { name: string; number: number | null }[];
        })
      : null;
    const serverObj = JSON.parse(serverSnap) as {
      name: string;
      category: string | null;
      gender: string | null;
      competitive_level: string;
      players: { name: string; number: number | null }[];
    };
    this._syncEditDraftFromDom();
    const draft = this._editDraftPayload();
    if (!draft.ok) {
      // Borrador inválido: no hay nada enviable AHORA, pero la base
      // confirmada se conserva (_editModel NO se mueve al servidor) y la
      // obligación de reconciliar sigue puesta. Adoptar `server` aquí
      // convertiría el draft del usuario en cambio unilateral sobre la
      // revisión nueva — al reparar el campo, el autosave reenviaría el
      // DOM viejo sin comparación ni decisión y borraría datos ajenos
      // (R3-D3-1). La próxima pasada — tras corregir la validación —
      // relee el servidor y hace la mezcla a tres bandas antes de
      // cualquier PUT.
      this._editSaveStatus = 'pending';
      this._editSaveMessage = draft.message;
      this._updateEditStatusDom();
      return 'failed';
    }
    const draftObj = JSON.parse(this._editSnapshotJson(draft)) as {
      name: string;
      category: string | null;
      gender: string | null;
      competitive_level: string;
      players: { name: string; number: number | null }[];
    };
    const fields: Array<{
      key: 'name' | 'category' | 'gender' | 'competitive_level' | 'players';
      label: string;
    }> = [
      { key: 'name', label: 'el nombre' },
      { key: 'category', label: 'la categoría' },
      { key: 'gender', label: 'el género' },
      { key: 'competitive_level', label: 'el nivel' },
      { key: 'players', label: 'la plantilla' },
    ];
    const conflicts: string[] = [];
    const serverWins: typeof fields[number]['key'][] = [];
    for (const { key, label } of fields) {
      const serverChanged = JSON.stringify(serverObj[key]) !== JSON.stringify(baseObj?.[key] ?? null) || baseObj === null;
      const draftChanged = JSON.stringify(draftObj[key]) !== JSON.stringify(baseObj?.[key] ?? null) || baseObj === null;
      if (serverChanged && draftChanged && JSON.stringify(serverObj[key]) !== JSON.stringify(draftObj[key])) {
        conflicts.push(label);
      } else if (serverChanged && !draftChanged) {
        serverWins.push(key);
      }
    }
    this._editModel = server; // handle CAS fresco en todos los desenlaces
    this._editNeedsReconcile = false;
    if (conflicts.length) {
      // Decisión explícita — nunca sobreescribir datos ajenos por un
      // Reintentar genérico: la plantilla del servidor queda descrita.
      // La bandera se mantiene: ningún autosave/flush posterior escribe a
      // ciegas mientras el conflicto siga sin decidir — cada pasada
      // reconcilia de nuevo hasta la elección del usuario.
      this._editNeedsReconcile = true;
      this._editConflictServer = server;
      const rosterSummary = serverObj.players.length
        ? ` Plantilla actual: ${serverObj.players.map((p) => p.number !== null ? `${p.name} (${p.number})` : p.name).join(', ')}.`
        : ' Plantilla actual: sin jugadores.';
      this._editSaveStatus = 'conflict';
      this._editSaveMessage =
        `Otro cambio modificó ${conflicts.join(' y ')}.${rosterSummary} ` +
        'Elige «Mantener mis cambios» o «Cargar versión actual».';
      this._updateEditStatusDom();
      return 'conflict';
    }
    // Mezcla disjunta: adopta los campos que solo cambió el servidor —
    // el DOM se actualiza solo en esos campos, nunca el texto del usuario.
    if (serverWins.includes('name')) {
      this._editNameDraft = server.name;
      const input = this.shadow.querySelector('[data-edit-team-name]') as HTMLInputElement | null;
      if (input) input.value = server.name;
    }
    if (serverWins.includes('competitive_level')) {
      this._editLevelDraft = server.competitive_level;
      const sel = this.shadow.querySelector('[data-edit-team-level]') as HTMLSelectElement | null;
      if (sel) sel.value = server.competitive_level;
    }
    if (serverWins.includes('category')) {
      this._editCategoryDraft = server.category ?? '';
      const sel = this.shadow.querySelector('[data-edit-team-category]') as HTMLSelectElement | null;
      if (sel) sel.value = this._editCategoryDraft;
    }
    if (serverWins.includes('gender')) {
      this._editGenderDraft = server.gender ?? '';
      const sel = this.shadow.querySelector('[data-edit-team-gender]') as HTMLSelectElement | null;
      if (sel) sel.value = this._editGenderDraft;
    }
    if (serverWins.includes('players')) {
      this._rosterDraft = server.players.map((p) => ({
        name: p.name,
        number: p.number === null || p.number === undefined ? '' : String(p.number),
        birth_date: '',
        birth_loaded: false,
        birth_dirty: false,
        existing: true,
        player_id: p.player_id ?? null,
      }));
      this._paintRosterRows();
      // Las fechas de nacimiento adoptadas son desconocidas — recarga los
      // perfiles para la plantilla nueva.
      if (this._editModel?.category !== undefined && this._editModel?.permissions.edit) {
        void this._loadPlayerProfiles(this._editModel.id, this._editSeq);
      }
    }
    if (serverWins.length) {
      this._editSaveMessage = 'Se incorporaron los cambios hechos en otro lugar.';
    }
    this._editSaveStatus = 'pending';
    this._updateEditStatusDom();
    return 'resolved';
  }

  // Fila de plantilla del editor compartido. La fecha de nacimiento solo
  // aparece en plantillas de club (model.category !== undefined): es dato
  // de perfil (biq-player), anclado a player_id — los equipos personales
  // no tienen ese canal.
  private _rosterRowHtml(
    p: RosterDraftRow,
    i: number,
    readOnly: boolean,
    showBirth: boolean,
  ): string {
    const off = readOnly ? ' disabled' : '';
    return `
      <div class="onboard-roster-row" data-roster-row>
        <input type="text" class="onboard-input onboard-input-sm" data-player-name="${i}" placeholder="Nombre y apellidos" aria-label="Nombre y apellidos del jugador" value="${escapeHtml(p.name)}"${off} />
        <input type="text" class="onboard-input onboard-input-sm onboard-player-num" data-player-number="${i}" placeholder="Nº" aria-label="Dorsal" inputmode="numeric" maxlength="2" value="${escapeHtml(p.number)}"${off} />
        ${showBirth ? `<input type="date" class="onboard-input onboard-input-sm onboard-player-birth" data-player-birth="${i}" aria-label="Fecha de nacimiento" value="${escapeHtml(p.birth_date)}"${off} />` : ''}
        ${readOnly ? '' : `<button class="onboard-icon-btn onboard-icon-btn-danger" data-remove-player="${i}" type="button" title="Quitar jugador" aria-label="Quitar jugador"${off}>${ICON_TRASH}</button>`}
      </div>`;
  }

  // Repinta solo las filas de plantilla tras adoptar el roster del
  // servidor — sin rebuild del modal (el usuario puede estar tecleando en
  // otro campo). El freeze impide que el focusout de las filas moribundas
  // re-siombre el draft durante la demolición.
  private _paintRosterRows(): void {
    const modal = this.shadow.querySelector('[data-edit-modal]');
    const holder = modal?.querySelector('[data-edit-roster-rows]');
    if (!holder) return;
    const readOnly = !this._editModel?.permissions.edit;
    const showBirth = !!this._editModel && this._editModel.category !== undefined;
    const rowsHtml = this._rosterDraft
      .map((p, i) => this._rosterRowHtml(p, i, readOnly, showBirth))
      .join('');
    this._editDomFreeze = true;
    try {
      holder.innerHTML = rowsHtml ||
        '<p class="onboard-card-desc onboard-roster-empty">Sin jugadores todavía — añade el primero con «Añadir jugador».</p>';
    } finally {
      this._editDomFreeze = false;
    }
    // Los botones de quitar recién pintados no tienen wiring — reengancha.
    holder.querySelectorAll('[data-remove-player]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._syncEditDraftFromDom();
        this._rosterDraft.splice(Number((btn as HTMLElement).dataset.removePlayer), 1);
        this.render();
        this._scheduleEditorSave(true);
      });
    });
  }

  // Parcheo en sitio del chip/disclaimer — nunca un re-render (un render
  // completo borraría el texto a medio teclear).
  private _updateEditStatusDom(): void {
    const chip = this.shadow.querySelector('[data-edit-save-status]');
    if (chip) {
      const status = this._editSaveStatus;
      chip.textContent = this._editSaveStatusLabel();
      chip.className = `onboard-save-chip is-${status}`;
      chip.toggleAttribute('hidden', status === 'idle');
    }
    const detail = this.shadow.querySelector('[data-edit-save-detail]');
    if (detail) {
      detail.textContent = this._editSaveMessage || '';
      detail.toggleAttribute('hidden', !this._editSaveMessage);
    }
    const retry = this.shadow.querySelector('[data-edit-retry]');
    if (retry) {
      retry.toggleAttribute('hidden',
        !(this._editSaveStatus === 'error' ||
          (this._editSaveStatus === 'conflict' && !this._editConflictServer)));
    }
    const conflictChoice = this._editSaveStatus === 'conflict' && !!this._editConflictServer;
    const keepMine = this.shadow.querySelector('[data-edit-keep-mine]');
    if (keepMine) keepMine.toggleAttribute('hidden', !conflictChoice);
    const loadServer = this.shadow.querySelector('[data-edit-load-server]');
    if (loadServer) loadServer.toggleAttribute('hidden', !conflictChoice);
  }

  // Vacía la cola antes de una transición voluntaria. Devuelve false con
  // trabajo sin persistir (validación pendiente, error, conflicto) — el
  // editor queda con su feedback. Acotado a 8 pasadas. La cola pertenece
  // al dueño capturado al entrar: si el editor cambia de identidad durante
  // un await (retirada forzada + reapertura), el flush se detiene en falso
  // y jamás decide sobre el editor nuevo.
  private _flushEditorQueue(owner = this._editOwnerNow()): Promise<boolean> {
    if (this._editFlush) return this._editFlush;
    const run = (async () => {
      for (let pass = 0; pass < 8; pass++) {
        if (!this._isEditOwner(owner)) return false;
        this._syncEditDraftFromDom();
        const pending = this._editDirty ||
          this._editSaveStatus === 'pending' ||
          this._editSaveStatus === 'error' ||
          this._editSaveStatus === 'conflict';
        if (!pending && this._editSaveStatus !== 'saving') return true;
        if (this._editSaveTimer) {
          clearTimeout(this._editSaveTimer);
          this._editSaveTimer = null;
        }
        this._queueEditorSave();
        await this._editSaveChain;
        if (!this._isEditOwner(owner)) return false;
        const s = this._editSaveStatus;
        if (s === 'error' || s === 'conflict' || s === 'pending') return false;
      }
      return this._editSaveStatus === 'saved' || this._editSaveStatus === 'idle';
    })();
    const shared = run.finally(() => {
      if (this._editFlush === shared) this._editFlush = null;
    });
    this._editFlush = shared;
    return shared;
  }

  // Contrato de carcasa (App shell), fase ADMITIR: se llama antes de
  // cualquier transición voluntaria que saque de la vista actual. Vacía la
  // cola y decide — NUNCA retira el editor: la retirada ocurre solo en
  // `commitLeave`, cuando la carcasa confirma que la transición se aplicó
  // (una navegación admitida puede morir por obsolescencia después; si
  // requestLeave retirara, un intent viejo destruiría el editor vivo).
  // `false` retiene la transición — el chip muestra el motivo y Reintentar.
  async requestLeave(grant?: unknown): Promise<boolean> {
    // Cada admisión invalida la anterior: un commit de una intención vieja
    // no debe encontrar un grant vivo sobre este editor.
    this._admittedLeaveGrant = null;
    this._admittedDraftJson = null;
    const owner = this._editOwnerNow();
    if (!owner.teamId) return true;
    if (!this._editModel?.permissions.edit) return true;
    const ok = await this._flushEditorQueue(owner);
    if (!this._isEditOwner(owner)) return false;
    if (!ok) {
      this._updateEditStatusDom();
      return false;
    }
    // El grant queda ligado a ESTA admisión concreta — commitLeave solo
    // retira si la carcasa repite el mismo token. La huella del borrador
    // se fija aquí: cambios tecleados tras la preparación no se descartan
    // en el commit — se vacían primero.
    this._admittedLeaveGrant = grant ?? null;
    this._admittedSeq = this._editSeq;
    this._syncEditDraftFromDom();
    const admittedDraft = this._editDraftPayload();
    this._admittedDraftJson = admittedDraft.ok ? this._editSnapshotJson(admittedDraft) : null;
    return true;
  }

  // Contrato de carcasa, fase COMMIT: la transición admitida se aplicó —
  // el editor se retira. `grant` debe ser el token exacto de la admisión:
  // si el elemento persistió a través de una reapertura, un commit tardío
  // de la admisión vieja no puede cerrar el editor nuevo. Si se tecleó
  // después de preparar la salida, esos cambios no se descartan: un último
  // flush y solo retira si el servidor confirma.
  // R3-D3-2: la fase es ESPERABLE — resuelve true solo cuando el editor
  // quedó retirado (o no había nada que retirar); false retiene la
  // transición (grant obsoleto, flush colgado/fallido/inválido, conflicto
  // sin decidir) y el editor conserva su estado con sus controles. La
  // carcasa revalida su intención tras el await — si el dueño se movió
  // durante el flush el commit no retira el editor nuevo.
  commitLeave(grant?: unknown): Promise<boolean> {
    if (!this._editingTeamId) return Promise.resolve(true);
    // La admisión con grant solo la consume el mismo token; una admisión
    // sin grant (caller legado) solo la consume un commit sin grant — y
    // en ambos casos exige la misma generación de editor admitida.
    if (this._admittedSeq !== this._editSeq) return Promise.resolve(false);
    if (this._admittedLeaveGrant !== null
      ? grant !== this._admittedLeaveGrant
      : grant !== undefined) return Promise.resolve(false);
    const owner = this._editOwnerNow();
    const admittedJson = this._admittedDraftJson;
    this._admittedLeaveGrant = null;
    this._admittedDraftJson = null;
    this._syncEditDraftFromDom();
    const draft = this._editDraftPayload();
    const nowJson = draft.ok ? this._editSnapshotJson(draft) : null;
    if (nowJson === admittedJson) {
      this._retireEditor();
      this.render();
      return Promise.resolve(true);
    }
    return this._flushEditorQueue(owner).then((ok) => {
      if (ok && this._isEditOwner(owner)) {
        this._retireEditor();
        this.render();
        return true;
      }
      // Retenido: el editor conserva su feedback (conflicto restablecido,
      // error con Reintentar, validación pendiente) — la carcasa no
      // desmonta ni muta la autoridad sobre un commit no confirmado.
      this._updateEditStatusDom();
      return false;
    });
  }

  // La ruta interna la aplica el módulo de forma asíncrona (puede retener
  // tras un flush): la carcasa no debe adelantar su bookkeeping — confirma
  // la ruta realmente aplicada/denegada con este evento.
  private _reportAppliedRoute(): void {
    try {
      this.dispatchEvent(new CustomEvent('biq-module:route-applied', {
        bubbles: true,
        composed: true,
        detail: { hash: window.location.hash || '' },
      }));
    } catch { /* sin carcasa escuchando — standalone */ }
  }

  // ─── navReady — acreditación de destino (transición unificada) ────────

  // Una señal por destino (`<subRoute>:<clubId>`): solo acredita si el
  // destino y el club siguen vigentes — una respuesta tardía de otra
  // pestaña o de otro club nunca cierra el ticket del actual.
  private _emitNavReady(
    state: 'content' | 'empty' | 'degraded' | 'blocked' | 'error',
    dest: string = this._subRoute,
    clubId: string = this._org?.club?.id ?? '',
  ): void {
    if (dest !== this._subRoute) return;
    // El selector no tiene club: su identidad de destino es el scope de
    // entrada (`_entryGen`) — cada resync/reentrada es un destino nuevo y
    // el guard de club no aplica (un club activo nunca puede vetarlo).
    if (dest !== 'spaces' && clubId !== (this._org?.club?.id ?? '')) return;
    const key = dest === 'spaces' ? `spaces:${this._entryGen}` : `${dest}:${clubId}`;
    if (this._navReadySent === key) return;
    this._navReadySent = key;
    try {
      this.navReady?.({ state });
    } catch { /* sin carcasa o contrato ausente — no-op */ }
  }

  // Reentrada en caliente (route aplicada por la carcasa o click de
  // pestaña con datos ya cargados): la acreditación es inmediata — el
  // destino no espera cargas que los _ensure*/load* no van a disparar.
  // Las cargas que sí se disparan emiten en su finally con la misma
  // marca (una señal por destino). 'spaces' también emite — una vez por
  // scope de entrada, nunca con un intent en vuelo (ese ticket es de home).
  private _navReadyNow(): void {
    const sub = this._subRoute;
    if (sub === 'spaces') {
      this._maybeSpacesNavReady();
    } else if (sub === 'teams') {
      this._maybeTeamsNavReady();
    } else if (sub === 'members') {
      this._maybeMembersNavReady();
    } else if (sub === 'profile') {
      this._maybeProfileNavReady();
    } else if (sub === '' || sub === 'club-details') {
      const clubId = this._org?.club?.id ?? '';
      // Sin club el 'blocked' lo emite render(); con club, el finally de
      // loadThemeData acredita salvo que la carga ya resolviera (warm).
      if (clubId && this._themeReadyClub === clubId) {
        this._emitNavReady(this._error ? 'error' : 'content');
      }
    }
  }

  private _maybeTeamsNavReady(clubId?: string): void {
    if (this._subRoute !== 'teams') return;
    const cid = clubId ?? this._org?.club?.id ?? '';
    if (this._isPersonalContext()) {
      // Contexto personal: la pestaña Equipos es el panel «Mi equipo» —
      // su dato esencial es el feed de equipos personales.
      if (this._personalTeamsStatus === 'ready') {
        this._emitNavReady(
          (this._personalTeams?.length ?? 0) > 0 ? 'content' : 'empty',
          'teams', cid,
        );
      } else if (this._personalTeamsStatus === 'error') {
        this._emitNavReady('error', 'teams', cid);
      }
      return;
    }
    if (!cid || this._myTeamsLoading || this._teamsLoading) return;
    if (this._myTeamsError) {
      this._emitNavReady('error', 'teams', cid);
      return;
    }
    // Feed de gestión caído pero selección servida — superficie parcial.
    if (this._canManageTeams() && this._teamsError) {
      this._emitNavReady('degraded', 'teams', cid);
      return;
    }
    // Sin el feed autogestionado confirmado aún no hay estado terminal.
    if (!this._myTeamsLoaded) return;
    const rows = this._canManageTeams() ? this._teams.length : this._myTeamsCatalog.length;
    this._emitNavReady(rows > 0 ? 'content' : 'empty', 'teams', cid);
  }

  private _maybeMembersNavReady(clubId?: string): void {
    if (this._subRoute !== 'members') return;
    const cid = clubId ?? this._org?.club?.id ?? '';
    if (!cid || this._membersLoading) return;
    if (!this._canManageMembers()) {
      this._emitNavReady('blocked', 'members', cid);
      return;
    }
    if (this._membersError) {
      this._emitNavReady('error', 'members', cid);
      return;
    }
    if (this._members === null) return; // aún no cargó — el finally emite
    this._emitNavReady(this._members.length > 0 ? 'content' : 'empty', 'members', cid);
  }

  private _maybeProfileNavReady(clubId?: string): void {
    if (this._subRoute !== 'profile') return;
    const cid = clubId ?? this._org?.club?.id ?? '';
    if (!cid || this._clubSummaryLoading) return;
    if (this._clubSummaryError) {
      this._emitNavReady('error', 'profile', cid);
      return;
    }
    if (!this._clubSummary) return;
    this._emitNavReady('content', 'profile', cid);
  }

  // Selector de espacios (T1 origen, ahora también destino de
  // back/historia y gestos «Cambiar de espacio»): emite cuando la
  // pantalla es terminal — bootstrap resuelto y, en scope personal, el
  // feed de equipos asentado. NUNCA con un intent de entrada en vuelo:
  // ese ticket pertenece al flujo T1 → home.
  private _maybeSpacesNavReady(): void {
    if (this._subRoute !== 'spaces') return;
    if (this._entryIntent) return;
    if (this._bootstrapLoading) return; // los finally emiten al resolver
    if (this._bootstrapFailed) {
      this._emitNavReady('error', 'spaces', '');
      return;
    }
    if (!this._bootstrap) return; // la carga aún no arrancó — render la dispara
    if (this._isPersonalContext()) {
      if (!this._personalReadAllowed()) {
        // Sesión sin autoridad personal (R1): la superficie terminal es el
        // aviso de elevación, no tarjetas.
        this._emitNavReady('blocked', 'spaces', '');
        return;
      }
      if (this._personalTeamsStatus === 'uninitialized') {
        // El resync resetea el feed — dispara la carga; su finally emite.
        this.loadPersonalTeams();
        return;
      }
      if (this._personalTeamsStatus === 'loading') return;
      if (this._personalTeamsStatus === 'error') {
        this._emitNavReady('error', 'spaces', '');
        return;
      }
    }
    this._emitNavReady('content', 'spaces', '');
  }

  // Salida voluntaria del editor (Volver / flecha de sección): vacía la
  // cola y solo entonces cierra; con fallo el editor queda visible. La
  // misma propiedad de dueño: una continuación vieja no cierra el editor
  // que se abrió después.
  private async _requestEditorClose(): Promise<void> {
    // Token por operación (R2-D3-2): retirar el editor libera el token del
    // cierre viejo — un «Volver» del editor nuevo nunca espera una petición
    // colgada del retirado; el finally solo suelta el token que lo creó.
    if (this._closingEditOp) return;
    const op: object = {};
    this._closingEditOp = op;
    try {
      const owner = this._editOwnerNow();
      const writable = !!this._editModel?.permissions.edit;
      const pending = this._editDirty ||
        this._editSaveStatus === 'pending' || this._editSaveStatus === 'saving' ||
        this._editSaveStatus === 'error' || this._editSaveStatus === 'conflict';
      if (writable && pending && owner.teamId) {
        if (this._editSaveTimer) {
          clearTimeout(this._editSaveTimer);
          this._editSaveTimer = null;
        }
        this._editSaveStatus = 'saving';
        this._updateEditStatusDom();
        const ok = await this._flushEditorQueue(owner);
        if (!this._isEditOwner(owner)) return;
        if (!ok) {
          this._updateEditStatusDom();
          const chip = this.shadow.querySelector('[data-edit-save-status]') as HTMLElement | null;
          chip?.focus?.();
          return;
        }
      }
      const refresh = this._editSavedChanges;
      this._closeEditModal();
      // Catálogos refrescados solo con el editor ya cerrado — un render
      // con el editor abierto borraría texto a medio teclear.
      if (refresh) {
        if (this._isPersonalContext()) {
          this._personalTeams = null;
          this._personalTeamsStatus = 'uninitialized';
          void this.loadPersonalTeams();
        } else {
          const clubId = this._org?.club?.id;
          if (clubId) void this.loadTeams(clubId);
        }
      }
    } finally {
      if (this._closingEditOp === op) this._closingEditOp = null;
    }
  }

  // Reintentar informado: pasa por la cadena serial, donde la bandera de
  // reconciliación fuerza la lectura-comparación antes de cualquier PUT —
  // detecta ACK perdido (cero reenvío), mezcla cambios disjuntos y exige
  // decisión explícita cuando el mismo campo divergió en ambos lados.
  // El DOM del usuario nunca se reescribe salvo campos que solo cambió el
  // servidor.
  private _reloadEditorForRetry(): void {
    if (!this._editingTeamId) return;
    this._editSaveStatus = 'saving';
    this._editSaveMessage = null;
    this._updateEditStatusDom();
    this._queueEditorSave();
  }

  // Consume the `?edit=<teamId>` deep-link intent once every teams feed has
  // settled (self-scoped selection catalog for all roles + the management
  // feed for ADMIN_ROLES). Fails closed: non-managers and unknown team ids
  // just land on the Equipos list — the pending intent never lingers.
  // Under a personal context the personal-teams feed is the readiness
  // signal (SF1 §5 — ownership, never ADMIN_ROLES).
  private _maybeOpenPendingEdit(): void {
    const teamId = this._pendingEditTeamId;
    if (!teamId || this._subRoute !== 'teams') return;
    if (this._isPersonalContext()) {
      if (this._subRoute !== 'teams') return;
      if (this._personalTeamsStatus === 'loading') return;
      if (this._personalTeams === null) {
        if (this._personalTeamsStatus === 'uninitialized') this.loadPersonalTeams();
        return;
      }
      this._pendingEditTeamId = null;
      const row = this._personalTeams.find((t) => t.team_id === teamId);
      if (row && !row.archived) this._openEditModal(teamId, true);
      return;
    }
    if (this._myTeamsLoading || this._teamsLoading) return;
    if (!this._myTeamsLoaded && this._teams.length === 0) {
      // Managers wait for the management feed; if the self-scoped fetch
      // already failed and no management load is possible, don't drain yet —
      // the retry path will settle it. Only a confirmed empty catalog
      // resolves to the plain list.
      if (this._canManageTeams() && !this._teamsError) return;
    }
    this._pendingEditTeamId = null;
    if (
      this._canManageTeams() &&
      this._mergedCatalog().some((t) => t.id === teamId)
    ) {
      // Same entry point as the «Plantilla» row action — roster focus.
      this._openEditModal(teamId, true);
    }
  }

  private _closeEditModal(): void {
    this._editingTeamId = null;
    this._editModel = null;
    this._editLoading = false;
    this._editSeq += 1; // an in-flight load landing after close is stale
    this._editNameDraft = '';
    this._editCategoryDraft = '';
    this._editGenderDraft = '';
    this._editLevelDraft = '';
    this._rosterDraft = [];
    this._addPlayerPickerOpen = false;
    this._rosterFocus = false;
    this._editError = null;
    if (this._editSaveTimer) {
      clearTimeout(this._editSaveTimer);
      this._editSaveTimer = null;
    }
    this._editSaveChain = Promise.resolve();
    this._editDirty = false;
    this._editSaveStatus = 'idle';
    this._editSaveMessage = null;
    this._editFlush = null;
    this._editSavedChanges = false;
    this._pendingRouteValue = null;
    this._admittedLeaveGrant = null;
    this._admittedDraftJson = null;
    this._editSentSnapshot = null;
    this._editNeedsReconcile = false;
    this._editConflictServer = null;
    this.render();
    // The ?edit=<id> intent is consumed once — drop it from the hash so a
    // refresh or back-forward doesn't reopen the modal (replaceState, no
    // hashchange; same pattern biq-playbook uses for internal nav sync).
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx >= 0) {
      const params = new URLSearchParams(hash.slice(qIdx + 1));
      if (params.has('edit')) {
        params.delete('edit');
        const query = params.toString();
        history.replaceState(null, '', `${hash.slice(0, qIdx)}${query ? `?${query}` : ''}`);
        this._reportAppliedRoute();
      }
    }
  }

  // Flush the open modal's DOM into the draft fields — the single place
  // where live input values are captured.
  private _syncEditDraftFromDom(): void {
    if (this._editDomFreeze) return;
    const modal = this.shadow.querySelector('[data-edit-modal]');
    if (!modal) return;
    const nameInput = modal.querySelector('[data-edit-team-name]') as HTMLInputElement | null;
    const levelSel = modal.querySelector('[data-edit-team-level]') as HTMLSelectElement | null;
    const catSel = modal.querySelector('[data-edit-team-category]') as HTMLSelectElement | null;
    const genderSel = modal.querySelector('[data-edit-team-gender]') as HTMLSelectElement | null;
    if (nameInput) this._editNameDraft = nameInput.value;
    if (levelSel) this._editLevelDraft = levelSel.value;
    if (catSel) this._editCategoryDraft = catSel.value;
    if (genderSel) this._editGenderDraft = genderSel.value;
    modal.querySelectorAll('[data-roster-row]').forEach((row, i) => {
      const pname = row.querySelector('[data-player-name]') as HTMLInputElement | null;
      const pnum = row.querySelector('[data-player-number]') as HTMLInputElement | null;
      const pbirth = row.querySelector('[data-player-birth]') as HTMLInputElement | null;
      if (!this._rosterDraft[i]) {
        this._rosterDraft[i] = {
          name: '', number: '', birth_date: '',
          birth_loaded: false, birth_dirty: false,
          existing: false, player_id: null,
        };
      }
      this._rosterDraft[i].name = pname?.value ?? '';
      this._rosterDraft[i].number = pnum?.value ?? '';
      // Solo existe el input en plantillas de club; un cambio respecto al
      // valor cargado marca la fecha como editada por el usuario (es lo
      // que la sincronización de perfiles escribe tras el save).
      if (pbirth) {
        const birth = pbirth.value;
        if (birth !== this._rosterDraft[i].birth_date) {
          this._rosterDraft[i].birth_dirty = true;
        }
        this._rosterDraft[i].birth_date = birth;
      }
    });
  }

  // Focus handoff after a render triggered with _rosterFocus: land on the
  // last roster name input (the new row from «Añadir jugador», or the first
  // when «Plantilla» opened the modal), else on the add button itself.
  private _maybeFocusRoster(): void {
    if (!this._rosterFocus) return;
    const modal = this.shadow.querySelector('[data-edit-modal]');
    // The async load renders the modal shell before the roster rows —
    // keep the intent until the model lands or the modal is gone.
    if (!modal || this._editLoading || !this._editModel) return;
    this._rosterFocus = false;
    const rows = modal.querySelectorAll('[data-roster-row] [data-player-name]');
    const target = (rows.length
      ? rows[rows.length - 1]
      : modal.querySelector('[data-add-player]')) as HTMLElement | null;
    target?.focus();
  }

  // Global nav contract §C — the section subhead's sticky top offset.
  // Priority: the shell provider's --biq-shell-chrome-top custom property
  // (chrome height while shown, 0 while collapsed/hidden — it already
  // carries the collapsed math, so an inherited value wins verbatim) >
  // body[data-shell-chrome="collapsed"|"hidden"] → 0 > the measured
  // legacy sticky header > standalone env(safe-area-inset-top) via the
  // CSS fallback. Read-only on shell DOM — never manipulates chrome.
  private _syncSubheadTop(): void {
    const provided = getComputedStyle(this)
      .getPropertyValue('--biq-shell-chrome-top').trim();
    const chrome = document.body?.dataset.shellChrome || '';
    const header = document.getElementById('shell-header');
    if (provided) {
      this.style.setProperty('--biq-subhead-top', provided);
    } else if (chrome === 'collapsed' || chrome === 'hidden') {
      this.style.setProperty('--biq-subhead-top', '0px');
    } else if (!header || header.hidden) {
      // No visible shell header: standalone/dev keeps the device inset;
      // embedded chrome-free states (no-club) pin to the viewport top.
      this.style.setProperty('--biq-subhead-top', !header && !chrome
        ? 'env(safe-area-inset-top, 0px)'
        : '0px');
    } else {
      this.style.setProperty('--biq-subhead-top',
        `${Math.ceil(header.getBoundingClientRect().height)}px`);
    }
  }

  // Which detail/editor subscreen (if any) is currently paintable. Single
  // fail-closed resolver shared by render() and the section renderers —
  // unresolved ids or unauthorized roles never produce a subscreen.
  private _activeSubscreen(): 'team-edit' | 'member-edit' | null {
    // SF1: under a personal context the roster editor shares the club
    // editor's subscreen — authority is the live own-workspace context
    // plus the port's typed load, never ADMIN_ROLES or a catalog row.
    if (this._isPersonalContext()) {
      if (this._subRoute === 'teams' && this._editingTeamId
          && (this._editLoading || this._editModel?.id === this._editingTeamId)) {
        return 'team-edit';
      }
      return null;
    }
    if (this._subRoute === 'teams' && this._canManageTeams() && this._editingTeamId
        && (this._editLoading || this._editModel?.id === this._editingTeamId)) {
      return 'team-edit';
    }
    if (this._subRoute === 'members' && this._canManageMembers() && this._editingMemberId
        && (this._members || []).some(
          (m) => m.id === this._editingMemberId && this._memberCanEdit(m))) {
      return 'member-edit';
    }
    return null;
  }

  // Canonical orange section subheader — present on EVERY club-selected
  // Mi Club view (Product addendum 2026-10-02 §2), absent in no-club.
  // `context` carries secondary identity (team/member name) on editor
  // subscreens without replacing the bold parent title. `backAriaLabel`
  // is null on the Mi Club landing (already at the section Home).
  // [data-section-back] is wired centrally in render() to the
  // deterministic list route — never history.back() and never app Home
  // (contract §C).
  private _renderSectionSubhead(spec: { title: string; context: string; backLabel: string | null }): string {
    const back = spec.backLabel === null ? '' : `<button type="button" class="onboard-subhead-back" data-section-back
        title="${escapeHtml(spec.backLabel)}" aria-label="${escapeHtml(spec.backLabel)}">${ICON_BACK}</button>`;
    const context = spec.context ? `<span class="onboard-subhead-context">${escapeHtml(spec.context)}</span>` : '';
    return `<header class="onboard-subhead" data-section-subhead>
      ${back}
      <span class="onboard-subhead-title"><strong>${escapeHtml(spec.title)}</strong>${context}</span>
    </header>`;
  }

  // Product addendum title matrix: «Mi Club» on the landing (bare
  // #/onboard) and «Mi Club: <section>» on Estilo/Equipos/Miembros/
  // Perfil. Editor subscreens keep the parent title; the team/member
  // name rides as secondary context.
  private _subheadSpec(section: string, canManageMembers: boolean): { title: string; context: string; backLabel: string | null } {
    const sub = this._activeSubscreen();
    if (sub === 'team-edit') {
      const team = this._mergedCatalog().find((t) => t.id === this._editingTeamId);
      return { title: 'Mi Club: Equipos', context: team?.name || '', backLabel: 'Volver a Equipos' };
    }
    if (sub === 'member-edit') {
      const member = (this._members || []).find((m) => m.id === this._editingMemberId);
      return { title: 'Mi Club: Miembros', context: member?.display_name || member?.email || member?.id || '', backLabel: 'Volver a Miembros' };
    }
    const view = this._subRoute === '' ? 'landing'
      : section === 'teams' ? 'teams'
      : section === 'members' && canManageMembers ? 'members'
      : section === 'profile' ? 'profile'
      : 'club-details';
    const title = {
      landing: 'Mi Club',
      'club-details': 'Mi Club: Identidad',
      teams: 'Mi Club: Equipos',
      members: 'Mi Club: Miembros',
      profile: 'Mi Club: Perfil',
    }[view]!;
    return { title, context: '', backLabel: view === 'landing' ? null : 'Volver a Mi Club' };
  }

  // Section back semantics (addendum §3): editors return to their section
  // list through the existing close paths; list views return to the Mi
  // Club landing. Module-local + deterministic — never history.back()
  // and never app Home («#/»).
  private _sectionBack(): void {
    const sub = this._activeSubscreen();
    if (sub === 'team-edit') {
      void this._requestEditorClose();
      return;
    }
    if (sub === 'member-edit') {
      this._editingMemberId = null;
      this.render();
      return;
    }
    this._subRoute = '';
    this.render();
    if ((window.location.hash || '') !== '#/onboard') {
      history.replaceState(null, '', '#/onboard');
      this._reportAppliedRoute();
    }
    this._navReadyNow();
  }

  // F12: Mirror of _maybeStartPolling for the seeding job — same 3s initial
  // backoff, ×1.5 bounded at 30s, and the same staleness threshold.
  private _maybeStartSeedingPolling(clubId: string): void {
    if (this._teamSeedingJob?.status !== 'pending') {
      this._stopSeedingPolling();
      return;
    }
    if (this._seedingPollStartedAt > 0 && (Date.now() - this._seedingPollStartedAt) > this._staleThresholdMs) {
      this._seedingStale = true;
      this._stopSeedingPolling();
      this.render();
      return;
    }
    if (this._seedingPollTimer) {
      clearTimeout(this._seedingPollTimer);
      this._seedingPollTimer = null;
    }
    if (this._seedingPolling) return;
    if (this._seedingPollingClubId !== clubId) {
      this._seedingPollingClubId = clubId;
      this._seedingPollBackoff = 3000;
      this._seedingPollStartedAt = Date.now();
      this._seedingStale = false;
    }
    if (this._seedingPollStartedAt === 0) {
      this._seedingPollStartedAt = Date.now();
    }
    this._seedingPollTimer = setTimeout(() => this._pollTeamSeeding(clubId), this._seedingPollBackoff);
  }

  private _stopSeedingPolling(): void {
    if (this._seedingPollTimer) {
      clearTimeout(this._seedingPollTimer);
      this._seedingPollTimer = null;
    }
    this._seedingPollingClubId = null;
    this._seedingPolling = false;
    this._seedingPollBackoff = 3000;
    this._seedingPollStartedAt = 0;
  }

  private async _pollTeamSeeding(clubId: string): Promise<void> {
    if (!this.isConnected || this._seedingPollingClubId !== clubId) {
      this._seedingPollTimer = null;
      return;
    }
    this._seedingPollTimer = null;
    this._seedingPolling = true;
    try {
      await this._loadTeamSeeding(clubId);
      if (this._teamSeedingJob?.status !== 'pending') {
        this._seedingPolling = false;
        this._stopSeedingPolling();
        // Terminal state — reload the team list so 'done' shows the catalog.
        await this.loadTeams(clubId);
        return;
      }
      this._seedingPolling = false;
      this._seedingPollBackoff = 3000;
      this._maybeStartSeedingPolling(clubId);
      this.render();
    } catch {
      this._seedingPolling = false;
      this._seedingPollBackoff = Math.min(this._seedingPollBackoff * 1.5, 30000);
      this._maybeStartSeedingPolling(clubId);
    }
  }

  // B14/C11: Poll only pending/running with bounded backoff.
  // C11 fixes: clear timer before rescheduling, prevent overlap, handle
  // disconnect/visibility/route change, guard stale responses.
  private _maybeStartPolling(clubId: string): void {
    const status = this._themeJob?.status;
    // Stop on terminal states
    if (status !== 'pending' && status !== 'running') {
      this._stopPolling();
      return;
    }
    // F5: Staleness check — if we've been polling for longer than the
    // threshold without a terminal callback, mark as stale and stop.
    // Cloud Tasks retries asynchronously (maxAttempts: 0 = unbounded) and
    // the job may never reach a terminal state from the caller's side.
    if (this._pollStartedAt > 0 && (Date.now() - this._pollStartedAt) > this._staleThresholdMs) {
      this._isStale = true;
      this._stopPolling();
      this.render();
      return;
    }
    // C11: Clear timer before checking to avoid the "truthy timer" deadlock
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    // Prevent overlap — don't schedule if a poll is in-flight
    if (this._polling) return;
    // Club changed — reset backoff and staleness
    if (this._pollingClubId !== clubId) {
      this._pollingClubId = clubId;
      this._pollBackoff = 3000;
      this._pollStartedAt = Date.now();
      this._isStale = false;
    }
    // Record start time if not yet set
    if (this._pollStartedAt === 0) {
      this._pollStartedAt = Date.now();
    }
    this._pollTimer = setTimeout(() => this._pollTheme(clubId), this._pollBackoff);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._pollingClubId = null;
    this._polling = false;
    this._pollBackoff = 3000;
    // F5: Don't reset _isStale here — it's reset when a new poll starts
    // or when a new generation is triggered. _stopPolling is called on
    // terminal states too, and we want to preserve the stale flag for
    // rendering until the user explicitly retries.
    this._pollStartedAt = 0;
  }

  // C11: Lifecycle — stop polling on disconnect, resume on reconnect
  disconnectedCallback(): void {
    this._stopPolling();
    this._stopSeedingPolling();
    // D20: invalidate in-flight submissions and abort stale responses.
    this._clubSubmitSeq += 1;
    if (this._clubSubmitAbort) {
      this._clubSubmitAbort.abort();
      this._clubSubmitAbort = null;
    }
    // OB60-3: a detached component must not keep retrying the personal
    // feed — fence + abort it like the club submit path.
    this._resetPersonalFeed();
    // Unmount retires the entry intent scope as well: continuations check
    // isConnected + generation, and the confirm timer must not outlive it.
    this._invalidateEntryScope();
    // Remove visibility handler
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._shellChromeObserver) {
      this._shellChromeObserver.disconnect();
      this._shellChromeObserver = null;
    }
    if (this._beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
      this._beforeUnloadHandler = null;
    }
    // Desmontaje (logout/teardown/remount): el borrador y la cola son del
    // principal que los creó — purga completa, nunca arrastrados.
    this._retireEditor();
  }

  connectedCallback(): void {
    this._beforeUnloadHandler = (e: BeforeUnloadEvent) => {
      const pending = this._editDirty ||
        this._editSaveStatus === 'pending' || this._editSaveStatus === 'saving' ||
        this._editSaveStatus === 'error' || this._editSaveStatus === 'conflict';
      if (pending && this._editingTeamId && this._editModel?.permissions.edit) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', this._beforeUnloadHandler);
    // C11: Resume polling on visibility/entry if theme job is pending/running
    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        if (this._pollingClubId) {
          const clubId = this._pollingClubId;
          this._pollingClubId = null; // force reschedule
          this._maybeStartPolling(clubId);
        }
        if (this._seedingPollingClubId) {
          const clubId = this._seedingPollingClubId;
          this._seedingPollingClubId = null; // force reschedule
          this._maybeStartSeedingPolling(clubId);
        }
      } else if (document.visibilityState === 'hidden') {
        // C11: Stop polling when page is hidden
        if (this._pollTimer) {
          clearTimeout(this._pollTimer);
          this._pollTimer = null;
        }
        if (this._seedingPollTimer) {
          clearTimeout(this._seedingPollTimer);
          this._seedingPollTimer = null;
        }
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
    // Global nav contract §2 — follow the shell provider's chrome state so
    // the section subhead stays below the header while shown and pins to
    // the viewport top once chrome collapses (read-only observation).
    if (!this._shellChromeObserver && document.body) {
      this._shellChromeObserver = new MutationObserver(() => this._syncSubheadTop());
      this._shellChromeObserver.observe(document.body, {
        attributes: true, attributeFilter: ['data-shell-chrome'],
      });
    }
  }

  private async _pollTheme(clubId: string): Promise<void> {
    // C11: Stop if component disconnected or club changed
    if (!this.isConnected || this._pollingClubId !== clubId) {
      this._pollTimer = null;
      return;
    }
    // C11: Clear timer before polling to allow rescheduling
    this._pollTimer = null;
    this._polling = true;
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      // C11: On non-OK, retry with backoff (don't just return)
      if (!res.ok) {
        this._polling = false;
        // C11: Bounded backoff — max 30s
        this._pollBackoff = Math.min(this._pollBackoff * 1.5, 30000);
        this._maybeStartPolling(clubId);
        return;
      }
      const data = await res.json();
      // C11: Guard stale responses — check club ID matches
      const responseClubId = data.themeJob?.clubId || data.theme?.clubId;
      if (responseClubId && responseClubId !== clubId) {
        this._polling = false;
        return; // stale response for a different club
      }
      const prevStatus = this._themeJob?.status;
      const prevThemeStatus = this._theme?.status;
      const pollJobStatus = data.themeJob?.status || '';
      if (this._awaitingNewJob && (pollJobStatus === 'pending' || pollJobStatus === 'running')) {
        // Issue #31: Keep previous theme preview displayed during polling
        this._theme = this._theme || data.theme || null;
        this._themeJob = data.themeJob || null;
      } else {
        this._awaitingNewJob = false;
        this._loading = false; // reset loading on terminal state
        this._theme = data.draftTheme || data.theme || null;
        this._themeJob = data.themeJob || null;
      }
      const newStatus = this._themeJob?.status;
      const newThemeStatus = this._theme?.status;
      // B15: emit event on status change
      if (prevStatus !== newStatus || prevThemeStatus !== newThemeStatus) {
        this._emitThemeStateEvent(clubId);
      }
      this._polling = false;
      // Reset backoff on successful poll
      this._pollBackoff = 3000;
      // Continue polling if still pending/running
      this._maybeStartPolling(clubId);
      this.render();
    } catch {
      // C11: On network error, retry with backoff instead of stopping
      this._polling = false;
      this._pollBackoff = Math.min(this._pollBackoff * 1.5, 30000);
      this._maybeStartPolling(clubId);
    }
  }

  // B15: Emit composed/bubbling state event for shell refresh
  private _emitThemeStateEvent(clubId: string): void {
    const status = this._themeJob?.status || 'none';
    const themeStatus = this._theme?.status || null;
    this.dispatchEvent(new CustomEvent('biq-theme-state', {
      bubbles: true,
      composed: true,
      detail: { clubId, state: status, themeStatus },
    }));
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  private async generateTheme(clubId: string, url: string): Promise<void> {
    this._loading = true;
    this._error = null;
    // F5: Reset staleness flag when a new generation is triggered
    this._isStale = false;
    this._pollStartedAt = 0;
    // F5: Clear previous theme/job state so stale errors and branding
    // cards from a prior generation don't persist into the new one.
    // Keep the current preview while the replacement is prepared.
    this._awaitingNewJob = true;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homepage_url: url }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  private async revertTheme(clubId: string): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  private async affirmLogoRights(clubId: string): Promise<void> {
    // Logo rights affirmation (ADDENDUM-06 §C3)
    this._loading = true;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/logo-rights`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affirmed: true }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  private async updateLogoUrl(clubId: string, logoUrl: string): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/logo`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo_url: logoUrl }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  private async uploadLogoFile(clubId: string, file: File): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/clubs/${clubId}/theme/logo/upload`, {
        method: 'PUT',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  // B14: Activate a draft/uncertain theme
  private async activateTheme(clubId: string, restorePrevious = false): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/activate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, restore_previous: restorePrevious, expected_revision: this._themeJob?.revision }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `HTTP ${res.status}`);
      }
      delete this._identityColours[clubId];
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  // Issue #31: Deactivate an active theme non-destructively
  private async deactivateTheme(clubId: string): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/deactivate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  // B14: Retry a failed theme generation
  private async retryTheme(clubId: string): Promise<void> {
    this._loading = true;
    this._error = null;
    // F5: Reset staleness flag when retrying
    this._isStale = false;
    this._pollStartedAt = 0;
    // F5: Clear previous theme/job state so stale errors and branding
    // cards from a prior run don't persist into the retry.
    // Keep the current preview while the replacement is prepared.
    this._awaitingNewJob = true;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/retry`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  // Un solo punto de repintado: el flag congela _syncEditDraftFromDom
  // durante la demolición del DOM (el focusout del input destruido no
  // puede resembrar filas eliminadas ni releer inputs a medio morir).
  private _paint(html: string): void {
    this._editDomFreeze = true;
    try {
      this.shadow.innerHTML = html;
    } finally {
      this._editDomFreeze = false;
    }
  }

  private render(): void {
    const club = this._org?.club;
    // R6: el selector de espacios es alcanzable en TODAS las cohortes —
    // un miembro con club activo o una sesión con contexto personal
    // también puede cambiar de espacio desde #/onboard/spaces. Solo la
    // ausencia real de autoridad cae a la vista legacy.
    if (this._subRoute === 'spaces') {
      if (this._bootstrap && !this._bootstrapFailed) {
        this._paint(`<style>${styles}</style>
          <div class="onboard-app onboard-clubstep">${this.renderEntryStep()}</div>`);
        this.wireEntryEvents();
        return;
      }
      if (!this._bootstrapFailed) {
        if (!this._bootstrapLoading) this.loadBootstrap();
        this._paint(`<style>${styles}</style>
          <div class="onboard-app onboard-clubstep"><p class="entry-loading">Cargando…</p></div>`);
        return;
      }
      // Sin autoridad de contexto no hay selector — la vista legacy sigue.
    }
    // Working context (BIQ-PERSONAL-CLUB-CONTEXT): con contexto activo el
    // módulo refleja su ámbito — personal muestra el espacio privado; club
    // sigue el Mi Club de siempre.
    if (this._context?.owner_scope?.kind === 'personal') {
      // SF1: the roster editor IS the club editor — same renderer and
      // handler set, personal adapter. It replaces the teams host while
      // open; closing lands back on the personal panel (never an
      // unrelated workspace-settings surface).
      if (this._activeSubscreen() === 'team-edit') {
        this._paint(`<style>${styles}</style>
          <div class="onboard-app">${this._editLoading || !this._editModel
            ? this._renderTeamEditLoading()
            : this._renderTeamEditScreen(this._editModel)}</div>`);
        this._wireTeamEditorEvents();
        this._maybeFocusRoster();
        return;
      }
      this._paint(`<style>${styles}</style>
        <div class="onboard-app">${this.renderPersonalPanel()}</div>`);
      this.wirePersonalEvents();
      return;
    }
    if (!club) {
      if (this._bootstrapLoading) {
        this._paint(`<style>${styles}</style>
          <div class="onboard-app onboard-clubstep"><p class="entry-loading">Cargando…</p></div>`);
        return;
      }
      if (this._bootstrap && !this._bootstrapFailed) {
        // Context entry selector: dos pestañas (personal / club) sobre el
        // bootstrap autoritativo — no hay club resuelto pero sí estado.
        this._paint(`<style>${styles}</style>
          <div class="onboard-app onboard-clubstep">${this.renderEntryStep()}</div>`);
        this.wireEntryEvents();
        // Sin club resuelto el destino Mi club queda bloqueado — estado
        // terminal honesto (la autoridad la aporta la entrada, no este
        // módulo); las pintas «Cargando…» no emiten: no son terminales.
        this._emitNavReady('blocked');
        return;
      }
      if (!this._bootstrapFailed) {
        this.loadBootstrap();
        this._paint(`<style>${styles}</style>
          <div class="onboard-app onboard-clubstep"><p class="entry-loading">Cargando…</p></div>`);
        return;
      }
      // ADDENDUM-07 §6 — paso de club: sin club resuelto este módulo ES el
      // paso 2 del onboarding (picker / unirse por ID / crear club).
      this._paint(`<style>${styles}</style>
        <div class="onboard-app onboard-clubstep">${this.renderClubStep()}</div>`);
      this.wireClubStepEvents();
      this._emitNavReady('blocked');
      return;
    }

    // Route determines which view to show
    const section = this._subRoute || 'club-details';
    const canManageMembers = ADMIN_ROLES.includes(this._org?.role || '');
    // Detail/editor subscreens replace the section nav with the sticky
    // orange subheader (contract §C) — the sibling tab bar must not show.
    const inSubscreen = this._activeSubscreen() !== null;
    let content = '';
    if (section === 'profile') {
      content = this.renderProfile();
    } else if (section === 'teams') {
      content = this.renderTeamsTab();
    } else if (section === 'members' && canManageMembers) {
      content = this.renderMembers(club.id);
    } else {
      content = this.renderClubDetails(club);
    }

    this._paint(`<style>${styles}</style>
      <div class="onboard-app">
        ${section === 'club-details' && !inSubscreen ? '' : this._renderSectionSubhead(this._subheadSpec(section, canManageMembers))}
        ${inSubscreen ? '' : `<nav class="onboard-nav">
          <button class="onboard-nav-item ${section === 'club-details' ? 'active' : ''}" data-nav="club-details">Identidad</button>
          <button class="onboard-nav-item ${section === 'teams' ? 'active' : ''}" data-nav="teams">Equipos</button>
          ${canManageMembers ? `<button class="onboard-nav-item ${section === 'members' ? 'active' : ''}" data-nav="members">Miembros</button>` : ''}
          <button class="onboard-nav-item ${section === 'profile' ? 'active' : ''}" data-nav="profile">Perfil</button>
          <button class="onboard-nav-item" data-nav="spaces">Espacios</button>
        </nav>`}
        ${content}
      </div>`);
    // One subhead per render — the back wiring resolves the destination
    // from live state (editor close paths vs. list → Mi Club landing).
    this.shadow.querySelector('[data-section-back]')?.addEventListener('click', () => this._sectionBack());
    if (section === 'teams') {
      this.wireTeamsEvents(club.id);
      this._maybeFocusRoster();
    } else if (section === 'members' && canManageMembers) {
      this.wireMembersEvents(club.id);
    } else {
      this.wireEvents(club.id);
    }
    this._syncSubheadTop();
  }

  private renderClubDetails(club: { id: string; name?: string; website?: string }): string {
    const website = club.website || '';
    const theme = this._theme;
    const job = this._themeJob;
    // B14: themeJob state matrix
    const jobStatus = job?.status || '';
    const jobCopy = jobStatus ? THEME_JOB_COPY[jobStatus] : null;
    const isPolling = jobStatus === 'pending' || jobStatus === 'running';
    // F5: Allow retry when the job is in a terminal failed state OR when
    // the staleness timeout has fired (job stuck pending/running without
    // a terminal callback for > _staleThresholdMs).
    // Note: "uncertain" is excluded — when a theme was extracted (even with
    // low confidence), the admin can activate/deactivate it directly via the
    // activation toggle. No retry needed.
    const canRetry = jobStatus === 'failed' || jobStatus === 'unreachable' || jobStatus === 'rejected_not_a_club' || jobStatus === 'unsupported_source' || this._isStale;

    return `
      <section class="onboard-section identity-editor">
        <h2 class="onboard-section-title">${escapeHtml(club.name || 'Mi club')}</h2>

        ${this._error ? `<div class="onboard-error">${escapeHtml(this._error)}</div>` : ''}

        <div class="onboard-card">
          <h3 class="onboard-card-title">Identidad visual</h3>
          <p class="onboard-card-desc">Obtén una propuesta desde la web de tu club o elige tus colores. Revísala antes de aplicarla.</p>
          <div class="onboard-form-row">
            <input type="url" class="onboard-input" data-website-input value="${escapeHtml(website)}" placeholder="https://www.miclub.com" ${this._loading || (isPolling && !this._isStale) ? 'disabled' : ''} />
            <button class="onboard-btn onboard-btn-primary" data-generate-btn ${this._loading || (isPolling && !this._isStale) ? 'disabled' : ''}>
              ${isPolling && !this._isStale ? 'Procesando…' : this._loading ? 'Generando…' : 'Proponer identidad'}
            </button>
          </div>
        </div>

        ${jobCopy && !(jobStatus === 'succeeded' && theme?.status !== 'active') && !(jobStatus === 'uncertain' && theme) ? `
          <div class="onboard-card onboard-theme-job-state" data-job-state="${jobStatus}">
            <h3 class="onboard-card-title">${escapeHtml(jobCopy.title)}</h3>
            <p class="onboard-card-desc">${escapeHtml(jobCopy.description)}</p>
            ${jobCopy.action && !isPolling ? `<p class="onboard-card-action">${escapeHtml(jobCopy.action)}</p>` : ''}
            ${isPolling && !this._isStale ? '<div class="onboard-loading">Procesando…</div>' : ''}
            ${isPolling && this._isStale ? '<div class="onboard-error">El proceso está tardando demasiado. Puedes reintentar.</div>' : ''}
            ${canRetry ? `<button class="onboard-btn onboard-btn-primary" data-retry-btn ${this._loading ? 'disabled' : ''}>Reintentar</button>` : ''}
          </div>
        ` : ''}

        ${this._loading && !theme && !jobCopy ? '<div class="onboard-loading">Cargando…</div>' : ''}

        ${ADMIN_ROLES.includes(this._org?.role || '') ? `${this.renderLogoSection(theme)}${this.renderIdentityEditor(club.id)}${theme ? this.renderActivationToggle(theme, isPolling) : ''}` : '<p class="onboard-card-desc">La identidad del club la gestiona un administrador.</p>'}
      </section>`;
  }

  private renderIdentityEditor(clubId: string): string {
    const hex = (v: string | null | undefined, fallback: string) => /^#[0-9a-f]{6}$/i.test(v || '') ? v! : fallback;
    const colours = this._identityColours[clubId] || { brand: hex(this._theme?.seed?.brand, '#123456'), alt: hex(this._theme?.seed?.brandAlt, '#ffffff') };
    const previews = (['light', 'dark'] as const).map(mode => {
      const t = this._theme?.tokens?.[mode];
      const bg = mode === 'light' ? '#f4f6fa' : '#080d1a';
      const fg = mode === 'light' ? '#0d1735' : '#f4f6fb';
      const header = hex(t?.['--biq-color-surface-inverse'], '#0a153a');
      const text = hex(t?.['--biq-color-inverse-text'], '#ffffff');
      const tint = hex(t?.['--biq-color-brand-tint'], bg);
      const onTint = hex(t?.['--biq-color-on-brand-tint'], fg);
      const logo = mode === 'light' ? this._theme?.logo?.onLight : this._theme?.logo?.onDark || this._theme?.logo?.onLight;
      return `<div class="identity-preview" style="background:${bg};color:${fg}"><span>${mode === 'light' ? 'Claro' : 'Oscuro'}</span><div class="identity-preview-header" style="background:${header};color:${text}">${logo ? `<img src="${escapeHtml(logo)}" alt="Escudo en vista previa">` : ''}${escapeHtml(this._org?.club?.name || 'Tu club')}</div><p>Planifica la próxima jugada.</p><p class="identity-preview-selection" style="background:${tint};color:${onTint}">Objetivo seleccionado</p><button type="button" tabindex="-1" aria-disabled="true">Añadir</button></div>`;
    }).join('');
    return `<div class="onboard-card"><h3 class="onboard-card-title">Colores del club</h3><p class="onboard-card-desc">Elige principal y secundario. El fondo y el texto se adaptan a cada modo; las acciones conservan el naranja de BasketSpark.</p><div class="identity-colours"><label>Principal <input aria-label="Color principal" type="color" data-identity-brand value="${colours.brand}"></label><label>Secundario <input aria-label="Color secundario" type="color" data-identity-alt value="${colours.alt}"></label></div><div class="identity-variants">${[['standard', 'Preparar vista previa'], ['contrast', 'Más contraste'], ['soft', 'Más suave']].map(([id, label]) => `<button class="onboard-btn ${id === 'standard' ? 'onboard-btn-primary' : 'onboard-btn-secondary'}" data-identity-variant="${id}" ${this._loading ? 'disabled' : ''}>${label}</button>`).join('')}</div><p class="onboard-card-desc" role="status">${this._theme?.tokens ? 'Vista previa de la última propuesta calculada. Prepara una nueva vista previa para comprobar tus cambios.' : 'Prepara una propuesta para comprobar los colores antes de aplicar.'}</p><div class="identity-previews">${previews}</div></div>`;
  }

  private renderActivationToggle(theme: ClubTheme, isPolling: boolean = false): string {
    const active = theme.status === 'active';
    const edited = this._identityColours[this._org?.club?.id || ''];
    const dirty = edited && (edited.brand.toLowerCase() !== theme.seed?.brand?.toLowerCase() || edited.alt.toLowerCase() !== theme.seed?.brandAlt?.toLowerCase());
    const ready = theme.gate?.passed === true && !isPolling && !this._loading && !dirty;
    return `<div class="onboard-card"><h3 class="onboard-card-title">${active ? 'Identidad aplicada' : 'Tu propuesta'}</h3><p class="onboard-card-desc">${active ? 'Visible para los miembros del club.' : 'Comprueba el escudo y las vistas clara y oscura antes de aplicar. La identidad actual se conserva hasta entonces.'}</p><button class="onboard-btn onboard-btn-primary" data-identity-apply ${!ready || active ? 'disabled' : ''}>Aplicar identidad</button>${active ? `<button class="onboard-btn" data-identity-default ${this._loading || isPolling ? 'disabled' : ''}>Usar identidad BasketSpark</button>` : ''}${this._themeJob?.previousTheme ? `<button class="onboard-btn" data-identity-restore ${this._loading || isPolling ? 'disabled' : ''}>Restaurar identidad anterior</button>` : ''}${dirty ? '<p role="status">Hay cambios de color pendientes de preparar.</p>' : ''}${theme.gate?.passed === false ? '<p role="status">Prepara la vista previa para validar el contraste antes de aplicar.</p>' : ''}</div>`;
  }

  private renderLogoSection(theme: ClubTheme | null): string {
    const logo = theme?.logo;
    const logoSrc = logo?.onLight ?? null;
    const awaitingRights = logo && !logo.rightsConfirmedAt;
    return `
      <div class="onboard-card">
        <h3 class="onboard-card-title">Logo del club</h3>
        ${logoSrc ? `<img class="onboard-logo-preview" src="${escapeHtml(logoSrc)}" alt="Logo" />` : '<p class="onboard-card-desc">No se encontró logo automáticamente.</p>'}
        <div class="onboard-logo-input-group">
          <input type="url" class="onboard-logo-input" data-logo-url-input placeholder="https://www.club.com/logo.png" />
          <button class="onboard-btn onboard-btn-primary" data-logo-url-btn ${this._loading ? 'disabled' : ''}>Actualizar logo</button>
        </div>
        <div class="onboard-logo-upload-group">
          <label class="onboard-file-label">
            <input type="file" accept="image/*" data-logo-file-input ${this._loading ? 'disabled' : ''} />
            <span class="onboard-btn">Subir archivo</span>
          </label>
        </div>
        ${logoSrc && awaitingRights ? `
          <div class="onboard-rights">
            <p class="onboard-rights-text">Para mostrar el logo necesitas confirmar que el club tiene derecho a usarlo.</p>
            <label class="onboard-rights-label">
              <input type="checkbox" data-rights-checkbox />
              <span>Confirmo que el club puede usar este logo</span>
            </label>
            <button class="onboard-btn onboard-btn-primary" data-affirm-rights-btn disabled>Confirmar</button>
          </div>
        ` : (logoSrc ? `
          <p class="onboard-rights-confirmed">Derechos de uso confirmados.</p>
        ` : '')}
      </div>`;
  }

  // ─── Club step (ADDENDUM-07 §6) ───────────────────────────────────────

  private async selectMembership(clubId: string): Promise<void> {
    if (this._clubSubmitLocked) return;
    this._clubSubmitLocked = true;
    this._loading = true;
    this._stepError = null;
    this.render();
    try {
      const res = await fetch('/api/auth/select-club', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ club_id: clubId }),
      });
      if (!res.ok) throw new Error('No se pudo seleccionar el club');
      // ADDENDUM-07 §6 C2 — persist last-entered club for multi-membership
      // auto-enter on the next login. Best-effort: failure doesn't block.
      try {
        await fetch('/api/preferences/last-club', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ club_id: clubId }),
        });
      } catch { /* best-effort */ }
      // Full navigation so the shell re-boots with the resolved club.
      window.location.replace('/');
    } catch (err) {
      this._loading = false;
      this._clubSubmitLocked = false;
      this._error = (err as Error).message;
      this.render();
    }
  }

  // ─── F1: single-owner submission lifecycle ─────────────────────────────
  // One method per form owns the ENTIRE lifecycle: lock acquisition, value
  // persistence, request generation, AbortController, disabled render, the
  // single fetch, and recovery. Event handlers only call these methods, so
  // lock ownership cannot diverge again.

  private async submitJoin(): Promise<void> {
    if (this._clubSubmitLocked) return;
    const clubId = this._clubForm.joinId.trim();
    // Synchronous validation BEFORE locking — invalid fields stay editable.
    if (!clubId) {
      this._stepError = { scope: 'join', message: 'Introduce el ID del club.' };
      this.render();
      return;
    }
    // Acquire the lock, persist values, and render the disabled/busy state.
    this._clubSubmitSeq += 1;
    const seq = this._clubSubmitSeq;
    this._clubSubmitAbort = new AbortController();
    this._clubSubmitLocked = true;
    this._loading = true;
    this._stepError = null;
    this._stepMessage = '';
    this.render();
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ club_id: clubId }),
        signal: this._clubSubmitAbort?.signal,
      });
      await this.handleStepResponse(res, 'join', seq);
    } catch (err) {
      this._recoverSubmission('join', (err as Error).message || 'No se pudo enviar la solicitud', seq);
    }
  }

  private async submitCreate(): Promise<void> {
    if (this._clubSubmitLocked) return;
    const name = this._clubForm.createName.trim();
    // Synchronous validation BEFORE locking — invalid fields stay editable.
    if (name.length < 2) {
      this._stepError = { scope: 'create', message: 'El nombre del club es obligatorio (mínimo 2 caracteres).' };
      this.render();
      return;
    }
    let website = '';
    if (this._clubForm.createWebsite.trim()) {
      const normalised = normaliseWebsiteUrl(this._clubForm.createWebsite);
      if (normalised === null) {
        this._stepError = { scope: 'create', message: 'La web del club debe usar https://' };
        this.render();
        return;
      }
      website = normalised;
    }
    // Acquire the lock, persist values, and render the disabled/busy state.
    this._clubSubmitSeq += 1;
    const seq = this._clubSubmitSeq;
    this._clubSubmitAbort = new AbortController();
    this._clubSubmitLocked = true;
    this._loading = true;
    this._stepError = null;
    this._stepMessage = '';
    // F2: one idempotency key per accepted submission; reused on retry.
    if (!this._createIdempotencyKey) {
      this._createIdempotencyKey =
        (globalThis.crypto && globalThis.crypto.randomUUID
          ? globalThis.crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2));
    }
    this.render();
    let res: Response;
    try {
      res = await fetch('/api/onboarding/clubs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, website, idempotency_key: this._createIdempotencyKey }),
        signal: this._clubSubmitAbort?.signal,
      });
    } catch (err) {
      this._recoverSubmission('create', (err as Error).message || 'No se pudo crear el club', seq);
      return;
    }
    if (this._clubSubmitSeq !== seq) return; // stale response guard
    if (res.ok) {
      if (this._clubSubmitAbort) {
        this._clubSubmitAbort = null; // request completed — clear the controller
      }
      // ADDENDUM-07 §6: chain select-club to re-point the shell session to
      // the new administrator row, then navigate to home. Only navigate when
      // both succeeded; surface the select failure as a step error (the
      // membership exists; the picker will offer it on the next visit —
      // degraded, not stuck).
      const data = await res.json().catch(() => null);
      const clubId = data?.club?.id;
      if (clubId) {
        try {
          const selectRes = await fetch('/api/auth/select-club', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ club_id: clubId }),
          });
          if (selectRes.ok) {
            // ADDENDUM-07 §6 C2 — persist last-entered club. Best-effort.
            try {
              await fetch('/api/preferences/last-club', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ club_id: clubId }),
              });
            } catch { /* best-effort */ }
            window.location.replace('/');
            return;
          }
          this._stepError = {
            scope: 'create',
            message: 'El club se ha creado, pero no se pudo iniciar sesión automáticamente. Recarga para entrar.',
          };
          this._loading = false;
          this._clubSubmitLocked = false;
          this.render();
          return;
        } catch {
          this._stepError = {
            scope: 'create',
            message: 'El club se ha creado, pero no se pudo iniciar sesión automáticamente. Recarga para entrar.',
          };
          this._loading = false;
          this._clubSubmitLocked = false;
          this.render();
          return;
        }
      }
      // Fallback: no club id in the response — reload.
      window.location.replace('/');
      return;
    }
    await this.handleStepResponse(res, 'create', seq);
  }

  // D20: restore controls, preserve typed values, and surface a focused error.
  private _recoverSubmission(scope: 'join' | 'create', message: string, seq: number): void {
    if (this._clubSubmitSeq !== seq) return;
    if (this._clubSubmitAbort) {
      this._clubSubmitAbort = null; // D21: clear only the matching controller
    }
    this._loading = false;
    this._clubSubmitLocked = false;
    this._stepError = { scope, message };
    this.render();
    const panel = this.shadow.querySelector(`#club-panel-${scope}`);
    const alert = panel?.querySelector('[role="alert"]') as HTMLElement | null;
    if (alert) {
      alert.focus();
    } else {
      (this.shadow.querySelector(`[data-${scope === 'join' ? 'join-id' : 'create-name'}]`) as HTMLElement | null)?.focus();
    }
  }

  private async handleStepResponse(
    res: Response,
    scope: 'join' | 'create',
    seq: number,
  ): Promise<void> {
    if (this._clubSubmitSeq !== seq) return; // D20: stale response guard
    if (this._clubSubmitAbort) {
      this._clubSubmitAbort = null; // D21: request completed — clear the controller
    }
    if (res.ok) {
      if (scope === 'join') {
        // Join: a pending JoinRequest was created — redirect to home so the
        // user lands on the authenticated shell and can resume from there
        // once the admin approves the request.
        window.location.replace('/');
        return;
      }
      this._stepMessage = 'Solicitud enviada. Un administrador del club revisará tu acceso.';
      this._stepError = null;
      this.render();
      return;
    }
    const data = await res.json().catch(() => null);
    const message =
      (data && (data as { detail?: string }).detail) || `Error ${res.status}`;
    this._recoverSubmission(scope, message, seq);
  }

  // ─── Working-context entry selector (entry-login v1) ──────────────────
  // One screen, no tabs and no visible title: the «Mi equipo» and
  // «Mi club» blocks render stacked with the approved copies, full-card
  // access and secondary create/invite/exit actions. All authority lives
  // server-side; this view only reflects entry_actions. Onboard draws no
  // header/footer of its own — chrome belongs to the shell.

  private renderEntryStep(): string {
    const boot = this._bootstrap!;
    const active = boot.active;
    const actions = boot.entry_actions || {};
    const clubs = (boot.contexts || []).filter((c) => c.kind === 'club');
    const createAllowed = actions['club.create']?.allowed === true;
    const busy = this._entryBusy;
    const busyAccess = this._intentAccess();
    const busyNote = (scope: 'personal' | 'club') =>
      busy && busyAccess === scope
        ? '<p class="entry-status" role="status">Entrando…</p>'
        : '';

    const activeLabel = active
      ? active.owner_scope.kind === 'personal'
        ? 'Espacio personal'
        : `Club ${(clubs.find((c) => c.owner_scope.club_id === active.owner_scope.club_id) as ContextCandidate | undefined)?.name || active.owner_scope.club_id}`
      : '';

    const personalTeams = (this._personalTeams || []).filter((t) => !t.archived);
    const archivedTeams = (this._personalTeams || []).filter((t) => t.archived);
    // Director 2026-10-24 (bugfix-auth-club-roster, bug 2): «Mi club» is
    // ALWAYS shown — the PD-ENTRY coach-hiding gate is removed; with no
    // clubs the block offers «Crear club».
    const atTeamCap = personalTeams.length >= 2;
    const teamMeta = (t: PersonalTeamRow) =>
      `${escapeHtml(t.category_label || t.category_key)}${t.gender && t.gender !== 'X' ? ` · ${escapeHtml(t.gender)}` : ''}${t.age_band ? ` · ${escapeHtml(t.age_band)}` : ''}`;

    // Member-scope sessions are denied personal authority by design (R1):
    // the feed is never fetched, so instead of a spinner/retry that could
    // never resolve, the block states the elevation requirement honestly.
    const teamBlock = `
      <section class="entry-block" aria-labelledby="entry-team-heading">
        <div class="entry-block-head">
          <h2 class="entry-block-title" id="entry-team-heading">Mi equipo</h2>
          <button class="entry-role entry-logout" type="button" data-entry-logout ${busy ? 'disabled' : ''}>Salir</button>
        </div>
        <p class="entry-block-copy">Modo entrenador. Usa BasketSpark para llevar a tu equipo a su mejor nivel esta temporada.</p>
        ${busyNote('personal')}
        ${!this._personalReadAllowed() ? `
          <p class="entry-note">El espacio personal requiere una sesión verificada. Cierra sesión y entra con tu cuenta para usarlo.</p>` : `
          ${this._personalTeamsStatus === 'loading' || this._personalTeamsStatus === 'uninitialized'
            ? '<p class="entry-loading">Cargando equipos…</p>'
            : this._personalTeamsStatus === 'error'
              ? `<p class="entry-error" role="alert">${escapeHtml(this._personalTeamsError || 'No se pudieron cargar los equipos')}
                  <button class="onboard-btn" type="button" data-personal-teams-retry ${busy ? 'disabled' : ''}>Reintentar</button></p>`
              : ''}
          ${personalTeams.length ? `
            <ul class="entry-cards">
              ${personalTeams.map((t) => `
                <li><button class="entry-card" type="button" data-entry-personal-enter-team="${escapeHtml(t.team_id)}" ${busy ? 'disabled' : ''} aria-label="Entrar en ${escapeHtml(t.name)}">
                  <span class="entry-card-icon">${ENTRY_TEAM_ICON_SVG}</span>
                  <span class="entry-card-copy">
                    <span class="entry-card-title">${escapeHtml(t.name)}</span>
                    <span class="entry-card-meta">${teamMeta(t)}</span>
                  </span>
                  <span class="entry-card-arrow">${ENTRY_ARROW_SVG}</span>
                </button></li>`).join('')}
            </ul>` : ''}
          ${atTeamCap
            ? ''
            : `<button class="entry-create" type="button" data-entry-team-create-toggle ${busy ? 'disabled' : ''}>${ENTRY_PLUS_SVG}<span>Crear equipo</span></button>
              ${this._teamCreateOpen ? `
                <form class="entry-form" data-entry-personal-create>
                  <div class="entry-field"><label>Nombre del equipo</label>
                    <input type="text" name="name" maxlength="120" required /></div>
                  <div class="entry-field"><label>Categoría</label>
                    <select name="category_key">${PERSONAL_CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}</select></div>
                  <div class="entry-field"><label>Género</label>
                    <select name="gender"><option value="X">Mixto</option><option value="F">Femenino</option><option value="M">Masculino</option></select></div>
                  <button class="onboard-btn onboard-btn-primary" type="submit" ${busy ? 'disabled' : ''}>Crear y entrar</button>
                </form>` : ''}`}
          ${!personalTeams.length && archivedTeams.length ? `
            <p class="entry-note">Tus equipos están archivados — entra para restaurarlos desde «Mis equipos», o crea uno nuevo.</p>
            <button class="onboard-btn" type="button" data-entry-personal-enter ${busy ? 'disabled' : ''}>Entrar</button>` : ''}
        `}
      </section>`;

    // Emailed invites are an explicit join gesture, not part of the club
    // membership universe — they stay reachable regardless of the club
    // block content.
    const inviteBlock = this._invitePreview ? `
      <div class="entry-invite">
        <p>Invitación para <strong>${escapeHtml(this._invitePreview.club_name || this._invitePreview.club_id)}</strong></p>
        <button class="onboard-btn onboard-btn-primary" type="button" data-entry-invite-redeem ${busy ? 'disabled' : ''}>Unirme al club</button>
      </div>` : '';

    const clubCard = (
      c: ContextCandidate,
      meta = '',
      opts: { pickerRow?: boolean; hidden?: boolean } = {},
    ) => {
      const clubId = c.owner_scope.club_id || '';
      const clubName = c.name || clubId;
      const myRole = (this._org?.memberships || []).find((m) => m.club_id === clubId)?.role;
      const roleLabel = myRole ? ROLE_LABELS[myRole] || myRole : '';
      const rowAttrs = opts.pickerRow
        ? ` data-entry-club-picker-row="${escapeHtml(normEntryText(clubName))}"`
        : '';
      return `
        <li${rowAttrs}${opts.hidden ? ' hidden' : ''}><button class="entry-card" type="button" data-entry-club-activate="${escapeHtml(clubId)}" ${busy ? 'disabled' : ''} aria-label="Entrar en ${escapeHtml(clubName)}">
          <span class="entry-card-icon entry-card-icon-club">${ENTRY_CLUB_ICON_SVG}</span>
          <span class="entry-card-copy">
            <span class="entry-card-title">${escapeHtml(clubName)}</span>
            ${meta ? `<span class="entry-card-meta">${escapeHtml(meta)}</span>` : ''}
            ${roleLabel ? `<span class="entry-card-meta">Entrar como ${escapeHtml(roleLabel)}</span>` : ''}
          </span>
          <span class="entry-card-arrow">${ENTRY_ARROW_SVG}</span>
        </button></li>`;
    };

    // PD-CLUBS: ≤2 clubs → one card each. ≥3 → one main access: the
    // server-active club first, else the account-bound last-entered club,
    // both validated against the feed; with no valid datum the access is
    // the neutral «Elegir club» picker — never an arbitrary club. Cards
    // carry only the name (no locality / team count / role — no
    // authoritative pre-entry source).
    const activeClubId =
      active && active.owner_scope.kind === 'club'
        ? active.owner_scope.club_id || ''
        : '';
    const recentClubId = activeClubId || this._readLastClubId();
    const recentClub = recentClubId
      ? clubs.find((c) => (c.owner_scope.club_id || '') === recentClubId)
      : undefined;
    const clubQuery = normEntryText(this._clubPickerQuery.trim());
    const pickerRows = clubs.filter(
      (c) =>
        !clubQuery ||
        normEntryText((c.name || c.owner_scope.club_id || '')).includes(clubQuery),
    );
    const clubPicker = this._clubPickerOpen ? `
      <div class="entry-picker-backdrop" data-entry-club-picker-backdrop>
        <div class="entry-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="entry-picker-title">
          <div class="entry-picker-head">
            <h2 class="entry-picker-title" id="entry-picker-title">Elegir club</h2>
            <button class="entry-help-close" type="button" data-entry-club-picker-close aria-label="Cerrar">${ENTRY_CLOSE_SVG}</button>
          </div>
          <div class="entry-picker-search">
            <input type="search" data-entry-club-picker-search value="${escapeHtml(this._clubPickerQuery)}" placeholder="Buscar club" aria-label="Buscar club" ${busy ? 'disabled' : ''} />
          </div>
          <ul class="entry-cards entry-picker-list" data-entry-club-picker-list>
            ${clubs.map((c) => clubCard(c, '', {
              pickerRow: true,
              hidden:
                !!clubQuery &&
                !normEntryText((c.name || c.owner_scope.club_id || '')).includes(clubQuery),
            })).join('')}
          </ul>
          <p class="entry-empty" data-entry-club-picker-empty ${pickerRows.length ? 'hidden' : ''}>No hay clubes que coincidan${clubQuery ? ` con «${escapeHtml(this._clubPickerQuery)}»` : ''}.</p>
        </div>
      </div>` : '';

    const clubAccess = clubs.length
      ? clubs.length <= 2
        ? `<ul class="entry-cards">${clubs.map((c) => clubCard(c)).join('')}</ul>`
        : recentClub
          ? `<ul class="entry-cards">${clubCard(recentClub, 'Club reciente')}</ul>
            <button class="entry-create" type="button" data-entry-club-picker-open ${busy ? 'disabled' : ''} aria-haspopup="dialog">${ENTRY_CLUB_ICON_SVG}<span>Elegir club</span><span class="entry-create-count">${clubs.length} clubes</span></button>`
          : // No valid «reciente» datum: the picker IS the main access —
            // a full card, never an arbitrary club (PD-CLUBS).
            `<ul class="entry-cards">
              <li><button class="entry-card" type="button" data-entry-club-picker-open ${busy ? 'disabled' : ''} aria-haspopup="dialog" aria-label="Elegir entre tus ${clubs.length} clubes">
                <span class="entry-card-icon entry-card-icon-club">${ENTRY_CLUB_ICON_SVG}</span>
                <span class="entry-card-copy">
                  <span class="entry-card-title">Elegir club</span>
                  <span class="entry-card-meta">${clubs.length} clubes</span>
                </span>
                <span class="entry-card-arrow">${ENTRY_ARROW_SVG}</span>
              </button></li>
            </ul>`
      : `<p class="entry-empty">No tienes clubes todavía.</p>`;

    const clubBlock = `
      <section class="entry-block" aria-labelledby="entry-club-heading">
        <div class="entry-block-head">
          <h2 class="entry-block-title" id="entry-club-heading">Mi club</h2>
        </div>
        <p class="entry-block-copy">Modo Director Deportivo. Diseña la estrategia deportiva de tu club de baloncesto y usa BasketSpark para alcanzar el mejor nivel con todos los equipos.</p>
        ${busyNote('club')}
        ${clubAccess}
        ${createAllowed ? `
          <button class="entry-create" type="button" data-entry-club-create-toggle ${busy ? 'disabled' : ''}>${ENTRY_PLUS_SVG}<span>Crear club</span></button>
          ${this._clubCreateOpen ? `
            <form class="entry-form" data-entry-club-create>
              <div class="entry-field"><label>Nombre del club</label>
                <input type="text" name="name" maxlength="200" required /></div>
              <button class="onboard-btn onboard-btn-primary" type="submit" ${busy ? 'disabled' : ''}>Crear</button>
            </form>` : ''}
        ` : ''}
      </section>`;

    const recovery = this._entryRecovery;
    const recoveryMarkup = recovery ? `
      <div class="entry-recovery" role="alert">
        <p class="entry-recovery-msg">${escapeHtml(recovery.message)}</p>
        <div class="entry-recovery-actions">
          ${recovery.kind === 'narrowing' ? `
            <button class="onboard-btn onboard-btn-primary" type="button" data-entry-retry-team="${escapeHtml(recovery.team_id)}">Reintentar equipo</button>
            <button class="onboard-btn" type="button" data-entry-enter-all>Entrar con todos los equipos</button>` : ''}
          ${recovery.kind === 'uncertain' ? `
            <button class="onboard-btn" type="button" data-entry-check>Comprobar</button>` : ''}
          ${recovery.kind === 'confirm' ? `
            <button class="onboard-btn" type="button" data-entry-check>Reintentar</button>` : ''}
        </div>
      </div>` : '';

    const helpDialog = this._helpOpen ? `
      <div class="entry-help-backdrop" data-entry-help-backdrop>
        <div class="entry-help-dialog" role="dialog" aria-modal="true" aria-labelledby="entry-help-title">
          <div class="entry-help-head">
            <img class="entry-help-chispa" src="${CHISPA_HEAD_COMPACT_URI}" alt="" aria-hidden="true">
            <h2 class="entry-help-title" id="entry-help-title">Cada forma de entrenar, su lugar</h2>
            <button class="entry-help-close" type="button" data-entry-help-close aria-label="Cerrar">${ENTRY_CLOSE_SVG}</button>
          </div>
          <p>No necesitas cambiar de cuenta. Puedes tener tu equipo y formar parte de un club.</p>
          <section class="entry-help-section">
            <h3>Mi equipo</h3>
            <p>Para el entrenador que lleva uno o dos equipos y quiere organizar su día a día.</p>
            <ul>
              <li>Planifica la temporada y prepara las sesiones.</li>
              <li>Organiza la plantilla y el calendario de partidos.</li>
              <li>Trabaja con tus equipos desde un mismo acceso.</li>
            </ul>
          </section>
          <section class="entry-help-section">
            <h3>Mi club</h3>
            <p>Para coordinar la actividad deportiva de un club, según los permisos de tu cuenta.</p>
            <ul>
              <li>Gestiona los equipos y las personas del staff.</li>
              <li>Define la metodología común del club.</li>
              <li>Acompaña la planificación de los entrenadores.</li>
            </ul>
          </section>
          <p class="entry-help-note">Puedes volver a esta pantalla para entrar en otro equipo o club.</p>
        </div>
      </div>` : '';

    return `
      <div class="entry-step"${this._helpOpen || this._clubPickerOpen ? ' inert' : ''}>
        <h1 class="sr-only">Entrar en BasketIQ</h1>
        ${activeLabel ? `<p class="entry-active">Trabajando en <strong>${escapeHtml(activeLabel)}</strong></p>` : ''}
        ${this._entryError ? `<p class="entry-error" role="alert">${escapeHtml(this._entryError)}</p>` : ''}
        ${recoveryMarkup}
        ${inviteBlock}
        ${teamBlock}
        ${clubBlock}
        <div class="entry-utility">
          <button class="entry-chispa" type="button" data-entry-help aria-haspopup="dialog" aria-label="Chispa: ayuda sobre Mi equipo y Mi club">
            <img class="entry-chispa-icon" src="${CHISPA_HEAD_COMPACT_URI}" alt="" aria-hidden="true">
            <span class="entry-chispa-copy"><strong>¿Mi equipo o mi club?</strong><small>Chispa te ayuda a elegir.</small></span>
          </button>
          <button class="entry-logout" type="button" data-entry-logout ${busy ? 'disabled' : ''}>Salir</button>
        </div>
      </div>
      ${helpDialog}
      ${clubPicker}`;
  }

  private _openEntryHelp(): void {
    if (this._helpOpen) return;
    this._helpOpen = true;
    this.render();
    const close = this.shadow.querySelector('[data-entry-help-close]') as HTMLElement | null;
    close?.focus();
  }

  private _closeEntryHelp(): void {
    if (!this._helpOpen) return;
    this._helpOpen = false;
    this.render();
    // Focus returns to the control that opened the dialog (the element is
    // recreated by the re-render — same logical control, same selector).
    const trigger = this.shadow.querySelector('[data-entry-help]') as HTMLElement | null;
    trigger?.focus();
  }

  // PD-CLUBS ≥3-club picker — same modal contract as the help dialog:
  // role=dialog + aria-modal, Escape/backdrop/close, focus into the search
  // field on open and back to the trigger on close, inert background.
  private _openClubPicker(): void {
    if (this._clubPickerOpen) return;
    this._clubPickerOpen = true;
    this._clubPickerQuery = '';
    this.render();
    const search = this.shadow.querySelector('[data-entry-club-picker-search]') as HTMLElement | null;
    search?.focus();
  }

  private _closeClubPicker(): void {
    if (!this._clubPickerOpen) return;
    this._clubPickerOpen = false;
    this.render();
    const trigger = this.shadow.querySelector('[data-entry-club-picker-open]') as HTMLElement | null;
    trigger?.focus();
  }

  // Live name filter — visibility toggled in place so typing keeps focus;
  // the same predicate runs at render time, so a busy repaint or a
  // re-rendered list reproduces the filtered state exactly.
  private _filterClubPicker(query: string): void {
    this._clubPickerQuery = query;
    const needle = normEntryText(query.trim());
    const list = this.shadow.querySelector('[data-entry-club-picker-list]');
    list?.querySelectorAll('[data-entry-club-picker-row]').forEach((row) => {
      const name = (row as HTMLElement).dataset.entryClubPickerRow || '';
      (row as HTMLElement).hidden = !!needle && !normEntryText(name).includes(needle);
    });
    const rows = Array.from(
      list?.querySelectorAll('[data-entry-club-picker-row]') ?? [],
    ).filter((row) => !(row as HTMLElement).hidden).length;
    const empty = this.shadow.querySelector('[data-entry-club-picker-empty]') as HTMLElement | null;
    if (empty) {
      empty.hidden = rows > 0;
      empty.textContent = `No hay clubes que coincidan${needle ? ` con «${query.trim()}»` : ''}.`;
    }
  }

  private async loadInvitePreview(): Promise<void> {
    if (this._inviteLoading) return;
    this._inviteLoading = true;
    this._entryError = null;
    try {
      const res = await fetch('/api/context/v1/invitations/preview', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this._inviteToken }),
      });
      if (!res.ok) throw new Error('Invitación no válida o caducada');
      this._invitePreview = await res.json();
    } catch (err) {
      this._entryError = (err as Error).message;
      this._inviteToken = '';
    } finally {
      this._inviteLoading = false;
      this.render();
    }
  }

  // «Salir» en el paso de entrada: hospedado, el cierre lo posee la
  // carcasa — la capacidad requestLogout activa la valla sessionClosing
  // síncronamente y ejecuta teardown/POST/limpieza/navegación canónicos.
  // Sin capacidad (documento viejo) se falla CERRADO con feedback
  // acotado — nunca un bypass local. Solo en standalone real (sin
  // carcasa) el módulo cierra por su cuenta.
  private async _entryLogout(): Promise<void> {
    this._entryBusy = true;
    this.render();
    if (this.shellHosted) {
      if (typeof this.requestLogout !== 'function') {
        this._entryLogoutFailed();
        return;
      }
      try {
        const result = this.requestLogout();
        if (result && typeof result.catch === 'function') {
          result.catch(() => this._entryLogoutFailed());
        }
      } catch {
        this._entryLogoutFailed();
      }
      return; // la carcasa desmonta — no se repinta ni hay POST local
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch { /* red no disponible: redirigimos igualmente */ }
    try {
      const keys: string[] = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (
          key?.startsWith('biq.activeTeamId.') ||
          key?.startsWith(ENTRY_LAST_CLUB_KEY_PREFIX)
        ) keys.push(key);
      }
      keys.forEach((key) => sessionStorage.removeItem(key));
    } catch { /* storage no disponible */ }
    location.replace('/login');
  }

  private _entryLogoutFailed(): void {
    if (!this.isConnected) return; // la carcasa ya desmontó el módulo
    // A failed logout must not release an in-flight intent's busy hold.
    if (!this._entryIntent) this._entryBusy = false;
    this._entryError = 'No se pudo cerrar la sesión. Reintenta o recarga la página.';
    this.render();
  }

  private wireEntryEvents(): void {
    const inviteAllowed =
      this._bootstrap?.entry_actions?.['club.invitation.redeem']?.allowed !== false;

    this.shadow.querySelectorAll('[data-entry-logout]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void this._entryLogout();
      });
    });

    // Email invitations land on `#/onboard?invite=<token>` — the token
    // arrives in the link, so there is no manual code entry at entry.
    // Auto-preview once and let the user confirm.
    if (
      this._inviteToken &&
      !this._invitePreview &&
      !this._inviteLoading &&
      inviteAllowed
    ) {
      this.loadInvitePreview();
    }

    // Feed failure in the selector is a bounded error too — the explicit
    // retry is the only refetch, never a render-triggered one.
    this.shadow.querySelector('[data-personal-teams-retry]')?.addEventListener('click', () => {
      this.loadPersonalTeams();
    });
    this.shadow.querySelector('[data-entry-personal-enter]')?.addEventListener('click', () => {
      this._enterPersonal();
    });
    this.shadow.querySelectorAll('[data-entry-personal-enter-team]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._enterPersonal((btn as HTMLElement).dataset.entryPersonalEnterTeam || '');
      });
    });
    this.shadow.querySelector('[data-entry-team-create-toggle]')?.addEventListener('click', () => {
      this._teamCreateOpen = !this._teamCreateOpen;
      this.render();
      if (this._teamCreateOpen) {
        const input = this.shadow.querySelector('[data-entry-personal-create] input[name="name"]') as HTMLInputElement | null;
        input?.focus();
      }
    });
    // Crear equipo desde el selector de entrada: crea el equipo privado y
    // entra en el espacio personal con ese equipo como equipo de trabajo.
    // The create→enter chain runs inside ONE intent — no nested finally
    // may release the parent's busy hold.
    this.shadow.querySelector('[data-entry-personal-create]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      const intent = this._beginEntryIntent('create-team');
      if (!intent) return;
      this._runEntryIntent(intent, async () => {
        const res = await this._entryMutation(
          '/api/context/v1/personal-teams',
          {
            name: String(fd.get('name') || '').trim(),
            category_key: String(fd.get('category_key') || ''),
            gender: String(fd.get('gender') || 'X'),
          },
          'POST',
          `entry-${Date.now()}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.detail || `No se pudo crear el equipo (${res.status})`);
        }
        const data = await res.json().catch(() => null);
        intent.mutated = true;
        intent.team_id = data?.team?.team_id || '';
        if (!this._intentCurrent(intent)) return;
        await this._postActivate('personal');
        intent.mutated = true;
        if (!this._intentCurrent(intent) || !intent.team_id) return;
        await this._putWorkingTeams(intent.team_id);
      });
    });

    this.shadow.querySelectorAll('[data-entry-help]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._openEntryHelp();
      });
    });
    this.shadow.querySelectorAll('[data-entry-help-close]').forEach((el) => {
      el.addEventListener('click', () => {
        this._closeEntryHelp();
      });
    });
    // Backdrop closes only on a direct backdrop hit — clicks inside the
    // dialog must not bubble-close it.
    this.shadow.querySelector('[data-entry-help-backdrop]')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) this._closeEntryHelp();
    });

    // PD-CLUBS «Elegir club» picker (≥3 clubs): open/close/backdrop and
    // the live search — rows filter in place, keeping input focus.
    this.shadow.querySelector('[data-entry-club-picker-open]')?.addEventListener('click', () => {
      this._openClubPicker();
    });
    this.shadow.querySelector('[data-entry-club-picker-close]')?.addEventListener('click', () => {
      this._closeClubPicker();
    });
    this.shadow.querySelector('[data-entry-club-picker-backdrop]')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) this._closeClubPicker();
    });
    this.shadow.querySelector('[data-entry-club-picker-search]')?.addEventListener('input', (ev) => {
      this._filterClubPicker((ev.target as HTMLInputElement).value);
    });

    this.shadow.querySelector('[data-entry-club-create-toggle]')?.addEventListener('click', () => {
      this._clubCreateOpen = !this._clubCreateOpen;
      this.render();
      if (this._clubCreateOpen) {
        const input = this.shadow.querySelector('[data-entry-club-create] input') as HTMLInputElement | null;
        input?.focus();
      }
    });

    this.shadow.querySelectorAll('[data-entry-club-activate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._enterClub((btn as HTMLElement).dataset.entryClubActivate || '');
      });
    });

    // Redeem→activate runs inside ONE intent — the redeem POST applying
    // without activation never releases the busy hold nor emits early.
    this.shadow.querySelector('[data-entry-invite-redeem]')?.addEventListener('click', () => {
      if (!this._inviteToken) return;
      const token = this._inviteToken;
      const intent = this._beginEntryIntent('redeem');
      if (!intent) return;
      this._runEntryIntent(intent, async () => {
        const res = await this._entryMutation('/api/context/v1/invitations/redeem', { token });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.detail || `No se pudo canjear la invitación (${res.status})`);
        }
        const data = await res.json().catch(() => null);
        intent.mutated = true;
        intent.club_id = data?.club_id || '';
        if (!this._intentCurrent(intent)) return;
        this._invitePreview = null;
        this._inviteToken = '';
        await this._postActivate('club', intent.club_id);
        intent.mutated = true;
      });
    });

    this.shadow.querySelector('[data-entry-club-create]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      const intent = this._beginEntryIntent('create-club');
      if (!intent) return;
      this._runEntryIntent(intent, async () => {
        const res = await this._entryMutation('/api/context/v1/clubs', {
          name: String(fd.get('name') || '').trim(),
          idempotency_key: `entry-club-${Date.now()}`,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.detail || `No se pudo crear el club (${res.status})`);
        }
        const data = await res.json().catch(() => null);
        intent.mutated = true;
        intent.club_id = data?.club?.id || '';
        if (!this._intentCurrent(intent)) return;
        await this._postActivate('club', intent.club_id);
        intent.mutated = true;
      });
    });

    // Recovery actions (entry-login §4.2): explicit gestures only — the
    // PUT-only narrowing retry, the plain activation path, and the
    // bootstrap-GET resync. Nothing here re-POSTs an uncertain mutation.
    this.shadow.querySelector('[data-entry-retry-team]')?.addEventListener('click', (ev) => {
      this._retryNarrowing((ev.currentTarget as HTMLElement).dataset.entryRetryTeam || '');
    });
    this.shadow.querySelector('[data-entry-enter-all]')?.addEventListener('click', () => {
      this._enterPersonal();
    });
    this.shadow.querySelectorAll('[data-entry-check]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._resyncBootstrap();
      });
    });
  }

  // Personal workspace panel (Mi espacio) when the active context is
  // private — teams list + create + switch affordance.
  private renderPersonalPanel(): string {
    const all = this._personalTeams || [];
    const teams = all.filter((t) => !t.archived);
    const archived = all.filter((t) => t.archived);
    const atCap = teams.length >= 2;
    const teamRow = (t: PersonalTeamRow) => this._editingPersonalTeamId === t.team_id ? `
      <li class="entry-team">
        <form class="entry-form" data-personal-team-edit="${escapeHtml(t.team_id)}" data-revision="${t.team_revision}">
          <div class="entry-field"><label>Nombre del equipo</label>
            <input type="text" name="name" maxlength="120" required value="${escapeHtml(t.name)}" /></div>
          <div class="entry-field"><label>Categoría</label>
            <select name="category_key">${PERSONAL_CATEGORIES.map((c) => `<option value="${c.key}"${c.key === t.category_key ? ' selected' : ''}>${c.label}</option>`).join('')}</select></div>
          <div class="entry-field"><label>Género</label>
            <select name="gender">${['X', 'F', 'M'].map((g) => `<option value="${g}"${g === t.gender ? ' selected' : ''}>${g === 'X' ? 'Mixto' : g === 'F' ? 'Femenino' : 'Masculino'}</option>`).join('')}</select></div>
          <button class="onboard-btn onboard-btn-primary" type="submit" ${this._entryBusy ? 'disabled' : ''}>Guardar</button>
          <button class="onboard-btn" type="button" data-personal-team-edit-cancel ${this._entryBusy ? 'disabled' : ''}>Cancelar</button>
        </form>
      </li>` : `
      <li class="entry-team"><strong>${escapeHtml(t.name)}</strong>
        <span>${escapeHtml(t.category_label || t.category_key)}${t.gender && t.gender !== 'X' ? ` · ${escapeHtml(t.gender)}` : ''}${t.age_band ? ` · ${escapeHtml(t.age_band)}` : ''}</span>
        <button class="onboard-btn" data-personal-team-roster-open="${escapeHtml(t.team_id)}" ${this._entryBusy ? 'disabled' : ''}>Plantilla</button>
        <button class="onboard-btn" data-personal-team-edit-open="${escapeHtml(t.team_id)}" ${this._entryBusy ? 'disabled' : ''}>Editar</button>
        <button class="onboard-btn entry-team-delete" data-personal-team-delete="${escapeHtml(t.team_id)}" ${this._entryBusy ? 'disabled' : ''}>Eliminar</button>
      </li>`;
    return `
      <div class="entry-step">
        <h2 class="entry-title">Mi espacio personal</h2>
        <button class="onboard-btn" data-personal-switch-space>Cambiar de espacio</button>
        ${this._entryError ? `<p class="entry-error" role="alert">${escapeHtml(this._entryError)}</p>` : ''}
        ${this._personalTeamsStatus === 'loading' || this._personalTeamsStatus === 'uninitialized'
          ? `<p class="entry-loading">Cargando equipos…</p>`
          : this._personalTeamsStatus === 'error'
            ? `<p class="entry-error" role="alert">${escapeHtml(this._personalTeamsError || 'No se pudieron cargar los equipos')}
                <button class="onboard-btn" type="button" data-personal-teams-retry ${this._entryBusy ? 'disabled' : ''}>Reintentar</button></p>`
            : teams.length
              ? `<ul class="entry-teams">${teams.map(teamRow).join('')}</ul>`
              : '<p class="entry-p">Todavía no tienes equipos personales.</p>'}
        ${archived.length ? `
          <h3 class="entry-h">Archivados</h3>
          <ul class="entry-teams">${archived.map((t) => `
            <li class="entry-team"><strong>${escapeHtml(t.name)}</strong>
              <span>${escapeHtml(t.category_label || t.category_key)}</span>
              <button class="onboard-btn" data-personal-team-restore="${escapeHtml(t.team_id)}" ${this._entryBusy || atCap ? 'disabled' : ''}>Restaurar</button>
            </li>`).join('')}</ul>` : ''}
        ${atCap
          ? '<p class="entry-note">Puedes tener hasta 2 equipos personales. Elimina uno para crear otro.</p>'
          : `<form class="entry-form" data-entry-personal-create>
          <div class="entry-field"><label>Nombre del equipo</label>
            <input type="text" name="name" maxlength="120" required /></div>
          <div class="entry-field"><label>Categoría</label>
            <select name="category_key">${PERSONAL_CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}</select></div>
          <div class="entry-field"><label>Género</label>
            <select name="gender"><option value="X">Mixto</option><option value="F">Femenino</option><option value="M">Masculino</option></select></div>
          <button class="onboard-btn onboard-btn-primary" type="submit" ${this._entryBusy ? 'disabled' : ''}>Crear equipo</button>
        </form>`}
      </div>`;
  }

  private wirePersonalEvents(): void {
    // Only a never-attempted feed self-loads — a failure is a bounded error
    // state, not an invitation to refetch on every render.
    if (this._personalTeamsStatus === 'uninitialized') {
      this.loadPersonalTeams();
    }
    this.shadow.querySelector('[data-personal-teams-retry]')?.addEventListener('click', () => {
      this.loadPersonalTeams(); // explicit retry clears the error state
    });
    // R6: el conmutador de espacios también es accesible desde el modo
    // personal — navega al selector autoritativo.
    this.shadow.querySelector('[data-personal-switch-space]')?.addEventListener('click', () => {
      location.hash = '#/onboard/spaces';
    });
    this.shadow.querySelector('[data-entry-personal-create]')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      this._entryBusy = true;
      this._entryError = null;
      this.render();
      try {
        const res = await fetch('/api/context/v1/personal-teams', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `panel-${Date.now()}` },
          body: JSON.stringify({
            name: String(fd.get('name') || '').trim(),
            category_key: String(fd.get('category_key') || ''),
            gender: String(fd.get('gender') || 'X'),
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.detail || `No se pudo crear el equipo (${res.status})`);
        }
        this._personalTeams = null;
        this.loadPersonalTeams();
      } catch (err) {
        this._entryError = (err as Error).message;
      } finally {
        this._entryBusy = false;
        this.render();
      }
    });
    // Eliminar un equipo personal libera el slot (cap de 2) — el servidor
    // archiva el equipo y lo retira del working set del contexto activo.
    this.shadow.querySelectorAll('[data-personal-team-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const teamId = (btn as HTMLElement).dataset.personalTeamDelete || '';
        if (!teamId || !window.confirm('¿Eliminar este equipo? Podrás crear otro después.')) return;
        this._entryBusy = true;
        this._entryError = null;
        this.render();
        try {
          const res = await fetch(`/api/context/v1/personal-teams/${encodeURIComponent(teamId)}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail || `No se pudo eliminar el equipo (${res.status})`);
          }
          this._personalTeams = null;
          this.loadPersonalTeams();
        } catch (err) {
          this._entryError = (err as Error).message;
        } finally {
          this._entryBusy = false;
          this.render();
        }
      });
    });
    // Plantilla — the shared roster editor (SF1): same renderer/handlers
    // as the club editor, personal roster adapter underneath. The button
    // lands the module on the canonical edit route so a refresh/deep link
    // reproduces the same surface.
    this.shadow.querySelectorAll('[data-personal-team-roster-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const teamId = (btn as HTMLElement).dataset.personalTeamRosterOpen || '';
        if (!teamId) return;
        this._subRoute = 'teams';
        history.replaceState(null, '', `#/onboard/teams?edit=${encodeURIComponent(teamId)}`);
        this._openEditModal(teamId, true);
      });
    });
    // Editar — formulario inline por equipo; PATCH con expected_revision
    // para que una edición sobre una versión vieja conflicte (409).
    this.shadow.querySelectorAll('[data-personal-team-edit-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._editingPersonalTeamId = (btn as HTMLElement).dataset.personalTeamEditOpen || null;
        this.render();
      });
    });
    this.shadow.querySelector('[data-personal-team-edit-cancel]')?.addEventListener('click', () => {
      this._editingPersonalTeamId = null;
      this.render();
    });
    this.shadow.querySelector('[data-personal-team-edit]')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target as HTMLFormElement;
      const teamId = form.dataset.personalTeamEdit || '';
      const revision = parseInt(form.dataset.revision || '', 10);
      const fd = new FormData(form);
      this._entryBusy = true;
      this._entryError = null;
      this.render();
      try {
        const res = await fetch(`/api/context/v1/personal-teams/${encodeURIComponent(teamId)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: String(fd.get('name') || '').trim(),
            category_key: String(fd.get('category_key') || ''),
            gender: String(fd.get('gender') || 'X'),
            ...(Number.isFinite(revision) ? { expected_revision: revision } : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.detail || `No se pudo guardar el equipo (${res.status})`);
        }
        this._editingPersonalTeamId = null;
        this._personalTeams = null;
        this.loadPersonalTeams();
      } catch (err) {
        this._entryError = (err as Error).message;
      } finally {
        this._entryBusy = false;
        this.render();
      }
    });
    // Restaurar un equipo archivado (bloqueado cuando el cap está lleno).
    this.shadow.querySelectorAll('[data-personal-team-restore]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const teamId = (btn as HTMLElement).dataset.personalTeamRestore || '';
        if (!teamId) return;
        this._entryBusy = true;
        this._entryError = null;
        this.render();
        try {
          const res = await fetch(`/api/context/v1/personal-teams/${encodeURIComponent(teamId)}/restore`, {
            method: 'POST',
            credentials: 'include',
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail || `No se pudo restaurar el equipo (${res.status})`);
          }
          this._personalTeams = null;
          this.loadPersonalTeams();
        } catch (err) {
          this._entryError = (err as Error).message;
        } finally {
          this._entryBusy = false;
          this.render();
        }
      });
    });
  }

  private renderClubStep(): string {
    const orgCtx = this._org;
    const memberships = orgCtx?.memberships || [];
    const err = this._stepError;
    const tabs = clubTabsForMembershipState(memberships);
    const activeTab = tabs.some((tab) => tab.id === this._activeClubTab)
      ? this._activeClubTab
      : defaultClubTab(memberships);
    this._activeClubTab = activeTab;
    const locked = this._clubSubmitLocked;
    const tabButtons = tabs.map((tab) => `
      <button type="button" role="tab" data-club-tab="${tab.id}"
        id="club-tab-${tab.id}" aria-controls="club-panel-${tab.id}"
        aria-selected="${tab.id === activeTab}" tabindex="${tab.id === activeTab ? 0 : -1}"
        ${locked ? 'disabled' : ''}>${tab.label}</button>`).join('');
    const panels = tabs.map((tab) => {
      const selected = tab.id === activeTab;
      if (tab.id === 'memberships') {
        return `<section id="club-panel-memberships" role="tabpanel" aria-labelledby="club-tab-memberships" ${selected ? '' : 'hidden'}>
          <p class="onboard-card-desc">Perteneces a varios clubs. Elige con cuál quieres entrar.</p>
          <div class="onboard-picker" role="listbox" aria-label="Elige tu club">
            ${memberships.map((m) => `<button class="onboard-club-row" data-pick-club="${escapeHtml(m.club_id)}" role="option" ${locked ? 'disabled' : ''}>
              <span class="onboard-club-name">${escapeHtml(m.club_name || m.club_id)}</span>
              <span class="onboard-club-role">${escapeHtml(m.role === 'administrator' ? 'Administrador' : m.role)}</span>
            </button>`).join('')}
          </div>
        </section>`;
      }
      if (tab.id === 'join') {
        return `<section id="club-panel-join" role="tabpanel" aria-labelledby="club-tab-join" aria-busy="${selected && this._loading ? 'true' : 'false'}" ${selected ? '' : 'hidden'}>
          <p class="onboard-card-desc">Si tu club ya usa BasketIQ, pide a un administrador el ID del club.</p>
          <div class="onboard-form-row">
            <input type="text" class="onboard-input" data-join-id placeholder="ID del club" aria-label="ID del club" value="${escapeHtml(this._clubForm.joinId)}" ${locked ? 'disabled' : ''} />
            <button class="onboard-btn onboard-btn-primary" data-join-btn ${locked ? 'disabled' : ''}>${this._loading && selected ? '<span class="onboard-spinner" aria-hidden="true"></span> Enviando solicitud…' : 'Solicitar acceso'}</button>
          </div>
          ${err?.scope === 'join' ? `<div class="onboard-error" role="alert" tabindex="-1">${escapeHtml(err.message)}</div>` : ''}
          ${this._stepMessage ? `<div class="onboard-success" aria-live="polite">${escapeHtml(this._stepMessage)}</div>` : ''}
        </section>`;
      }
      return `<section id="club-panel-create" role="tabpanel" aria-labelledby="club-tab-create" aria-busy="${selected && this._loading ? 'true' : 'false'}" ${selected ? '' : 'hidden'}>
        <p class="onboard-card-desc">Crea la organización de tu club. Serás su administrador; podremos tomar el escudo y los colores de su web para personalizar la app.</p>
        <label class="onboard-field-label" for="create-name">Nombre del club</label>
        <input type="text" id="create-name" class="onboard-input onboard-input-block" data-create-name placeholder="Club Baloncesto…" value="${escapeHtml(this._clubForm.createName)}" ${locked ? 'disabled' : ''} />
        <label class="onboard-field-label" for="create-web">Web del club (opcional)</label>
        <input type="url" id="create-web" class="onboard-input onboard-input-block" data-create-website placeholder="mi-club.es" value="${escapeHtml(this._clubForm.createWebsite)}" ${locked ? 'disabled' : ''} />
        <button class="onboard-btn onboard-btn-primary" data-create-btn ${locked ? 'disabled' : ''}>${this._loading && selected ? '<span class="onboard-spinner" aria-hidden="true"></span> Creando el club…' : 'Crear club'}</button>
        ${err?.scope === 'create' ? `<div class="onboard-error" role="alert" tabindex="-1">${escapeHtml(err.message)}</div>` : ''}
      </section>`;
    }).join('');

    return `<header class="onboard-step-head">
      <h2 class="onboard-section-title">Tu club</h2>
      <p class="onboard-card-desc">Elige una opción para empezar a usar BasketIQ.</p>
      ${this._error ? `<div class="onboard-error" role="alert">${escapeHtml(this._error)}</div>` : ''}
    </header>
    ${this._loading ? '<div class="onboard-loading" role="status" aria-live="polite"><span class="onboard-spinner" aria-hidden="true"></span> Procesando…</div>' : ''}
    <div class="onboard-tabs" role="tablist" aria-label="Opciones de club">${tabButtons}</div>
    <div class="onboard-tab-panels">${panels}</div>`;
  }

  private wireClubStepEvents(): void {
    const tabElements = Array.from(this.shadow.querySelectorAll<HTMLButtonElement>('[data-club-tab]'));
    const activateTab = (id: string, focus = false) => {
      if (this._clubSubmitLocked) return;
      this._activeClubTab = id;
      this.render();
      if (focus) this.shadow.querySelector<HTMLButtonElement>(`[data-club-tab="${id}"]`)?.focus();
    };
    tabElements.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.clubTab || ''));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabElements.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabElements.length) % tabElements.length;
        activateTab(tabElements[next].dataset.clubTab || '', true);
      });
    });

    this.shadow.querySelectorAll('[data-pick-club]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectMembership((btn as HTMLElement).dataset.pickClub || '');
      });
    });

    const joinBtn = this.shadow.querySelector('[data-join-btn]');
    const joinInput = this.shadow.querySelector('[data-join-id]') as HTMLInputElement | null;
    if (joinBtn && joinInput) {
      joinInput.addEventListener('input', () => {
        this._clubForm.joinId = joinInput.value;
      });
      // F1: thin callers — the submit method owns the entire lifecycle.
      joinBtn.addEventListener('click', () => {
        this.submitJoin();
      });
      joinInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submitJoin();
        }
      });
    }

    const createBtn = this.shadow.querySelector('[data-create-btn]');
    const nameInput = this.shadow.querySelector('[data-create-name]') as HTMLInputElement | null;
    const webInput = this.shadow.querySelector('[data-create-website]') as HTMLInputElement | null;
    if (createBtn && nameInput) {
      nameInput.addEventListener('input', () => {
        this._clubForm.createName = nameInput.value;
      });
      if (webInput) {
        webInput.addEventListener('input', () => {
          this._clubForm.createWebsite = webInput.value;
        });
      }
      // F1: thin callers — the submit method owns the entire lifecycle.
      createBtn.addEventListener('click', () => {
        this.submitCreate();
      });
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submitCreate();
        }
      });
    }
  }

  // ─── Consolidated Equipos tab ──────────────────────────────────────────
  // "Mis equipos" (self-scoped selection summary) + "Equipos del club"
  // (catalog). Selection rides the self-scoped /api/org/my-teams contract;
  // catalog management keeps the existing club.teams.manage-gated endpoints.

  // Merge the two feeds by team id into one normalized row model — the
  // my-teams catalog defines the selectable universe and its order; the
  // management feed enriches rows it knows (archived flag, competition
  // level) and contributes management-only rows. No row appears twice.
  private _mergedCatalog(): TeamRow[] {
    const mgmtById = new Map(this._teams.map((t) => [t.id, t]));
    const merged: TeamRow[] = [];
    const seen = new Set<string>();
    for (const t of this._myTeamsCatalog) {
      const m = mgmtById.get(t.id);
      seen.add(t.id);
      merged.push({
        id: t.id,
        name: m?.name || t.name,
        category: (m?.category ?? t.category) || null,
        gender: (m?.gender ?? t.gender) || null,
        label: (m?.label ?? t.label) || null,
        archived: m ? !!m.archived : !!t.archived,
        competitive_level: m?.competitive_level ?? t.competitive_level,
        players: m?.players ?? t.players,
      });
    }
    for (const t of this._teams) {
      if (!seen.has(t.id)) merged.push(t);
    }
    return merged;
  }

  // Selected ids in catalog order — the PUT contract sends the complete
  // desired set. Only selectable rows count (in catalog, not archived), so a
  // stale archived/foreign persisted id is cleaned by the next explicit save
  // rather than silently re-persisted.
  private _orderedSelectedIds(): string[] {
    const selectable = new Map(
      this._mergedCatalog().filter((t) => !t.archived).map((t, i) => [t.id, i] as [string, number]),
    );
    return [...this._selectedIds]
      .filter((id) => selectable.has(id))
      .sort((a, b) => selectable.get(a)! - selectable.get(b)!);
  }

  private _myTeamsChipsHtml(): string {
    const catalog = this._mergedCatalog();
    const byId = new Map(catalog.map((t) => [t.id, t]));
    const chips: string[] = [];
    const stale: string[] = [];
    for (const t of catalog) {
      if (!this._selectedIds.has(t.id)) continue;
      const label = t.name || t.label || t.id;
      if (t.archived) {
        stale.push(`<span class="onboard-myteams-chip onboard-myteams-chip-stale" title="Equipo archivado">${escapeHtml(label)} · no disponible</span>`);
      } else {
        chips.push(`<span class="onboard-myteams-chip">${escapeHtml(label)}</span>`);
      }
    }
    // A persisted id outside the current catalog is flagged too — never
    // silently dropped from the summary.
    for (const id of this._selectedIds) {
      if (!byId.has(id)) {
        stale.push(`<span class="onboard-myteams-chip onboard-myteams-chip-stale" title="Ya no está en el catálogo">${escapeHtml(id)} · no disponible</span>`);
      }
    }
    if (!chips.length && !stale.length) {
      return '<span class="onboard-myteams-empty">No tienes equipos seleccionados</span>';
    }
    return chips.join('') + stale.join('');
  }

  private _selectionStatusText(): string {
    switch (this._selectionStatus) {
      case 'saving': return 'Guardando…';
      case 'saved': return 'Guardado';
      case 'error': return 'No se pudo guardar';
      default: return '';
    }
  }

  // Continuar is usable once a non-empty selection is persisted — a deep
  // link with ?return= must never navigate before a successful save.
  private _canContinue(): boolean {
    return !!this._returnRoute && this._selectedIds.size > 0 && this._selectionStatus !== 'saving';
  }

  private _renderMyTeamsBlock(canPick: boolean): string {
    const status = this._selectionStatusText();
    const statusCls = this._selectionStatus === 'error' ? ' onboard-save-status-error' : '';
    return `<div class="onboard-card onboard-myteams">
      <h3 class="onboard-card-title">Mis equipos</h3>
      <div class="onboard-myteams-chips" data-myteams-chips>${this._myTeamsChipsHtml()}</div>
      ${canPick ? `<div class="onboard-myteams-meta">
        <span class="onboard-save-status${statusCls}" data-selection-status aria-live="polite">${escapeHtml(status)}</span>
        <button class="onboard-linkbtn" data-retry-save ${this._selectionStatus === 'error' && this._failedSelection ? '' : 'hidden'}>Reintentar</button>
        ${this._returnRoute ? `<button class="onboard-btn onboard-btn-primary onboard-btn-sm" data-continue ${this._canContinue() ? '' : 'disabled'}>Continuar</button>` : ''}
      </div>` : ''}
    </div>`;
  }

  // F12: Render the Equipos tab — club team catalog management.
  private renderTeamsTab(): string {
    const canPick = this._canPickTeams();
    const canManage = this._canManageTeams();
    // Section subscreen (global nav contract §C): the editor replaces the
    // Equipos list. Resolution stays fail-closed in _activeSubscreen.
    if (this._activeSubscreen() === 'team-edit') {
      return this._editLoading || !this._editModel
        ? this._renderTeamEditLoading()
        : this._renderTeamEditScreen(this._editModel);
    }
    const myTeamsBlock = this._renderMyTeamsBlock(canPick);

    // Team-seeding job states — pending shows "generating", failed (or a
    // stale pending) shows an explicit error + Reintentar. The category
    // sections still render below so manual add stays available.
    let seedingBanner = '';
    if (canManage) {
      const seeding = this._teamSeedingJob;
      if (seeding?.status === 'pending' && !this._seedingStale) {
        seedingBanner = '<div class="onboard-loading" role="status" aria-live="polite"><span class="onboard-spinner" aria-hidden="true"></span> Generando el catálogo de equipos del club… Esto puede tardar unos segundos.</div>';
      } else if (seeding?.status === 'failed' || (seeding?.status === 'pending' && this._seedingStale)) {
        const reason = seeding.reason ? `<p class="onboard-card-desc">${escapeHtml(seeding.reason)}</p>` : '';
        const staleNote = this._seedingStale ? '<p class="onboard-card-desc">El proceso está tardando demasiado.</p>' : '';
        seedingBanner = `<div class="onboard-card">
        <p class="onboard-error" role="alert">No se pudieron generar los equipos automáticamente.</p>
        ${reason}${staleNote}
        <p class="onboard-card-desc">Puedes reintentar la generación o añadir equipos manualmente desde cada categoría.</p>
        <button class="onboard-btn onboard-btn-primary" data-reseed-teams ${this._seedingLoading ? 'disabled' : ''}>${this._seedingLoading ? 'Generando…' : 'Reintentar'}</button>
      </div>`;
      }
    }

    if (this._myTeamsLoading && !this._myTeamsLoaded) {
      return `${myTeamsBlock}<div class="onboard-loading" role="status" aria-live="polite"><span class="onboard-spinner" aria-hidden="true"></span> Cargando equipos…</div>`;
    }
    if (this._myTeamsError && !this._myTeamsLoaded) {
      return `${myTeamsBlock}<div class="onboard-error" role="alert">${escapeHtml(this._myTeamsError)} <button class="onboard-linkbtn" data-retry-load>Reintentar</button></div>`;
    }
    if (canManage && this._teamsLoading && !this._teams.length) {
      return `${myTeamsBlock}<div class="onboard-loading" role="status" aria-live="polite"><span class="onboard-spinner" aria-hidden="true"></span> Cargando equipos…</div>`;
    }
    if (canManage && this._teamsError && !this._deleteConfirmTeamId && !this._teams.length) {
      return `${myTeamsBlock}<div class="onboard-error" role="alert">${escapeHtml(this._teamsError)}</div>`;
    }

    const catalog = this._mergedCatalog();
    // Non-managers only ever see the active catalog — archived rows and the
    // archived filter are management surfaces.
    const visibleTeams = canManage
      ? (this._teamsFilter === 'all' ? catalog : catalog.filter(t => !t.archived))
      : catalog.filter(t => !t.archived);

    // Group teams by category using the canonical order.
    const groups = new Map<string, TeamRow[]>();
    for (const t of visibleTeams) {
      const cat = t.category || 'senior';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(t);
    }

    // Managers keep every canonical category card so the + add-row is always
    // available; pickers/read-only roles only see categories with teams.
    const allCategoryIds = new Set<string>();
    for (const t of catalog) {
      if (canManage || !t.archived) allCategoryIds.add(t.category || 'senior');
    }
    if (canManage) {
      for (const cat of CATEGORY_ORDER) {
        allCategoryIds.add(cat);
      }
    }

    const sections = Array.from(allCategoryIds).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }).map((cat) => {
      const catLabel = CATEGORY_LABELS[cat] || cat;
      const teams = groups.get(cat) || [];
      const rows = teams.map((t) => {
        // Gender shows the stored single-letter code (M/F/X) — no Fem/Masc/Mix
        // mapping, so the badge stays one character wide on narrow screens.
        const genderBadge = t.gender ? `<span class="onboard-badge">${escapeHtml(t.gender)}</span>` : '';
        const archivedBadge = t.archived ? '<span class="onboard-badge onboard-badge-muted">Archivado</span>' : '';
        const level = t.competitive_level
          ? (COMPETITIVE_LEVEL_LABELS[t.competitive_level] || t.competitive_level)
          : (canManage ? 'Sin definir' : '');
        // Selection is its own click target on the right side of the primary
        // row. Management icons stay on the meta line so picking a team can
        // never fire edit/archive/delete. Archived teams are not selectable.
        const selected = this._selectedIds.has(t.id);
        const pick = (canPick && !t.archived)
          ? `<label class="onboard-team-pick" title="${selected ? 'Quitar' : 'Añadir'} ${escapeHtml(t.name)} ${selected ? 'de' : 'a'} Mis equipos" aria-label="${selected ? 'Quitar' : 'Añadir'} ${escapeHtml(t.name)} ${selected ? 'de' : 'a'} Mis equipos"><input type="checkbox" class="onboard-team-check" data-pick-team="${escapeHtml(t.id)}"${selected ? ' checked' : ''} /><span class="onboard-team-box">${ICON_CHECK}</span></label>`
          : '';
        let actions = '';
        if (canManage) {
          const actionBtns = [
            `<button class="onboard-icon-btn" data-edit-team="${escapeHtml(t.id)}" title="Editar equipo" aria-label="Editar equipo">${ICON_EDIT}</button>`,
            `<button class="onboard-icon-btn" data-edit-roster="${escapeHtml(t.id)}" title="Plantilla" aria-label="Editar plantilla">${ICON_USERS}</button>`,
          ];
          if (t.archived) {
            // Archived teams: show restore + delete (physical)
            actionBtns.push(`<button class="onboard-icon-btn" data-unarchive-team="${escapeHtml(t.id)}" title="Restaurar" aria-label="Restaurar">${ICON_RESTORE}</button>`);
            actionBtns.push(`<button class="onboard-icon-btn onboard-icon-btn-danger" data-delete-team="${escapeHtml(t.id)}" title="Eliminar" aria-label="Eliminar">${ICON_TRASH}</button>`);
          } else {
            // Active teams: archive (logical) + delete (physical)
            actionBtns.push(`<button class="onboard-icon-btn" data-archive-team="${escapeHtml(t.id)}" title="Archivar" aria-label="Archivar">${ICON_ARCHIVE}</button>`);
            actionBtns.push(`<button class="onboard-icon-btn onboard-icon-btn-danger" data-delete-team="${escapeHtml(t.id)}" title="Eliminar" aria-label="Eliminar">${ICON_TRASH}</button>`);
          }
          actions = `<div class="onboard-team-actions">${actionBtns.join('')}</div>`;
        }
        // Name gets the full row width (never truncates); gender/level/actions
        // share the compact second line.
        return `<div class="onboard-team-row" data-team-row="${escapeHtml(t.id)}">
          <div class="onboard-team-row-main">
            <span class="onboard-team-name">${escapeHtml(t.name)}</span> ${archivedBadge}
            ${pick}
          </div>
          <div class="onboard-team-row-meta">
            ${genderBadge}
            ${level ? `<span class="onboard-team-level">${escapeHtml(level)}</span>` : ''}
            ${actions}
          </div>
        </div>`;
      }).join('');

      // Category-level add row (when _addingTeamCategory === cat)
      const addRow = canManage && this._addingTeamCategory === cat ? `<div class="onboard-team-row" data-adding-row="true">
        <div class="onboard-team-row-main">
          <input type="text" class="onboard-input onboard-input-sm" data-new-team-name placeholder="Nombre del equipo" />
        </div>
        <div class="onboard-team-row-meta">
          <select class="onboard-input onboard-input-sm" data-new-team-gender>
            <option value="M">M</option>
            <option value="F">F</option>
            <option value="X">X</option>
          </select>
          <select class="onboard-input onboard-input-sm" data-new-team-level aria-label="Nivel de competición">${competitiveLevelOptionsHtml('')}</select>
          <div class="onboard-team-actions">
            <button class="onboard-icon-btn" data-confirm-add-team="${escapeHtml(cat)}" title="Confirmar" aria-label="Confirmar">${ICON_CHECK}</button>
            <button class="onboard-icon-btn" data-cancel-add-team title="Cancelar" aria-label="Cancelar">${ICON_CANCEL}</button>
          </div>
        </div>
      </div>` : '';

      const hasTeams = teams.length > 0 || this._addingTeamCategory === cat;
      if (!hasTeams) {
        // Empty category: just show the header (+ button for managers)
        return `<div class="onboard-card">
          <div class="onboard-team-header">
            <h3 class="onboard-card-title">${escapeHtml(catLabel)}</h3>
            ${canManage ? `<button class="onboard-icon-btn" data-add-team-category="${escapeHtml(cat)}" title="Añadir equipo" aria-label="Añadir equipo a ${escapeHtml(catLabel)}">${ICON_PLUS}</button>` : ''}
          </div>
        </div>`;
      }
      return `<div class="onboard-card">
        <div class="onboard-team-header">
          <h3 class="onboard-card-title">${escapeHtml(catLabel)}</h3>
          ${canManage ? `<button class="onboard-icon-btn" data-add-team-category="${escapeHtml(cat)}" title="Añadir equipo" aria-label="Añadir equipo a ${escapeHtml(catLabel)}">${ICON_PLUS}</button>` : ''}
        </div>
        <div class="onboard-team-list" role="table" aria-label="Equipos">
          ${rows}${addRow}
        </div>
      </div>`;
    }).join('');

    // Delete confirmation modal (management only)
    const deleteModal = canManage && this._deleteConfirmTeamId ? (() => {
      const team = this._mergedCatalog().find(t => t.id === this._deleteConfirmTeamId);
      const teamName = team ? team.name : this._deleteConfirmTeamId;
      return `<div class="onboard-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
        <div class="onboard-modal">
          <h3 id="delete-modal-title">Confirmar eliminación</h3>
          <p>¿Seguro que quieres eliminar definitivamente el equipo <strong>${escapeHtml(teamName)}</strong>?</p>
          <p class="onboard-card-desc">Esta acción no se puede deshacer.</p>
          <div class="onboard-team-actions">
            <button class="onboard-btn onboard-btn-danger" data-confirm-delete-team="${escapeHtml(this._deleteConfirmTeamId)}">Eliminar</button>
            <button class="onboard-btn onboard-btn-secondary" data-cancel-delete>Cancelar</button>
          </div>
        </div>
      </div>`;
    })() : '';

    return `<section class="onboard-section">
      ${myTeamsBlock}
      <div class="onboard-form-row onboard-clubteams-head">
        <h3 class="onboard-card-title">Equipos del club</h3>
        ${canManage ? `<label class="onboard-filter-label">
          Ver:
          <select class="onboard-input onboard-input-sm" data-teams-filter>
            <option value="active" ${this._teamsFilter === 'active' ? 'selected' : ''}>Activos</option>
            <option value="all" ${this._teamsFilter === 'all' ? 'selected' : ''}>Todos</option>
          </select>
        </label>` : ''}
      </div>
      ${seedingBanner}
      ${this._teamsError ? `<div class="onboard-error" role="alert">${escapeHtml(this._teamsError)}</div>` : ''}
      ${sections || '<p class="onboard-card-desc">No hay equipos.</p>'}
      ${deleteModal}
    </section>`;
  }

  // Team edit/Plantilla subscreen (global nav contract §C): replaces the
  // Equipos list, carries the sticky orange section subheader titled
  // «Club – <team name>», and keeps the full draft/focus contract of the
  // previous modal (data-edit-modal keeps _maybeFocusRoster's anchor).
  // Shared roster-editor shell — the same section for club and personal
  // models; loading is a separate marker so waits on [data-edit-modal]
  // only resolve once the model's drafts are actually painted.
  private _renderTeamEditLoading(): string {
    return `<section class="onboard-section onboard-subscreen">
      <div class="onboard-subscreen-card">
        <p class="entry-loading">Cargando equipo…</p>
      </div>
    </section>`;
  }

  private _renderTeamEditScreen(model: TeamEditorModel): string {
    // permissions.edit=false renders the truthful read-only state — a
    // readable own team outside the working set is never shown writable.
    // Con autosave los inputs NO se deshabilitan durante el vuelo — teclear
    // mientras guarda es el caso central; la cola serial lo ordena.
    const readOnly = !model.permissions.edit;
    const off = readOnly ? ' disabled' : '';
    // Club teams only: the birth-date field is a biq-player profile field
    // anchored on player_id, and the add-player offer links existing club
    // players — personal rosters have neither channel.
    const isClub = model.category !== undefined;
    const showBirth = isClub;
    const rosterRows = this._rosterDraft
      .map((p, i) => this._rosterRowHtml(p, i, readOnly, showBirth))
      .join('');
    return `<section class="onboard-section onboard-subscreen" data-edit-modal aria-labelledby="edit-team-title">
      <div class="onboard-subscreen-card">
        <h3 class="onboard-card-title" id="edit-team-title">${readOnly ? 'Equipo (solo lectura)' : 'Editar equipo'}</h3>
        ${readOnly ? '<p class="onboard-card-desc" data-edit-readonly-note>Este equipo está fuera de tu selección activa — solo lectura.</p>' : ''}
        ${model.category !== undefined ? `
        <label class="onboard-field-label" for="edit-team-category">Categoría</label>
        <select id="edit-team-category" class="onboard-input" data-edit-team-category${off}>${categoryOptionsHtml(this._editCategoryDraft)}</select>` : ''}
        <label class="onboard-field-label" for="edit-team-name">Nombre del equipo</label>
        <input id="edit-team-name" type="text" class="onboard-input" data-edit-team-name value="${escapeHtml(this._editNameDraft)}"${off} />
        ${model.gender !== undefined ? `
        <label class="onboard-field-label" for="edit-team-gender">Género</label>
        <select id="edit-team-gender" class="onboard-input" data-edit-team-gender${off}>${genderOptionsHtml(this._editGenderDraft)}</select>` : ''}
        <label class="onboard-field-label" for="edit-team-level">Nivel de competición</label>
        <select id="edit-team-level" class="onboard-input" data-edit-team-level${off}>${competitiveLevelOptionsHtml(this._editLevelDraft)}</select>
        <div class="onboard-roster">
          <div class="onboard-roster-head">
            <h4 class="onboard-roster-title">Plantilla</h4>
            ${readOnly ? '' : `<button class="onboard-linkbtn" data-add-player type="button"${off}>+ Añadir jugador</button>`}
          </div>
          <div class="onboard-roster-rows" data-edit-roster-rows>
            ${rosterRows || '<p class="onboard-card-desc onboard-roster-empty">Sin jugadores todavía — añade el primero con «Añadir jugador».</p>'}
          </div>
          ${!readOnly && isClub && this._addPlayerPickerOpen ? this._addPlayerPickerHtml() : ''}
        </div>
        ${this._editError ? `<div class="onboard-error onboard-modal-error" role="alert">${escapeHtml(this._editError)}</div>` : ''}
        ${readOnly ? '' : `<div class="onboard-save-state">
          <span class="onboard-save-chip is-${this._editSaveStatus}" data-edit-save-status role="status" aria-live="polite" tabindex="-1"${this._editSaveStatus === 'idle' ? ' hidden' : ''}>${this._editSaveStatusLabel()}</span>
          <span class="onboard-save-detail" data-edit-save-detail role="alert"${this._editSaveMessage ? '' : ' hidden'}>${escapeHtml(this._editSaveMessage || '')}</span>
          <button class="onboard-btn onboard-btn-sm" data-edit-retry type="button"${this._editSaveStatus === 'error' || (this._editSaveStatus === 'conflict' && !this._editConflictServer) ? '' : ' hidden'}>Reintentar</button>
          <button class="onboard-btn onboard-btn-sm" data-edit-keep-mine type="button"${this._editSaveStatus === 'conflict' && this._editConflictServer ? '' : ' hidden'}>Mantener mis cambios</button>
          <button class="onboard-btn onboard-btn-sm onboard-btn-quiet" data-edit-load-server type="button"${this._editSaveStatus === 'conflict' && this._editConflictServer ? '' : ' hidden'}>Cargar versión actual</button>
        </div>`}
        <div class="onboard-team-actions">
          <button class="onboard-btn onboard-btn-secondary" data-cancel-edit type="button">Volver</button>
        </div>
      </div>
    </section>`;
  }

  // ─── PD-2 «+ Añadir jugadora» offer ──────────────────────────────────
  // Before creating a new row, the club editor offers to link an existing
  // club player: same person appearing in another team's plantilla keeps
  // her `player_id` (the server accepts same-club ids as a link, PD-2).
  // Candidates come from the already-loaded club catalog (_teams, every
  // team's roster); a player already in this draft is never offered twice.

  private _clubPlayerCandidates(): {
    player_id: string;
    name: string;
    number: number | null;
    teamId: string;
    teamName: string;
    birth_date: string;
  }[] {
    const inDraft = new Set(
      this._rosterDraft.map((r) => r.player_id).filter((p) => !!p) as string[],
    );
    const seen = new Set<string>();
    const out: {
      player_id: string;
      name: string;
      number: number | null;
      teamId: string;
      teamName: string;
      birth_date: string;
    }[] = [];
    for (const t of this._teams) {
      for (const p of t.players || []) {
        const pid = p.player_id;
        if (!pid || seen.has(pid) || inDraft.has(pid)) continue;
        seen.add(pid);
        out.push({
          player_id: pid,
          name: p.name,
          number: p.number,
          teamId: t.id,
          teamName: t.name,
          birth_date: this._playerProfiles[pid]?.birth_date || '',
        });
      }
    }
    return out;
  }

  private _addPlayerPickerHtml(): string {
    const candidates = this._clubPlayerCandidates();
    const list = candidates.length
      ? `<div class="onboard-linkable-list">${candidates.map((c) => `
          <button class="onboard-linkbtn onboard-linkable" data-link-player="${escapeHtml(c.player_id)}" type="button">
            ${escapeHtml(c.name)}${c.number !== null ? ` · Nº ${c.number}` : ''} — ${escapeHtml(c.teamName)}${c.birth_date ? ` · ${escapeHtml(c.birth_date)}` : ''}
          </button>`).join('')}</div>`
      : '<p class="onboard-card-desc">No hay más jugadoras en las plantillas del club.</p>';
    return `<div class="onboard-addplayer" data-add-player-picker>
      <p class="onboard-card-desc">¿Ya figura en otra plantilla del club? Vincúlala para conservar su identidad de scouting.</p>
      ${list}
      <div class="onboard-team-actions">
        <button class="onboard-btn onboard-btn-sm" data-add-new-player type="button">Nueva jugadora</button>
        <button class="onboard-btn onboard-btn-sm onboard-btn-quiet" data-cancel-link type="button">Cancelar</button>
      </div>
    </div>`;
  }

  private renderProfile(): string {
    const user = this._user || 'Usuario';
    const club = this._org?.club;
    const role = this._org?.role || 'coach';
    const roleLabels: Record<string, string> = {
      sports_director: 'Director deportivo',
      coach: 'Entrenador',
      administrator: 'Administrador',
      super_administrator: 'Super administrador',
    };

    // Phase 3: club summary card — real reads from the summary endpoint.
    // Presence is tri-state: Sí / No / Desconocido (upstream unreachable).
    const presence = (v: boolean | null | undefined) =>
      v === true ? 'Sí' : v === false ? 'No' : 'Desconocido';
    const s = this._clubSummary;
    let summaryCard: string;
    if (this._clubSummaryLoading && !s) {
      summaryCard = '<div class="onboard-loading" role="status" aria-live="polite"><span class="onboard-spinner" aria-hidden="true"></span> Cargando datos del club…</div>';
    } else if (this._clubSummaryError && !s) {
      summaryCard = `<div class="onboard-error" role="alert">${escapeHtml(this._clubSummaryError)}</div>`;
    } else if (s) {
      summaryCard = `<div class="onboard-card" data-club-summary>
        <h3 class="onboard-card-title">Tu club</h3>
        <dl class="onboard-summary-list">
          <div class="onboard-summary-row"><dt>ID del club</dt><dd><code class="onboard-club-id" data-club-id>${escapeHtml(s.club.id)}</code></dd></div>
          <div class="onboard-summary-row"><dt>Equipos</dt><dd data-team-count>${s.team_count}</dd></div>
          <div class="onboard-summary-row"><dt>Miembros</dt><dd data-member-count>${s.member_count}</dd></div>
          <div class="onboard-summary-row"><dt>Metodología</dt><dd data-methodology-present>${presence(s.methodology_present)}</dd></div>
          <div class="onboard-summary-row"><dt>Plan de temporada</dt><dd data-season-plan-present>${presence(s.season_plan_present)}</dd></div>
        </dl>
      </div>`;
    } else {
      summaryCard = '';
    }

    return `
      <section class="onboard-section">
        <div class="onboard-profile-card">
          <div class="onboard-profile-avatar">${escapeHtml(user.charAt(0).toUpperCase())}</div>
          <h2 class="onboard-profile-name">${escapeHtml(user)}</h2>
          ${club ? `<p class="onboard-profile-club">${escapeHtml(club.name || club.id)}</p>` : ''}
          <span class="onboard-profile-role">${escapeHtml(roleLabels[role] || role)}</span>
        </div>
        ${summaryCard}
      </section>`;
  }

  // ─── Mi Club Phase 4: Miembros tab ─────────────────────────────────────

  // Role management surface for a member row. Administrators can edit
  // identity + all assignable roles; sports directors can only manage
  // sporting roles on sporting-role members (server enforces the same).
  private _memberCanEdit(member: MemberRow): boolean {
    const role = this._org?.role || '';
    if (role === 'administrator' || role === 'super_administrator') return true;
    if (role === 'sports_director') {
      return SPORTING_ASSIGNABLE_ROLES.includes(member.role);
    }
    return false;
  }

  private _memberAssignableRoles(): string[] {
    const role = this._org?.role || '';
    return role === 'sports_director' ? SPORTING_ASSIGNABLE_ROLES : ASSIGNABLE_ROLES;
  }

  private renderMembers(clubId: string): string {
    const members = this._members || [];
    const inv = this._inviteState;
    const myRole = this._org?.role || '';
    const isAdminTier = myRole === 'administrator' || myRole === 'super_administrator';
    const roleOptions = this._memberAssignableRoles();

    // Section subscreen (global nav contract §C): member editing replaces
    // the Miembros list. Resolution stays fail-closed in _activeSubscreen.
    if (this._activeSubscreen() === 'member-edit') {
      const editingMember = members.find((m) => m.id === this._editingMemberId)!;
      return this._renderMemberEditScreen(editingMember, isAdminTier, roleOptions);
    }

    let body: string;
    if (this._membersError) {
      body = `<p class="onboard-error" data-members-error>No se pudo cargar la lista de miembros (${escapeHtml(this._membersError)}).</p><button class="onboard-btn onboard-btn-sm" data-members-retry type="button">Reintentar</button>`;
    } else if (this._members === null) {
      // Roster unknown: never fetched or load still in flight — never show
      // the empty message until a successful 200 confirms an empty array.
      body = '<p class="onboard-muted">Cargando miembros…</p>';
    } else if (members.length === 0) {
      body = '<p class="onboard-muted">Aún no hay miembros en este club.</p>';
    } else {
      body = `<div class="onboard-member-list">${members.map((m) => this._renderMemberRow(m, isAdminTier)).join('')}</div>`;
    }

    return `<section class="onboard-section" data-testid="members-tab">
      <div class="onboard-invite-card">
        <h3 class="onboard-invite-title">Invitar a un miembro</h3>
        <p class="onboard-muted">Recibirá un email con instrucciones para unirse al club.</p>
        <form class="onboard-invite-form" data-invite-form data-club-id="${escapeHtml(clubId)}">
          <input type="email" class="onboard-input" data-invite-email placeholder="email@ejemplo.com"
            required ${inv.sending ? 'disabled' : ''} />
          <button type="submit" class="onboard-btn" ${inv.sending ? 'disabled' : ''}>
            ${inv.sending ? 'Enviando…' : 'Invitar'}</button>
        </form>
        ${inv.error ? `<p class="onboard-error" data-invite-error>${escapeHtml(inv.error)}</p>` : ''}
        ${inv.sent ? `<p class="onboard-success" data-invite-sent>Invitación enviada a ${escapeHtml(inv.sent)}.</p>` : ''}
      </div>
      ${body}
    </section>`;
  }

  private _renderMemberRow(m: MemberRow, isAdminTier: boolean): string {
    const deactivated = m.status === 'deactivated';
    const canEdit = this._memberCanEdit(m);
    const secondary = (m.roles || []).filter((r) => r !== m.role);
    const roleBadges = [m.role, ...secondary]
      .map((r) => `<span class="onboard-role-badge">${escapeHtml(ROLE_LABELS[r] || r)}</span>`)
      .join('');

    const statusBadge = deactivated
      ? '<span class="onboard-status-badge off">Desactivado</span>' : '';
    // V2 Miembros (UX-15/16): el email es la única identidad de la fila —
    // nunca display_name ni id técnicos como cabecera. Un email genuinamente
    // ausente es incidencia explícita, no un fallback fabricado.
    const email = (m.email || '').trim();
    const identity = email ? escapeHtml(email) : '';
    const identityForLabel = email ? escapeHtml(email) : 'miembro sin email disponible';
    const actions = canEdit ? `
      <div class="onboard-member-actions">
        <button class="onboard-icon-btn onboard-icon-btn-lg" data-member-edit="${escapeHtml(m.id)}" type="button"
          aria-label="Editar a ${identityForLabel}" title="Editar a ${identityForLabel}">${MEMBER_ICONS.edit}</button>
        <button class="onboard-icon-btn onboard-icon-btn-lg" data-member-status="${escapeHtml(m.id)}" type="button"
          data-status="${deactivated ? 'active' : 'deactivated'}"
          aria-label="${deactivated ? 'Reactivar' : 'Desactivar'} a ${identityForLabel}"
          title="${deactivated ? 'Reactivar' : 'Desactivar'} a ${identityForLabel}">${deactivated ? MEMBER_ICONS.reactivate : MEMBER_ICONS.deactivate}</button>
        ${isAdminTier ? (this._deleteConfirmUserId === m.id
          ? `<button class="onboard-btn onboard-btn-sm onboard-btn-danger" data-member-delete="${escapeHtml(m.id)}" type="button"
              aria-label="Confirmar eliminación de ${identityForLabel}">Confirmar</button>`
          : `<button class="onboard-icon-btn onboard-icon-btn-lg onboard-icon-btn-danger" data-member-delete="${escapeHtml(m.id)}" type="button"
              aria-label="Eliminar a ${identityForLabel}" title="Eliminar a ${identityForLabel}">${MEMBER_ICONS.delete}</button>`)
        : ''}
      </div>` : '';
    return `<div class="onboard-member-row${deactivated ? ' off' : ''}" data-member-row="${escapeHtml(m.id)}">
      <div class="onboard-member-main">
        <span class="onboard-member-email${email ? '' : ' missing'}">${email ? identity : 'Email no disponible'}</span>
        ${actions}
      </div>
      <div class="onboard-member-meta">${roleBadges}${statusBadge}</div>
      ${email ? '' : '<p class="onboard-member-note">Debe recuperarse el email desde la fuente autorizada.</p>'}
    </div>`;
  }

  // Member detail/editing subscreen (global nav contract §C): the sticky
  // orange subheader carries «Club – <member context>»; back resolves to
  // the Miembros list — never history.back(), never app Home.
  private _renderMemberEditScreen(m: MemberRow, isAdminTier: boolean, roleOptions: string[]): string {
    const secondary = (m.roles || []).filter((r) => r !== m.role);
    // Identity fields are admin-only; role chips for everyone who
    // passed _memberCanEdit.
    const identityFields = isAdminTier ? `
      <input class="onboard-input" data-edit-name="${escapeHtml(m.id)}"
        value="${escapeHtml(m.display_name || '')}" placeholder="Nombre" />
      <input class="onboard-input" data-edit-email="${escapeHtml(m.id)}"
        value="${escapeHtml(m.email || '')}" placeholder="Email" type="email" />` : '';
    const primarySelect = isAdminTier ? `
      <label class="onboard-member-field">Rol principal
        <select class="onboard-input" data-edit-primary="${escapeHtml(m.id)}">
          ${roleOptions.map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${escapeHtml(ROLE_LABELS[r] || r)}</option>`).join('')}
        </select>
      </label>` : '';
    const secondaryChips = secondary.map((r) => `
      <span class="onboard-role-badge removable">${escapeHtml(ROLE_LABELS[r] || r)}
        <button class="onboard-chip-x" data-member-role-remove="${escapeHtml(m.id)}" data-role="${escapeHtml(r)}"
          title="Quitar rol">×</button>
      </span>`).join('');
    const addableRoles = roleOptions.filter((r) => r !== m.role && !secondary.includes(r));
    const addSelect = addableRoles.length ? `
      <select class="onboard-input onboard-input-sm" data-member-role-add="${escapeHtml(m.id)}">
        <option value="">Añadir rol…</option>
        ${addableRoles.map((r) => `<option value="${r}">${escapeHtml(ROLE_LABELS[r] || r)}</option>`).join('')}
      </select>` : '';

    return `<section class="onboard-section onboard-subscreen" data-member-edit-screen>
      <div class="onboard-subscreen-card" data-member-row="${escapeHtml(m.id)}">
        <div class="onboard-member-edit">
          ${identityFields}
          ${primarySelect}
          <div class="onboard-member-roles-edit">${secondaryChips}${addSelect}</div>
          <div class="onboard-member-edit-actions">
            <button class="onboard-btn onboard-btn-sm onboard-btn-primary" data-member-save="${escapeHtml(m.id)}">Guardar</button>
            <button class="onboard-btn onboard-btn-sm" data-member-cancel>Cancelar</button>
          </div>
        </div>
      </div>
    </section>`;
  }

  private wireMembersEvents(clubId: string): void {
    // Navigation — shared path so every tab entry triggers its loader.
    this.shadow.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nav = (btn as HTMLElement).dataset.nav || 'club-details';
        this._selectTab(nav, clubId);
      });
    });

    // Error-state retry.
    this.shadow.querySelector('[data-members-retry]')?.addEventListener('click', () => {
      this.loadMembers(clubId);
    });

    // Invite form → Phase 5 endpoint.
    this.shadow.querySelector('[data-invite-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = this.shadow.querySelector('[data-invite-email]') as HTMLInputElement | null;
      const email = (input?.value || '').trim();
      if (!email) return;
      this._inviteState = { sending: true, error: null, sent: null };
      this.render();
      try {
        const res = await fetch(`/api/clubs/${clubId}/invite`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        this._inviteState = { sending: false, error: null, sent: email };
      } catch (err) {
        this._inviteState = { sending: false, error: (err as Error).message, sent: null };
      }
      this.render();
    });

    const mutate = async (fn: () => Promise<Response>) => {
      try {
        const res = await fn();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        this._membersError = null;
      } catch (err) {
        this._membersError = (err as Error).message;
      } finally {
        this._members = null; // force refetch
        this.render();
        this.loadMembers(clubId);
      }
    };

    this.shadow.querySelectorAll('[data-member-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._editingMemberId = (btn as HTMLElement).dataset.memberEdit || null;
        this.render();
      });
    });
    this.shadow.querySelector('[data-member-cancel]')?.addEventListener('click', () => {
      this._editingMemberId = null;
      this.render();
    });

    this.shadow.querySelectorAll('[data-member-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement;
        const userId = el.dataset.memberStatus!;
        const status = el.dataset.status!;
        mutate(() => fetch(`/api/clubs/${clubId}/users/${userId}/status`, {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }));
      });
    });

    this.shadow.querySelectorAll('[data-member-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        const userId = (btn as HTMLElement).dataset.memberDelete!;
        if (this._deleteConfirmUserId === userId) {
          this._deleteConfirmUserId = null;
          mutate(() => fetch(`/api/clubs/${clubId}/users/${userId}`, {
            method: 'DELETE', credentials: 'include',
          }));
        } else {
          this._deleteConfirmUserId = userId;
          this.render();
        }
      });
    });

    this.shadow.querySelectorAll('[data-member-role-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement;
        const userId = el.dataset.memberRoleRemove!;
        const role = el.dataset.role!;
        const assignment = (this._memberAssignments || []).find(
          (a) => a.user_id === userId && a.role === role && a.club_id === clubId);
        if (!assignment) { this._membersError = 'Asignación no encontrada'; this.render(); return; }
        mutate(() => fetch(`/api/clubs/${clubId}/roles/${encodeURIComponent(assignment.id)}`, {
          method: 'DELETE', credentials: 'include',
        }));
      });
    });

    this.shadow.querySelectorAll('[data-member-role-add]').forEach(sel => {
      sel.addEventListener('change', () => {
        const el = sel as HTMLSelectElement;
        const userId = el.dataset.memberRoleAdd!;
        const role = el.value;
        if (!role) return;
        mutate(() => fetch(`/api/clubs/${clubId}/roles`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, role }),
        }));
      });
    });

    this.shadow.querySelectorAll('[data-member-save]').forEach(btn => {
      btn.addEventListener('click', () => {
        const userId = (btn as HTMLElement).dataset.memberSave!;
        const nameEl = this.shadow.querySelector(`[data-edit-name="${userId}"]`) as HTMLInputElement | null;
        const emailEl = this.shadow.querySelector(`[data-edit-email="${userId}"]`) as HTMLInputElement | null;
        const primaryEl = this.shadow.querySelector(`[data-edit-primary="${userId}"]`) as HTMLSelectElement | null;
        const payload: Record<string, string> = {};
        const member = (this._members || []).find((m) => m.id === userId);
        if (nameEl && nameEl.value.trim() !== (member?.display_name || '')) {
          payload.display_name = nameEl.value.trim();
        }
        if (emailEl && emailEl.value.trim() !== (member?.email || '')) {
          payload.email = emailEl.value.trim();
        }
        if (primaryEl && primaryEl.value !== member?.role) {
          payload.role = primaryEl.value;
        }
        if (Object.keys(payload).length === 0) {
          this._editingMemberId = null;
          this.render();
          return;
        }
        this._editingMemberId = null;
        mutate(() => fetch(`/api/clubs/${clubId}/users/${userId}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));
      });
    });
  }

  // ─── Event wiring ──────────────────────────────────────────────────────

  private wireEvents(clubId: string): void {
    const brand = this.shadow.querySelector('[data-identity-brand]') as HTMLInputElement | null;
    const alt = this.shadow.querySelector('[data-identity-alt]') as HTMLInputElement | null;
    const keepColours = () => { if (brand && alt) { this._identityColours[clubId] = { brand: brand.value, alt: alt.value }; const apply = this.shadow.querySelector('[data-identity-apply]') as HTMLButtonElement | null; if (apply) apply.disabled = true; } };
    brand?.addEventListener('input', keepColours);
    alt?.addEventListener('input', keepColours);
    this.shadow.querySelector('[data-identity-default]')?.addEventListener('click', () => this.deactivateTheme(clubId));
    this.shadow.querySelector('[data-identity-restore]')?.addEventListener('click', () => this.activateTheme(clubId, true));
    this.shadow.querySelector('[data-identity-apply]')?.addEventListener('click', () => this.activateTheme(clubId));
    this.shadow.querySelectorAll('[data-identity-variant]').forEach(button => button.addEventListener('click', async () => {
      keepColours();
      const colours = this._identityColours[clubId];
      if (!colours) return;
      this._loading = true;
      this._error = null;
      this.render();
      try {
        const res = await fetch(`/api/clubs/${clubId}/theme`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed_brand: colours.brand, seed_brand_alt: colours.alt, variant: (button as HTMLElement).dataset.identityVariant }) });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail || 'No se pudo preparar la propuesta');
        await this.loadThemeData(clubId);
      } catch (err) { this._error = (err as Error).message; }
      finally { this._loading = false; this.render(); }
    }));

    // Navigation — shared path so every tab entry triggers its loader.
    this.shadow.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nav = (btn as HTMLElement).dataset.nav || 'club-details';
        this._selectTab(nav, clubId);
      });
    });

    // Generate theme
    const genBtn = this.shadow.querySelector('[data-generate-btn]');
    const urlInput = this.shadow.querySelector('[data-website-input]') as HTMLInputElement | null;
    if (genBtn && urlInput) {
      genBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (url) this.generateTheme(clubId, url);
      });
    }

    // Activation switch — direct toggle, no modal


    // Revert theme (gate-failed case)
    const revertBtn = this.shadow.querySelector('[data-revert-btn]');
    if (revertBtn) {
      revertBtn.addEventListener('click', () => {
        this.revertTheme(clubId);
      });
    }

    // Logo rights checkbox + button
    const rightsCheckbox = this.shadow.querySelector('[data-rights-checkbox]') as HTMLInputElement | null;
    const affirmBtn = this.shadow.querySelector('[data-affirm-rights-btn]') as HTMLButtonElement | null;
    if (rightsCheckbox && affirmBtn) {
      rightsCheckbox.addEventListener('change', () => {
        affirmBtn.disabled = !rightsCheckbox.checked;
      });
      affirmBtn.addEventListener('click', () => {
        if (!affirmBtn.disabled) this.affirmLogoRights(clubId);
      });
    }

    // Logo URL input (manual logo override)
    const logoUrlBtn = this.shadow.querySelector('[data-logo-url-btn]') as HTMLButtonElement | null;
    const logoUrlInput = this.shadow.querySelector('[data-logo-url-input]') as HTMLInputElement | null;
    if (logoUrlBtn && logoUrlInput) {
      logoUrlBtn.addEventListener('click', () => {
        const url = logoUrlInput.value.trim();
        if (url) this.updateLogoUrl(clubId, url);
      });
    }

    // Logo file upload (manual logo override from disk)
    const logoFileInput = this.shadow.querySelector('[data-logo-file-input]') as HTMLInputElement | null;
    if (logoFileInput) {
      logoFileInput.addEventListener('change', () => {
        const file = logoFileInput.files?.[0];
        if (file) this.uploadLogoFile(clubId, file);
      });
    }

    // B14: Activate theme from job-state card (Sí, usarlo) — removed, activation now via switch

    // B14: Retry theme button
    const retryBtn = this.shadow.querySelector('[data-retry-btn]');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.retryTheme(clubId));
    }
  }

  // F12: Wire events for the Equipos tab.
  // The editor's handler set — shared verbatim by the club and personal
  // render paths (SF1 §5): cancel/add/remove/save plus draft capture.
  // Save resolves through the context port, which carries the CAS handle
  // (personal team_revision) or none (club PUT contract).
  private _wireTeamEditorEvents(): void {
    // Volver (salida voluntaria): vacía la cola de autosave antes de
    // cerrar; con fallo el editor queda visible con su feedback.
    const cancelBtn = this.shadow.querySelector('[data-cancel-edit]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        void this._requestEditorClose();
      });
    }

    // Reintentar — SIEMPRE informado: primero una lectura de
    // reconciliación (conflicto 409 o resultado incierto — la escritura
    // pudo haberse aplicado en el servidor), luego el borrador vigente se
    // reenvía sobre la revisión fresca. Nunca un reenvío a ciegas.
    this.shadow.querySelector('[data-edit-retry]')?.addEventListener('click', () => {
      if (
        (this._editSaveStatus === 'conflict' || this._editSaveStatus === 'error') &&
        this._editingTeamId && this._editModel?.permissions.edit
      ) {
        void this._reloadEditorForRetry();
      }
    });

    // Decisión explícita de conflicto (R2-D3-1): «Mantener mis cambios»
    // adopta el handle de revisión del servidor y reenvía el borrador del
    // usuario; «Cargar versión actual» descarta el borrador y adopta la
    // versión del servidor (DOM incluido). Ninguna es un reenvío a ciegas.
    this.shadow.querySelector('[data-edit-keep-mine]')?.addEventListener('click', () => {
      // La decisión queda anclada a `_editConflictServer` (pegajosa) — el
      // chip puede haber seguido mostrando «conflicto» incluso si el
      // usuario tecleó después del diagnóstico.
      if (!this._editConflictServer) return;
      this._editModel = this._editConflictServer;
      this._editConflictServer = null;
      this._editNeedsReconcile = false;
      this._editDirty = true;
      this._editSaveStatus = 'pending';
      this._editSaveMessage = null;
      this._updateEditStatusDom();
      this._queueEditorSave();
    });
    this.shadow.querySelector('[data-edit-load-server]')?.addEventListener('click', () => {
      if (!this._editConflictServer) return;
      const server = this._editConflictServer;
      this._editModel = server;
      this._editConflictServer = null;
      this._editNeedsReconcile = false;
      this._editNameDraft = server.name;
      this._editCategoryDraft = server.category ?? '';
      this._editGenderDraft = server.gender ?? '';
      this._editLevelDraft = server.competitive_level;
      this._rosterDraft = server.players.map((p) => ({
        name: p.name,
        number: p.number === null || p.number === undefined ? '' : String(p.number),
        birth_date: '',
        birth_loaded: false,
        birth_dirty: false,
        existing: true,
        player_id: p.player_id ?? null,
      }));
      if (server.category !== undefined && server.permissions.edit) {
        void this._loadPlayerProfiles(server.id, this._editSeq);
      }
      this._editDirty = false;
      this._editSaveStatus = 'saved';
      this._editSaveMessage = 'Se cargó la versión actual del equipo.';
      // Render completo: la elección es explícita — el borrador descartado
      // desaparece de todos los campos, no solo del modelo.
      this.render();
    });

    // Roster editor — add/remove re-render from the draft, so the DOM is
    // flushed into _rosterDraft first and nothing typed is lost.
    const addPlayerBtn = this.shadow.querySelector('[data-add-player]');
    if (addPlayerBtn) {
      addPlayerBtn.addEventListener('click', () => {
        this._syncEditDraftFromDom();
        // Club rosters (PD-2): antes de crear una fila nueva se ofrece
        // vincular una jugadora existente del club — conserva su
        // player_id y, por tanto, su identidad de scouting.
        if (this._editModel && this._editModel.category !== undefined) {
          this._addPlayerPickerOpen = true;
          this.render();
          return;
        }
        this._rosterDraft.push({ name: '', number: '', birth_date: '', birth_loaded: false, birth_dirty: false, existing: false, player_id: null });
        this._rosterFocus = true;
        this.render();
        // La fila nueva vacía es un borrador incompleto — se marca
        // pendiente de inmediato (nunca «Guardado» con edición incompleta).
        this._scheduleEditorSave(false);
      });
    }
    // PD-2 picker: «Nueva jugadora» crea la fila vacía como siempre;
    // «Vincular jugadora existente» adopta su player_id (link mismo-club).
    this.shadow.querySelector('[data-add-new-player]')?.addEventListener('click', () => {
      this._syncEditDraftFromDom();
      this._rosterDraft.push({ name: '', number: '', birth_date: '', birth_loaded: false, birth_dirty: false, existing: false, player_id: null });
      this._addPlayerPickerOpen = false;
      this._rosterFocus = true;
      this.render();
      this._scheduleEditorSave(false);
    });
    this.shadow.querySelector('[data-cancel-link]')?.addEventListener('click', () => {
      this._addPlayerPickerOpen = false;
      this.render();
    });
    this.shadow.querySelectorAll('[data-link-player]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._syncEditDraftFromDom();
        const pid = (btn as HTMLElement).dataset.linkPlayer || '';
        const c = this._clubPlayerCandidates().find((x) => x.player_id === pid);
        if (!c) return; // ya vinculada o catálogo movido — nada que enlazar
        this._rosterDraft.push({
          name: c.name,
          number: c.number === null || c.number === undefined ? '' : String(c.number),
          birth_date: c.birth_date,
          birth_loaded: !!this._playerProfiles[pid],
          birth_dirty: false,
          existing: false,
          player_id: pid,
        });
        this._addPlayerPickerOpen = false;
        this.render();
        // El vínculo es un cambio real de plantilla — persiste ya.
        this._scheduleEditorSave(true);
        // Fecha de nacimiento de la jugadora vinculada: lectura perezosa
        // contra su equipo de origen (puede quedar fuera del grant — la
        // fila se queda sin fecha y nunca escribe a ciegas).
        if (!c.birth_date) void this._fillLinkedBirthDate(pid, c.teamId);
      });
    });
    this.shadow.querySelectorAll('[data-remove-player]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._syncEditDraftFromDom();
        this._rosterDraft.splice(Number((btn as HTMLElement).dataset.removePlayer), 1);
        this.render();
        this._scheduleEditorSave(true); // borrado persistido — envío inmediato
      });
    });

    // Autosave: teclear programa (debounce ~600ms); select y blur aceleran.
    // El borrador se vuelca del DOM en cada envío — teclear durante el
    // vuelo queda cubierto por la siguiente pasada de la cola serial.
    const modal = this.shadow.querySelector('[data-edit-modal]');
    if (modal && this._editModel?.permissions.edit) {
      const isField = (el: EventTarget | null) =>
        (el as HTMLElement | null)?.closest?.(
          '[data-edit-team-name],[data-edit-team-level],[data-edit-team-category],[data-edit-team-gender],[data-player-name],[data-player-number],[data-player-birth]',
        ) !== null;
      modal.addEventListener('input', (e) => {
        if (isField(e.target)) this._scheduleEditorSave(false);
      });
      modal.addEventListener('change', (e) => {
        if (isField(e.target)) this._scheduleEditorSave(true);
      });
      // focusout acelera el envío solo si hay borrador — un blur sin
      // edición (p. ej. re-render que suelta el input enfocado al añadir
      // fila) nunca dispara un PUT de contenido idéntico.
      modal.addEventListener('focusout', (e) => {
        if (isField(e.target) && this._editDirty) this._scheduleEditorSave(true);
      });
    }
  }

  private wireTeamsEvents(clubId: string): void {
    // Navigation (same as wireEvents but routes to teams-specific wiring)
    this.shadow.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        const nav = (btn as HTMLElement).dataset.nav || 'club-details';
        this._editingTeamId = null;
        this._addingTeamCategory = null;
        this._deleteConfirmTeamId = null;
        this._selectTab(nav, clubId);
      });
    });

    // Self-selection checkboxes (pickers only — the control does not render
    // for players or on archived rows). Optimistic chips; the save is
    // debounced then serialized through _selectionSaveChain.
    this.shadow.querySelectorAll('[data-pick-team]').forEach(input => {
      input.addEventListener('change', () => {
        const el = input as HTMLInputElement;
        const id = el.dataset.pickTeam || '';
        if (!id) return;
        if (el.checked) this._selectedIds.add(id);
        else this._selectedIds.delete(id);
        this._selectionStatus = 'saving';
        this._failedSelection = null;
        this._updateSelectionDom();
        this._scheduleSelectionSave();
      });
    });

    // Retry a failed save — re-applies the last intended (unsaved) set.
    const retrySaveBtn = this.shadow.querySelector('[data-retry-save]');
    if (retrySaveBtn) {
      retrySaveBtn.addEventListener('click', () => {
        if (this._failedSelection) {
          this._selectedIds = new Set(this._failedSelection);
          this._failedSelection = null;
        }
        this._queueSelectionSave();
      });
    }

    // Retry the self-scoped catalog load after a fetch failure.
    const retryLoadBtn = this.shadow.querySelector('[data-retry-load]');
    if (retryLoadBtn) {
      retryLoadBtn.addEventListener('click', () => this.loadTeamSelection());
    }

    // Continuar after a gate deep link — only fires when a non-empty
    // selection is already persisted (_canContinue), never mid-flight.
    const continueBtn = this.shadow.querySelector('[data-continue]');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        if (!this._canContinue()) return;
        location.hash = `#/${this._returnRoute}`;
      });
    }

    // Filter toggle (active / all)
    const filterSelect = this.shadow.querySelector('[data-teams-filter]');
    if (filterSelect) {
      filterSelect.addEventListener('change', () => {
        this._teamsFilter = (filterSelect as HTMLSelectElement).value as 'active' | 'all';
        this._editingTeamId = null;
        this._addingTeamCategory = null;
        this._deleteConfirmTeamId = null;
        this.render();
      });
    }

    // Reseed the team catalog after a failed/stalled seeding job.
    const reseedBtn = this.shadow.querySelector('[data-reseed-teams]');
    if (reseedBtn) {
      reseedBtn.addEventListener('click', async () => {
        this._seedingLoading = true;
        this._teamsError = null;
        this.render();
        try {
          const res = await fetch(`/api/clubs/${clubId}/teams/reseed`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
          }
          this._seedingLoading = false;
          // Reseed sets the job to done — reload refreshes both job and list.
          await this.loadTeams(clubId);
        } catch (err) {
          this._seedingLoading = false;
          this._teamsError = (err as Error).message;
          // Refresh the job so the banner re-renders with the latest reason.
          await this._loadTeamSeeding(clubId).catch(() => {});
          this.render();
        }
      });
    }

    // Edit team (pen icon → modal: name + level + plantilla)
    this.shadow.querySelectorAll('[data-edit-team]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._openEditModal((btn as HTMLElement).dataset.editTeam || '', false);
      });
    });

    // Plantilla (users icon → same modal, focus lands on the roster editor)
    this.shadow.querySelectorAll('[data-edit-roster]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._openEditModal((btn as HTMLElement).dataset.editRoster || '', true);
      });
    });

    // Shared roster-editor wiring — identical for club and personal
    // contexts; the data path differs only inside the context port.
    this._wireTeamEditorEvents();

    // Archive team (logical — 📦 icon)
    this.shadow.querySelectorAll('[data-archive-team]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const teamId = (btn as HTMLElement).dataset.archiveTeam || '';
        try {
          const res = await fetch(`/api/clubs/${clubId}/teams/${teamId}/archive`, {
            method: 'PUT',
            credentials: 'include',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await this.loadTeams(clubId);
        } catch (err) {
          this._teamsError = (err as Error).message;
          this.render();
        }
      });
    });

    // Unarchive team (restore — ↩️ icon, only visible when filter=all)
    this.shadow.querySelectorAll('[data-unarchive-team]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const teamId = (btn as HTMLElement).dataset.unarchiveTeam || '';
        try {
          const res = await fetch(`/api/clubs/${clubId}/teams/${teamId}/unarchive`, {
            method: 'PUT',
            credentials: 'include',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await this.loadTeams(clubId);
        } catch (err) {
          this._teamsError = (err as Error).message;
          this.render();
        }
      });
    });

    // Delete team (physical — 🗑️ icon → opens confirmation modal)
    this.shadow.querySelectorAll('[data-delete-team]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._deleteConfirmTeamId = (btn as HTMLElement).dataset.deleteTeam || '';
        this._editingTeamId = null;
        this._addingTeamCategory = null;
        this.render();
      });
    });

    // Cancel delete (modal)
    const cancelDeleteBtn = this.shadow.querySelector('[data-cancel-delete]');
    if (cancelDeleteBtn) {
      cancelDeleteBtn.addEventListener('click', () => {
        this._deleteConfirmTeamId = null;
        this.render();
      });
    }

    // Confirm delete (modal → physical DELETE)
    this.shadow.querySelectorAll('[data-confirm-delete-team]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const teamId = (btn as HTMLElement).dataset.confirmDeleteTeam || '';
        try {
          const res = await fetch(`/api/clubs/${clubId}/teams/${teamId}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this._deleteConfirmTeamId = null;
          await this.loadTeams(clubId);
        } catch (err) {
          this._teamsError = (err as Error).message;
          this._deleteConfirmTeamId = null;
          this.render();
        }
      });
    });

    // Category-level Add (+) — show inline add row under the category
    this.shadow.querySelectorAll('[data-add-team-category]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._addingTeamCategory = (btn as HTMLElement).dataset.addTeamCategory || '';
        this._editingTeamId = null;
        this._deleteConfirmTeamId = null;
        this.render();
      });
    });

    // Cancel add team
    const cancelAddBtn = this.shadow.querySelector('[data-cancel-add-team]');
    if (cancelAddBtn) {
      cancelAddBtn.addEventListener('click', () => {
        this._addingTeamCategory = null;
        this.render();
      });
    }

    // Confirm add team (from category-level inline row)
    this.shadow.querySelectorAll('[data-confirm-add-team]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const category = (btn as HTMLElement).dataset.confirmAddTeam || '';
        const addRow = this.shadow.querySelector('[data-adding-row="true"]');
        if (!addRow) return;
        const name = (addRow.querySelector('[data-new-team-name]') as HTMLInputElement)?.value.trim() || '';
        const gender = (addRow.querySelector('[data-new-team-gender]') as HTMLSelectElement)?.value || 'M';
        const competitive_level = (addRow.querySelector('[data-new-team-level]') as HTMLSelectElement)?.value.trim() || '';
        if (!name) {
          this._teamsError = 'El nombre es obligatorio.';
          this.render();
          return;
        }
        // Generate a deterministic ID from club + category + gender + name slug
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const id = `${clubId}_${category}_${gender.toLowerCase()}_${slug}`;
        try {
          const res = await fetch(`/api/clubs/${clubId}/teams`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, club_id: clubId, name, category, gender, competitive_level }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this._addingTeamCategory = null;
          await this.loadTeams(clubId);
        } catch (err) {
          this._teamsError = (err as Error).message;
          this.render();
        }
      });
    });
  }
}

customElements.define('biq-onboard-app', BiqOnboardApp);

// F7: Exports for unit testing (not part of the public bundle API)
export { canCreateClub, clubTabsForMembershipState, defaultClubTab, normaliseWebsiteUrl };
export type { ClubTab };
