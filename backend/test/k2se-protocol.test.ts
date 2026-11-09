import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  gcodeDirFromList,
  mapState,
  mergeFrame,
  normalizeColor,
  parseCfs,
  parseFileList,
  parseFirmware,
  parseFrame,
  safePrinterFileName,
  toPrinterStatus,
  type RawPrinterState,
} from '../src/printers/k2se/protocol.js';
import { uploadAccepted } from '../src/printers/k2se/live-driver.js';
import { extractMultipartFile, gcodeMeta } from '../src/printers/sim/simulator.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/k2se/${name}`, import.meta.url), 'utf8');

describe('K2 SE protocol: status merge from captured frames', () => {
  const frames = JSON.parse(fixture('printing-stream.json')) as string[];

  it('merges the full dump and partial deltas into PrinterStatus', () => {
    const raw: RawPrinterState = {};
    for (const text of frames) {
      const f = parseFrame(text);
      if (f.kind === 'data') mergeFrame(raw, f.data);
    }
    const s = toPrinterStatus(1, raw, true, 1000);
    assert.equal(s.state, 'printing');
    assert.equal(s.online, true);
    assert.equal(s.totalLayers, 756);
    assert.equal(s.layer, 145); // layer changed 144 → 145 in a later delta
    assert.equal(s.progress, 31);
    assert.equal(s.fileName, 'Object_1_PLA_3h40m37s.gcode');
    assert.equal(s.nozzleTarget, 220);
    assert.equal(s.bedTarget, 60);
    assert.ok(s.nozzleTemp !== null && s.nozzleTemp > 219 && s.nozzleTemp < 221, String(s.nozzleTemp));
    assert.ok(s.bedTemp !== null && s.bedTemp > 59 && s.bedTemp < 61);
    assert.equal(typeof s.nozzleTemp, 'number'); // strings coerced
    assert.equal(s.chamberTemp, null); // boxTemp 0 = no sensor
    assert.ok(s.remainingSec !== null && s.remainingSec < 8521); // decreasing printLeftTime deltas applied
    assert.ok(s.elapsedSec !== null && s.elapsedSec > 4716);
    assert.equal(s.errorCode, null);
    assert.equal(s.cfs, null); // boxsInfo is a separate reply
    assert.equal(s.updatedAt, 1000);
  });

  it('ignores "ok" acks and answers printer heart_beat frames', () => {
    assert.deepEqual(parseFrame('ok'), { kind: 'ok' });
    assert.deepEqual(parseFrame('{"ModeCode":"heart_beat"}'), { kind: 'heartbeat' });
    assert.deepEqual(parseFrame('garbage{'), { kind: 'invalid' });
    assert.deepEqual(parseFrame('[1,2]'), { kind: 'invalid' });
  });

  it('does not let frames pollute the prototype', () => {
    const raw: RawPrinterState = {};
    mergeFrame(raw, JSON.parse('{"__proto__":{"polluted":1},"state":1}') as Record<string, unknown>);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(raw.state, 1);
  });

  it('parses firmware from modelVersion', () => {
    const full = JSON.parse(frames[0]!) as Record<string, unknown>;
    assert.equal(parseFirmware(full.modelVersion), '2.3.6.57');
    assert.equal(parseFirmware('printer hw ver:;printer sw ver:1.1.0.5;DWIN sw ver:2.3.6.57;'), '1.1.0.5');
    assert.equal(parseFirmware(undefined), null);
  });

  it('reads the captured boxsInfo (external spool only) and a CFS unit', () => {
    const ext = parseCfs((JSON.parse(fixture('boxsinfo-external-only.json')) as { boxsInfo: unknown }).boxsInfo);
    assert.deepEqual(ext, [
      {
        box: 0, slot: 1, material: 'Generic PLA', color: '#7a92ac', remainingPct: null, type: 'PLA', external: true,
        vendor: 'Generic', name: 'Generic PLA', minTemp: 200, maxTemp: 220, pressureAdvance: 0.02,
        rfid: null, // '00001' is Creality's placeholder
        percent: null, // the external holder always says 100: not a measurement
        selected: false, editStatus: 1,
      },
    ]);
    const cfs = parseCfs({
      materialBoxs: [
        { id: 1, type: 0, materials: [
          { id: 0, vendor: 'Creality', type: 'PLA', name: 'Hyper PLA', color: '#0ffffff', percent: 80, rfid: '1A2B3C4D', selected: 1, minTemp: 190, maxTemp: 230, pressure: 0.04, editStatus: 0 },
          { id: 3, type: '', name: '', color: '', percent: 0, state: 0 },
        ] },
      ],
    });
    assert.deepEqual(cfs, [
      {
        box: 1, slot: 1, material: 'Hyper PLA', color: '#ffffff', remainingPct: 80, type: 'PLA',
        vendor: 'Creality', name: 'Hyper PLA', minTemp: 190, maxTemp: 230, pressureAdvance: 0.04, rfid: '1A2B3C4D', percent: 80, selected: true, editStatus: 0,
      },
      {
        box: 1, slot: 4, material: null, color: null, remainingPct: null, type: null,
        vendor: null, name: null, minTemp: null, maxTemp: null, pressureAdvance: null, rfid: null, percent: null, selected: false, editStatus: null,
      },
    ]);
    assert.equal(parseCfs(undefined), null);
  });

  it('normalises Creality colours', () => {
    assert.equal(normalizeColor('#07a92ac'), '#7a92ac');
    assert.equal(normalizeColor('#FF0000'), '#ff0000');
    assert.equal(normalizeColor('00FF00'), '#00ff00');
    assert.equal(normalizeColor('red'), null);
    // 7/8/9 hex digit forms: pad digit, alpha prefix
    assert.equal(normalizeColor('07a92ac'), '#7a92ac');
    assert.equal(normalizeColor('#FF7A92AC'), '#7a92ac');
    assert.equal(normalizeColor('#0FF7A92AC'), '#7a92ac');
    assert.equal(normalizeColor('#7a92a'), null);
    assert.equal(normalizeColor('#07a92acff1'), null);
  });

  it('parses the printer file list and derives the gcode directory', () => {
    const list = parseFileList(JSON.parse(fixture('gcode-file-list.json')) as Record<string, unknown>)!;
    assert.equal(list.length, 3);
    assert.deepEqual(list[0], {
      name: 'Object_1_PLA_3h40m37s.gcode',
      path: '/usr/data/printer_data/gcodes/Object_1_PLA_3h40m37s.gcode',
      size: 5117963,
    });
    assert.equal(gcodeDirFromList(list), '/usr/data/printer_data/gcodes');
    assert.equal(gcodeDirFromList([{ name: 'a', path: '/mnt/UDISK/printer_data/gcodes/a', size: 1 }]), '/mnt/UDISK/printer_data/gcodes');
    assert.equal(gcodeDirFromList(null), '/usr/data/printer_data/gcodes');
    const old = parseFileList({ retGcodeFileInfo: { fileInfo: '/usr/data/printer_data/gcodes:a.gcode:123:0:0:0;' } });
    assert.deepEqual(old, [{ name: 'a.gcode', path: '/usr/data/printer_data/gcodes/a.gcode', size: 123 }]);
    assert.equal(parseFileList({ state: 1 }), null);
  });
});

describe('K2 SE protocol: state mapping', () => {
  const st = (raw: RawPrinterState) => mapState(raw);
  it('maps every Creality state code', () => {
    const expected = ['idle', 'printing', 'complete', 'failed', 'aborted', 'paused', 'pausing', 'stopping', 'printing'];
    expected.forEach((s, code) => assert.equal(st({ state: code }), s, `code ${code}`));
    assert.equal(st({}), 'idle');
    assert.equal(st({ state: 99 }), 'idle');
  });

  it('reports errors without hiding a running job', () => {
    assert.equal(st({ state: 0, err: { errcode: 2001, key: 1 } }), 'error');
    assert.equal(st({ state: 1, err: { errcode: 2001, key: 1 } }), 'printing');
    const s = toPrinterStatus(1, { state: 5, materialStatus: 1, err: { errcode: 0 } }, true);
    assert.equal(s.state, 'paused');
    assert.equal(s.errorCode, 2839); // runout
    assert.equal(toPrinterStatus(1, { state: 0, repoPlrStatus: 1 }, true).errorCode, 115);
  });

  it('offline and complete/idle shapes', () => {
    const off = toPrinterStatus(3, { state: 1, nozzleTemp: '200.0' }, false, 5);
    assert.equal(off.state, 'offline');
    assert.equal(off.online, false);
    assert.equal(off.nozzleTemp, null);
    const done = toPrinterStatus(1, { state: 2, printProgress: 99, printFileName: '/x/gcodes/a.gcode', TotalLayer: 10, layer: 10 }, true);
    assert.equal(done.progress, 100);
    assert.equal(done.remainingSec, 0);
    assert.equal(done.fileName, 'a.gcode');
    const idle = toPrinterStatus(1, { state: 0, printProgress: 31, printFileName: '/x/gcodes/a.gcode' }, true);
    assert.equal(idle.progress, null);
    assert.equal(idle.fileName, null);
    // dProgress fallback uses ??, so 0 is kept
    assert.equal(toPrinterStatus(1, { state: 1, dProgress: 0 }, true).progress, 0);
  });
});

describe('K2 SE helpers', () => {
  it('builds safe printer file names', () => {
    assert.equal(safePrinterFileName('Benchy: v2 (copy).gcode'), 'Benchy_v2_copy_.gcode');
    assert.equal(safePrinterFileName('Pieza señal.GCODE'), 'Pieza_senal.gcode');
    assert.equal(safePrinterFileName('../../etc/passwd'), 'etc_passwd.gcode');
    assert.equal(safePrinterFileName('::'), 'print.gcode');
  });

  it('recognises upload success bodies', () => {
    assert.ok(uploadAccepted('{"code":200,"message":"OK"}'));
    assert.ok(uploadAccepted('OK'));
    assert.ok(!uploadAccepted('{"code":500}'));
    assert.ok(!uploadAccepted('error'));
  });

  it('simulator multipart parsing and gcode metadata', () => {
    const gcode = '; generated\n;LAYER_CHANGE\nG1\n;LAYER_CHANGE\nG1\n; estimated printing time (normal mode) = 1h 2m 3s\n';
    const boundary = 'XyZ';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.gcode"\r\n\r\n${gcode}\r\n--${boundary}--\r\n`);
    const file = extractMultipartFile(body, `multipart/form-data; boundary=${boundary}`);
    assert.equal(file?.toString(), gcode);
    assert.deepEqual(gcodeMeta(Buffer.from(gcode)), { seconds: 3723, layers: 2 });
  });
});
