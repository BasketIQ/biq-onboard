import { guidedEntryCopy } from "./guided-entry-copy";

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
export function guidedEntry(s: GuidedEntryState, forms: {coach: string; director: string}, invite: string, locale = "es-ES"): string {
  const copy = guidedEntryCopy(locale);
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
    ? `<button class="entry-role" type="button" data-guided-show-club ${disabled}>${copy.backToClubAccess}</button>`
    : ''}<button class="entry-role entry-logout" type="button" data-entry-logout ${disabled}>${copy.signOut}</button></div>`;

  if (hasClubAccess && !s.otherOptions) {
    return `<section class="guided-entry">${toolbar}<h1>${copy.clubAccess}</h1>
      ${invite}
      ${s.invitations.map(item => `<div class="entry-invite">
        <p>${copy.invitedStaff} <strong>${esc(item.club_name || item.club_id)}</strong>.</p>
        <button class="onboard-btn onboard-btn-primary" type="button" data-guided-invitation="${esc(item.id)}" ${disabled}>${esc(copy.joinAsCoach(item.club_name || item.club_id))}</button>
      </div>`).join('')}
      ${clubAccess.map(({entry, index}) => `<div class="entry-invite">
        <p>${copy.chooseTeamInside}</p>
        <button class="onboard-btn onboard-btn-primary" type="button" data-guided-club-access="${index}" ${disabled}>${esc(copy.enterAsCoach(entry.name))}</button>
      </div>`).join('')}
      <button class="onboard-btn" type="button" data-guided-other-options ${disabled}>${copy.otherOptions}</button>
    </section>`;
  }

  if (existing && s.step === 1) {
    const teams = [...workspaces].sort((a, b) => Number(a.entry.kind === 'personal') - Number(b.entry.kind === 'personal'))
      .map(({ entry, index }) => entry.teams.map(team =>
      option(`${index}:${team.id}`, team.name, entry.kind === 'personal' ? copy.personalTeam : entry.name),
    ).join('')).join('');
    const unassignedClubs = clubAccess.map(({ entry, index }) =>
      option(`${index}:waiting`, copy.enterClub, entry.name),
    ).join('');
    const clubs = s.entries.map((entry, index) =>
      entry.kind === 'club' && entry.can_direct ? option(`${index}:director`, entry.name) : '',
    ).join('');
    return `<section class="guided-entry">${toolbar}
      <h1 id="guided-session-title">${copy.chooseProfile}</h1>
      <div role="radiogroup" aria-labelledby="guided-session-title">
        <section aria-labelledby="guided-coach-title">
          <h2 id="guided-coach-title">${copy.coach}</h2>
          ${teams}${unassignedClubs}
          ${s.createTeam ? `<button class="entry-create" type="button" data-guided-create="coach" ${disabled}>${copy.createPersonalTeam}</button>` : ''}
        </section>
        ${clubs || s.createClub ? `<section aria-labelledby="guided-director-title">
          <h2 id="guided-director-title">${copy.directorSection}</h2>
          ${clubs}
          ${s.createClub ? `<button class="entry-create" type="button" data-guided-create="director" ${disabled}>${copy.createClub}</button>` : ''}
        </section>` : ''}
      </div>
      <div class="guided-footer"><button class="onboard-btn onboard-btn-primary" data-guided-confirm ${!s.selection || s.busy ? 'disabled' : ''}>${copy.enter}</button></div>
    </section>`;
  }
  if(s.step===1)return `<section class="guided-entry">${toolbar}<p class="guided-progress">${copy.roleProgress}</p><h1>${copy.roleTitle}</h1><div class="guided-roles" role="radiogroup" aria-label="${copy.role}">${[['coach',copy.coach,s.coachImage,copy.coachDescription],['director',copy.director,s.directorImage,copy.directorDescription]].map(([id,title,img,description])=>`<label class="guided-role"><img src="${esc(img)}" alt="${id==='coach'?copy.coachAlt:copy.directorAlt}"><strong>${title}</strong><p>${description}</p><input type="checkbox" role="radio" name="guided-role" data-guided-role="${id}" aria-label="${title}" aria-checked="${s.role===id}" ${s.role===id?'checked':''} ${disabled}${id==='director'&&!s.createClub?' disabled':''}></label>`).join('')}</div>${!s.createClub?`<p class="entry-note">${copy.clubCreationUnavailable}</p>`:''}<div class="guided-footer"><button class="onboard-btn onboard-btn-primary" data-guided-next ${s.role&&!s.busy?'':'disabled'}>${copy.continue}</button></div></section>`;
  const director=s.role==='director';
  const progress = existing ? '' : `<p class="guided-progress">${director ? copy.clubProgress : copy.teamProgress}</p>`;
  const title = director ? copy.createYourClub : existing ? copy.createYourPersonalTeam : copy.prepareFirstTeam;
  return `<section class="guided-entry">${toolbar}${progress}<img class="guided-profile" src="${esc(director?s.directorImage:s.coachImage)}" alt="${director?copy.directorAlt:copy.coachAlt}"><h1>${title}</h1>${director?forms.director:forms.coach}<button class="onboard-btn" data-guided-back ${disabled}>${copy.back}</button></section>`;
}
