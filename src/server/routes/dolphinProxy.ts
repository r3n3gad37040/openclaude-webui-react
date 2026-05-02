import { createGenericProxy } from './proxyFactory.js'

export default createGenericProxy({
  pathPrefix: 'dolphin-proxy',
  baseUrl: 'https://chat.dolphin.ru/api/v1',
  providerName: 'Dolphin',
  defaultModel: 'dolphin-mixtral',
  ownedBy: 'dolphin',
})
