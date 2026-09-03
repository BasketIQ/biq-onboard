/**
 * Regression tests for the theme job terminal-state rendering bugs.
 *
 * Bug 1: _loading was never reset to false when the job reached a terminal
 *        state (uncertain, failed, etc.), causing the "Generar tema" button
 *        to stay stuck at "Generando…" and disabled.
 *
 * Bug 2: The job state card (<div data-job-state="...">) was rendered as an
 *        empty container — the jobCopy title/description were never inserted
 *        into the HTML, so the user saw an empty card for non-polling states.
 *
 * Bug 3 (revised): "uncertain" with a theme should NOT show a retry button
 *        or the "Revisión necesaria" card. The admin activates/deactivates
 *        via the activation toggle. The job state card is suppressed when
 *        uncertain AND a theme exists.
 *
 * These tests verify the source code patterns directly, without requiring
 * Playwright or a built dist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'src', 'onboard-app.ts'), 'utf-8');

// ─── Bug 1: _loading reset on terminal state ───────────────────────────

test('_loading is reset to false in loadThemeData terminal branch', () => {
  const idx = SRC.indexOf('async loadThemeData');
  assert.ok(idx > 0, 'loadThemeData method should exist');
  const section = SRC.slice(idx, idx + 2000);
  assert.ok(
    section.includes('this._loading = false'),
    '_loading = false should be present in loadThemeData'
  );
});

test('_loading is reset to false in _pollTheme terminal branch', () => {
  const idx = SRC.indexOf('private async _pollTheme');
  assert.ok(idx > 0, '_pollTheme method should exist');
  const section = SRC.slice(idx, idx + 3000);
  assert.ok(
    section.includes('this._loading = false'),
    '_loading = false should be present in _pollTheme'
  );
});

// ─── Bug 2: jobCopy title/description rendered ─────────────────────────

test('jobCopy.title is rendered in the job state card HTML', () => {
  assert.ok(
    SRC.includes('jobCopy.title'),
    'jobCopy.title should be rendered in the card HTML'
  );
});

test('jobCopy.description is rendered in the job state card HTML', () => {
  assert.ok(
    SRC.includes('jobCopy.description'),
    'jobCopy.description should be rendered in the card HTML'
  );
});

// ─── Bug 3 (revised): uncertain NOT in canRetry ────────────────────────

test('uncertain is NOT in the canRetry list', () => {
  const match = SRC.match(/canRetry = ([^;]+)/);
  assert.ok(match, 'canRetry definition should exist');
  assert.ok(
    !match[1].includes('uncertain'),
    "'uncertain' should NOT be in the canRetry list — admin activates via toggle"
  );
});

// ─── Bug 4: job state card suppressed for uncertain + theme ────────────

test('job state card is suppressed when uncertain AND theme exists', () => {
  // The render condition should exclude uncertain+theme from showing the card
  assert.ok(
    SRC.includes("!(jobStatus === 'uncertain' && theme)"),
    'The job state card render condition should suppress uncertain+theme'
  );
});

// ─── THEME_JOB_COPY has uncertain entry (still defined, just not shown) ─

test('THEME_JOB_COPY has an entry for uncertain status', () => {
  const match = SRC.match(/uncertain:\s*\{[^}]*title:/);
  assert.ok(match, 'THEME_JOB_COPY should have an uncertain entry with a title');
});
