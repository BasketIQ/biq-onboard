/**
 * Static unit assertions for Issue #31:
 * - Deactivate endpoint integration in onboard-app.ts
 * - Control disabling during polling
 * - Preview preservation during polling
 * - Banner suppression when theme status is not active
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'src', 'onboard-app.ts'), 'utf-8');

// ─── Requirement 1: Deactivation endpoint and switch uncheck ──────────

test('deactivateTheme method is implemented and calls /deactivate endpoint', () => {
  assert.ok(
    SRC.includes('async deactivateTheme(clubId: string)'),
    'deactivateTheme method should exist'
  );
  assert.ok(
    SRC.includes('/theme/deactivate'),
    'deactivateTheme should call /theme/deactivate endpoint'
  );
  assert.ok(
    SRC.includes("method: 'POST'"),
    'deactivateTheme should dispatch a POST request'
  );
});

test('default identity button calls non-destructive deactivation', () => {
  assert.ok(SRC.includes("[data-identity-default]"));
  assert.ok(SRC.includes("addEventListener('click', () => this.deactivateTheme(clubId))"));
});

// ─── Requirement 2: Polling UI Guards ─────────────────────────────────

test('website input is disabled when polling', () => {
  assert.ok(
    SRC.includes("data-website-input value=\"${escapeHtml(website)}\" placeholder=\"https://www.miclub.com\" ${this._loading || (isPolling && !this._isStale) ? 'disabled' : ''}"),
    'data-website-input should be disabled during polling'
  );
});

test('explicit apply is guarded by gate, polling, loading and unsaved colours', () => {
  assert.ok(SRC.includes("theme.gate?.passed === true && !isPolling && !this._loading && !dirty"));
  assert.ok(SRC.includes("data-identity-apply ${!ready || active ? 'disabled' : ''}"));
});

// ─── Requirement 3: Theme preview preserved during polling ────────────

test('theme is preserved during awaitingNewJob in loadThemeData', () => {
  const idx = SRC.indexOf('async loadThemeData');
  assert.ok(idx > 0, 'loadThemeData method should exist');
  const section = SRC.slice(idx, idx + 2000);
  assert.ok(
    section.includes('this._theme = this._theme || data.theme || null'),
    'loadThemeData should keep previous theme preview during in-flight jobs'
  );
});

test('theme is preserved during awaitingNewJob in _pollTheme', () => {
  const idx = SRC.indexOf('private async _pollTheme');
  assert.ok(idx > 0, '_pollTheme method should exist');
  const section = SRC.slice(idx, idx + 2000);
  assert.ok(
    section.includes('this._theme = this._theme || data.theme || null'),
    '_pollTheme should keep previous theme preview during in-flight jobs'
  );
});

// ─── Requirement 4: Banner suppression ─────────────────────────────────

test('job state card is suppressed when succeeded and theme status is not active', () => {
  assert.ok(
    SRC.includes("!(jobStatus === 'succeeded' && theme?.status !== 'active')"),
    'job state card should be suppressed when succeeded but theme is not active'
  );
});
