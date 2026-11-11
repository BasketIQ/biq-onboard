type Grant = {
  account_id: string; owner_account_id: string; generation: number;
  plan_state: 'free' | 'premium' | 'grace' | 'expired'; archived: boolean;
};
type Team = Grant & { team_id: string; name: string };
type Member = { account_id: string; generation: number; revision: number; premium_access_enabled: boolean; display_name?: string };
type Invitation = { invitation_id: string; team_id: string; name?: string; email?: string; expires_at: number; mail_delivery_state?: string };
type Transfer = { transfer_id: string; to_account_id: string };
type Directory = { grant: Grant; name: string; members: Member[]; invitations: Invitation[]; transfer: Transfer | null };
const BASE = '/api/context/v1/personal-staff';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

const COPY = {
  es: {
    loading: 'Cargando staff…',
    verifyEmail: 'Para aceptar invitaciones, inicia sesión con un enlace enviado al correo invitado.',
    pending: 'Invitaciones a equipos personales', expires: 'Caduca:', accept: 'Aceptar invitación',
    staff: 'Staff del equipo', team: 'Equipo', premium: 'Premium activo',
    grace: 'Cortesía: trabajo ordinario durante siete días, sin invitaciones ni consumo Premium.',
    expired: 'Suscripción vencida. Equipo archivado.', free: 'Coach', owner: 'Dueño',
    premiumPermission: 'Permitir Premium y Smart', remove: 'Retirar del staff',
    email: 'Correo del entrenador', invite: 'Invitar al staff', resend: 'Reenviar',
    revoke: 'Revocar invitación', pendingTransfer: 'Transferencia de propiedad pendiente de aceptación.',
    acceptOwnership: 'Aceptar propiedad', cancelTransfer: 'Cancelar transferencia', newOwner: 'Nuevo dueño',
    proposeTransfer: 'Proponer transferencia', restore: 'Restaurar equipo', archive: 'Archivar equipo',
    leave: 'Salir del equipo', ownerMustTransfer: 'Para salir, otro entrenador debe aceptar primero la propiedad.',
    refresh: 'Actualizar staff', conflict: 'El equipo ha cambiado. Actualiza y revisa antes de reintentar.',
    verifiedEmailRequired: 'Verifica el correo invitado mediante un enlace de acceso para aceptar.',
    premiumRequired: 'Esta acción requiere Premium activo en el equipo.',
    actionFailed: 'No se pudo completar la acción. Actualiza el equipo o vuelve a iniciar sesión.',
    loadFailed: 'No se pudo cargar el staff.',
    mailFailed: 'Invitación guardada, pero el correo no se ha enviado. Puedes reintentar sin ampliar el vencimiento.',
    confirmRemove: '¿Retirar a este entrenador? Perderá el acceso al equipo.',
    confirmLeave: '¿Salir del equipo y perder el acceso?',
  },
  en: {
    loading: 'Loading staff…',
    verifyEmail: 'To accept invitations, sign in with a link sent to the invited mailbox.',
    pending: 'Personal team invitations', expires: 'Expires:', accept: 'Accept invitation',
    staff: 'Team staff', team: 'Team', premium: 'Premium active',
    grace: 'Courtesy period: ordinary work for seven days, without invitations or Premium consumption.',
    expired: 'Subscription expired. Team archived.', free: 'Coach', owner: 'Owner',
    premiumPermission: 'Allow Premium and Smart', remove: 'Remove from staff',
    email: "Coach's email", invite: 'Invite to staff', resend: 'Resend',
    revoke: 'Revoke invitation', pendingTransfer: 'Ownership transfer pending acceptance.',
    acceptOwnership: 'Accept ownership', cancelTransfer: 'Cancel transfer', newOwner: 'New owner',
    proposeTransfer: 'Propose transfer', restore: 'Restore team', archive: 'Archive team',
    leave: 'Leave team', ownerMustTransfer: 'To leave, another coach must accept ownership first.',
    refresh: 'Refresh staff', conflict: 'The team has changed. Refresh and review before retrying.',
    verifiedEmailRequired: 'Verify the invited email with a sign-in link to accept.',
    premiumRequired: 'This action requires active Premium on the team.',
    actionFailed: 'The action could not be completed. Refresh the team or sign in again.',
    loadFailed: 'Staff could not be loaded.',
    mailFailed: 'Invitation saved, but the email was not sent. You can retry without extending expiry.',
    confirmRemove: 'Remove this coach? They will lose access to the team.',
    confirmLeave: 'Leave the team and lose access?',
  },
} as const;

export class PersonalStaff extends HTMLElement {
  localize?: (key: string, fallback: string) => string;
  private controller: AbortController | null = null;
  private generation = 0;
  private teams: Team[] = [];
  private invitations: Invitation[] = [];
  private verificationRequired = false;
  private directory: Directory | null = null;
  private selected = '';
  private busy = false;
  private error = '';
  private operations = new Map<string, string>();
  private inviteDraft = '';

  connectedCallback() { void this.load(); }
  disconnectedCallback() { this.generation++; this.controller?.abort(); }
  private get language() { return this.locale.toLowerCase().startsWith('en') ? 'en' : 'es'; }
  private copy(key: string, fallback: string) {
    const localized = COPY[this.language][key as keyof typeof COPY.es] || fallback;
    return escape(this.localize?.(`personalStaff.${key}`, localized) || localized);
  }
  private message(key: keyof typeof COPY.es) {
    const fallback = COPY[this.language][key];
    return this.localize?.(`personalStaff.${key}`, fallback) || fallback;
  }
  private get invitationsOnly() { return this.hasAttribute('invitations-only'); }
  private get locale() { return this.getAttribute('lang') || document.documentElement.lang || 'es-ES'; }

  private async request(path: string, body?: object, method = 'POST') {
    const response = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : method, credentials: 'include', cache: 'no-store',
      signal: this.controller?.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = data?.detail;
      if (response.status === 409) throw new Error(this.message('conflict'));
      if (code === 'verified_email_required') throw new Error(this.message('verifiedEmailRequired'));
      if (code === 'premium_required') throw new Error(this.message('premiumRequired'));
      throw new Error(this.message('actionFailed'));
    }
    return data;
  }

  private async load() {
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    this.busy = true;
    this.paint();
    try {
      const [teams, invitations] = await Promise.all([
        this.invitationsOnly ? Promise.resolve({ teams: [] }) : this.request('/teams'),
        this.request('/invitations'),
      ]);
      if (generation !== this.generation || !this.isConnected) return;
      if (!Array.isArray(teams?.teams) || !Array.isArray(invitations?.invitations)) throw new Error(this.message('loadFailed'));
      this.teams = teams.teams;
      this.invitations = invitations.invitations;
      this.verificationRequired = invitations.requires_email_verification === true;
      this.selected = this.teams.some(team => team.team_id === this.selected) ? this.selected : this.teams[0]?.team_id || '';
      this.directory = this.selected ? await this.request(`/teams/${encodeURIComponent(this.selected)}`) : null;
    } catch (error) {
      if (generation !== this.generation || !this.isConnected) return;
      this.error = (error as Error).message;
      this.directory = null;
    } finally {
      if (generation === this.generation && this.isConnected) { this.busy = false; this.paint(); }
    }
  }

  private async command(path: string, body: Record<string, unknown>, method = 'POST', operation = false) {
    if (this.busy) return;
    const generation = this.generation;
    const identity = JSON.stringify([path, body]);
    if (operation) {
      if (!this.operations.has(identity)) this.operations.set(identity, crypto.randomUUID());
      body = { ...body, operation_id: this.operations.get(identity) };
    }
    this.busy = true;
    this.error = '';
    this.paint();
    try {
      const result = await this.request(path, body, method);
      if (generation !== this.generation || !this.isConnected) return;
      this.operations.delete(identity);
      if (result.mail_delivery_state && result.mail_delivery_state !== 'sent') this.error = this.message('mailFailed');
      if (path === '/invitations/accept' || path.endsWith('/leave') || path === '/transfers/accept' || path.endsWith('/archive')) {
        this.dispatchEvent(new CustomEvent('personal-staff:changed', { bubbles: true, composed: true }));
      }
      if (path.endsWith('/invitations')) this.inviteDraft = '';
    } catch (error) {
      if (generation !== this.generation || !this.isConnected) return;
      this.error = (error as Error).message;
    } finally {
      if (generation === this.generation && this.isConnected) { this.busy = false; await this.load(); }
    }
  }

  private paint() {
    const disabled = this.busy ? 'disabled' : '';
    const directory = this.directory;
    const grant = directory?.grant;
    const owner = grant?.account_id === grant?.owner_account_id;
    const canInvite = grant?.plan_state === 'premium' && !grant.archived;
    const teamPath = `/teams/${encodeURIComponent(this.selected)}`;
    const date = (timestamp: number) => escape(new Date(timestamp * 1000).toLocaleString(this.locale));
    this.innerHTML = `
      ${this.error ? `<p class="entry-error" role="alert">${escape(this.error)}</p>` : ''}
      ${this.busy ? `<p role="status">${this.copy('loading', 'Cargando staff…')}</p>` : ''}
      ${this.verificationRequired ? `<p>${this.copy('verifyEmail', 'Para aceptar invitaciones, inicia sesión con un enlace enviado al correo invitado.')}</p>` : ''}
      ${this.invitations.length ? `<section class="entry-block"><h2>${this.copy('pending', 'Invitaciones a equipos personales')}</h2>
        ${this.invitations.map(invitation => `<div class="entry-team"><strong>${escape(invitation.name)}</strong>
          <span>${this.copy('expires', 'Caduca:')} ${date(invitation.expires_at)}</span>
          <button class="onboard-btn onboard-btn-primary" data-accept="${escape(invitation.invitation_id)}" ${disabled}>${this.copy('accept', 'Aceptar invitación')}</button></div>`).join('')}</section>` : ''}
      ${!this.invitationsOnly ? `<section class="entry-block" aria-label="${this.copy('staff', 'Staff del equipo')}">
        <h2>${this.copy('staff', 'Staff del equipo')}</h2>
        <label>${this.copy('team', 'Equipo')} <select data-team ${disabled}>${this.teams.map(team =>
          `<option value="${escape(team.team_id)}" ${team.team_id === this.selected ? 'selected' : ''}>${escape(team.name)}</option>`).join('')}</select></label>
        ${directory && grant ? `<p>${this.copy(grant.plan_state, {
          premium: 'Premium activo', grace: 'Cortesía: trabajo ordinario durante siete días, sin invitaciones ni consumo Premium.',
          expired: 'Suscripción vencida. Equipo archivado.', free: 'Coach',
        }[grant.plan_state])}</p>
        <ul class="entry-teams">${directory.members.map(member => `<li class="entry-team">
          <strong>${escape(member.display_name || member.account_id)}</strong>
          ${member.account_id === grant.owner_account_id ? `<span>${this.copy('owner', 'Dueño')}</span>` : `
            ${owner ? `<label><input type="checkbox" data-permission="${escape(member.account_id)}" ${member.premium_access_enabled ? 'checked' : ''} ${disabled}> ${this.copy('premiumPermission', 'Permitir complementos Premium')}</label>` : ''}
            <button class="onboard-btn" data-remove="${escape(member.account_id)}" ${disabled}>${this.copy('remove', 'Retirar del staff')}</button>`}
        </li>`).join('')}</ul>
        ${canInvite ? `<form class="entry-form" data-invite><label>${this.copy('email', 'Correo del entrenador')}
          <input name="staff-email" type="email" maxlength="254" value="${escape(this.inviteDraft)}" required ${disabled}></label>
          <button class="onboard-btn onboard-btn-primary" ${disabled}>${this.copy('invite', 'Invitar al staff')}</button></form>` : ''}
        ${directory.invitations.map(invitation => `<div class="entry-team"><span>${escape(invitation.email)}</span>
          <span>${this.copy('expires', 'Caduca:')} ${date(invitation.expires_at)}</span>
          <span>${escape(invitation.mail_delivery_state)}</span>
          <button class="onboard-btn" data-resend="${escape(invitation.invitation_id)}" ${this.busy || !canInvite ? 'disabled' : ''}>${this.copy('resend', 'Reenviar')}</button>
          <button class="onboard-btn" data-revoke="${escape(invitation.invitation_id)}" ${disabled}>${this.copy('revoke', 'Revocar invitación')}</button></div>`).join('')}
        ${directory.transfer ? `<div class="entry-team"><p>${this.copy('pendingTransfer', 'Transferencia de propiedad pendiente de aceptación.')}</p>
          ${directory.transfer.to_account_id === grant.account_id ? `<button class="onboard-btn" data-transfer-accept ${disabled}>${this.copy('acceptOwnership', 'Aceptar propiedad')}</button>` : ''}
          ${owner ? `<button class="onboard-btn" data-transfer-cancel ${disabled}>${this.copy('cancelTransfer', 'Cancelar transferencia')}</button>` : ''}</div>`
          : owner && directory.members.length > 1 ? `<form class="entry-form" data-transfer><label>${this.copy('newOwner', 'Nuevo dueño')}
            <select name="new-owner" ${disabled}>${directory.members.filter(member => member.account_id !== grant.account_id).map(member =>
              `<option value="${escape(member.account_id)}">${escape(member.display_name || member.account_id)}</option>`).join('')}</select></label>
            <button class="onboard-btn" ${disabled}>${this.copy('proposeTransfer', 'Proponer transferencia')}</button></form>` : ''}
        <button class="onboard-btn" data-archive ${this.busy || (grant.archived && grant.plan_state === 'expired') ? 'disabled' : ''}>${this.copy(grant.archived ? 'restore' : 'archive', grant.archived ? 'Restaurar equipo' : 'Archivar equipo')}</button>
        ${!owner ? `<button class="onboard-btn" data-leave ${disabled}>${this.copy('leave', 'Salir del equipo')}</button>` : `<p>${this.copy('ownerMustTransfer', 'Para salir, otro entrenador debe aceptar primero la propiedad.')}</p>`}
        ` : ''}</section>` : ''}
      ${this.error || !this.invitationsOnly ? `<button class="onboard-btn" data-refresh ${disabled}>${this.copy('refresh', 'Actualizar staff')}</button>` : ''}`;
    this.querySelector('[data-refresh]')?.addEventListener('click', () => { this.error = ''; void this.load(); });
    this.querySelector<HTMLSelectElement>('[data-team]')?.addEventListener('change', event => {
      this.selected = (event.target as HTMLSelectElement).value; this.error = ''; void this.load();
    });
    this.querySelector<HTMLInputElement>('[name="staff-email"]')?.addEventListener('input', event => { this.inviteDraft = (event.target as HTMLInputElement).value; });
    this.querySelector('[data-invite]')?.addEventListener('submit', event => {
      event.preventDefault(); void this.command(teamPath + '/invitations', { email: this.inviteDraft }, 'POST', true);
    });
    this.querySelector('[data-transfer]')?.addEventListener('submit', event => {
      event.preventDefault();
      const account = new FormData(event.target as HTMLFormElement).get('new-owner');
      void this.command(teamPath + '/transfers', { account_id: account }, 'POST', true);
    });
    this.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach(button => button.addEventListener('click', () => {
      void this.command('/invitations/accept', { invitation_id: button.dataset.accept });
    }));
    for (const action of ['resend', 'revoke'] as const) {
      this.querySelectorAll<HTMLButtonElement>(`[data-${action}]`).forEach(button => button.addEventListener('click', () => {
        void this.command('/invitations/' + action, { invitation_id: button.dataset[action] }, 'POST', action === 'resend');
      }));
    }
    this.querySelectorAll<HTMLInputElement>('[data-permission]').forEach(input => input.addEventListener('change', () => {
      const member = directory?.members.find(member => member.account_id === input.dataset.permission);
      if (member) void this.command(teamPath + '/permission', {
        account_id: member.account_id, generation: member.generation, expected_revision: member.revision, enabled: input.checked,
      }, 'PATCH');
    }));
    this.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.addEventListener('click', () => {
      const member = directory?.members.find(member => member.account_id === button.dataset.remove);
      if (member && window.confirm(this.message('confirmRemove'))) void this.command(teamPath + '/remove', { account_id: member.account_id, generation: member.generation });
    }));
    this.querySelector('[data-leave]')?.addEventListener('click', () => {
      if (grant && window.confirm(this.message('confirmLeave'))) void this.command(teamPath + '/leave', { generation: grant.generation });
    });
    this.querySelector('[data-archive]')?.addEventListener('click', () => {
      if (grant) void this.command(teamPath + '/archive', { archived: !grant.archived }, 'PATCH');
    });
    for (const action of ['accept', 'cancel'] as const) {
      this.querySelector(`[data-transfer-${action}]`)?.addEventListener('click', () => {
        if (directory?.transfer) void this.command('/transfers/' + action, { transfer_id: directory.transfer.transfer_id });
      });
    }
  }
}

if (!customElements.get('biq-personal-staff')) customElements.define('biq-personal-staff', PersonalStaff);
