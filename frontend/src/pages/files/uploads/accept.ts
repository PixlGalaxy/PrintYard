export const ACCEPTED_EXTENSIONS = ['stl', '3mf', 'obj', 'gcode'] as const
/** For <input type="file" accept=…> */
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(',')
export const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
export const isAccepted = (name: string) => (ACCEPTED_EXTENSIONS as readonly string[]).includes(extOf(name))
