import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  allDefectsRepaired,
  createEmptyWorkOrderStat,
  isOverdue,
  nextWorkOrderState,
  orderDefectIds,
  pendingDefectIds,
  repairedDefectIds,
  WORK_TEAMS,
  type RepairResult,
  type RepairVerdict,
  type WorkOrder,
  type WorkOrderState,
  type WorkOrderStat
} from '@/types/workOrder'
import type { Defect } from '@/types/defect'
import type { Segment } from '@/types/segment'
import type { Blade } from '@/types/blade'
import type { Turbine } from '@/types/turbine'
import { percentOf } from '@/utils/severity'

/** 作业单内的一条缺陷明细（含分段、复验结论） */
export interface WorkOrderItem {
  defect: Defect | null
  segment: Segment | null
  /** 修复结果登记，未登记为 null */
  result: RepairResult | null
}

/** 工单列表的一行：作业单 + 所含缺陷明细 + 叶片 + 机组 */
export interface WorkOrderRow {
  order: WorkOrder
  items: WorkOrderItem[]
  blade: Blade | null
  turbine: Turbine | null
  /** 所含缺陷条数 */
  defectCount: number
  /** 已登记「已修复」的条数 */
  repairedCount: number
  /** 尚未完成（待复验）条数 */
  pendingCount: number
  /** 限期已过且未闭环 */
  overdue: boolean
}

/** 可派工缺陷候选项（不含工单字段，供派工对话框使用） */
export interface DispatchOption {
  defect: Defect
  segment: Segment | null
  blade: Blade | null
  turbine: Turbine | null
}

export interface DispatchOutcome {
  /** 新建作业单张数 */
  created: number
  /** 改派（更新班组 / 限期）作业单张数 */
  reassigned: number
  /** 涉及缺陷条数 */
  defectCount: number
}

/** 今天的日期（YYYY-MM-DD，本地时区） */
export function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

/**
 * 工单 store：一张作业单覆盖同叶片、同班组、同限期的多条缺陷；
 * 待验收阶段逐条登记修复结果，全部「已修复」才能闭环。
 */
export const useWorkOrderStore = defineStore('workOrder', () => {
  const workOrdersTable = useIdbTable<WorkOrder>((database) => database.workOrders)
  const defectsTable = useIdbTable<Defect>((database) => database.defects, { sortByUpdatedAt: false })
  const segmentsTable = useIdbTable<Segment>((database) => database.segments, { sortByUpdatedAt: false })
  const bladesTable = useIdbTable<Blade>((database) => database.blades, { sortByUpdatedAt: false })
  const turbinesTable = useIdbTable<Turbine>((database) => database.turbines, { sortByUpdatedAt: false })

  const keyword = ref('')
  const teamFilter = ref<string[]>([])
  const stateFilter = ref<WorkOrderState[]>([])
  const onlyOverdue = ref(false)

  const orders = computed<WorkOrder[]>(() => workOrdersTable.rows.value)
  const defects = computed<Defect[]>(() => defectsTable.rows.value)
  const segments = computed<Segment[]>(() => segmentsTable.rows.value)
  const blades = computed<Blade[]>(() => bladesTable.rows.value)
  const turbines = computed<Turbine[]>(() => turbinesTable.rows.value)
  const loading = computed(() => workOrdersTable.loading.value)
  const ordersReady = computed(() => workOrdersTable.ready.value)

  const today = computed(() => todayString())

  const rows = computed<WorkOrderRow[]>(() => {
    const defectMap = new Map(defects.value.map((defect) => [defect.id, defect]))
    const segmentMap = new Map(segments.value.map((segment) => [segment.id, segment]))
    const bladeMap = new Map(blades.value.map((blade) => [blade.id, blade]))
    const turbineMap = new Map(turbines.value.map((turbine) => [turbine.id, turbine]))
    return orders.value.map((order) => {
      const ids = orderDefectIds(order)
      const items: WorkOrderItem[] = ids.map((id) => {
        const defect = defectMap.get(id) ?? null
        const segment = defect ? segmentMap.get(defect.segmentId) ?? null : null
        return { defect, segment, result: order.repairResults?.[id] ?? null }
      })
      // 明细按分段序号、展向位置排序，现场核对时与叶片顺序一致
      items.sort((a, b) => {
        const sa = a.segment?.index ?? 0
        const sb = b.segment?.index ?? 0
        if (sa !== sb) return sa - sb
        return (a.defect?.positionM ?? 0) - (b.defect?.positionM ?? 0)
      })
      const firstSegment = items.find((item) => item.segment)?.segment ?? null
      const blade = firstSegment ? bladeMap.get(firstSegment.bladeId) ?? null : null
      const turbine = blade ? turbineMap.get(blade.turbineId) ?? null : null
      const repairedCount = repairedDefectIds(order).length
      return {
        order,
        items,
        blade,
        turbine,
        defectCount: ids.length,
        repairedCount,
        pendingCount: ids.length - repairedCount,
        overdue: isOverdue(order, today.value)
      }
    })
  })

  /** 按班组与状态筛选，支持关键字与超期开关；关键字命中任意所含缺陷即保留整张单 */
  const filteredRows = computed<WorkOrderRow[]>(() =>
    rows.value.filter((row) => {
      const { order, items, blade, turbine } = row
      const kw = keyword.value.trim()
      if (kw.length > 0) {
        const defectHaystack = items
          .map((item) => `${item.defect?.type ?? ''}${item.defect?.severity ?? ''}${item.result?.verdict ?? ''}`)
          .join('')
        const haystack = `${order.team}${order.state}${order.acceptor}${order.dueDate}${
          blade?.serial ?? ''
        }${turbine?.code ?? ''}${defectHaystack}`
        if (!haystack.includes(kw)) return false
      }
      if (teamFilter.value.length > 0 && !teamFilter.value.includes(order.team)) return false
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(order.state)) return false
      if (onlyOverdue.value && !row.overdue) return false
      return true
    })
  )

  /** 限期升序：越紧急越靠前；已闭环沉底 */
  const sortedRows = computed<WorkOrderRow[]>(() =>
    [...filteredRows.value].sort((a, b) => {
      if (a.order.state === b.order.state) return a.order.dueDate.localeCompare(b.order.dueDate)
      if (a.order.state === '已闭环') return 1
      if (b.order.state === '已闭环') return -1
      return a.order.dueDate.localeCompare(b.order.dueDate)
    })
  )

  const teamOptions = computed<string[]>(() => {
    const used = new Set(orders.value.map((order) => order.team))
    return Array.from(new Set([...WORK_TEAMS, ...used]))
  })

  const stats = computed<WorkOrderStat>(() => {
    if (orders.value.length === 0) return createEmptyWorkOrderStat()
    const closed = orders.value.filter((order) => order.state === '已闭环').length
    // 待复验：待验收作业单里尚未登记「已修复」的缺陷条数（未登记或复验未通过）
    const pendingRepair = rows.value
      .filter((row) => row.order.state === '待验收')
      .reduce((sum, row) => sum + row.pendingCount, 0)
    return {
      total: orders.value.length,
      pending: orders.value.filter((order) => order.state === '待派').length,
      processing: orders.value.filter((order) => order.state === '处理中').length,
      awaiting: orders.value.filter((order) => order.state === '待验收').length,
      closed,
      overdue: rows.value.filter((row) => row.overdue).length,
      pendingRepair,
      closedPercent: percentOf(closed, orders.value.length)
    }
  })

  /** 已被任一作业单覆盖的缺陷 id（以工单表为准，兼容旧 defectId 数据） */
  const dispatchedDefectIds = computed<Set<string>>(() => {
    const set = new Set<string>()
    orders.value.forEach((order) => orderDefectIds(order).forEach((id) => set.add(id)))
    return set
  })

  /** 可派工的缺陷：未修复且尚无作业单覆盖 */
  const dispatchableDefects = computed<DispatchOption[]>(() => {
    const segmentMap = new Map(segments.value.map((segment) => [segment.id, segment]))
    const bladeMap = new Map(blades.value.map((blade) => [blade.id, blade]))
    const turbineMap = new Map(turbines.value.map((turbine) => [turbine.id, turbine]))
    const options: DispatchOption[] = []
    defects.value.forEach((defect) => {
      if (defect.state === '已修复' || dispatchedDefectIds.value.has(defect.id)) return
      const segment = segmentMap.get(defect.segmentId) ?? null
      const blade = segment ? bladeMap.get(segment.bladeId) ?? null : null
      const turbine = blade ? turbineMap.get(blade.turbineId) ?? null : null
      options.push({ defect, segment, blade, turbine })
    })
    return options
  })

  function patchFilter(patch: {
    keyword?: string
    teams?: string[]
    states?: WorkOrderState[]
    onlyOverdue?: boolean
  }): void {
    if (patch.keyword !== undefined) keyword.value = patch.keyword
    if (patch.teams !== undefined) teamFilter.value = patch.teams
    if (patch.states !== undefined) stateFilter.value = patch.states
    if (patch.onlyOverdue !== undefined) onlyOverdue.value = patch.onlyOverdue
  }

  function resetFilters(): void {
    keyword.value = ''
    teamFilter.value = []
    stateFilter.value = []
    onlyOverdue.value = false
  }

  function orderById(id: string): WorkOrder | undefined {
    return orders.value.find((order) => order.id === id)
  }

  /** 覆盖某条缺陷的全部作业单（正常只有一张） */
  function ordersOfDefect(defectId: string): WorkOrder[] {
    return orders.value.filter((order) => orderDefectIds(order).includes(defectId))
  }

  /**
   * 派工：一次派工覆盖同叶片、同班组、同限期的多条缺陷。
   * - 尚无作业单的缺陷：按叶片分组合并，一张叶片只新建一张作业单；
   * - 已在作业单上的缺陷：按「改派」更新该单的班组与限期；
   * - 涉及缺陷统一置为「已派工」。
   */
  async function dispatchDefects(defectIds: string[], team: string, dueDate: string): Promise<DispatchOutcome> {
    const uniqueIds = Array.from(new Set(defectIds))
    const orderMap = new Map(orders.value.map((order) => [order.id, order]))
    const defectMap = new Map(defects.value.map((defect) => [defect.id, defect]))
    const segmentMap = new Map(segments.value.map((segment) => [segment.id, segment]))

    const fresh: string[] = []
    const reassignedOrderIds = new Set<string>()
    uniqueIds.forEach((id) => {
      const existing = orders.value.find((order) => orderDefectIds(order).includes(id))
      if (existing) reassignedOrderIds.add(existing.id)
      else fresh.push(id)
    })

    // 改派：每张受影响作业单只更新一次
    for (const orderId of reassignedOrderIds) {
      const order = orderMap.get(orderId)
      if (order) await workOrdersTable.update(orderId, { team, dueDate })
    }

    // 新缺陷按叶片分组：同叶片合并为一张作业单
    const byBlade = new Map<string, string[]>()
    fresh.forEach((id) => {
      const defect = defectMap.get(id)
      const segment = defect ? segmentMap.get(defect.segmentId) : undefined
      const bladeKey = segment ? `b:${segment.bladeId}` : `n:${id}`
      const list = byBlade.get(bladeKey) ?? []
      list.push(id)
      byBlade.set(bladeKey, list)
    })
    for (const ids of byBlade.values()) {
      await workOrdersTable.create(
        {
          defectIds: ids,
          repairResults: {},
          team,
          dueDate,
          state: '待派',
          acceptor: '',
          closedAt: null
        },
        'wo'
      )
    }

    for (const id of uniqueIds) {
      const defect = defectMap.get(id)
      if (defect && defect.state !== '已修复') await defectsTable.update(id, { state: '已派工' })
    }

    return { created: byBlade.size, reassigned: reassignedOrderIds.size, defectCount: uniqueIds.length }
  }

  async function updateWorkOrder(id: string, patch: Partial<WorkOrder>): Promise<void> {
    await workOrdersTable.update(id, patch)
  }

  /** 状态推进：待派 → 处理中 → 待验收（闭环需走验收登记） */
  async function advanceState(id: string): Promise<WorkOrderState | null> {
    const order = orderById(id)
    if (!order) return null
    const next = nextWorkOrderState(order.state)
    if (!next || next === '已闭环') return null
    await workOrdersTable.update(id, { state: next })
    return next
  }

  /**
   * 待验收阶段登记一条或多条缺陷的修复结果：
   * 「已修复」回写缺陷为已修复；「未通过 / 未登记」缺陷保持已派工，留在待复验。
   */
  async function registerRepairResults(
    id: string,
    entries: Array<{ defectId: string; verdict: RepairVerdict; note?: string }>
  ): Promise<void> {
    const order = orderById(id)
    if (!order || order.state !== '待验收') return
    const ids = new Set(orderDefectIds(order))
    const repairResults: Record<string, RepairResult> = { ...(order.repairResults ?? {}) }
    const now = Date.now()
    for (const entry of entries) {
      if (!ids.has(entry.defectId)) continue
      repairResults[entry.defectId] = {
        defectId: entry.defectId,
        verdict: entry.verdict,
        note: entry.note ?? '',
        registeredAt: now
      }
    }
    await workOrdersTable.update(id, { repairResults })
    for (const entry of entries) {
      if (!ids.has(entry.defectId)) continue
      await defectsTable.update(entry.defectId, {
        state: entry.verdict === '已修复' ? '已修复' : '已派工'
      })
    }
  }

  /** 验收闭环：仅当所有缺陷都已登记「已修复」才置为已闭环，返回是否成功与剩余条数 */
  async function acceptOrder(
    id: string,
    acceptor: string
  ): Promise<{ ok: boolean; pendingCount: number }> {
    const order = orderById(id)
    if (!order) return { ok: false, pendingCount: 0 }
    const pending = pendingDefectIds(order).length
    if (pending > 0) return { ok: false, pendingCount: pending }
    await workOrdersTable.update(id, {
      state: '已闭环',
      acceptor: acceptor.trim(),
      closedAt: Date.now()
    })
    return { ok: true, pendingCount: 0 }
  }

  /** 撤回验收：已闭环 → 待验收，清空逐条结论，所含缺陷一起回到「已派工」 */
  async function reopenOrder(id: string): Promise<void> {
    const order = orderById(id)
    if (!order) return
    const ids = orderDefectIds(order)
    await workOrdersTable.update(id, { state: '待验收', closedAt: null, repairResults: {} })
    for (const defectId of ids) {
      await defectsTable.update(defectId, { state: '已派工' })
    }
  }

  /**
   * 编辑作业单（班组 / 限期 / 状态 / 验收人）。
   * 手工改为「已闭环」时自动给未登记缺陷补登「已修复」并回写；
   * 从「已闭环」改回非闭环则清空结论，缺陷回到「已派工」。
   */
  async function editOrder(
    id: string,
    patch: { team: string; dueDate: string; state: WorkOrderState; acceptor: string }
  ): Promise<void> {
    const order = orderById(id)
    if (!order) return
    const ids = orderDefectIds(order)
    const wasClosed = order.state === '已闭环'
    const next: Partial<WorkOrder> = {
      team: patch.team,
      dueDate: patch.dueDate,
      state: patch.state,
      acceptor: patch.state === '已闭环' ? patch.acceptor.trim() : ''
    }
    if (patch.state === '已闭环') {
      const repairResults: Record<string, RepairResult> = { ...(order.repairResults ?? {}) }
      const now = Date.now()
      ids.forEach((defectId) => {
        if (repairResults[defectId]?.verdict !== '已修复') {
          repairResults[defectId] = {
            defectId,
            verdict: '已修复',
            note: '编辑作业单手工闭环补登',
            registeredAt: now
          }
        }
      })
      next.repairResults = repairResults
      next.closedAt = order.closedAt ?? now
    } else {
      next.closedAt = null
      if (wasClosed) next.repairResults = {}
    }
    await workOrdersTable.update(id, next)
    for (const defectId of ids) {
      if (patch.state === '已闭环') {
        await defectsTable.update(defectId, { state: '已修复' })
      } else if (wasClosed) {
        await defectsTable.update(defectId, { state: '已派工' })
      }
    }
  }

  /** 撤掉作业单：删除单据，所含缺陷恢复「未派工（待处理）」 */
  async function removeWorkOrder(id: string): Promise<void> {
    const order = orderById(id)
    if (!order) return
    const ids = orderDefectIds(order)
    await workOrdersTable.remove(id)
    for (const defectId of ids) {
      // 该缺陷没有其它作业单覆盖时才恢复未派工
      const stillCovered = orders.value.some(
        (item) => item.id !== id && orderDefectIds(item).includes(defectId)
      )
      if (!stillCovered) await defectsTable.update(defectId, { state: '待处理' })
    }
  }

  /** 单张作业单是否已满足闭环条件（页面按钮状态使用） */
  function canClose(order: WorkOrder): boolean {
    return allDefectsRepaired(order)
  }

  return {
    orders,
    defects,
    segments,
    blades,
    turbines,
    loading,
    ordersReady,
    keyword,
    teamFilter,
    stateFilter,
    onlyOverdue,
    today,
    rows,
    filteredRows,
    sortedRows,
    teamOptions,
    stats,
    dispatchableDefects,
    patchFilter,
    resetFilters,
    orderById,
    ordersOfDefect,
    dispatchDefects,
    updateWorkOrder,
    advanceState,
    registerRepairResults,
    acceptOrder,
    reopenOrder,
    editOrder,
    removeWorkOrder,
    canClose
  }
})
