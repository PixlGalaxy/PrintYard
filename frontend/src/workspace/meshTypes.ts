// Messages between the main thread and mesh.worker.ts

export interface MeshWorkerRequest {
  id: number
  name: string
  buffer: ArrayBuffer
}

export interface WorkerFacet {
  normal: [number, number, number]
  area: number
  /** triangles of the facet (file coordinates), 9 floats per triangle */
  tris: Float32Array
}

export type MeshWorkerResponse =
  | {
      id: number
      ok: true
      positions: Float32Array
      normals: Float32Array
      triangles: number
      volume: number
      min: [number, number, number]
      max: [number, number, number]
      /** convex hull vertices (file coordinates) */
      hull: Float32Array
      facets: WorkerFacet[]
    }
  | { id: number; ok: false; error: string }
