import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostnameFromHostHeader, isLanHostHeader, isLanSetupRequest, PROXY_HEADERS } from '../src/modules/setup/lan-guard.js';
import { fakeReq } from './helpers.js';

describe('isLanSetupRequest', () => {
  it('allows a LAN socket with a 192.168.x.x Host and no proxy headers', () => {
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: '192.168.8.5:3000' })), true);
  });

  it('allows an IPv4-mapped LAN socket (::ffff:192.168.8.10)', () => {
    assert.equal(isLanSetupRequest(fakeReq('::ffff:192.168.8.10', { host: '192.168.8.5:3000' })), true);
  });

  it('allows loopback with Host localhost / 127.0.0.1 / [::1]', () => {
    assert.equal(isLanSetupRequest(fakeReq('127.0.0.1', { host: 'localhost:5173' })), true);
    assert.equal(isLanSetupRequest(fakeReq('::1', { host: '127.0.0.1:3000' })), true);
    assert.equal(isLanSetupRequest(fakeReq('::1', { host: '[::1]:3000' })), true);
  });

  it('allows IPv6 ULA and link-local sockets', () => {
    assert.equal(isLanSetupRequest(fakeReq('fd12:3456:789a::10', { host: '[fd12:3456:789a::1]:3000' })), true);
    assert.equal(isLanSetupRequest(fakeReq('fe80::1%eth0', { host: 'slicedock.local' })), true);
    assert.equal(isLanSetupRequest(fakeReq('fc00::5', { host: 'slicedock:3000' })), true);
  });

  it('allows *.local, *.lan, *.home.arpa and single-label hostnames', () => {
    for (const host of ['slicedock.local', 'printer.lan:3000', 'nas.home.arpa', 'slicedock', 'nas:8080']) {
      assert.equal(isLanSetupRequest(fakeReq('10.0.0.4', { host })), true, host);
    }
  });

  it('rejects an NPM-proxied request from a LAN IP carrying X-Forwarded-For', () => {
    assert.equal(
      isLanSetupRequest(
        fakeReq('192.168.8.2', { host: '192.168.8.5:3000', 'x-forwarded-for': '192.168.8.10' }),
      ),
      false,
    );
    assert.equal(
      isLanSetupRequest(
        fakeReq('172.17.0.1', {
          host: 'print.example.com',
          'x-forwarded-for': '203.0.113.9',
          'x-forwarded-proto': 'https',
          'x-real-ip': '203.0.113.9',
        }),
      ),
      false,
    );
  });

  it('rejects Cloudflare Tunnel headers even from loopback', () => {
    assert.equal(isLanSetupRequest(fakeReq('127.0.0.1', { host: 'localhost:3000', 'cf-connecting-ip': '198.51.100.1' })), false);
    assert.equal(isLanSetupRequest(fakeReq('127.0.0.1', { host: 'localhost:3000', 'cf-ray': '8a1b2c3d4e5f-MAD' })), false);
    assert.equal(isLanSetupRequest(fakeReq('127.0.0.1', { host: 'localhost:3000', 'cf-visitor': '{"scheme":"https"}' })), false);
  });

  it('rejects every proxy header individually (even when empty)', () => {
    for (const name of PROXY_HEADERS) {
      assert.equal(isLanSetupRequest(fakeReq('192.168.1.2', { host: '192.168.1.1', [name]: '' })), false, name);
      assert.equal(isLanSetupRequest(fakeReq('192.168.1.2', { host: '192.168.1.1', [name]: '10.0.0.1' })), false, name);
    }
  });

  it('rejects a public-domain Host from a LAN socket', () => {
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: 'print.example.com' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: 'print.example.com:443' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: 'localhost.example.com' })), false);
  });

  it('rejects a public IP literal in Host', () => {
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: '203.0.113.7' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: '[2001:db8::1]:3000' })), false);
  });

  it('rejects public socket IPs (v4, v6 and mapped)', () => {
    assert.equal(isLanSetupRequest(fakeReq('203.0.113.7', { host: '192.168.8.5' })), false);
    assert.equal(isLanSetupRequest(fakeReq('::ffff:8.8.8.8', { host: 'localhost' })), false);
    assert.equal(isLanSetupRequest(fakeReq('2001:db8::1', { host: 'localhost' })), false);
    assert.equal(isLanSetupRequest(fakeReq('100.64.0.1', { host: 'localhost' })), false); // CGNAT is not LAN
    assert.equal(isLanSetupRequest(fakeReq('172.32.0.1', { host: 'localhost' })), false); // just outside 172.16/12
  });

  it('rejects missing/unknown socket address and missing/garbage Host', () => {
    assert.equal(isLanSetupRequest(fakeReq(undefined, { host: 'localhost' })), false);
    assert.equal(isLanSetupRequest(fakeReq('garbage', { host: 'localhost' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', {})), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: '' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: 'evil.com/x' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: 'a..local' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: '.local' })), false);
    assert.equal(isLanSetupRequest(fakeReq('192.168.8.10', { host: '1.2.3' })), false);
  });
});

describe('Host header parsing', () => {
  it('extracts hostnames', () => {
    assert.equal(hostnameFromHostHeader('Example.COM:8080'), 'example.com');
    assert.equal(hostnameFromHostHeader('[::1]:3000'), '::1');
    assert.equal(hostnameFromHostHeader('192.168.1.1'), '192.168.1.1');
    assert.equal(hostnameFromHostHeader('slicedock.local.'), 'slicedock.local');
    assert.equal(hostnameFromHostHeader(undefined), null);
  });

  it('classifies LAN hosts', () => {
    assert.equal(isLanHostHeader('10.1.2.3'), true);
    assert.equal(isLanHostHeader('169.254.10.1'), true);
    assert.equal(isLanHostHeader('8.8.8.8'), false);
    assert.equal(isLanHostHeader('foo.lan'), true);
    assert.equal(isLanHostHeader('lan'), true); // single label
    assert.equal(isLanHostHeader('foo.lan.example.com'), false);
  });
});
