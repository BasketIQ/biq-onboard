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
  };
  logo?: {
    url: string | null;
    rightsConfirmedAt: string | null;
    status: 'awaiting_rights' | 'confirmed' | 'rejected';
  } | null;
  tokens?: {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
  gate?: {
    passed: boolean;
    failures: string[];
  };
  activation?: {
    themeStatus: string;
    reason: string;
  };
}

interface ThemeJob {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'reverted';
  sourceUrl: string;
  requestedAt: string;
  finishedAt: string | null;
  attempts: number;
  verdict?: {
    verdict: string;
    score: number;
  } | null;
}

// ─── Per-verdict Spanish copy (ADDENDUM-04 §5) ──────────────────────────

const VERDICT_COPY: Record<string, { title: string; description: string; action?: string }> = {
  club_confirmed: {
    title: 'Club confirmado',
    description: 'Hemos detectado la web de tu club y generado los colores del tema.',
  },
  uncertain: {
    title: 'No estamos seguros',
    description: 'La web parece legítima pero no tenemos suficiente confianza para aplicar los colores automáticamente. Puedes revisarlos y activarlos manualmente.',
    action: 'Revisar colores',
  },
  not_a_club: {
    title: 'No parece un club',
    description: 'La URL indicada no corresponde a un club de baloncesto. Revisa la dirección e inténtalo de nuevo.',
  },
  unsupported_source: {
    title: 'Fuente no soportada',
    description: 'No podemos extraer colores de este tipo de página (redes sociales, PDFs, etc.). Introduce la URL de la web del club.',
  },
  unreachable: {
    title: 'No se pudo acceder',
    description: 'La web del club no respondió o no es accesible públicamente. Verifica la URL e inténtalo de nuevo.',
  },
};

const THEME_STATUS_COPY: Record<string, { label: string; color: string }> = {
  active: { label: 'Activo', color: 'var(--biq-green)' },
  draft: { label: 'Borrador', color: 'var(--biq-amber)' },
  rejected: { label: 'Rechazado', color: 'var(--biq-red)' },
  pending: { label: 'Pendiente', color: 'var(--biq-blue)' },
};

// ─── Helpers ────────────────────────────────────────────────────────────

const escapeHtml = (s: string): string =>
  String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Roles that may create clubs (ADDENDUM-07 §6.3 — mirrors the server rule;
// here it drives presentation only, the server enforces with 403).
const ADMIN_ROLES = ['administrator', 'sports_director', 'super_administrator'];

function canCreateClub(memberships: MembershipInfo[] | undefined): boolean {
  const ms = memberships || [];
  return ms.length === 0 || ms.some((m) => ADMIN_ROLES.includes(m.role));
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

// ─── Main component ─────────────────────────────────────────────────────

class BiqOnboardApp extends HTMLElement {
  private shadow: ShadowRoot;
  private _org: OrgContext | null = null;
  private _user: string | null = null;
  private _subRoute = '';
  private _theme: ClubTheme | null = null;
  private _themeJob: ThemeJob | null = null;
  private _loading = false;
  private _error: string | null = null;
  // Club step (ADDENDUM-07 §6) per-card feedback
  private _stepError: { scope: 'join' | 'create'; message: string } | null = null;
  private _stepMessage = '';

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    this.shadow.appendChild(styleEl);
  }

  // Shell-injected properties (ADR-009)
  set org(value: OrgContext | null) {
    this._org = value;
    this.render();
    if (value?.club?.id) this.loadThemeData(value.club.id);
  }
  get org(): OrgContext | null { return this._org; }

  set user(value: string | null) {
    this._user = value;
    this.render();
  }
  get user(): string | null { return this._user; }

  set route(value: string) {
    this._subRoute = value || '';
    this.render();
  }
  get route(): string { return this._subRoute; }

  // ─── Data loading ─────────────────────────────────────────────────────

  private async loadThemeData(clubId: string): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/admin/clubs/${clubId}/theme`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._theme = data.theme || null;
      this._themeJob = data.themeJob || null;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  private async generateTheme(clubId: string, url: string): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/admin/clubs/${clubId}/theme/generate`, {
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

  private async saveManualTheme(clubId: string, brand: string, brandAlt: string | null): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/admin/clubs/${clubId}/theme`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed_brand: brand, seed_brand_alt: brandAlt }),
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
      const res = await fetch(`/api/admin/clubs/${clubId}/theme`, {
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
    // This would call a dedicated endpoint; for now we use the theme PUT
    // to update the logo rights status
    this._loading = true;
    this.render();
    try {
      const res = await fetch(`/api/admin/clubs/${clubId}/theme/logo-rights`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affirmed: true }),
      });
      if (!res.ok && res.status !== 404) {
        // 404 = endpoint not implemented yet; that's OK for now
        throw new Error(`HTTP ${res.status}`);
      }
      await this.loadThemeData(clubId);
    } catch (err) {
      this._error = (err as Error).message;
      this._loading = false;
      this.render();
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  private render(): void {
    const club = this._org?.club;
    if (!club) {
      // ADDENDUM-07 §6 — paso de club: sin club resuelto este módulo ES el
      // paso 2 del onboarding (picker / unirse por ID / crear club).
      this.shadow.innerHTML = `<style>${styles}</style>
        <div class="onboard-app onboard-clubstep">${this.renderClubStep()}</div>`;
      this.wireClubStepEvents();
      return;
    }

    // Route determines which view to show
    const section = this._subRoute || 'club-details';
    let content = '';
    if (section === 'profile') {
      content = this.renderProfile();
    } else {
      content = this.renderClubDetails(club);
    }

    this.shadow.innerHTML = `<style>${styles}</style>
      <div class="onboard-app">
        <nav class="onboard-nav">
          <button class="onboard-nav-item ${section === 'club-details' ? 'active' : ''}" data-nav="club-details">Club</button>
          <button class="onboard-nav-item ${section === 'profile' ? 'active' : ''}" data-nav="profile">Perfil</button>
        </nav>
        ${content}
      </div>`;
    this.wireEvents(club.id);
  }

  private renderClubDetails(club: { id: string; name?: string; website?: string }): string {
    const website = club.website || '';
    const theme = this._theme;
    const job = this._themeJob;
    const verdict = job?.verdict?.verdict || (theme?.activation?.themeStatus === 'active' ? 'club_confirmed' : 'uncertain');
    const verdictCopy = VERDICT_COPY[verdict] || VERDICT_COPY.uncertain;
    const statusCopy = theme ? THEME_STATUS_COPY[theme.status] || THEME_STATUS_COPY.pending : null;

    return `
      <section class="onboard-section">
        <h2 class="onboard-section-title">${escapeHtml(club.name || club.id)}</h2>

        ${this._error ? `<div class="onboard-error">${escapeHtml(this._error)}</div>` : ''}

        <div class="onboard-card">
          <h3 class="onboard-card-title">Sitio web del club</h3>
          <p class="onboard-card-desc">Introduce la URL de la web del club. Extraeremos los colores del tema automáticamente.</p>
          <div class="onboard-form-row">
            <input type="url" class="onboard-input" data-website-input value="${escapeHtml(website)}" placeholder="https://www.miclub.com" />
            <button class="onboard-btn onboard-btn-primary" data-generate-btn ${this._loading ? 'disabled' : ''}>
              ${this._loading ? 'Generando…' : 'Generar tema'}
            </button>
          </div>
        </div>

        ${this._loading && !theme ? '<div class="onboard-loading">Cargando…</div>' : ''}

        ${theme ? this.renderBrandingState(theme, verdictCopy, statusCopy) : ''}
        ${theme?.logo ? this.renderLogoSection(theme) : ''}
        ${theme ? this.renderPreview(theme) : ''}
        ${theme ? this.renderManualPicker(club.id, theme) : ''}
        ${theme ? this.renderRevertButton(club.id) : ''}
      </section>`;
  }

  private renderBrandingState(theme: ClubTheme, verdictCopy: { title: string; description: string; action?: string }, statusCopy: { label: string; color: string } | null): string {
    const gateFailed = theme.gate && theme.gate.passed === false;
    return `
      <div class="onboard-card onboard-branding-state" data-branding-state="${theme.status}">
        <div class="onboard-branding-header">
          <h3 class="onboard-card-title">${escapeHtml(verdictCopy.title)}</h3>
          ${statusCopy ? `<span class="onboard-badge" style="color: ${statusCopy.color}; border-color: ${statusCopy.color}">${escapeHtml(statusCopy.label)}</span>` : ''}
        </div>
        <p class="onboard-card-desc">${escapeHtml(verdictCopy.description)}</p>

        ${gateFailed ? `
          <div class="onboard-gate-failure">
            <h4>El tema no superó el control de contraste</h4>
            <p>Algunas combinaciones de color no cumplen WCAG 2.2 AA. Puedes ajustar manualmente los colores o usar el tema BasketIQ por defecto.</p>
            <ul class="onboard-gate-failures">
              ${(theme.gate?.failures || []).map(f => `<li>${escapeHtml(f)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${theme.status === 'active' ? `
          <div class="onboard-active-notice">
            <p>El tema del club está activo. Los colores se muestran en toda la aplicación.</p>
          </div>
        ` : ''}

        ${theme.status === 'draft' ? `
          <div class="onboard-draft-notice">
            <p>El tema está en borrador. Revisa los colores y actívalo cuando estés conforme.</p>
            <button class="onboard-btn onboard-btn-primary" data-activate-btn>Activar tema</button>
          </div>
        ` : ''}
      </div>`;
  }

  private renderLogoSection(theme: ClubTheme): string {
    const logo = theme.logo;
    if (!logo) return '';
    const awaitingRights = logo.rightsConfirmedAt === null;
    return `
      <div class="onboard-card">
        <h3 class="onboard-card-title">Escudo del club</h3>
        ${logo.url ? `<img class="onboard-logo-preview" src="${escapeHtml(logo.url)}" alt="Escudo" />` : '<p class="onboard-card-desc">No se encontró escudo.</p>'}
        ${awaitingRights ? `
          <div class="onboard-rights">
            <p class="onboard-rights-text">Para mostrar el escudo necesitas confirmar que el club tiene derecho a usarlo.</p>
            <label class="onboard-rights-label">
              <input type="checkbox" data-rights-checkbox />
              <span>Confirmo que el club puede usar este escudo</span>
            </label>
            <button class="onboard-btn onboard-btn-primary" data-affirm-rights-btn disabled>Confirmar</button>
          </div>
        ` : `
          <p class="onboard-rights-confirmed">Derechos de uso confirmados.</p>
        `}
      </div>`;
  }

  private renderPreview(theme: ClubTheme): string {
    const lightTokens = theme.tokens?.light || {};
    const darkTokens = theme.tokens?.dark || {};
    return `
      <div class="onboard-card">
        <h3 class="onboard-card-title">Vista previa</h3>
        <div class="onboard-preview-grid">
          <div class="onboard-preview onboard-preview-light" style="background: ${escapeHtml(lightTokens['--biq-bg'] || '#F4F6FA')}; color: ${escapeHtml(lightTokens['--biq-text'] || '#0D1735')}">
            <span class="onboard-preview-label">Modo claro</span>
            <div class="onboard-preview-swatch" style="background: ${escapeHtml(lightTokens['--biq-orange'] || '#FF5A00')}; color: ${escapeHtml(lightTokens['--biq-on-orange'] || '#FFFFFF')}">Acción</div>
            <div class="onboard-preview-swatch" style="background: ${escapeHtml(lightTokens['--biq-surface-1'] || '#FFFFFF')}; border: 1px solid ${escapeHtml(lightTokens['--biq-line'] || '#E4E8F0')}">Superficie</div>
          </div>
          <div class="onboard-preview onboard-preview-dark" style="background: ${escapeHtml(darkTokens['--biq-bg'] || '#080D1A')}; color: ${escapeHtml(darkTokens['--biq-text'] || '#FFFFFF')}">
            <span class="onboard-preview-label">Modo oscuro</span>
            <div class="onboard-preview-swatch" style="background: ${escapeHtml(darkTokens['--biq-orange'] || '#FF5A00')}; color: ${escapeHtml(darkTokens['--biq-on-orange'] || '#FFFFFF')}">Acción</div>
            <div class="onboard-preview-swatch" style="background: ${escapeHtml(darkTokens['--biq-surface-1'] || '#111A2D')}; border: 1px solid ${escapeHtml(darkTokens['--biq-line'] || '#1A2440')}">Superficie</div>
          </div>
        </div>
      </div>`;
  }

  private renderManualPicker(clubId: string, theme: ClubTheme): string {
    const brand = theme.seed?.brand || '#FF5A00';
    const brandAlt = theme.seed?.brandAlt || '';
    return `
      <div class="onboard-card">
        <h3 class="onboard-card-title">Selector manual de colores</h3>
        <p class="onboard-card-desc">Si la extracción automática no es correcta, puedes elegir los colores manualmente.</p>
        <div class="onboard-form-row">
          <label class="onboard-color-label">
            <span>Color principal</span>
            <input type="color" class="onboard-color-input" data-manual-brand value="${escapeHtml(brand)}" />
          </label>
          <label class="onboard-color-label">
            <span>Color secundario (opcional)</span>
            <input type="color" class="onboard-color-input" data-manual-brand-alt value="${escapeHtml(brandAlt || '#0A153A')}" />
          </label>
        </div>
        <button class="onboard-btn onboard-btn-secondary" data-save-manual-btn ${this._loading ? 'disabled' : ''}>
          ${this._loading ? 'Guardando…' : 'Guardar colores manuales'}
        </button>
      </div>`;
  }

  private renderRevertButton(clubId: string): string {
    return `
      <div class="onboard-card onboard-revert-card">
        <h3 class="onboard-card-title">Restablecer tema BasketIQ</h3>
        <p class="onboard-card-desc">Vuelve al tema BasketIQ por defecto, eliminando los colores del club.</p>
        <button class="onboard-btn onboard-btn-danger" data-revert-btn ${this._loading ? 'disabled' : ''}>
          Restablecer
        </button>
      </div>`;
  }

  // ─── Club step (ADDENDUM-07 §6) ───────────────────────────────────────

  private async selectMembership(clubId: string): Promise<void> {
    const email = this._org?.email || '';
    try {
      const res = await fetch('/api/auth/select-club', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, club_id: clubId }),
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
      this._error = (err as Error).message;
      this.render();
    }
  }

  private async joinByClubId(clubId: string): Promise<void> {
    const org_ = this._org;
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: org_?.email || '',
        display_name: org_?.display_name || '',
        club_id: clubId,
      }),
    });
    return this.handleStepResponse(res, 'join');
  }

  private async createClub(name: string, website: string): Promise<void> {
    const res = await fetch('/api/onboarding/clubs', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, website }),
    });
    if (res.ok) {
      // ADDENDUM-07 §6: chain select-club to re-point the shell session to
      // the new administrator row, then navigate to home. Only navigate when
      // both succeeded; surface the select failure as a step error (the
      // membership exists; the picker will offer it on the next visit —
      // degraded, not stuck).
      const data = await res.json().catch(() => null);
      const clubId = data?.club?.id;
      const email = this._org?.email || '';
      if (clubId && email) {
        try {
          const selectRes = await fetch('/api/auth/select-club', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, club_id: clubId }),
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
          this.render();
          return;
        } catch {
          this._stepError = {
            scope: 'create',
            message: 'El club se ha creado, pero no se pudo iniciar sesión automáticamente. Recarga para entrar.',
          };
          this._loading = false;
          this.render();
          return;
        }
      }
      // Fallback: no club id or email in the response — reload.
      window.location.replace('/');
      return;
    }
    await this.handleStepResponse(res, 'create');
  }

  private async handleStepResponse(
    res: Response,
    scope: 'join' | 'create',
  ): Promise<void> {
    this._loading = false;
    if (res.ok) {
      // Join: a pending JoinRequest was created — confirm and stay on the
      // step (membership is granted after admin approval).
      this._stepMessage = 'Solicitud enviada. Un administrador del club revisará tu acceso.';
      this._stepError = null;
      this.render();
      return;
    }
    const data = await res.json().catch(() => null);
    const message =
      (data && (data as { detail?: string }).detail) || `Error ${res.status}`;
    this._stepError = { scope, message };
    this.render();
  }

  private renderClubStep(): string {
    const orgCtx = this._org;
    const memberships = orgCtx?.memberships || [];
    const showCreate = canCreateClub(memberships);
    const err = this._stepError;

    const pickerHtml = memberships.length
      ? `
      <section class="onboard-card">
        <h3 class="onboard-card-title">Tus clubs</h3>
        <p class="onboard-card-desc">Perteneces a varios clubs. Elige con cuál quieres entrar.</p>
        <div class="onboard-picker" role="listbox" aria-label="Elige tu club">
          ${memberships
            .map(
              (m) => `
            <button class="onboard-club-row" data-pick-club="${escapeHtml(m.club_id)}" role="option">
              <span class="onboard-club-name">${escapeHtml(m.club_name || m.club_id)}</span>
              <span class="onboard-club-role">${escapeHtml(m.role === 'administrator' ? 'Administrador' : m.role)}</span>
            </button>`,
            )
            .join('')}
        </div>
      </section>`
      : '';

    return `
      <header class="onboard-step-head">
        <h2 class="onboard-section-title">Tu club</h2>
        <p class="onboard-card-desc">Únete a un club o crea uno nuevo para empezar a usar BasketIQ.</p>
        ${this._error ? `<div class="onboard-error">${escapeHtml(this._error)}</div>` : ''}
      </header>
      ${this._loading && !err ? '<div class="onboard-loading">Cargando…</div>' : ''}
      ${pickerHtml}
      <section class="onboard-card">
        <h3 class="onboard-card-title">Unirse a un club</h3>
        <p class="onboard-card-desc">Si tu club ya usa BasketIQ, pide a un administrador el ID del club.</p>
        <div class="onboard-form-row">
          <input type="text" class="onboard-input" data-join-id placeholder="ID del club" aria-label="ID del club" />
          <button class="onboard-btn onboard-btn-primary" data-join-btn>Solicitar acceso</button>
        </div>
        ${
          err?.scope === 'join'
            ? `<div class="onboard-error">${escapeHtml(err.message)}</div>`
            : ''
        }
        ${this._stepMessage ? `<div class="onboard-success">${escapeHtml(this._stepMessage)}</div>` : ''}
      </section>
      ${
        showCreate
          ? `
      <section class="onboard-card">
        <h3 class="onboard-card-title">Crear un club nuevo</h3>
        <p class="onboard-card-desc">Crea la organización de tu club. Serás su administrador; podremos tomar el escudo y los colores de su web para personalizar la app.</p>
        <label class="onboard-field-label" for="create-name">Nombre del club</label>
        <input type="text" id="create-name" class="onboard-input onboard-input-block" data-create-name placeholder="Club Baloncesto…" />
        <label class="onboard-field-label" for="create-web">Web del club (opcional)</label>
        <input type="url" id="create-web" class="onboard-input onboard-input-block" data-create-website placeholder="mi-club.es" />
        <button class="onboard-btn onboard-btn-primary" data-create-btn>Crear club</button>
        ${
          err?.scope === 'create'
            ? `<div class="onboard-error">${escapeHtml(err.message)}</div>`
            : ''
        }
      </section>`
          : ''
      }`;
  }

  private wireClubStepEvents(): void {
    this.shadow.querySelectorAll('[data-pick-club]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectMembership((btn as HTMLElement).dataset.pickClub || '');
      });
    });

    const joinBtn = this.shadow.querySelector('[data-join-btn]');
    const joinInput = this.shadow.querySelector('[data-join-id]') as HTMLInputElement | null;
    if (joinBtn && joinInput) {
      joinBtn.addEventListener('click', () => {
        const clubId = joinInput.value.trim();
        if (!clubId) return;
        this._loading = true;
        this._stepError = null;
        this._stepMessage = '';
        this.render();
        this.joinByClubId(clubId);
      });
    }

    const createBtn = this.shadow.querySelector('[data-create-btn]');
    const nameInput = this.shadow.querySelector('[data-create-name]') as HTMLInputElement | null;
    const webInput = this.shadow.querySelector('[data-create-website]') as HTMLInputElement | null;
    if (createBtn && nameInput) {
      createBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (name.length < 2) {
          this._stepError = { scope: 'create', message: 'El nombre del club es obligatorio (mínimo 2 caracteres).' };
          this.render();
          return;
        }
        let website = '';
        if (webInput && webInput.value.trim()) {
          const normalised = normaliseWebsiteUrl(webInput.value);
          if (normalised === null) {
            this._stepError = { scope: 'create', message: 'La web del club debe usar https://' };
            this.render();
            return;
          }
          website = normalised;
        }
        this._loading = true;
        this._stepError = null;
        this._stepMessage = '';
        this.render();
        this.createClub(name, website);
      });
    }
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
    return `
      <section class="onboard-section">
        <div class="onboard-profile-card">
          <div class="onboard-profile-avatar">${escapeHtml(user.charAt(0).toUpperCase())}</div>
          <h2 class="onboard-profile-name">${escapeHtml(user)}</h2>
          ${club ? `<p class="onboard-profile-club">${escapeHtml(club.name || club.id)}</p>` : ''}
          <span class="onboard-profile-role">${escapeHtml(roleLabels[role] || role)}</span>
        </div>
      </section>`;
  }

  // ─── Event wiring ──────────────────────────────────────────────────────

  private wireEvents(clubId: string): void {
    // Navigation
    this.shadow.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._subRoute = (btn as HTMLElement).dataset.nav || 'club-details';
        this.render();
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

    // Save manual theme
    const saveBtn = this.shadow.querySelector('[data-save-manual-btn]');
    const brandInput = this.shadow.querySelector('[data-manual-brand]') as HTMLInputElement | null;
    const brandAltInput = this.shadow.querySelector('[data-manual-brand-alt]') as HTMLInputElement | null;
    if (saveBtn && brandInput) {
      saveBtn.addEventListener('click', () => {
        const brand = brandInput.value.toUpperCase();
        const brandAlt = brandAltInput?.value.toUpperCase() || null;
        this.saveManualTheme(clubId, brand, brandAlt);
      });
    }

    // Revert theme
    const revertBtn = this.shadow.querySelector('[data-revert-btn]');
    if (revertBtn) {
      revertBtn.addEventListener('click', () => {
        if (confirm('¿Restablecer al tema BasketIQ por defecto?')) {
          this.revertTheme(clubId);
        }
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
  }
}

customElements.define('biq-onboard-app', BiqOnboardApp);
