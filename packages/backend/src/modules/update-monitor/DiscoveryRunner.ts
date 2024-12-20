import { Logger } from '@l2beat/backend-tools'
import {
  AllProviders,
  ConfigReader,
  DiscoveryConfig,
  DiscoveryEngine,
  DiscoveryLogger,
  flattenDiscoveredSources,
  toDiscoveryOutput,
} from '@l2beat/discovery'
import type { DiscoveryOutput } from '@l2beat/discovery-types'
import {
  AllProviderStats,
  ProviderMeasurement,
  ProviderStats,
} from '@l2beat/discovery/dist/discovery/provider/Stats'
import { assert } from '@l2beat/shared-pure'
import { isError } from 'lodash'
import { Gauge } from 'prom-client'

export interface DiscoveryRunnerOptions {
  logger: Logger
  injectInitialAddresses: boolean
  maxRetries?: number
  retryDelayMs?: number
}

export interface DiscoveryRunResult {
  discovery: DiscoveryOutput
  flatSources: Record<string, string>
}

// 10 minutes
const MAX_RETRIES = 30
const RETRY_DELAY_MS = 20_000

export class DiscoveryRunner {
  constructor(
    private readonly allProviders: AllProviders,
    private readonly discoveryEngine: DiscoveryEngine,
    private readonly configReader: ConfigReader,
    readonly chain: string,
  ) {}

  async getBlockNumber(): Promise<number> {
    return await this.allProviders.getLatestBlockNumber(this.chain)
  }

  async run(
    projectConfig: DiscoveryConfig,
    blockNumber: number,
    options: DiscoveryRunnerOptions,
  ): Promise<DiscoveryRunResult> {
    const config = options.injectInitialAddresses
      ? await this.updateInitialAddresses(projectConfig)
      : projectConfig

    return await this.discoverWithRetry(
      config,
      blockNumber,
      options.logger,
      options.maxRetries,
      options.retryDelayMs,
    )
  }

  private async discover(
    config: DiscoveryConfig,
    blockNumber: number,
  ): Promise<DiscoveryRunResult> {
    const provider = this.allProviders.get(config.chain, blockNumber)
    const result = await this.discoveryEngine.discover(provider, config)

    setDiscoveryMetrics(this.allProviders.getStats(config.chain), config.chain)

    const discovery = toDiscoveryOutput(
      config.name,
      config.chain,
      config.hash,
      blockNumber,
      result,
    )

    const flatSources = flattenDiscoveredSources(result, DiscoveryLogger.SILENT)

    return { discovery, flatSources }
  }

  async discoverWithRetry(
    config: DiscoveryConfig,
    blockNumber: number,
    logger: Logger,
    maxRetries = MAX_RETRIES,
    delayMs = RETRY_DELAY_MS,
  ): Promise<DiscoveryRunResult> {
    let result: DiscoveryRunResult | undefined = undefined
    let err: Error | undefined = undefined

    for (let i = 0; i <= maxRetries; i++) {
      try {
        result = await this.discover(config, blockNumber)
        break
      } catch (error) {
        err = isError(err) ? (error as Error) : new Error(JSON.stringify(error))
      }

      const errorString = JSON.stringify(
        err,
        Object.getOwnPropertyNames(err),
        2,
      )
      logger.warn(
        `DiscoveryRunner: Retrying ${config.name} (chain: ${config.chain}) | attempt:${i} | error:${errorString}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    if (result?.discovery === undefined) {
      assert(
        err !== undefined,
        'Programmer error: Error should not be undefined there',
      )
      throw err
    }

    return result
  }

  // There was a case connected with Amarok (better described in L2B-1521)
  // the problem was with stack too deep in the discovery caused by misconfigured new contract
  // that had a lot of relatives (e.g. Uniswap, DAI)
  // unfortunately, it resulted in not discovering important contracts because they cannot be put on the stack
  // this function ensures that initial addresses are taken from discovered.json
  // so this way we will always discover "known" contracts
  async updateInitialAddresses(config: DiscoveryConfig) {
    const discovery = this.configReader.readDiscovery(config.name, this.chain)
    const initialAddresses = discovery.contracts.map((c) => c.address)
    return new DiscoveryConfig({
      ...config.raw,
      initialAddresses,
      maxAddresses: (config.raw.maxAddresses ?? 200) * 3,
      maxDepth: (config.raw.maxDepth ?? 6) * 3,
    })
  }
}

function setDiscoveryMetrics(stats: AllProviderStats, chain: string) {
  setProviderGauge(
    lowLevelProviderCountGauge,
    lowLevelProviderDurationGauge,
    stats.lowLevelMeasurements,
    chain,
  )
  setProviderGauge(
    cacheProviderCountGauge,
    cacheProviderDurationGauge,
    stats.cacheMeasurements,
    chain,
  )
  setProviderGauge(
    highLevelProviderCountGauge,
    highLevelProviderDurationGauge,
    stats.highLevelMeasurements,
    chain,
  )
}

function setProviderGauge(
  countGauge: ProviderGauge,
  durationGauge: ProviderGauge,
  stats: ProviderStats,
  chain: string,
) {
  for (const [key, index] of Object.entries(ProviderMeasurement)) {
    const entry = stats.get(index)
    let avg = 0
    if (entry.durations.length > 0) {
      avg = entry.durations.reduce((acc, v) => acc + v) / entry.durations.length
    }

    countGauge.set({ chain: chain, method: key }, entry.count)
    durationGauge.set({ chain: chain, method: key }, avg)
  }
}

type ProviderGauge = Gauge<'chain' | 'method'>
const lowLevelProviderCountGauge: ProviderGauge = new Gauge({
  name: 'update_monitor_low_level_provider_stats',
  help: 'Low level provider calls done during discovery',
  labelNames: ['chain', 'method'],
})
const lowLevelProviderDurationGauge: ProviderGauge = new Gauge({
  name: 'update_monitor_low_level_provider_duration_stats',
  help: 'Average duration of methods in low level provider calls done during discovery',
  labelNames: ['chain', 'method'],
})

const cacheProviderCountGauge: ProviderGauge = new Gauge({
  name: 'update_monitor_cache_provider_stats',
  help: 'Cache hit counts done during discovery',
  labelNames: ['chain', 'method'],
})
const cacheProviderDurationGauge: ProviderGauge = new Gauge({
  name: 'update_monitor_cache_provider_duration_stats',
  help: 'Average duration of methods when a cache hit occurs during discovery',
  labelNames: ['chain', 'method'],
})

const highLevelProviderCountGauge: ProviderGauge = new Gauge({
  name: 'update_monitor_high_level_provider_stats',
  help: 'High level provider calls done during discovery',
  labelNames: ['chain', 'method'],
})
const highLevelProviderDurationGauge: ProviderGauge = new Gauge({
  name: 'update_monitor_high_level_provider_duration_stats',
  help: 'Average duration of methods in high level provider calls done during discovery',
  labelNames: ['chain', 'method'],
})
