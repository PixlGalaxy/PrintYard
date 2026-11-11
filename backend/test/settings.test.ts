import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  maskSettings,
  SECRET_MASK,
  SettingsService,
  SettingsValidationError,
  SETTING_DEFS,
  type SettingDefs,
} from '../src/db/settings.js';
import { NOTIFY_SETTING_DEFS } from '../src/modules/notifications/settings.js';
import './helpers.js';

function freshDb() {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

describe('SettingsService', () => {
  it('returns every contract key with its default', () => {
    const s = new SettingsService(freshDb());
    // Phase 4 notification channel keys are checked against their own defaults (test/notifications.test.ts covers them).
    const all = Object.fromEntries(Object.entries(s.getAll()).filter(([k]) => !k.startsWith('notify.')));
    for (const [k, d] of Object.entries(NOTIFY_SETTING_DEFS)) assert.deepEqual(s.get(k as keyof typeof NOTIFY_SETTING_DEFS), d.default, k);
    assert.deepEqual(all, {
      'app.defaultLanguage': 'en',
      'appearance.defaultMode': 'system',
      'appearance.defaultSkin': 'sky',
      'workspace.defaultLevel': 'basic',
      'admin.email': null,
      'exposure.mode': 'none',
      'exposure.trustedProxies': [],
      'exposure.publicUrl': null,
      'security.sessionHours': 168,
      'security.idleMinutes': 0,
      'engine.selected': 'creality',
      'engine.autoUpdate': true,
      'engine.checkIntervalHours': 24,
      'files.retention.enabled': true,
      'files.retention.keep': 10,
      'files.maxUploadMb': 200,
      'files.quotaMb': 2048,
      'slicing.timeoutMinutes': 15,
      'slicing.maxMemoryMb': 0,
      'printers.retention.enabled': true,
      'printers.retention.keep': 10,
      'printers.profilesBackup.enabled': true,
      'printers.idleHeaterOffMinutes': 15,
      'printing.calibrateByDefault': false,
      'limits.costPerKg': null,
      'limits.currency': 'USD',
    });
  });

  it('validates per key and writes nothing when any key is invalid', () => {
    const s = new SettingsService(freshDb());
    assert.throws(
      () => s.patch({ 'exposure.mode': 'nginx', 'security.sessionHours': -1 }),
      (err: unknown) => err instanceof SettingsValidationError && err.issues[0]?.key === 'security.sessionHours',
    );
    assert.equal(s.get('exposure.mode'), 'none');
    assert.throws(() => s.patch({ 'no.such.key': 1 }), SettingsValidationError);
    assert.throws(() => s.patch({ 'exposure.trustedProxies': ['not-a-cidr'] }), SettingsValidationError);
    assert.throws(() => s.patch({ 'exposure.publicUrl': 'javascript:alert(1)' }), SettingsValidationError);
    assert.throws(() => s.patch([]), SettingsValidationError);
  });

  it('persists, normalises and reports changed keys', () => {
    const db = freshDb();
    const s = new SettingsService(db);
    const changed = s.patch({
      'exposure.mode': 'other',
      'exposure.trustedProxies': ['10.0.0.0/8'],
      'exposure.publicUrl': 'https://print.example.com/',
      'limits.currency': 'eur',
      'admin.email': '',
      'app.defaultLanguage': 'en', // unchanged
    });
    assert.deepEqual(changed.sort(), ['exposure.mode', 'exposure.publicUrl', 'exposure.trustedProxies', 'limits.currency']);
    const again = new SettingsService(db);
    assert.equal(again.get('exposure.publicUrl'), 'https://print.example.com');
    assert.equal(again.get('limits.currency'), 'EUR');
    assert.equal(again.get('admin.email'), null);
  });
});

describe('secret masking', () => {
  const defs: SettingDefs = {
    ...SETTING_DEFS,
    'notify.discordWebhook': { schema: z.string().nullable(), default: null, secret: true },
  };

  it('masks set secrets and leaves unset ones null', () => {
    assert.deepEqual(maskSettings({ 'notify.discordWebhook': 'https://discord/x', 'exposure.mode': 'none' }, defs), {
      'notify.discordWebhook': SECRET_MASK,
      'exposure.mode': 'none',
    });
    assert.deepEqual(maskSettings({ 'notify.discordWebhook': null }, defs), { 'notify.discordWebhook': null });
  });

  it('treats a PATCH of the mask as "unchanged" and never stores the mask', () => {
    const s = new SettingsService(freshDb(), defs);
    s.patch({ 'notify.discordWebhook': 'https://discord.com/api/webhooks/1/abc' });
    assert.equal(s.getAllMasked()['notify.discordWebhook'], SECRET_MASK);
    assert.deepEqual(s.patch({ 'notify.discordWebhook': SECRET_MASK }), []);
    assert.equal(s.get('notify.discordWebhook'), 'https://discord.com/api/webhooks/1/abc');
    s.patch({ 'notify.discordWebhook': null });
    assert.equal(s.getAllMasked()['notify.discordWebhook'], null);
  });
});
