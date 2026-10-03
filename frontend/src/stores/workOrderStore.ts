import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createEmptyWorkOrderStat,
  defectIdsOf,
  isOverdue,
  nextWorkOrderState,
  WORK_TEAMS,
  type WorkOrder,
  type WorkOrderState,
  type WorkOrderStat
} from '@/types/workOrder'
import { hasRepairResult, type Defect } from '@/types/defect'
import type { Segment } from '@/types/segment'
import type { Blade } from '@/types/blade'
import type { Turbine } from '@/types/turbine'
import { percentOf } from '@/utils/severity'

/** 作业单内的一条缺陷（附所属分段） */
export interface WorkOrderItem {
  defect: Defect
  segment: Segment | null
}

/** 工单列表的一行：作业单 + 所含缺陷 + 叶片 + 机组 */
export interface WorkOrderRow {
  order: WorkOrder
  items: WorkOrderItem[]
  blade: Blade | null
  turbine: Turbine | null
  /** 限期已过且未闭环 */
  overdue: boolean
  /** 已登记修复结果的缺陷数 */
  registeredCount: number
  /** 所含缺陷全部登记了修复结果，可以验收闭环 */
  readyToClose: boolean
}

/** 可派工缺陷候选项（不含工单字段，供派工下拉框使用） */
export interface DispatchOption {
  defect: Defect
  segment: Segment | null
  blade: Blade | null
  turbine: Turbine | null
}

/** 一次派工的结果：按叶片分组生成的作业单与覆盖的缺陷数 */
export interface DispatchResult {
  orders: WorkOrder[]
  defectCount: number
}

/** 验收闭环结果：missing 为尚未登记修复结果的缺陷 id */
export interface AcceptResult {
  ok: boolean
  missing: string[]
}

/** 今天的日期（YYYY-MM-DD，本地时区） */
export function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

/**
 * 工单 store：维护维修作业单的状态流转与验收记录。
 * 一张作业单覆盖同叶片、同班组、同限期的多条缺陷；
 * 所含缺陷全部登记修复结果后才能闭环，闭环 / 撤回时整单缺陷同步回写。
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

  /** 已被作业单覆盖的缺陷 id 集合 */
  const dispatchedDefectIds = computed<Set<string>>(() => {
    const set = new Set<string>()
    orders.value.forEach((order) => {
      defectIdsOf(order).forEach((id) => set.add(id))
    })
    return set
  })

  const rows = computed<WorkOrderRow[]>(() => {
    const defectMap = new Map(defects.value.map((defect) => [defect.id, defect]))
    const segmentMap = new Map(segments.value.map((segment) => [segment.id, segment]))
    const bladeMap = new Map(blades.value.map((blade) => [blade.id, blade]))
    const turbineMap = new Map(turbines.value.map((turbine) => [turbine.id, turbine]))
    return orders.value.map((order) => {
      const items: WorkOrderItem[] = []
      defectIdsOf(order).forEach((defectId) => {
        const defect = defectMap.get(defectId)
        if (!defect) return
        items.push({ defect, segment: segmentMap.get(defect.segmentId) ?? null })
      })
      // 作业单内缺陷同属一片叶片，叶片 / 机组取第一条缺陷的归属
      const firstSegment = items[0]?.segment ?? null
      const blade = firstSegment ? bladeMap.get(firstSegment.bladeId) ?? null : null
      const turbine = blade ? turbineMap.get(blade.turbineId) ?? null : null
      const registeredCount = items.filter((item) => hasRepairResult(item.defect)).length
      return {
        order,
        items,
        blade,
        turbine,
        overdue: isOverdue(order, today.value),
        registeredCount,
        readyToClose: items.length > 0 && registeredCount === items.length
      }
    })
  })

  /** 按班组与状态筛选，支持关键字与超期开关；关键字命中任一所含缺陷即保留 */
  const filteredRows = computed<WorkOrderRow[]>(() =>
    rows.value.filter((row) => {
      const { order, items, blade, turbine } = row
      const kw = keyword.value.trim()
      if (kw.length > 0) {
        const defectText = items.map((item) => `${item.defect.type}${item.defect.severity}`).join('')
        const haystack = `${order.team}${order.state}${order.acceptor}${order.dueDate}${defectText}${
          blade?.serial ?? ''
        }${turbine?.code ?? ''}`
        if (!haystack.includes(kw)) return false
      }
      if (teamFilter.value.length > 0 && !teamFilter.value.includes(order.team)) return false
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(order.state)) return false
      if (onlyOverdue.value && !row.overdue) return false
      return true
    })
  )

  /** 限期升序：越紧急越靠前，已闭环沉底 */
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
    return {
      total: orders.value.length,
      pending: orders.value.filter((order) => order.state === '待派').length,
      processing: orders.value.filter((order) => order.state === '处理中').length,
      awaiting: orders.value.filter((order) => order.state === '待复验').length,
      closed,
      overdue: rows.value.filter((row) => row.overdue).length,
      closedPercent: percentOf(closed, orders.value.length)
    }
  })

  /** 可派工的缺陷：未修复且未被任何作业单覆盖（以缺陷表为准，不能以工单行为准） */
  const dispatchableDefects = computed<DispatchOption[]>(() => {
    const dispatched = dispatchedDefectIds.value
    const segmentMap = new Map(segments.value.map((segment) => [segment.id, segment]))
    const bladeMap = new Map(blades.value.map((blade) => [blade.id, blade]))
    const turbineMap = new Map(turbines.value.map((turbine) => [turbine.id, turbine]))
    const options: DispatchOption[] = []
    defects.value.forEach((defect) => {
      if (defect.state === '已修复' || dispatched.has(defect.id)) return
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

  function ordersOfDefect(defectId: string): WorkOrder[] {
    return orders.value.filter((order) => defectIdsOf(order).includes(defectId))
  }

  /** 批量置缺陷状态并同步 updatedAt */
  async function patchDefectStates(
    defectIds: string[],
    state: Defect['state'],
    resetRepair: boolean
  ): Promise<void> {
    if (defectIds.length === 0) return
    const now = Date.now()
    await db.defects
      .where('id')
      .anyOf(defectIds)
      .modify((defect) => {
        defect.state = state
        if (resetRepair) {
          defect.repairResult = ''
          defect.repairedAt = null
        }
        defect.updatedAt = now
      })
  }

  /**
   * 派工建单：把同一叶片的多条缺陷合成一张作业单（待派），
   * 所含缺陷置为「已派工」并清空修复结果登记。
   */
  async function dispatchGroup(
    defectIds: string[],
    team: string,
    dueDate: string
  ): Promise<WorkOrder | null> {
    const dispatched = dispatchedDefectIds.value
    const ids = defectIds.filter((id) => {
      const defect = defects.value.find((item) => item.id === id)
      return defect !== undefined && defect.state !== '已修复' && !dispatched.has(id)
    })
    if (ids.length === 0) return null
    const order = await workOrdersTable.create(
      {
        defectIds: ids,
        team,
        dueDate,
        state: '待派',
        acceptor: '',
        closedAt: null
      },
      'wo'
    )
    await patchDefectStates(ids, '已派工', true)
    return order
  }

  /**
   * 批量派工：按叶片分组，同叶片、同班组、同限期的缺陷合成一张作业单。
   * 返回生成的作业单与覆盖的缺陷数。
   */
  async function dispatchMany(
    defectIds: string[],
    team: string,
    dueDate: string
  ): Promise<DispatchResult> {
    const defectMap = new Map(defects.value.map((defect) => [defect.id, defect]))
    const segmentMap = new Map(segments.value.map((segment) => [segment.id, segment]))
    const groups = new Map<string, string[]>()
    defectIds.forEach((id) => {
      const defect = defectMap.get(id)
      const segment = defect ? segmentMap.get(defect.segmentId) : undefined
      // 同叶片归为一组；归属信息缺失的缺陷各自成组，避免误并单
      const key = segment?.bladeId ?? segment?.id ?? id
      const list = groups.get(key) ?? []
      list.push(id)
      groups.set(key, list)
    })
    const created: WorkOrder[] = []
    for (const ids of groups.values()) {
      const order = await dispatchGroup(ids, team, dueDate)
      if (order) created.push(order)
    }
    return {
      orders: created,
      defectCount: created.reduce((sum, order) => sum + defectIdsOf(order).length, 0)
    }
  }

  async function updateWorkOrder(id: string, patch: Partial<WorkOrder>): Promise<void> {
    const before = orderById(id)
    await workOrdersTable.update(id, patch)
    // 手工改状态时同步整单缺陷：闭环 → 已修复；从闭环改回 → 已派工
    if (!before || patch.state === undefined || patch.state === before.state) return
    const ids = defectIdsOf(before)
    if (patch.state === '已闭环') {
      await patchDefectStates(ids, '已修复', false)
    } else if (before.state === '已闭环') {
      await patchDefectStates(ids, '已派工', false)
    }
  }

  /** 状态推进：待派 → 处理中 → 待复验（闭环需走验收） */
  async function advanceState(id: string): Promise<WorkOrderState | null> {
    const order = orderById(id)
    if (!order) return null
    const next = nextWorkOrderState(order.state)
    if (!next || next === '已闭环') return null
    await workOrdersTable.update(id, { state: next })
    return next
  }

  /** 登记某条缺陷的修复结果（覆盖式，可反复修改） */
  async function registerRepairResult(defectId: string, result: string): Promise<void> {
    await defectsTable.update(defectId, {
      repairResult: result.trim(),
      repairedAt: Date.now()
    })
  }

  /** 验收闭环：所含缺陷全部登记修复结果才允许闭环，闭环后整单缺陷回写「已修复」 */
  async function acceptOrder(id: string, acceptor: string): Promise<AcceptResult> {
    const order = orderById(id)
    if (!order) return { ok: false, missing: [] }
    const ids = defectIdsOf(order)
    const missing = ids.filter((defectId) => {
      const defect = defects.value.find((item) => item.id === defectId)
      return defect !== undefined && !hasRepairResult(defect)
    })
    if (missing.length > 0) return { ok: false, missing }
    await workOrdersTable.update(id, {
      state: '已闭环',
      acceptor: acceptor.trim(),
      closedAt: Date.now()
    })
    await patchDefectStates(ids, '已修复', false)
    return { ok: true, missing: [] }
  }

  /** 撤回验收：已闭环 → 待复验，整单缺陷一起回到「已派工」 */
  async function reopenOrder(id: string): Promise<void> {
    const order = orderById(id)
    if (!order) return
    await workOrdersTable.update(id, { state: '待复验', closedAt: null })
    await patchDefectStates(defectIdsOf(order), '已派工', false)
  }

  /** 撤掉作业单：所含缺陷恢复未派工（待处理），并清空修复结果登记 */
  async function removeWorkOrder(id: string): Promise<void> {
    const order = orderById(id)
    if (!order) return
    const ids = defectIdsOf(order)
    await workOrdersTable.remove(id)
    await patchDefectStates(ids, '待处理', true)
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
    dispatchGroup,
    dispatchMany,
    updateWorkOrder,
    advanceState,
    registerRepairResult,
    acceptOrder,
    reopenOrder,
    removeWorkOrder
  }
})
