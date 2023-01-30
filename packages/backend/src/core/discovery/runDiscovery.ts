import { providers } from 'ethers'

import { DiscoveryConfig } from '../../config/Config'
import { MainnetEtherscanClient } from '../../peripherals/etherscan/MainnetEtherscanClient'
import { ConfigReader } from './ConfigReader'
import { discover } from './discover'
import { DiscoveryLogger } from './DiscoveryLogger'
import { ProviderWithCache } from './provider/ProviderWithCache'
import { saveDiscoveryResult } from './saveDiscoveryResult'

export async function runDiscovery(
  provider: providers.AlchemyProvider,
  etherscanClient: MainnetEtherscanClient,
  configReader: ConfigReader,
  config: DiscoveryConfig,
) {
  const projectConfig = await configReader.readConfig(config.project)

  const blockNumber = config.blockNumber ?? (await provider.getBlockNumber())

  const discoveryProvider = new ProviderWithCache(
    provider,
    etherscanClient,
    blockNumber,
  )

  const logger = new DiscoveryLogger({ enabled: true })

  const result = await discover(discoveryProvider, projectConfig, logger)
  await saveDiscoveryResult(result, config.project, blockNumber)
}
