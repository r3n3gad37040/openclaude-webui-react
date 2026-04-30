import { createGenericProxy } from './proxyFactory.js'

export default createGenericProxy({
  pathPrefix: 'nineteen-proxy',
  baseUrl: 'https://api.nineteen.ai/v1',
  providerName: 'Nineteen',
  defaultModel: 'llama-3',
  ownedBy: 'nineteen',
})
