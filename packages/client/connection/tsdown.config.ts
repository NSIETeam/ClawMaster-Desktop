import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-connection', ['lib/types/index.js'], {
  companions: [{
    entry: { 'web-rpc': 'lib/types/web-rpc.js' },
    outDir: 'lib',
    platform: 'node',
    format: ['esm'],
    target: 'es2024',
    dts: false,
    clean: false,
    fixedExtension: false,
  }],
})
