import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import {
  DEFECT_STATES,
  DEFECT_TYPES,
  SEVERITIES,
  hasRepairResult,
  type Defect,
  type DefectState,
  type DefectType,
  type Severity
} from '@/types/defect'
import { WORK_ORDER_STATES, defectIdsOf, isOverdue, type WorkOrder, type WorkOrderState } from '@/types/workOrder'
import { defectAreaCm2, percentOf, SEVERITY_WEIGHT } from '@/utils/severity'

/** 报告页 / 导出文件里的一行分布统计 */
export interface ReportDistributionRow {
  label: string
  count: number
  percent: number
}

/** 报告中的单个展向分段 */
export interface ReportSegmentLine {
  segment: Segment
  defectCount: number
  openCount: number
  heavyCount: number
  areaCm2: number
  defects: Defect[]
}

/** 报告中的单片叶片 */
export interface ReportBladeSection {
  blade: Blade
  segments: ReportSegmentLine[]
  defectCount: number
  openCount: number
  heavyCount: number
  areaCm2: number
}

/** 报告中作业单内的一条缺陷（保证每条缺陷都在报告中出现） */
export interface ReportWorkOrderDefect {
  defect: Defect
  segmentIndex: number
  repairRegistered: boolean
}

/** 报告中的作业单行：一张作业单 + 所含全部缺陷 */
export interface ReportWorkOrderLine {
  order: WorkOrder
  bladeSerial: string
  defects: ReportWorkOrderDefect[]
  /** 已登记修复结果的缺陷数 */
  registeredCount: number
  overdue: boolean
}

/** 按机组生成的巡检报告数据结构（同时作为导出 JSON 的结构） */
export interface TurbineReport {
  app: 'gbwindblade'
  kind: 'turbine-inspection-report'
  dbVersion: number
  generatedAt: string
  turbine: {
    id: string
    code: string
    model: string
    hubHeightM: number
    commissionDate: string
    bladeCount: number
  }
  summary: {
    bladeCount: number
    segmentCount: number
    defectCount: number
    openCount: number
    closedCount: number
    heavyCount: number
    heavyPercent: number
    closedPercent: number
    areaCm2: number
    workOrderCount: number
    overdueCount: number
    /** 作业单覆盖的缺陷条数 */
    orderDefectCount: number
    /** 未闭环作业单中尚未登记修复结果的缺陷条数（跟催重点） */
    repairPendingCount: number
    riskScore: number
  }
  severityDist: ReportDistributionRow[]
  typeDist: ReportDistributionRow[]
  stateDist: ReportDistributionRow[]
  blades: ReportBladeSection[]
  workOrders: ReportWorkOrderLine[]
}

/** 报告数据来源：全部模型均由调用方（store）注入，report.ts 保持纯函数 */
export interface ReportSource {
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
}

function distribution(labels: string[], counts: Record<string, number>, total: number): ReportDistributionRow[] {
  return labels.map((label) => ({
    label,
    count: counts[label] ?? 0,
    percent: percentOf(counts[label] ?? 0, total)
  }))
}

/** 按机组汇总缺陷统计并生成导出用的报告数据结构 */
export function buildTurbineReport(
  turbine: TurbineReport['turbine'],
  source: ReportSource,
  dbVersion: number,
  generatedAt = new Date().toISOString()
): TurbineReport {
  const blades = source.blades
    .filter((blade) => blade.turbineId === turbine.id)
    .sort((a, b) => a.serial.localeCompare(b.serial))

  const bladeSections: ReportBladeSection[] = blades.map((blade) => {
    const segments = source.segments
      .filter((segment) => segment.bladeId === blade.id)
      .sort((a, b) => a.index - b.index)
      .map((segment) => {
        const defects = source.defects
          .filter((defect) => defect.segmentId === segment.id)
          .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
        return {
          segment,
          defectCount: defects.length,
          openCount: defects.filter((defect) => defect.state !== '已修复').length,
          heavyCount: defects.filter((defect) => defect.severity === '重度').length,
          areaCm2: defects.reduce((sum, defect) => sum + defectAreaCm2(defect.lengthMm, defect.widthMm), 0),
          defects
        }
      })
    return {
      blade,
      segments,
      defectCount: segments.reduce((sum, line) => sum + line.defectCount, 0),
      openCount: segments.reduce((sum, line) => sum + line.openCount, 0),
      heavyCount: segments.reduce((sum, line) => sum + line.heavyCount, 0),
      areaCm2: segments.reduce((sum, line) => sum + line.areaCm2, 0)
    }
  })

  const defects = bladeSections.flatMap((section) => section.segments.flatMap((line) => line.defects))
  const segmentCount = bladeSections.reduce((sum, section) => sum + section.segments.length, 0)
  const heavyCount = defects.filter((defect) => defect.severity === '重度').length
  const openCount = defects.filter((defect) => defect.state !== '已修复').length
  const areaCm2 = defects.reduce((sum, defect) => sum + defectAreaCm2(defect.lengthMm, defect.widthMm), 0)

  const severityCounts: Record<string, number> = {}
  const typeCounts: Record<string, number> = {}
  const stateCounts: Record<string, number> = {}
  defects.forEach((defect) => {
    severityCounts[defect.severity] = (severityCounts[defect.severity] ?? 0) + 1
    typeCounts[defect.type] = (typeCounts[defect.type] ?? 0) + 1
    stateCounts[defect.state] = (stateCounts[defect.state] ?? 0) + 1
  })

  const defectToSegment = new Map(source.segments.map((segment) => [segment.id, segment]))
  const bladeById = new Map(blades.map((blade) => [blade.id, blade]))
  const defectById = new Map(source.defects.map((defect) => [defect.id, defect]))
  const today = generatedAt.slice(0, 10)

  // 作业单逐条展开所含缺陷：只保留属于本机组叶片的缺陷，单内无本机组缺陷的整单略过
  const workOrders: ReportWorkOrderLine[] = source.workOrders
    .map((order) => {
      const items: ReportWorkOrderDefect[] = []
      let bladeSerial = ''
      defectIdsOf(order).forEach((defectId) => {
        const defect = defectById.get(defectId)
        if (!defect) return
        const segment = defectToSegment.get(defect.segmentId)
        if (!segment) return
        const blade = bladeById.get(segment.bladeId)
        if (!blade) return
        if (bladeSerial === '') bladeSerial = blade.serial
        items.push({
          defect,
          segmentIndex: segment.index,
          repairRegistered: hasRepairResult(defect)
        })
      })
      if (items.length === 0) return null
      items.sort(
        (a, b) => a.segmentIndex - b.segmentIndex || a.defect.positionM - b.defect.positionM
      )
      return {
        order,
        bladeSerial,
        defects: items,
        registeredCount: items.filter((item) => item.repairRegistered).length,
        overdue: isOverdue(order, today)
      }
    })
    .filter((line): line is ReportWorkOrderLine => line !== null)
    .sort((a, b) => a.order.dueDate.localeCompare(b.order.dueDate))

  const closedCount = defects.filter((defect) => defect.state === '已修复').length
  const riskScore = defects.reduce((sum, defect) => sum + SEVERITY_WEIGHT[defect.severity], 0)

  return {
    app: 'gbwindblade',
    kind: 'turbine-inspection-report',
    dbVersion,
    generatedAt,
    turbine,
    summary: {
      bladeCount: blades.length,
      segmentCount,
      defectCount: defects.length,
      openCount,
      closedCount,
      heavyCount,
      heavyPercent: percentOf(heavyCount, defects.length),
      closedPercent: percentOf(closedCount, defects.length),
      areaCm2,
      workOrderCount: workOrders.length,
      overdueCount: workOrders.filter((line) => line.overdue).length,
      orderDefectCount: workOrders.reduce((sum, line) => sum + line.defects.length, 0),
      repairPendingCount: workOrders
        .filter((line) => line.order.state !== '已闭环')
        .reduce((sum, line) => sum + (line.defects.length - line.registeredCount), 0),
      riskScore
    },
    severityDist: distribution(SEVERITIES as string[], severityCounts, defects.length),
    typeDist: distribution(DEFECT_TYPES as string[], typeCounts, defects.length),
    stateDist: distribution(DEFECT_STATES as string[], stateCounts, defects.length),
    blades: bladeSections,
    workOrders
  }
}

export function emptyDistribution(labels: string[]): ReportDistributionRow[] {
  return labels.map((label) => ({ label, count: 0, percent: 0 }))
}

export const DISTRIBUTION_LABELS: {
  severity: Severity[]
  type: DefectType[]
  state: DefectState[]
  order: WorkOrderState[]
} = {
  severity: SEVERITIES,
  type: DEFECT_TYPES,
  state: DEFECT_STATES,
  order: WORK_ORDER_STATES
}

/** 报告纯文本预览（用于「查看导出结构」） */
export function reportToText(report: TurbineReport): string {
  const lines: string[] = []
  lines.push(`风电叶片巡检报告 · ${report.turbine.code}（${report.turbine.model}）`)
  lines.push(`生成时间：${report.generatedAt}`)
  lines.push(`数据结构版本：v${report.dbVersion}（IndexedDB 库 gbwindblade）`)
  lines.push('')
  lines.push('一、总体统计')
  lines.push(
    `  叶片 ${report.summary.bladeCount} 片｜展向分段 ${report.summary.segmentCount} 段｜缺陷 ${report.summary.defectCount} 条`
  )
  lines.push(
    `  未闭环 ${report.summary.openCount} 条｜已修复 ${report.summary.closedCount} 条｜重度 ${report.summary.heavyCount} 条（${report.summary.heavyPercent}%）`
  )
  lines.push(
    `  损伤面积 ${report.summary.areaCm2} cm²｜作业单 ${report.summary.workOrderCount} 张（超期 ${report.summary.overdueCount} 张，覆盖缺陷 ${report.summary.orderDefectCount} 条，待登记修复结果 ${report.summary.repairPendingCount} 条）｜风险分 ${report.summary.riskScore}`
  )
  lines.push('')
  lines.push('二、严重程度分布')
  report.severityDist.forEach((row) => lines.push(`  ${row.label}：${row.count} 条（${row.percent}%）`))
  lines.push('')
  lines.push('三、缺陷类型分布')
  report.typeDist.forEach((row) => lines.push(`  ${row.label}：${row.count} 条（${row.percent}%）`))
  lines.push('')
  lines.push('四、处置状态分布')
  report.stateDist.forEach((row) => lines.push(`  ${row.label}：${row.count} 条（${row.percent}%）`))
  lines.push('')
  lines.push('五、叶片与展向分段明细')
  report.blades.forEach((section) => {
    lines.push(
      `  [叶片 ${section.blade.serial}] 长度 ${section.blade.lengthM} m｜材质 ${section.blade.material}｜分段 ${section.segments.length} 段｜缺陷 ${section.defectCount} 条｜未闭环 ${section.openCount} 条`
    )
    section.segments.forEach((line) => {
      lines.push(
        `    第 ${line.segment.index} 段 ${line.segment.startM}-${line.segment.endM} m｜${line.segment.face}｜翼型 ${line.segment.airfoil}｜剖面图 ${line.segment.sectionImage || '未上传'}｜缺陷 ${line.defectCount} 条`
      )
      line.defects.forEach((defect) => {
        lines.push(
          `      · ${defect.type}（${defect.severity}）${defect.lengthMm}×${defect.widthMm} mm｜${defect.face}｜${defect.positionM} m｜发现 ${defect.foundAt}｜${defect.state}`
        )
      })
    })
  })
  lines.push('')
  lines.push('六、维修作业单')
  if (report.workOrders.length === 0) {
    lines.push('  （暂无作业单）')
  }
  report.workOrders.forEach((line) => {
    lines.push(
      `  #${line.order.id.slice(-6)} 叶片 ${line.bladeSerial}｜${line.order.team}｜限期 ${line.order.dueDate}｜${line.order.state}${
        line.overdue ? '（已超期）' : ''
      }｜验收人 ${line.order.acceptor || '—'}｜修复结果 ${line.registeredCount}/${line.defects.length}`
    )
    line.defects.forEach((item) => {
      lines.push(
        `    · 第 ${item.segmentIndex} 段 ${item.defect.type}（${item.defect.severity}）${item.defect.lengthMm}×${item.defect.widthMm} mm｜${item.defect.positionM} m｜${
          item.repairRegistered ? `已登记：${item.defect.repairResult}` : '待复验（未登记修复结果）'
        }`
      )
    })
  })
  return lines.join('\n')
}

/** 导出文件名 */
export function reportFileName(report: TurbineReport): string {
  const stamp = report.generatedAt.slice(0, 19).replace(/[:T]/g, '')
  return `gbwindblade-${report.turbine.code}-report-v${report.dbVersion}-${stamp}.json`
}
