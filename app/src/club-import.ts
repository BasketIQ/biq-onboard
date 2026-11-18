const texts = {
  es: {
    title: 'Importar equipos y entrenadores', file: 'Fichero de hasta 5 MB', preview: 'Preparar vista previa',
    confirm: 'Confirmar altas e invitaciones', close: 'Cerrar', discard: 'Quitar fila',
    team: 'Equipo', coach: 'Entrenador', name: 'Nombre', category: 'Categoría',
    gender: 'Género', level: 'Nivel', email: 'Correo', role: 'Rol', teams: 'Equipos separados por coma',
    help: 'Revisa o elimina filas antes de confirmar. Los entrenadores deben aceptar la invitación.',
    previewError: 'No se pudo leer el fichero. Comprueba el formato, el tamaño y Smart.',
    confirmError: 'No se confirmó el resultado. Puedes reintentar la misma confirmación.',
    busy: 'Procesando…', empty: 'El fichero no contiene equipos ni entrenadores reconocibles.',
    created: 'Equipo creado', invited: 'Invitación pendiente de aceptación',
    errors: {
      invalid_team: 'Categoría, género o nivel no válido', duplicate_team: 'El equipo ya existe',
      club_team_limit_reached: 'Límite de equipos alcanzado', invalid_email: 'Correo no válido',
      duplicate_email: 'Correo repetido', invalid_role: 'El rol debe ser Entrenador',
      already_member: 'Ya pertenece al club', already_invited: 'Ya tiene una invitación pendiente',
      unknown_or_ambiguous_team: 'Equipo desconocido o ambiguo', team_not_imported: 'Equipo no importado',
      team_changed: 'El equipo cambió', invitation_unavailable: 'Invitación caducada o revocada',
    },
  },
  en: {
    title: 'Import teams and coaches', file: 'File up to 5 MB', preview: 'Prepare preview',
    confirm: 'Confirm teams and invitations', close: 'Close', discard: 'Remove row',
    team: 'Team', coach: 'Coach', name: 'Name', category: 'Category',
    gender: 'Gender', level: 'Level', email: 'Email', role: 'Role', teams: 'Teams separated by commas',
    help: 'Review or remove rows before confirming. Coaches must accept their invitation.',
    previewError: 'Could not read the file. Check its format, size and Smart access.',
    confirmError: 'The result could not be confirmed. You can retry the same confirmation.',
    busy: 'Processing…', empty: 'The file contains no recognizable teams or coaches.',
    created: 'Team created', invited: 'Invitation awaiting acceptance',
    errors: {
      invalid_team: 'Invalid category, gender or level', duplicate_team: 'Team already exists',
      club_team_limit_reached: 'Team limit reached', invalid_email: 'Invalid email',
      duplicate_email: 'Duplicate email', invalid_role: 'Only the Coach role can be invited',
      already_member: 'Already a club member', already_invited: 'Invitation already pending',
      unknown_or_ambiguous_team: 'Team is unknown or ambiguous', team_not_imported: 'Team was not imported',
      team_changed: 'Team changed', invitation_unavailable: 'Invitation expired or revoked',
    },
  },
} as const;

type Row = {type: 'team' | 'coach'; name: string; category?: string | null; gender?: string | null;
  level?: string | null; email?: string | null; role?: string | null; teams?: string[]};
type Outcome = {row: number; status: 'created' | 'invited' | 'rejected'; reason?: string};
const FILE_LIMIT = 5 * 1024 * 1024;

export function clubImportLabel(locale: string) {
  return texts[locale.startsWith('en') ? 'en' : 'es'].title;
}

function encode(data: Uint8Array) {
  let text = '';
  for (let offset = 0; offset < data.length; offset += 8192)
    text += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(text);
}

export function openClubImport(locale: string, current: () => boolean, refresh: () => void,
  options: Record<"category" | "gender" | "level", [string, string][]>) {
  const english = locale.startsWith('en');
  const t = texts[english ? 'en' : 'es'];
  const wireLocale = english ? 'en' : 'es-ES';
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', t.title);
  Object.assign(dialog.style, {width: 'min(42rem, 92vw)', maxHeight: '85dvh',
    background: 'Canvas', color: 'CanvasText', border: '1px solid GrayText',
    borderRadius: '1rem', padding: '1rem', overflow: 'auto'});
  const abort = new AbortController();
  let rows: Row[] | null = null;
  let outcomes: Outcome[] | null = null;
  let error = '';
  let busy = false;
  let pendingCommit: string | null = null;
  let previewKey: { fingerprint: string; operation: string } | undefined;

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function button(label: string, act: () => void) {
    const result = node('button', label);
    result.type = 'button';
    result.disabled = busy;
    result.addEventListener('click', act);
    return result;
  }
  async function request(path: string, body: object | string) {
    if (!current()) throw new Error('context changed');
    const response = await fetch('/api/director-smart/v1/club-import/' + path, {
      method: 'POST', credentials: 'include', signal: abort.signal,
      headers: {'Content-Type': 'application/json'}, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (!response.ok || !current()) throw new Error('request failed');
    return response.json();
  }
  function render() {
    dialog.replaceChildren(node('h2', t.title));
    if (outcomes) {
      const list = node('ol');
      for (const row of outcomes) {
        const reason = row.reason as keyof typeof t.errors;
        list.append(node('li', row.status === 'rejected' ? t.errors[reason] || t.confirmError : t[row.status]));
      }
      dialog.append(list);
    } else if (rows) {
      dialog.append(node('p', rows.length ? t.help : t.empty));
      rows.forEach((row, index) => {
        const group = node('fieldset');
        group.disabled = busy || pendingCommit !== null;
        group.append(node('legend', `${index + 1}. ${t[row.type]}`));
        const fields = row.type === 'team' ? ['name', 'category', 'gender', 'level'] as const
          : ['name', 'email', 'role', 'teams'] as const;
        for (const field of fields) {
          const label = node('label', t[field] + ' ');
          const value = field === 'teams' ? (row.teams || []).join(', ') : row[field] || '';
          const isOption = field === 'category' || field === 'gender' || field === 'level';
          const input = isOption ? node('select') : node('input');
          if (isOption && input instanceof HTMLSelectElement) {
            input.add(new Option('—', ''));
            const choices = options[field];
            for (const [key, name] of choices) input.add(new Option(name, key));
            const normalized = value.toLocaleLowerCase();
            const match = choices.find(([key, name]) => key.toLocaleLowerCase() === normalized
              || name.toLocaleLowerCase() === normalized);
            if (!match && value) input.add(new Option(value, value));
            row[field] = match?.[0] ?? value;
          }
          label.style.display = 'block';
          input.style.width = '100%';
          input.value = field === 'teams' ? value : row[field] || '';
          input.addEventListener('input', () => {
            if (field === 'teams') row.teams = input.value.split(',').map(s => s.trim()).filter(Boolean);
            else row[field] = input.value;
          });
          label.append(input);
          group.append(label);
        }
        group.append(button(t.discard, () => { rows!.splice(index, 1); render(); }));
        dialog.append(group);
      });
      if (rows.length) dialog.append(button(t.confirm, () => void commit()));
    } else {
      const label = node('label', t.file + ' ');
      const field = node('input');
      field.type = 'file';
      field.accept = '.pdf,.png,.jpg,.jpeg,.txt,.csv,.xlsx';
      field.disabled = busy;
      label.append(field);
      dialog.append(label, button(t.preview, () => {
        const file = field.files?.[0];
        if (file) void preview(file);
      }));
    }
    if (busy || error) {
      const message = node('p', busy ? t.busy : error);
      message.setAttribute('role', busy ? 'status' : 'alert');
      dialog.append(message);
    }
    dialog.append(button(t.close, () => dialog.close()));
  }
  async function preview(file: File) {
    if (!file.size || file.size > FILE_LIMIT) { error = t.previewError; render(); return; }
    busy = true; error = ''; render();
    try {
      const bytes = await file.arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const fingerprint = file.name + ':' + encode(hash);
      if (previewKey?.fingerprint !== fingerprint) previewKey = {fingerprint, operation: crypto.randomUUID()};
      const body = await request('preview', {operation_id: previewKey.operation, locale: wireLocale,
        filename: file.name, content_b64: encode(new Uint8Array(bytes))});
      if (body.contract !== 'document-import/1.0' || !Array.isArray(body.candidates)) throw new Error('invalid preview');
      rows = body.candidates;
    } catch {
      error = t.previewError;
    } finally {
      busy = false;
      if (dialog.isConnected) render();
    }
  }
  async function commit() {
    if (!rows?.length) return;
    pendingCommit ??= JSON.stringify({contract: 'document-import/1.0', operation_id: crypto.randomUUID(),
      locale: wireLocale, rows});
    busy = true; error = ''; render();
    try {
      const result = await request('commit', pendingCommit);
      outcomes = result.rows;
      refresh();
    } catch {
      error = t.confirmError;
    } finally {
      busy = false;
      if (dialog.isConnected) render();
    }
  }
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { abort.abort(); dialog.remove(); }, {once: true});
  document.body.append(dialog);
  render();
  dialog.showModal();
  return () => { abort.abort(); dialog.remove(); };
}
