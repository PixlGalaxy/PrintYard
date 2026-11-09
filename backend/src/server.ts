import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { memoryStatus } from './lib/memory.js';
import { hostNetworkLikely } from './lib/network.js';
import { logger, setLogLevel } from './logger.js';
import { AUDIT_RETENTION_MS } from './modules/audit/audit.service.js';
import { isReadOnly } from './printers/read-only.js';

function main(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  logger.info(`SliceDock ${config.version} starting (Node ${process.version})`);

  if (isReadOnly()) {
    logger.warn('READ-ONLY MODE (SLICEDOCK_READ_ONLY=1): printer control is disabled; only status reads are sent to printers');
  }

  const db = openDb(config.dbPath);
  runMigrations(db);
  const ctx = createContext(config, db);

  const mem = memoryStatus();
  if (!mem.ok) {
    logger.warn(`Container memory limit is ${mem.limitBytes} bytes; SliceDock needs more than 1 GiB (2 GiB recommended)`);
  }

  const runHousekeeping = () => {
    try {
      ctx.sessions.purgeExpired();
      ctx.bans.purgeExpired();
      ctx.audit.purgeOlderThan(AUDIT_RETENTION_MS);
    } catch (err) {
      logger.error('Housekeeping failed', err);
    }
  };
  runHousekeeping();
  const housekeeping = setInterval(runHousekeeping, 10 * 60_000);
  housekeeping.unref();

  const app = createApp(ctx);
  const server: Server = app.listen(config.port, config.host, () => {
    logger.info(`Listening on http://${config.host}:${config.port}`);
    logger.info(`App data: ${config.appdataRoot} | Data: ${config.dataRoot}`);
    logger.info(`Setup complete: ${ctx.users.adminExists()} | host network likely: ${hostNetworkLikely()}`);
  });
  // Hardening normally done by a front proxy (nginx): cut slow/idle clients
  // (slowloris) and cap header size. requestTimeout stays generous because
  // large STL/3MF uploads stream through this same server (Phase 3).
  server.headersTimeout = 20_000;
  server.requestTimeout = 10 * 60_000;
  server.keepAliveTimeout = 10_000;
  server.maxHeadersCount = 100;
  ctx.hub.attach(server);
  ctx.printerManager.start();
  ctx.tempHistory.start();
  ctx.engine.startScheduler(() => ctx.slicing.idle()); // B1: engine auto-update
  ctx.notifications.start(); // Phase 4: VAPID keys in /appdata
  ctx.notificationSources.startEnginePoll();
  server.on('error', (err) => {
    logger.error('HTTP server error', err);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    clearInterval(housekeeping);
    ctx.loginGuard.stop();
    ctx.printerManager.stop();
    ctx.tempHistory.stop();
    ctx.engine.stop(); // B1
    ctx.slicing.stop(); // B1
    void ctx.projects.pool.terminate(); // B1: build worker
    ctx.notificationSources.stop(); // Phase 4
    ctx.notifications.stop();
    ctx.hub.close();
    const force = setTimeout(() => {
      logger.warn('Forcing exit after 10 s');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      logger.info('Bye');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
}

try {
  main();
} catch (err) {
  logger.error('Fatal error during startup', err);
  process.exit(1);
}
