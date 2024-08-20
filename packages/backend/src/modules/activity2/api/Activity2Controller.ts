import {
  ActivityApiChart,
  ActivityApiChartPoint,
  ActivityApiCharts,
  ActivityApiResponse,
  ProjectId,
  Result,
  UnixTime,
  json,
} from '@l2beat/shared-pure'

import { Layer2, Layer3, layer2s, layer3s } from '@l2beat/config'
import { Database } from '@l2beat/database'
import { Clock } from '../../../tools/Clock'
import { formatActivityChart } from './formatActivityChart'
import { postprocessCounts } from './postprocessCounts'
import { toCombinedActivity } from './toCombinedActivity'
import {
  DailyTransactionCount,
  DailyTransactionCountProjectsMap,
} from './types'

export type ActivityResult = Result<
  ActivityApiResponse,
  'DATA_NOT_SYNCED' | 'ETHEREUM_DATA_DELAYED'
>

export type AggregatedActivityResult = Result<
  ActivityApiCharts,
  'DATA_NOT_SYNCED' | 'ETHEREUM_DATA_DELAYED'
>

export type MapSlugsToProjectIdsResult = Result<
  ProjectId[],
  'UNKNOWN_PROJECT' | 'NO_TRANSACTION_API' | 'EMPTY_PROJECTS'
>

export class Activity2Controller {
  constructor(
    private readonly projectIds: ProjectId[],
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async getActivity(): Promise<ActivityResult> {
    const dbCounts = await this.getPostprocessedDailyCounts()
    const projectCounts: DailyTransactionCountProjectsMap = new Map()
    let ethereumCounts: DailyTransactionCount[] | undefined

    for (const [projectId, counts] of dbCounts) {
      if (projectId === ProjectId.ETHEREUM) {
        ethereumCounts = counts
        continue
      }
      if (!this.projectIds.includes(projectId)) {
        continue
      }
      projectCounts.set(projectId, counts)
    }

    const { daily: combinedDaily, ...estimationInfo } =
      toCombinedActivity(projectCounts)

    const combinedChartPoints = this.alignActivityData(
      combinedDaily,
      ethereumCounts,
    )

    if (combinedChartPoints.type === 'error') {
      return combinedChartPoints
    }

    const projects: ActivityApiResponse['projects'] = {}
    for (const [projectId, counts] of projectCounts.entries()) {
      const activityAlignmentResult = this.alignActivityData(
        counts,
        ethereumCounts,
      )

      if (activityAlignmentResult.type === 'error') {
        return activityAlignmentResult
      }

      projects[projectId.toString()] = formatActivityChart(
        activityAlignmentResult.data,
      )
    }

    return {
      type: 'success',
      data: {
        combined: {
          ...formatActivityChart(combinedChartPoints.data),
          ...estimationInfo,
        },
        projects,
      },
    }
  }

  async getAggregatedActivity(
    projects: ProjectId[],
  ): Promise<AggregatedActivityResult> {
    const [aggregatedDailyCounts, ethereumCounts] = await Promise.all([
      await this.db.activity.getProjectsAggregatedDailyCount(projects),
      await this.db.activity.getDailyCountsPerProject(ProjectId.ETHEREUM),
    ])
    const now = this.clock.getLastHour().toStartOf('day')

    const processedCounts = postprocessCounts(aggregatedDailyCounts, true, now)
    const processedEthereumCounts = postprocessCounts(ethereumCounts, true, now)

    const chartPoints = this.alignActivityData(
      processedCounts,
      processedEthereumCounts,
    )

    if (chartPoints.type === 'error') {
      return chartPoints
    }

    return {
      type: 'success',
      data: formatActivityChart(chartPoints.data),
    }
  }

  mapSlugsToProjectIds(slugs: string[]): MapSlugsToProjectIdsResult {
    if (slugs.length === 0) {
      return {
        type: 'error',
        error: 'EMPTY_PROJECTS',
      }
    }

    const projects: (Layer2 | Layer3)[] = []
    const allProjects = [...layer2s, ...layer3s]
    for (const s of slugs) {
      const project = allProjects.find((project) => project.display.slug === s)

      if (!project) {
        return {
          type: 'error',
          error: 'UNKNOWN_PROJECT',
        }
      }

      projects.push(project)
    }

    if (!projects.some((p) => p.config.transactionApi)) {
      return {
        type: 'error',
        error: 'NO_TRANSACTION_API',
      }
    }

    return {
      type: 'success',
      data: projects.map((p) => p.id),
    }
  }

  alignActivityData(
    apiChartData: DailyTransactionCount[],
    ethereumChartData: DailyTransactionCount[] = [],
  ): Result<
    ActivityApiChartPoint[],
    'DATA_NOT_SYNCED' | 'ETHEREUM_DATA_DELAYED'
  > {
    const lastProjectTimestamp = apiChartData.at(-1)?.timestamp
    if (!lastProjectTimestamp) {
      // No data in activity chart
      return { type: 'error', error: 'DATA_NOT_SYNCED' }
    }
    const ethChartTimestampIndex = ethereumChartData.findIndex(
      (x) => x.timestamp.toNumber() === lastProjectTimestamp.toNumber(),
    )
    if (ethChartTimestampIndex === -1) {
      return { type: 'error', error: 'ETHEREUM_DATA_DELAYED' }
    }
    const alignedEthChartData = ethereumChartData.slice(
      0,
      ethChartTimestampIndex + 1,
    )
    const length = Math.min(apiChartData.length, alignedEthChartData.length)

    const data: ActivityApiChart['data'] = new Array(length)
      .fill(0)
      .map((_, i) => {
        const apiPoint = apiChartData.at(-length + i)
        const ethPoint = alignedEthChartData.at(-length + i)
        return [
          apiPoint?.timestamp ?? new UnixTime(0),
          apiPoint?.count ?? 0,
          ethPoint?.count ?? 0,
        ]
      })

    return {
      type: 'success',
      data,
    }
  }

  async getStatus() {
    const configurations = await this.db.indexerState.getAll()
    const activityConfigurations = configurations.filter((c) =>
      c.indexerId.includes('activity'),
    )
    const projects = activityConfigurations.map((c) => {
      const projectId = c.indexerId.split('::')[1]
      return {
        projectId,
        includedInApi: this.projectIds.includes(ProjectId(projectId)),
        currentHeight: c.safeHeight,
      }
    })

    return projects.reduce<Record<string, json>>((result, project) => {
      result[project.projectId] = project
      return result
    }, {})
  }

  private async getPostprocessedDailyCounts(): Promise<DailyTransactionCountProjectsMap> {
    const counts = await this.db.activity.getDailyCounts()
    const result: DailyTransactionCountProjectsMap = new Map()
    const today = this.clock.getLastHour().toStartOf('day')

    for (const projectId of this.projectIds) {
      if (!this.projectIds.includes(projectId)) continue

      const projectCounts = counts.filter((c) => c.projectId === projectId)
      if (projectCounts.at(-1)?.timestamp.lt(today.add(-7, 'days'))) continue

      const postprocessedCounts = postprocessCounts(
        projectCounts,
        projectCounts.at(-1)?.timestamp.equals(today) ?? false,
        today,
      )

      // This is needed because currently there is a window between the project being
      // synced_once and the data being available in the materialized view.
      // TODO(imxeno): Remove this check once we change materialized view logic.
      if (postprocessedCounts.length === 0) continue

      result.set(projectId, postprocessedCounts)
    }
    return result
  }
}