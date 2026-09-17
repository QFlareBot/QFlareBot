import type { Manifest } from '@qqbot/sdk'
import type { BaseBindings, DeployManifest, InstalledPlugin, Projection } from '../types.js'

export function makeManifest(overrides: Partial<Manifest> & { name: string }): Manifest {
  return {
    version: '1.0.0',
    apiVersion: 1,
    permissions: [],
    depends: {},
    conflicts: [],
    commands: [],
    regex: [],
    events: [],
    cron: [],
    routes: [],
    hasMiddleware: false,
    services: [],
    durableObjects: [],
    ...overrides,
  }
}

export function makePlugin(
  name: string,
  overrides: Partial<Omit<InstalledPlugin, 'name' | 'manifest'>> & { manifest?: Partial<Manifest> } = {},
): InstalledPlugin {
  const { manifest, ...rest } = overrides
  const version = rest.version ?? '1.0.0'
  return {
    name,
    version,
    source: `npm:@qqbot/plugin-${name}`,
    enabled: true,
    ...rest,
    manifest: makeManifest({ name, version, ...manifest }),
  }
}

/** foo 带 DO 类 Game，bar 无 DO；清单中故意让 foo 排在 bar 之后 */
export function makeDeployManifest(): DeployManifest {
  return {
    core: { version: '0.3.0' },
    plugins: [
      makePlugin('foo', { version: '1.2.0', integrity: 'sha256-Zm9v', manifest: { durableObjects: ['Game'] } }),
      makePlugin('bar', { version: '2.0.0', integrity: 'sha256-YmFy', enabled: false }),
    ],
  }
}

export const bindings: BaseBindings = {
  kv: { binding: 'KV', namespaceId: 'kv-id' },
  d1: { binding: 'DB', databaseId: 'd1-id' },
  r2: { binding: 'R2', bucketName: 'bucket' },
  vars: { ENV: 'prod' },
}

export function makeProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    mainModule: 'index.js',
    modules: { 'index.js': 'export default {}', 'runtime.js': 'export const createRuntime = () => ({})' },
    hash: 'a'.repeat(64),
    metadata: {
      main_module: 'index.js',
      compatibility_date: '2025-09-01',
      bindings: [],
      annotations: { 'workers/message': 'test', 'workers/tag': 'a'.repeat(20) },
    },
    integrity: { core: 'sha256-x', plugins: {} },
    ...overrides,
  }
}
