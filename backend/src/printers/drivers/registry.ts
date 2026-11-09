import type { PrinterKinematics, PrinterModel, PrinterModelInfo, ProbeResult } from '../../types.js';
import { CrealityK2SEDriver } from './creality-k2se.js';
import type { PrinterDriverClass, ProbeOptions } from './types.js';

export const DRIVERS: Record<PrinterModel, PrinterDriverClass> = {
  'creality-k2se': CrealityK2SEDriver,
};

export const PRINTER_MODELS = Object.keys(DRIVERS) as PrinterModel[];

export function listPrinterModels(): PrinterModelInfo[] {
  return Object.values(DRIVERS).map((d) => d.info);
}

/** Motion system of a model (`unknown` for models no driver knows, e.g. a stale DB row). */
export function kinematicsOf(model: string): PrinterKinematics {
  return (DRIVERS as Record<string, PrinterDriverClass | undefined>)[model]?.info.kinematics ?? 'unknown';
}

export type ProbeFn = (model: PrinterModel, host: string, opts: ProbeOptions) => Promise<ProbeResult>;

export const probePrinter: ProbeFn = (model, host, opts) => DRIVERS[model].probe(host, opts);
