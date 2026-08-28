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

// B14: themeJob state matrix — presentation + action per canonical state
const THEME_JOB_COPY: Record<string, { title: string; description: string; action?: string }> = {
  pending: {
    title: 'Personalización en cola',
    description: 'Tu tema se generará automáticamente en unos segundos.',
  },
  running: {
    title: 'Analizando la web del club',
    description: 'Extrayendo colores y generando el tema.',
  },
  succeeded: {
    title: 'Tema disponible y activo',
    description: 'El tema del club está activo. Puedes ajustarlo, regenerarlo o revertirlo.',
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
    action: 'Corregir URL / tema manual',
  },
  unsupported_source: {
    title: 'Fuente no soportada',
    description: 'No podemos extraer colores de este tipo de página.',
    action: 'Añadir web / tema manual',
  },
  unreachable: {
    title: 'No se pudo acceder',
    description: 'La web del club no respondió después de varios intentos.',
    action: 'Reintentar / cambiar URL',
  },
  failed: {
    title: 'Error técnico',
    description: 'Se produjo un error al generar el tema.',
    action: 'Reintentar / tema manual',
  },
  reverted: {
    title: 'Tema BasketIQ por defecto',
    description: 'El tema se ha revertido al BasketIQ por defecto.',
    action: 'Generar de nuevo',
  },
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
  private _activeClubTab = '';
  private _clubSubmitLocked = false;
  private _clubSubmitSeq = 0;
  private _clubSubmitAbort: AbortController | null = null;
  // D20: typed field values survive re-renders (validation/error/loading).
  private _clubForm: { joinId: string; createName: string; createWebsite: string } = {
    joinId: '', createName: '', createWebsite: '',
  };
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _pollingClubId: string | null = null;
  private _pollBackoff = 3000; // C11: starts at 3s, backs off
  private _polling = false; // C11: prevent overlap
  private _visibilityHandler: (() => void) | null = null; // C11: visibility handling

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
      const res = await fetch(`/api/clubs/${clubId}/theme`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._theme = data.theme || null;
      this._themeJob = data.themeJob || null;
      // B14: start polling if pending/running
      this._maybeStartPolling(clubId);
      // B15: emit state event to shell
      this._emitThemeStateEvent(clubId);
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loading = false;
      this.render();
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
    // C11: Clear timer before checking to avoid the "truthy timer" deadlock
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    // Prevent overlap — don't schedule if a poll is in-flight
    if (this._polling) return;
    // Club changed — reset backoff
    if (this._pollingClubId !== clubId) {
      this._pollingClubId = clubId;
      this._pollBackoff = 3000;
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
  }

  // C11: Lifecycle — stop polling on disconnect, resume on reconnect
  disconnectedCallback(): void {
    super.disconnectedCallback?.();
    this._stopPolling();
    // D20: invalidate in-flight submissions and abort stale responses.
    this._clubSubmitSeq += 1;
    if (this._clubSubmitAbort) {
      this._clubSubmitAbort.abort();
      this._clubSubmitAbort = null;
    }
    // Remove visibility handler
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  connectedCallback(): void {
    super.connectedCallback?.();
    // C11: Resume polling on visibility/entry if theme job is pending/running
    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this._pollingClubId) {
        const clubId = this._pollingClubId;
        this._pollingClubId = null; // force reschedule
        this._maybeStartPolling(clubId);
      } else if (document.visibilityState === 'hidden') {
        // C11: Stop polling when page is hidden
        if (this._pollTimer) {
          clearTimeout(this._pollTimer);
          this._pollTimer = null;
        }
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
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
      this._theme = data.theme || null;
      this._themeJob = data.themeJob || null;
      const newStatus = this._themeJob?.status;
      // B15: emit event on status change
      if (prevStatus !== newStatus) {
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

  private async saveManualTheme(clubId: string, brand: string, brandAlt: string | null): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme`, {
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
    // This would call a dedicated endpoint; for now we use the theme PUT
    // to update the logo rights status
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

  // B14: Activate a draft/uncertain theme
  private async activateTheme(clubId: string): Promise<void> {
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const res = await fetch(`/api/clubs/${clubId}/theme/activate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
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
    // B14: themeJob state matrix
    const jobStatus = job?.status || '';
    const jobCopy = jobStatus ? THEME_JOB_COPY[jobStatus] : null;
    const isPolling = jobStatus === 'pending' || jobStatus === 'running';
    const canActivate = theme && (theme.status === 'draft' || theme.status === 'uncertain' || (jobStatus === 'succeeded' && theme.status !== 'active'));
    const canRetry = jobStatus === 'failed' || jobStatus === 'unreachable' || jobStatus === 'rejected_not_a_club' || jobStatus === 'unsupported_source';

    return `
      <section class="onboard-section">
        <h2 class="onboard-section-title">${escapeHtml(club.name || club.id)}</h2>

        ${this._error ? `<div class="onboard-error">${escapeHtml(this._error)}</div>` : ''}

        <div class="onboard-card">
          <h3 class="onboard-card-title">Sitio web del club</h3>
          <p class="onboard-card-desc">Introduce la URL de la web del club. Extraeremos los colores del tema automáticamente.</p>
          <div class="onboard-form-row">
            <input type="url" class="onboard-input" data-website-input value="${escapeHtml(website)}" placeholder="https://www.miclub.com" />
            <button class="onboard-btn onboard-btn-primary" data-generate-btn ${this._loading || isPolling ? 'disabled' : ''}>
              ${isPolling ? 'Procesando…' : this._loading ? 'Generando…' : 'Generar tema'}
            </button>
          </div>
        </div>

        ${jobCopy ? `
          <div class="onboard-card onboard-theme-job-state" data-job-state="${jobStatus}">
            <h3 class="onboard-card-title">${escapeHtml(jobCopy.title)}</h3>
            <p class="onboard-card-desc">${escapeHtml(jobCopy.description)}</p>
            ${isPolling ? '<div class="onboard-loading">Procesando…</div>' : ''}
            ${canActivate ? `<button class="onboard-btn onboard-btn-primary" data-activate-btn ${this._loading ? 'disabled' : ''}>Sí, usarlo</button>` : ''}
            ${canRetry ? `<button class="onboard-btn onboard-btn-primary" data-retry-btn ${this._loading ? 'disabled' : ''}>Reintentar</button>` : ''}
          </div>
        ` : ''}

        ${this._loading && !theme && !jobCopy ? '<div class="onboard-loading">Cargando…</div>' : ''}

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

  private async joinByClubId(clubId: string, seq: number): Promise<void> {
    if (this._clubSubmitLocked) return;
    this._clubSubmitLocked = true;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ club_id: clubId }),
        signal: this._clubSubmitAbort?.signal,
      });
      return this.handleStepResponse(res, 'join', seq);
    } catch (err) {
      this._recoverSubmission('join', (err as Error).message || 'No se pudo enviar la solicitud', seq);
    }
  }

  private async createClub(name: string, website: string, seq: number): Promise<void> {
    if (this._clubSubmitLocked) return;
    this._clubSubmitLocked = true;
    let res: Response;
    try {
      res = await fetch('/api/onboarding/clubs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, website }),
        signal: this._clubSubmitAbort?.signal,
      });
    } catch (err) {
      this._recoverSubmission('create', (err as Error).message || 'No se pudo crear el club', seq);
      return;
    }
    if (this._clubSubmitSeq !== seq) return; // D20: stale response
    if (res.ok) {
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

  private renderClubStep(): string {
    const orgCtx = this._org;
    const memberships = orgCtx?.memberships || [];
    const showCreate = canCreateClub(memberships);
    const err = this._stepError;
    const tabs = [
      ...(memberships.length ? [{ id: 'memberships', label: 'Mis clubes' }] : []),
      { id: 'join', label: 'Unirme a un club' },
      ...(showCreate ? [{ id: 'create', label: 'Crear un club' }] : []),
    ];
    const activeTab = tabs.some((tab) => tab.id === this._activeClubTab)
      ? this._activeClubTab
      : memberships.length ? 'memberships' : 'join';
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
      joinBtn.addEventListener('click', () => {
        if (this._clubSubmitLocked) return;
        const clubId = joinInput.value.trim();
        if (!clubId) return;
        // D20: lock BEFORE rendering so the fresh controls are disabled.
        this._clubSubmitSeq += 1;
        this._clubSubmitAbort = new AbortController();
        this._clubSubmitLocked = true;
        this._loading = true;
        this._stepError = null;
        this._stepMessage = '';
        this.render();
        this.joinByClubId(clubId, this._clubSubmitSeq);
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
      createBtn.addEventListener('click', () => {
        if (this._clubSubmitLocked) return;
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
        // D20: lock BEFORE rendering so the fresh controls are disabled.
        this._clubSubmitSeq += 1;
        this._clubSubmitAbort = new AbortController();
        this._clubSubmitLocked = true;
        this._loading = true;
        this._stepError = null;
        this._stepMessage = '';
        this.render();
        this.createClub(name, website, this._clubSubmitSeq);
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

    // B14: Activate theme button
    const activateBtn = this.shadow.querySelector('[data-activate-btn]');
    if (activateBtn) {
      activateBtn.addEventListener('click', () => this.activateTheme(clubId));
    }

    // B14: Retry theme button
    const retryBtn = this.shadow.querySelector('[data-retry-btn]');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.retryTheme(clubId));
    }
  }
}

customElements.define('biq-onboard-app', BiqOnboardApp);
