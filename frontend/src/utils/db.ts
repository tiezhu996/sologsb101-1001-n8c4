import Dexie, { type Table } from 'dexie'
import type { Turbine } from '@/types/turbine'
import type { Blade, BladeMaterial, BladeSerial } from '@/types/blade'
import type { Segment, SegmentFace } from '@/types/segment'
import type { Defect, DefectState, DefectType, Severity } from '@/types/defect'
import { orderDefectIds, type WorkOrder, type WorkOrderState } from '@/types/workOrder'

/** 本地 IndexedDB 库名 */
export const DB_NAME = 'gbwindblade'

/** 本地结构版本号：新增 / 修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** localStorage 侧的少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbwindblade:db-version',
  lastBackupAt: 'gbwindblade:last-backup-at',
  uiPrefs: 'gbwindblade:ui-prefs'
} as const

export interface UiPrefs {
  lastTurbineId: string | null
  lastBladeId: string | null
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastTurbineId: null,
  lastBladeId: null
}

/** 备份 / 导出文件结构，供 utils/export.ts 与报告页使用 */
export interface BackupPayload {
  app: 'gbwindblade'
  dbVersion: number
  exportedAt: string
  turbines: Turbine[]
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
}

/** 全部业务表集合，清空与导入共用 */
export const ALL_TABLES = [
  'turbines',
  'blades',
  'segments',
  'defects',
  'workOrders'
] as const

export class WindBladeDatabase extends Dexie {
  turbines!: Table<Turbine, string>
  blades!: Table<Blade, string>
  segments!: Table<Segment, string>
  defects!: Table<Defect, string>
  workOrders!: Table<WorkOrder, string>

  constructor() {
    super(DB_NAME)
    this.version(1).stores({
      turbines: 'id, code, model, commissionDate, updatedAt',
      blades: 'id, turbineId, serial, material, updatedAt',
      segments: 'id, bladeId, index, airfoil, updatedAt',
      defects: 'id, segmentId, type, severity, updatedAt',
      workOrders: 'id, defectId, team, state, updatedAt'
    })
    // v2：分段补充检修面索引，缺陷补充面位 / 状态 / 发现日期索引，工单补充限期索引
    this.version(2)
      .stores({
        turbines: 'id, code, model, commissionDate, updatedAt',
        blades: 'id, turbineId, serial, material, updatedAt',
        segments: 'id, bladeId, index, face, updatedAt',
        defects: 'id, segmentId, type, severity, face, state, foundAt, updatedAt',
        workOrders: 'id, defectId, team, state, dueDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史记录补全 v2 新增字段，避免页面读取到 undefined
        await tx
          .table<Defect>('defects')
          .toCollection()
          .modify((defect) => {
            if (!defect.state) defect.state = '待处理'
            if (typeof defect.lengthMm !== 'number') defect.lengthMm = 0
            if (typeof defect.widthMm !== 'number') defect.widthMm = 0
            if (typeof defect.positionM !== 'number') defect.positionM = 0
          })
        await tx
          .table<WorkOrder>('workOrders')
          .toCollection()
          .modify((order) => {
            if (!order.state) order.state = '待派'
            if (typeof order.acceptor !== 'string') order.acceptor = ''
            if (order.closedAt === undefined) order.closedAt = null
          })
        await tx
          .table<Segment>('segments')
          .toCollection()
          .modify((segment) => {
            if (typeof segment.sectionImage !== 'string') segment.sectionImage = ''
            if (!segment.face) segment.face = 'PS'
          })
      })
    // v3：工单升级为「作业单」，一张单覆盖同叶片多缺陷（defectIds 多值索引 *defectIds）
    this.version(DB_VERSION)
      .stores({
        turbines: 'id, code, model, commissionDate, updatedAt',
        blades: 'id, turbineId, serial, material, updatedAt',
        segments: 'id, bladeId, index, face, updatedAt',
        defects: 'id, segmentId, type, severity, face, state, foundAt, updatedAt',
        workOrders: 'id, *defectIds, team, state, dueDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：旧版一条缺陷一张工单（defectId）兼容读入为 defectIds + repairResults
        await tx
          .table<WorkOrder>('workOrders')
          .toCollection()
          .modify((order) => {
            const ids =
              Array.isArray(order.defectIds) && order.defectIds.length > 0
                ? order.defectIds
                : typeof order.defectId === 'string' && order.defectId
                  ? [order.defectId]
                  : []
            order.defectIds = ids
            if (!order.repairResults || typeof order.repairResults !== 'object') {
              order.repairResults = {}
            }
            // 已闭环的旧工单：所含缺陷视为已复验通过，避免升级后过不了「全部修复」校验
            if (order.state === '已闭环') {
              ids.forEach((defectId) => {
                if (!order.repairResults[defectId]) {
                  order.repairResults[defectId] = {
                    defectId,
                    verdict: '已修复',
                    note: '历史闭环工单迁移补登',
                    registeredAt: order.closedAt ?? Date.now()
                  }
                }
              })
            }
          })
      })
  }
}

export const db = new WindBladeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 清空全部业务表，供「清空本地数据」与导入前覆盖使用 */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.turbines, db.blades, db.segments, db.defects, db.workOrders], async () => {
    await Promise.all([
      db.turbines.clear(),
      db.blades.clear(),
      db.segments.clear(),
      db.defects.clear(),
      db.workOrders.clear()
    ])
  })
}

/**
 * 删除缺陷时对作业单做「修剪」：把缺陷从所含 defectIds / repairResults 中摘除，
 * 作业单被摘空（旧版一单一缺陷的典型情况）则整张删除。
 * 必须在已包含 db.workOrders 的读写事务内调用。
 */
export async function pruneDefectsFromWorkOrders(defectIds: string[]): Promise<void> {
  if (defectIds.length === 0) return
  const removing = new Set(defectIds)
  const affected = await db.workOrders.where('defectIds').anyOf(defectIds).toArray()
  for (const order of affected) {
    const remaining = orderDefectIds(order).filter((id) => !removing.has(id))
    if (remaining.length === 0) {
      await db.workOrders.delete(order.id)
      continue
    }
    const repairResults = { ...(order.repairResults ?? {}) }
    removing.forEach((id) => {
      delete repairResults[id]
    })
    await db.workOrders.put({
      ...order,
      defectIds: remaining,
      defectId: remaining[0],
      repairResults,
      updatedAt: Date.now()
    })
  }
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastTurbineId: typeof parsed.lastTurbineId === 'string' ? parsed.lastTurbineId : null,
      lastBladeId: typeof parsed.lastBladeId === 'string' ? parsed.lastBladeId : null
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本，便于报告页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

/** 相对今天偏移 N 天的日期（YYYY-MM-DD），用于播种出「超期 / 临近」工单 */
function dateOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 播种用的缺陷规格：order.group 相同的多条缺陷合并到一张作业单（同班组 / 同限期） */
interface SeedDefectSpec {
  turbine: 0 | 1
  serial: BladeSerial
  seg: number
  type: DefectType
  severity: Severity
  lengthMm: number
  widthMm: number
  foundOffsetDays: number
  order?: {
    /** 同一机组内相同 group 的缺陷合并为一张作业单 */
    group: string
    team: string
    dueOffsetDays: number
    state: WorkOrderState
    acceptor: string
    closedOffsetDays: number | null
    /** 待验收 / 已闭环单的逐条复验结论；缺省按「未登记」处理 */
    verdict?: '已修复' | '未通过'
  }
}

/** 演示数据：2 台机组 × 各 2 片叶片 × 各 3 个展向分段 × 18 条缺陷 × 4 张作业单 */
const SEED_DEFECTS: SeedDefectSpec[] = [
  // ---- 机组一 WT-A01 ----
  // 叶片 A 段1 两条缺陷一次高空检修合并处理（作业单 G-A01-A-1，处理中、已超期）
  {
    turbine: 0, serial: 'A', seg: 1, type: '前缘腐蚀', severity: '中度',
    lengthMm: 820, widthMm: 36, foundOffsetDays: -46,
    order: { group: 'G-A01-A-1', team: '叶片检修一班', dueOffsetDays: -12, state: '处理中', acceptor: '', closedOffsetDays: null }
  },
  {
    turbine: 0, serial: 'A', seg: 1, type: '砂眼', severity: '轻度', lengthMm: 12, widthMm: 9, foundOffsetDays: -46,
    order: { group: 'G-A01-A-1', team: '叶片检修一班', dueOffsetDays: -12, state: '处理中', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 0, serial: 'A', seg: 2, type: '裂纹', severity: '重度', lengthMm: 1450, widthMm: 6, foundOffsetDays: -30 },
  { turbine: 0, serial: 'A', seg: 2, type: '油污', severity: '轻度', lengthMm: 340, widthMm: 210, foundOffsetDays: -30 },
  { turbine: 0, serial: 'A', seg: 3, type: '雷击', severity: '重度', lengthMm: 260, widthMm: 180, foundOffsetDays: -18 },
  {
    turbine: 0, serial: 'B', seg: 1, type: '油污', severity: '轻度',
    lengthMm: 260, widthMm: 140, foundOffsetDays: -52,
    order: { group: 'G-A01-B-1', team: '无人机巡检组', dueOffsetDays: 26, state: '待派', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 0, serial: 'B', seg: 2, type: '裂纹', severity: '重度', lengthMm: 1180, widthMm: 5, foundOffsetDays: -25 },
  // 叶片 B 段2、段3 两条缺陷同班组同限期合并（作业单 G-A01-B-2，待验收：一条已登记修复、一条复验未通过留待复验）
  {
    turbine: 0, serial: 'B', seg: 2, type: '前缘腐蚀', severity: '中度',
    lengthMm: 640, widthMm: 28, foundOffsetDays: -25,
    order: { group: 'G-A01-B-2', team: '复材修复三班', dueOffsetDays: 4, state: '待验收', acceptor: '', closedOffsetDays: null, verdict: '已修复' }
  },
  {
    turbine: 0, serial: 'B', seg: 3, type: '砂眼', severity: '中度', lengthMm: 18, widthMm: 14, foundOffsetDays: -11,
    order: { group: 'G-A01-B-2', team: '复材修复三班', dueOffsetDays: 4, state: '待验收', acceptor: '', closedOffsetDays: null, verdict: '未通过' }
  },
  // ---- 机组二 WT-B07 ----
  // 叶片 A 段1、段2 两条缺陷合并为一张已闭环作业单（验收通过）
  {
    turbine: 1, serial: 'A', seg: 1, type: '雷击', severity: '重度',
    lengthMm: 310, widthMm: 220, foundOffsetDays: -64,
    order: { group: 'G-B07-A-1', team: '高空作业二班', dueOffsetDays: -40, state: '已闭环', acceptor: '赵鹏', closedOffsetDays: -35, verdict: '已修复' }
  },
  {
    turbine: 1, serial: 'A', seg: 2, type: '前缘腐蚀', severity: '中度', lengthMm: 910, widthMm: 42, foundOffsetDays: -33,
    order: { group: 'G-B07-A-1', team: '高空作业二班', dueOffsetDays: -40, state: '已闭环', acceptor: '赵鹏', closedOffsetDays: -35, verdict: '已修复' }
  },
  { turbine: 1, serial: 'A', seg: 3, type: '裂纹', severity: '轻度', lengthMm: 420, widthMm: 3, foundOffsetDays: -20 },
  { turbine: 1, serial: 'A', seg: 3, type: '油污', severity: '轻度', lengthMm: 180, widthMm: 120, foundOffsetDays: -20 },
  { turbine: 1, serial: 'B', seg: 1, type: '砂眼', severity: '轻度', lengthMm: 15, widthMm: 11, foundOffsetDays: -58 },
  {
    turbine: 1, serial: 'B', seg: 2, type: '裂纹', severity: '重度',
    lengthMm: 1620, widthMm: 8, foundOffsetDays: -27,
    order: { group: 'G-B07-B-2', team: '复材修复三班', dueOffsetDays: 9, state: '处理中', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 1, serial: 'B', seg: 2, type: '雷击', severity: '中度', lengthMm: 150, widthMm: 96, foundOffsetDays: -27 },
  { turbine: 1, serial: 'B', seg: 3, type: '前缘腐蚀', severity: '重度', lengthMm: 1720, widthMm: 55, foundOffsetDays: -14 },
  { turbine: 1, serial: 'B', seg: 3, type: '砂眼', severity: '中度', lengthMm: 22, widthMm: 16, foundOffsetDays: -14 }
]

/** 是否已完成播种（机组表非空即视为已播种） */
export async function isSeeded(): Promise<boolean> {
  return (await db.turbines.count()) > 0
}

/**
 * 首次进入自动播种演示数据：2 台机组 × 各 2 片叶片 × 各 3 个展向分段 × 18 条缺陷 × 4 张作业单。
 * 幂等：机组表非空时直接返回 false，不会重复播种。
 */
export async function seedDemoData(): Promise<boolean> {
  if (await isSeeded()) return false

  const now = Date.now()
  const turbines: Turbine[] = []
  const blades: Blade[] = []
  const segments: Segment[] = []
  const defects: Defect[] = []
  const workOrders: WorkOrder[] = []

  const blueprints: Array<{
    code: string
    model: string
    hubHeightM: number
    commissionDate: string
    lengthM: number
    material: BladeMaterial
    serials: BladeSerial[]
    airfoil: string
    faces: SegmentFace[]
  }> = [
    {
      code: 'WT-A01',
      model: 'GW155-4.5MW',
      hubHeightM: 110,
      commissionDate: '2021-06-18',
      lengthM: 68.5,
      material: '玻璃纤维',
      serials: ['A', 'B'],
      airfoil: 'DU-91-W2-250',
      faces: ['PS', 'LE', 'SS']
    },
    {
      code: 'WT-B07',
      model: 'GW171-6.0MW',
      hubHeightM: 120,
      commissionDate: '2023-03-05',
      lengthM: 84,
      material: '碳纤维',
      serials: ['A', 'B'],
      airfoil: 'DU-93-W-210',
      faces: ['LE', 'PS', 'TE']
    }
  ]

  // 跨叶片累计作业单分组：建单模板（班组/限期/状态）+ 逐条缺陷及其复验结论
  const bladeOrderGroups: Array<{
    template: NonNullable<SeedDefectSpec['order']>
    entries: Array<{ defectId: string; verdict?: '已修复' | '未通过' }>
  }> = []

  blueprints.forEach((blueprint, turbineIndex) => {
    const turbineId = createId('tbn')
    turbines.push({
      id: turbineId,
      code: blueprint.code,
      model: blueprint.model,
      hubHeightM: blueprint.hubHeightM,
      commissionDate: blueprint.commissionDate,
      bladeCount: blueprint.serials.length,
      createdAt: now,
      updatedAt: now
    })

    blueprint.serials.forEach((serial, bladeIndex) => {
      const bladeId = createId('bld')
      const segmentCount = 3
      blades.push({
        id: bladeId,
        turbineId,
        serial,
        lengthM: blueprint.lengthM,
        material: blueprint.material,
        segmentCount,
        createdAt: now,
        updatedAt: now
      })

      for (let i = 1; i <= segmentCount; i += 1) {
        const startM = round2(((i - 1) * blueprint.lengthM) / segmentCount)
        const endM = round2((i * blueprint.lengthM) / segmentCount)
        const face = blueprint.faces[(i - 1) % blueprint.faces.length]
        segments.push({
          id: createId('seg'),
          bladeId,
          index: i,
          startM,
          endM,
          airfoil: blueprint.airfoil,
          face,
          sectionImage: `${blueprint.code}-${serial}-seg${String(i).padStart(2, '0')}-${face}.png`,
          createdAt: now,
          updatedAt: now
        })
      }

      // 逐段挂接缺陷，记录缺陷 id 与其所属作业单分组，落库后再按分组建单
      const groupedSpecs = new Map<
        string,
        {
          template: NonNullable<SeedDefectSpec['order']>
          entries: Array<{ defectId: string; verdict?: '已修复' | '未通过' }>
        }
      >()
      for (let i = 1; i <= segmentCount; i += 1) {
        const segment = segments.find(
          (item) => item.bladeId === bladeId && item.index === i
        ) as Segment
        const specs = SEED_DEFECTS.filter(
          (spec) =>
            spec.turbine === turbineIndex && spec.serial === serial && spec.seg === i
        )
        specs.forEach((spec, specIndex) => {
          const defectId = createId('dfc')
          // 待验收 / 已闭环作业单里登记为「已修复」的缺陷，播种时即为已修复；
          // 其余在单缺陷（含复验未通过 / 未登记）保持已派工
          const repairedByOrder = spec.order?.verdict === '已修复'
          const state: DefectState = spec.order
            ? spec.order.state === '已闭环' || repairedByOrder
              ? '已修复'
              : '已派工'
            : '待处理'
          // 展向位置：在分段区间内按缺陷序号错开，避免重叠
          const ratio = 0.3 + ((bladeIndex + specIndex) % 3) * 0.2
          const positionM = round2(segment.startM + (segment.endM - segment.startM) * ratio)
          defects.push({
            id: defectId,
            segmentId: segment.id,
            type: spec.type,
            severity: spec.severity,
            lengthMm: spec.lengthMm,
            widthMm: spec.widthMm,
            face: segment.face,
            positionM,
            foundAt: dateOffset(spec.foundOffsetDays),
            state,
            createdAt: now,
            updatedAt: now
          })

          if (spec.order) {
            const groupKey = `${turbineIndex}-${serial}-${spec.order.group}`
            const bucket = groupedSpecs.get(groupKey)
            if (bucket) {
              bucket.entries.push({ defectId, verdict: spec.order.verdict })
            } else {
              groupedSpecs.set(groupKey, {
                template: spec.order,
                entries: [{ defectId, verdict: spec.order.verdict }]
              })
            }
          }
        })
      }

      // 该叶片处理完后把分组暂存到外层，全部缺陷生成后统一建单
      bladeOrderGroups.push(...groupedSpecs.values())
    })
  })

  // 按分组合并建作业单：同叶片、同班组、同限期的多条缺陷只出一张单
  bladeOrderGroups.forEach(({ template, entries }) => {
    const repairResults: WorkOrder['repairResults'] = {}
    if (template.state === '待验收' || template.state === '已闭环') {
      entries.forEach(({ defectId, verdict }) => {
        if (verdict) {
          repairResults[defectId] = {
            defectId,
            verdict,
            note: verdict === '未通过' ? '复验发现返修复发，待重新处理' : '',
            registeredAt:
              template.closedOffsetDays === null
                ? now
                : now + template.closedOffsetDays * 24 * 60 * 60 * 1000
          }
        }
      })
    }
    workOrders.push({
      id: createId('wo'),
      defectIds: entries.map((entry) => entry.defectId),
      repairResults,
      team: template.team,
      dueDate: dateOffset(template.dueOffsetDays),
      state: template.state,
      acceptor: template.acceptor,
      closedAt:
        template.closedOffsetDays === null
          ? null
          : now + template.closedOffsetDays * 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now
    })
  })

  await db.transaction(
    'rw',
    [db.turbines, db.blades, db.segments, db.defects, db.workOrders],
    async () => {
      await db.turbines.bulkPut(turbines)
      await db.blades.bulkPut(blades)
      await db.segments.bulkPut(segments)
      await db.defects.bulkPut(defects)
      await db.workOrders.bulkPut(workOrders)
    }
  )

  return true
}

/**
 * 应用启动入口调用：首次进入（机组表为空）自动播种演示数据。
 * 幂等，可重复调用。
 */
export async function ensureSeeded(): Promise<boolean> {
  try {
    return await seedDemoData()
  } catch (error) {
    console.error('[gbwindblade] 播种演示数据失败：', error)
    return false
  }
}
