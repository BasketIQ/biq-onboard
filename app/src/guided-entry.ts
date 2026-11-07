/** Presentation only: grants, activation and creates stay in existing ports. */
export interface WorkspacesEntry {
  kind: 'personal' | 'club'; name: string;
  owner_scope: {kind: string; club_id?: string};
  can_direct: boolean;
  teams: {id: string; name: string; category_key?: string; gender?: string}[];
}
export interface PendingInvitation {
  id: string;
  club_id: string;
  club_name: string;
}
export interface GuidedEntryState {
  entries: WorkspacesEntry[]; role: 'coach' | 'director' | null; step: number;
  selection: string; busy: boolean; createTeam: boolean; createClub: boolean;
  coachImage: string; directorImage: string;
  invitations: PendingInvitation[]; otherOptions: boolean;
}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function guidedEntry(s: GuidedEntryState, forms: {coach: string; director: string}, invite: string): string {
  const disabled=s.busy?'disabled':'';
  const existing=s.entries.some(e=>e.kind==='club'||e.teams.length);
  const option = (key: string, name: string, context?: string) => {
    const label = context ? `${name} - ${context}` : name;
    return `<label class="guided-choice"><span><strong>${esc(name)}</strong>${context ? ` <span class="guided-choice-context">- ${esc(context)}</span>` : ''}</span><input type="checkbox" role="radio" name="workspace-choice" data-guided-choice="${esc(key)}" aria-label="${esc(label)}" aria-checked="${s.selection === key}" ${s.selection === key ? 'checked' : ''} ${disabled}></label>`;
  };
  const invitedClubIds = new Set(s.invitations.map(invitation => invitation.club_id));
  const workspaces = s.entries.map((entry, index) => ({ entry, index }));
  const clubAccess = workspaces.filter(({entry}) =>
    entry.kind === 'club' && !entry.can_direct && !entry.teams.length
    && !invitedClubIds.has(entry.owner_scope.club_id || ''));
  const hasClubAccess = Boolean(invite || s.invitations.length || clubAccess.length);
  const toolbar = `<div class="guided-toolbar">${s.otherOptions && hasClubAccess
    ? `<button class="entry-role" type="button" data-guided-show-club ${disabled}>Volver al acceso al club</button>`
    : ''}<button class="entry-role entry-logout" type="button" data-entry-logout ${disabled}>Salir</button></div>`;

  if (hasClubAccess && !s.otherOptions) {
    return `<section class="guided-entry">${toolbar}<h1>Acceso al club</h1>
      ${invite}
      ${s.invitations.map(item => `<div class="entry-invite">
        <p>Te han invitado al staff de <strong>${esc(item.club_name || item.club_id)}</strong>.</p>
        <button class="onboard-btn onboard-btn-primary" type="button" data-guided-invitation="${esc(item.id)}" ${disabled}>Unirme a ${esc(item.club_name || item.club_id)} como entrenador</button>
      </div>`).join('')}
      ${clubAccess.map(({entry, index}) => `<div class="entry-invite">
        <p>Podrás elegir un equipo desde «Mis equipos» una vez dentro del club.</p>
        <button class="onboard-btn onboard-btn-primary" type="button" data-guided-club-access="${index}" ${disabled}>Entrar en ${esc(entry.name)} como entrenador</button>
      </div>`).join('')}
      <button class="onboard-btn" type="button" data-guided-other-options ${disabled}>Otras opciones</button>
    </section>`;
  }

  if (existing && s.step === 1) {
    const teams = [...workspaces].sort((a, b) => Number(a.entry.kind === 'personal') - Number(b.entry.kind === 'personal'))
      .map(({ entry, index }) => entry.teams.map(team =>
      option(`${index}:${team.id}`, team.name, entry.kind === 'personal' ? 'Equipo personal' : entry.name),
    ).join('')).join('');
    const unassignedClubs = clubAccess.map(({ entry, index }) =>
      option(`${index}:waiting`, 'Entrar al club', entry.name),
    ).join('');
    const clubs = s.entries.map((entry, index) =>
      entry.kind === 'club' && entry.can_direct ? option(`${index}:director`, entry.name) : '',
    ).join('');
    return `<section class="guided-entry">${toolbar}
      <h1 id="guided-session-title">Elige tu perfil para esta sesión</h1>
      <div role="radiogroup" aria-labelledby="guided-session-title">
        <section aria-labelledby="guided-coach-title">
          <h2 id="guided-coach-title">Entrenador</h2>
          ${teams}${unassignedClubs}
          ${s.createTeam ? `<button class="entry-create" type="button" data-guided-create="coach" ${disabled}>+ Crear equipo Personal</button>` : ''}
        </section>
        ${clubs || s.createClub ? `<section aria-labelledby="guided-director-title">
          <h2 id="guided-director-title">Director Deportivo</h2>
          ${clubs}
          ${s.createClub ? `<button class="entry-create" type="button" data-guided-create="director" ${disabled}>+ Crear Club</button>` : ''}
        </section>` : ''}
      </div>
      <div class="guided-footer"><button class="onboard-btn onboard-btn-primary" data-guided-confirm ${!s.selection || s.busy ? 'disabled' : ''}>Entrar</button></div>
    </section>`;
  }
  if(s.step===1)return `<section class="guided-entry">${toolbar}<p class="guided-progress">1 de 2 · Tu rol</p><h1>¿Cuál es tu rol?</h1><div class="guided-roles" role="radiogroup" aria-label="Tu rol">${[['coach','Entrenador',s.coachImage,'Te ayudamos a preparar tu equipo, planificar la temporada y los entrenamientos, seguir los partidos y valorar a tus jugadores para desarrollar su talento.'],['director','Director deportivo',s.directorImage,'Te ayudamos a crear y personalizar tu club, organizar equipos y entrenadores, definir la estrategia deportiva y comunicarte con sus miembros.']].map(([id,title,img,copy])=>`<label class="guided-role"><img src="${esc(img)}" alt="${id==='coach'?'Hoopie entrenador':'Chispa directora deportiva'}"><strong>${title}</strong><p>${copy}</p><input type="checkbox" role="radio" name="guided-role" data-guided-role="${id}" aria-label="${title}" aria-checked="${s.role===id}" ${s.role===id?'checked':''} ${disabled}${id==='director'&&!s.createClub?' disabled':''}></label>`).join('')}</div>${!s.createClub?'<p class="entry-note">La creación de clubes aún no está habilitada para tu cuenta.</p>':''}<div class="guided-footer"><button class="onboard-btn onboard-btn-primary" data-guided-next ${s.role&&!s.busy?'':'disabled'}>Continuar</button></div></section>`;
  const director=s.role==='director';
  const progress = existing ? '' : `<p class="guided-progress">2 de 2 · ${director ? 'Tu club' : 'Tu primer equipo'}</p>`;
  const title = director ? 'Crea tu club' : existing ? 'Crea tu equipo personal' : 'Prepara tu primer equipo';
  return `<section class="guided-entry">${toolbar}${progress}<img class="guided-profile" src="${esc(director?s.directorImage:s.coachImage)}" alt="${director?'Chispa directora deportiva':'Hoopie entrenador'}"><h1>${title}</h1>${director?forms.director:forms.coach}<button class="onboard-btn" data-guided-back ${disabled}>Atrás</button></section>`;
}
