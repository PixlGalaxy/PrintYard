import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHttpsRequest, resolveClientIp, type ExposureConfig } from '../src/lib/client-ip.js';
import { isPrivateIp, isValidCidr, normalizeIp } from '../src/lib/ip.js';
import { fakeReq } from './helpers.js';

const none: ExposureConfig = { mode: 'none', trustedProxies: [] };
const cf: ExposureConfig = { mode: 'cloudflare', trustedProxies: [] };
const nginx: ExposureConfig = { mode: 'nginx', trustedProxies: [] };
const other: ExposureConfig = { mode: 'other', trustedProxies: [] };

describe('normalizeIp / isPrivateIp', () => {
  it('normalises socket and header formats', () => {
    assert.equal(normalizeIp('::ffff:192.168.8.10'), '192.168.8.10');
    assert.equal(normalizeIp('::FFFF:c0a8:080a'), '192.168.8.10');
    assert.equal(normalizeIp('[::1]:443'), '::1');
    assert.equal(normalizeIp('1.2.3.4:80'), '1.2.3.4');
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
    assert.equal(normalizeIp(' "10.0.0.1" '), '10.0.0.1');
    assert.equal(normalizeIp('unknown'), null);
    assert.equal(normalizeIp(''), null);
  });

  it('knows the private ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.1.1.1']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '::ffff:1.1.1.1', 'nope']) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });

  it('validates CIDRs', () => {
    assert.equal(isValidCidr('10.0.0.0/8'), true);
    assert.equal(isValidCidr('192.168.1.1'), true);
    assert.equal(isValidCidr('fd00::/8'), true);
    assert.equal(isValidCidr('10.0.0.0/33'), false);
    assert.equal(isValidCidr('10.0.0.0/8/1'), false);
    assert.equal(isValidCidr('example.com'), false);
  });
});

describe('resolveClientIp', () => {
  it('mode none: always the socket, headers ignored', () => {
    assert.equal(resolveClientIp(fakeReq('192.168.1.5', { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }), none), '192.168.1.5');
    assert.equal(resolveClientIp(fakeReq('::ffff:192.168.1.5'), none), '192.168.1.5');
  });

  it('mode cloudflare: CF-Connecting-IP only from a private/loopback socket', () => {
    assert.equal(resolveClientIp(fakeReq('172.17.0.1', { 'cf-connecting-ip': '198.51.100.1' }), cf), '198.51.100.1');
    assert.equal(resolveClientIp(fakeReq('203.0.113.5', { 'cf-connecting-ip': '198.51.100.1' }), cf), '203.0.113.5');
    assert.equal(resolveClientIp(fakeReq('127.0.0.1', { 'cf-connecting-ip': 'garbage' }), cf), '127.0.0.1');
    assert.equal(resolveClientIp(fakeReq('127.0.0.1'), cf), '127.0.0.1');
  });

  it('mode nginx: right-most X-Forwarded-For, else X-Real-IP, only from a trusted socket', () => {
    // XFF (appended by the proxy) wins over a client-supplied X-Real-IP forwarded untouched
    assert.equal(resolveClientIp(fakeReq('172.18.0.2', { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }), nginx), '203.0.113.9');
    assert.equal(resolveClientIp(fakeReq('192.168.1.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), nginx), '203.0.113.9');
    assert.equal(resolveClientIp(fakeReq('192.168.1.2', { 'x-real-ip': '203.0.113.9' }), nginx), '203.0.113.9');
    assert.equal(resolveClientIp(fakeReq('8.8.4.4', { 'x-real-ip': '203.0.113.9' }), nginx), '8.8.4.4');
    assert.equal(resolveClientIp(fakeReq('192.168.1.2', { 'x-forwarded-for': 'bogus' }), nginx), '192.168.1.2');
  });

  it('cloudflare and nginx honour exposure.trustedProxies when set', () => {
    const pinnedCf: ExposureConfig = { mode: 'cloudflare', trustedProxies: ['172.18.0.5/32'] };
    assert.equal(resolveClientIp(fakeReq('172.18.0.5', { 'cf-connecting-ip': '198.51.100.1' }), pinnedCf), '198.51.100.1');
    // another LAN host can no longer spoof CF-Connecting-IP
    assert.equal(resolveClientIp(fakeReq('192.168.1.77', { 'cf-connecting-ip': '8.8.8.8' }), pinnedCf), '192.168.1.77');
    const pinnedNginx: ExposureConfig = { mode: 'nginx', trustedProxies: ['10.0.0.1'] };
    assert.equal(resolveClientIp(fakeReq('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), pinnedNginx), '203.0.113.9');
    assert.equal(resolveClientIp(fakeReq('10.0.0.2', { 'x-forwarded-for': '203.0.113.9' }), pinnedNginx), '10.0.0.2');
    assert.equal(isHttpsRequest(fakeReq('10.0.0.2', { 'x-forwarded-proto': 'https' }), pinnedNginx), false);
    assert.equal(isHttpsRequest(fakeReq('10.0.0.1', { 'x-forwarded-proto': 'https' }), pinnedNginx), true);
  });

  it('mode other: walks X-Forwarded-For right-to-left skipping trusted proxies', () => {
    // default trust = private ranges
    assert.equal(resolveClientIp(fakeReq('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.3' }), other), '203.0.113.9');
    assert.equal(resolveClientIp(fakeReq('10.0.0.2', { 'x-forwarded-for': '192.168.1.50, 10.0.0.3' }), other), '192.168.1.50');
    // untrusted socket: header ignored
    assert.equal(resolveClientIp(fakeReq('8.8.8.8', { 'x-forwarded-for': '1.1.1.1' }), other), '8.8.8.8');
    // explicit list: only 10.0.0.2 is trusted → 10.0.0.3 counts as the client
    const strict: ExposureConfig = { mode: 'other', trustedProxies: ['10.0.0.2/32'] };
    assert.equal(resolveClientIp(fakeReq('10.0.0.2', { 'x-forwarded-for': '203.0.113.9, 10.0.0.3' }), strict), '10.0.0.3');
    assert.equal(resolveClientIp(fakeReq('10.0.0.5', { 'x-forwarded-for': '203.0.113.9' }), strict), '10.0.0.5');
    // garbage entry stops the walk at the last verified hop
    assert.equal(resolveClientIp(fakeReq('10.0.0.2', { 'x-forwarded-for': '203.0.113.9, junk, 10.0.0.3' }), other), '10.0.0.3');
  });

  it('isHttpsRequest honours X-Forwarded-Proto only from trusted proxies', () => {
    assert.equal(isHttpsRequest(fakeReq('192.168.1.2', { 'x-forwarded-proto': 'https' }), none), false);
    assert.equal(isHttpsRequest(fakeReq('192.168.1.2', { 'x-forwarded-proto': 'https' }), nginx), true);
    assert.equal(isHttpsRequest(fakeReq('8.8.8.8', { 'x-forwarded-proto': 'https' }), nginx), false);
    assert.equal(isHttpsRequest(fakeReq('127.0.0.1', { 'x-forwarded-proto': 'http' }), cf), false);
    assert.equal(isHttpsRequest({ socket: { remoteAddress: '8.8.8.8', encrypted: true }, headers: {} }, none), true);
  });
});
