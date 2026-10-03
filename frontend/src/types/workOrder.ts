/** 工单状态流转：待派 → 处理中 → 待验收 → 已闭环 */
export type WorkOrderState = '待派' | '处理中' | '待验收' | '已闭环'

/** 复验结论：登记为「已修复」才算完成，「未通过」需返工后重新复验 */
export type RepairVerdict = '已修复' | '未通过'

/**
 * 单条缺陷的修复结果登记：作业单进入待验收后逐条填写，
 * 一张作业单必须所有缺陷都登记为「已修复」才能闭环。
 */
export interface RepairResult {
  defectId: string
  verdict: RepairVerdict
  /** 复验备注（返工说明 / 现场记录等，可为空） */
  note: string
  /** 登记时间戳 */
  registeredAt: number
}

/**
 * 维修作业单：一次高空检修覆盖同一叶片、同一班组、同一限期的多条缺陷。
 * defectIds 为所含缺陷；验收通过（全部缺陷登记「已修复」）后回写缺陷为已修复。
 *
 * 兼容说明：defectId 是旧版「一条缺陷一张工单」的字段，仅用于历史数据读取，
 * 新数据一律写 defectIds，读取时通过 orderDefectIds() 统一兜底。
 */
export interface WorkOrder {
  id: string
  /** 本次作业单覆盖的缺陷清单（同叶片） */
  defectIds: string[]
  /** @deprecated 旧版单缺陷工单字段，历史数据兼容用，逻辑请走 defectIds */
  defectId?: string
  /** 逐条缺陷的修复结果，键为 defectId */
  repairResults: Record<string, RepairResult>
  /** 派工班组 */
  team: string
  /** 限期 YYYY-MM-DD */
  dueDate: string
  state: WorkOrderState
  /** 验收人，闭环时填写 */
  acceptor: string
  /** 闭环时间戳，未闭环为 null */
  closedAt: number | null
  createdAt: number
  updatedAt: number
}

export const WORK_TEAMS: string[] = ['叶片检修一班', '高空作业二班', '复材修复三班', '无人机巡检组']
export const WORK_ORDER_STATES: WorkOrderState[] = ['待派', '处理中', '待验收', '已闭环']

/** 状态机：每个状态的下一状态，已闭环没有下一状态 */
export const WORK_ORDER_FLOW: Record<WorkOrderState, WorkOrderState | null> = {
  待派: '处理中',
  处理中: '待验收',
  待验收: '已闭环',
  已闭环: null
}

export const WORK_ORDER_STATE_COLOR: Record<WorkOrderState, string> = {
  待派: '#8c8479',
  处理中: '#d68910',
  待验收: '#4a6fa5',
  已闭环: '#1e8449'
}

export function nextWorkOrderState(state: WorkOrderState): WorkOrderState | null {
  return WORK_ORDER_FLOW[state]
}

/** 统一读取作业单所含缺陷 id，兼容旧数据只有 defectId 的情况 */
export function orderDefectIds(order: WorkOrder): string[] {
  if (Array.isArray(order.defectIds) && order.defectIds.length > 0) return order.defectIds
  return typeof order.defectId === 'string' && order.defectId ? [order.defectId] : []
}

/** 读取某条缺陷在作业单上的修复结果，未登记返回 null */
export function repairResultOf(order: WorkOrder, defectId: string): RepairResult | null {
  return order.repairResults?.[defectId] ?? null
}

/** 已登记为「已修复」的缺陷 id */
export function repairedDefectIds(order: WorkOrder): string[] {
  return orderDefectIds(order).filter((id) => order.repairResults?.[id]?.verdict === '已修复')
}

/** 尚未登记「已修复」结论的缺陷 id（未登记或复验未通过） */
export function pendingDefectIds(order: WorkOrder): string[] {
  return orderDefectIds(order).filter((id) => order.repairResults?.[id]?.verdict !== '已修复')
}

/** 作业单能否闭环：至少含一条缺陷且全部登记为「已修复」 */
export function allDefectsRepaired(order: WorkOrder): boolean {
  const ids = orderDefectIds(order)
  return ids.length > 0 && ids.every((id) => order.repairResults?.[id]?.verdict === '已修复')
}

/** 工单统计汇总，维修工单页与报告页直接消费 */
export interface WorkOrderStat {
  /** 作业单（工单）张数 */
  total: number
  pending: number
  processing: number
  awaiting: number
  closed: number
  /** 已超期（限期已过且未闭环）的作业单数量 */
  overdue: number
  /** 待验收作业单里尚未登记「已修复」的缺陷条数（待复验） */
  pendingRepair: number
  /** 闭环率，0-100 的整数 */
  closedPercent: number
}

/** 工单是否超期：限期早于今天且尚未闭环（一张单超期，所含缺陷都算跟催对象） */
export function isOverdue(order: WorkOrder, today: string): boolean {
  if (order.state === '已闭环') return false
  if (!order.dueDate) return false
  return order.dueDate < today
}

/** 空工单统计 */
export function createEmptyWorkOrderStat(): WorkOrderStat {
  return { total: 0, pending: 0, processing: 0, awaiting: 0, closed: 0, overdue: 0, pendingRepair: 0, closedPercent: 0 }
}
