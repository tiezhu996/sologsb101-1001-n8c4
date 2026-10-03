<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Plus, Refresh, RefreshLeft, Right } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useWorkOrderStore, type DispatchOption, type WorkOrderRow } from '@/stores/workOrderStore'
import { useBladeStore } from '@/stores/bladeStore'
import {
  WORK_ORDER_STATE_COLOR,
  WORK_ORDER_STATES,
  WORK_TEAMS,
  type RepairVerdict,
  type WorkOrder,
  type WorkOrderState
} from '@/types/workOrder'
import { FACE_LABEL, formatRange, type SegmentFace } from '@/types/segment'
import { seedDemoData } from '@/utils/db'

const router = useRouter()
const workOrderStore = useWorkOrderStore()
const bladeStore = useBladeStore()

function dateAfter(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function formatDateTime(value: number | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 距限期的天数：负数表示已超期 */
function daysLeft(dueDate: string): number {
  if (!dueDate) return 0
  const due = new Date(`${dueDate}T00:00:00`).getTime()
  const today = new Date(`${workOrderStore.today}T00:00:00`).getTime()
  return Math.round((due - today) / (24 * 60 * 60 * 1000))
}

const filterModel = computed<FilterModel>(() => ({
  keyword: workOrderStore.keyword,
  teams: workOrderStore.teamFilter,
  states: workOrderStore.stateFilter,
  onlyOverdue: workOrderStore.onlyOverdue
}))

const filterSelects = computed(() => [
  {
    key: 'teams',
    label: '班组',
    options: workOrderStore.teamOptions.map((team) => ({ label: team, value: team })),
    placeholder: '选择班组'
  },
  {
    key: 'states',
    label: '工单状态',
    options: WORK_ORDER_STATES.map((state) => ({ label: state, value: state })),
    placeholder: '选择状态'
  }
])

function handleFilterChange(value: FilterModel): void {
  workOrderStore.patchFilter({
    keyword: typeof value.keyword === 'string' ? value.keyword : '',
    teams: (Array.isArray(value.teams) ? value.teams : []) as string[],
    states: (Array.isArray(value.states) ? value.states : []) as WorkOrderState[],
    onlyOverdue: value.onlyOverdue === true
  })
}

function stateColor(state: string): string {
  return WORK_ORDER_STATE_COLOR[state as WorkOrderState] ?? '#4a5b63'
}

/** 面位中文标签（模板内免去类型断言） */
function faceText(face: string): string {
  return FACE_LABEL[face as SegmentFace] ?? face
}

/* ---------------- 新建作业单（派工） ---------------- */
const createVisible = ref(false)
const createSubmitting = ref(false)
const createForm = reactive({
  bladeId: '',
  defectIds: [] as string[],
  team: WORK_TEAMS[0],
  dueDate: dateAfter(7)
})

const dispatchable = computed<DispatchOption[]>(() => workOrderStore.dispatchableDefects)

/** 可派工缺陷按叶片分组（一次派工只能覆盖同一叶片） */
const dispatchableBlades = computed(() => {
  const map = new Map<string, { label: string; defects: DispatchOption[] }>()
  dispatchable.value.forEach((option) => {
    const key = option.blade?.id ?? `missing-${option.defect.id}`
    const bucket = map.get(key) ?? { label: '', defects: [] }
    bucket.label = option.blade
      ? `${option.turbine?.code ?? '未知机组'}｜叶片 ${option.blade.serial}`
      : '叶片归属缺失'
    bucket.defects.push(option)
    map.set(key, bucket)
  })
  return Array.from(map, ([bladeId, group]) => ({ bladeId, ...group }))
})

/** 当前选中叶片下的可派工缺陷 */
const bladeDispatchOptions = computed<DispatchOption[]>(() => {
  if (!createForm.bladeId) return []
  return dispatchableBlades.value.find((group) => group.bladeId === createForm.bladeId)?.defects ?? []
})

function defectOptionLabel(row: DispatchOption): string {
  const segment = row.segment ? `第 ${row.segment.index} 段` : '分段缺失'
  return `${segment}｜${row.defect.type}（${row.defect.severity}）｜${row.defect.positionM} m`
}

function openCreate(): void {
  const firstBlade = dispatchableBlades.value[0]
  createForm.bladeId = firstBlade?.bladeId ?? ''
  createForm.defectIds = firstBlade ? firstBlade.defects.map((item) => item.defect.id) : []
  createForm.team = WORK_TEAMS[0]
  createForm.dueDate = dateAfter(7)
  createVisible.value = true
}

watch(createVisible, (visible) => {
  if (visible) openCreate()
})

async function submitCreate(): Promise<void> {
  if (createForm.defectIds.length === 0) {
    ElMessage.warning('请勾选本次作业单要覆盖的缺陷')
    return
  }
  createSubmitting.value = true
  try {
    const result = await workOrderStore.dispatchDefects(
      createForm.defectIds,
      createForm.team,
      createForm.dueDate
    )
    createVisible.value = false
    ElMessage.success(
      `已派工：新建 ${result.created} 张作业单，覆盖 ${result.defectCount} 条缺陷，班组「${createForm.team}」，限期 ${createForm.dueDate}`
    )
  } finally {
    createSubmitting.value = false
  }
}

/* ---------------- 状态流转 ---------------- */
async function advance(row: WorkOrderRow): Promise<void> {
  if (row.order.state === '待验收') {
    openAccept(row.order)
    return
  }
  const next = await workOrderStore.advanceState(row.order.id)
  if (next) ElMessage.success(`作业单已推进到「${next}」`)
  else ElMessage.info('该作业单已闭环，如需修正请使用「撤回验收」')
}

/* ---------------- 验收（逐条登记修复结果） ---------------- */
const acceptVisible = ref(false)
const acceptSubmitting = ref(false)
const acceptTargetId = ref<string | null>(null)
const acceptForm = reactive<Record<string, { verdict: RepairVerdict | ''; note: string }>>({})
const acceptAcceptor = ref('')

const acceptTarget = computed<WorkOrderRow | null>(
  () => workOrderStore.rows.find((row) => row.order.id === acceptTargetId.value) ?? null
)

function openAccept(order: WorkOrder): void {
  acceptTargetId.value = order.id
  acceptAcceptor.value = order.acceptor || ''
  const row = workOrderStore.rows.find((item) => item.order.id === order.id)
  const form: Record<string, { verdict: RepairVerdict | ''; note: string }> = {}
  row?.items.forEach((item) => {
    if (!item.defect) return
    form[item.defect.id] = {
      verdict: item.result?.verdict ?? '',
      note: item.result?.note ?? ''
    }
  })
  Object.keys(acceptForm).forEach((key) => delete acceptForm[key])
  Object.assign(acceptForm, form)
  acceptVisible.value = true
}

/** 对话框中尚未登记为「已修复」的条数 */
const acceptPendingCount = computed(() => {
  const row = acceptTarget.value
  if (!row) return 0
  return row.items.filter(
    (item) => item.defect && acceptForm[item.defect.id]?.verdict !== '已修复'
  ).length
})

async function saveResults(): Promise<void> {
  const row = acceptTarget.value
  if (!row) return
  const entries = row.items
    .filter((item) => item.defect && acceptForm[item.defect.id]?.verdict)
    .map((item) => ({
      defectId: item.defect!.id,
      verdict: acceptForm[item.defect!.id].verdict as RepairVerdict,
      note: acceptForm[item.defect!.id].note
    }))
  if (entries.length === 0) {
    ElMessage.warning('请先为缺陷选择复验结论（已修复 / 未通过）')
    return
  }
  await workOrderStore.registerRepairResults(row.order.id, entries)
  ElMessage.success(`已登记 ${entries.length} 条缺陷的修复结果`)
}

async function submitAccept(): Promise<void> {
  const row = acceptTarget.value
  if (!row) return
  // 先把对话框里尚未保存的结论落库，再判定能否闭环
  const dirtyEntries = row.items
    .filter((item) => {
      if (!item.defect) return false
      const formValue = acceptForm[item.defect.id]
      if (!formValue?.verdict) return false
      return item.result?.verdict !== formValue.verdict || (item.result?.note ?? '') !== formValue.note
    })
    .map((item) => ({
      defectId: item.defect!.id,
      verdict: acceptForm[item.defect!.id].verdict as RepairVerdict,
      note: acceptForm[item.defect!.id].note
    }))
  if (dirtyEntries.length > 0) {
    await workOrderStore.registerRepairResults(row.order.id, dirtyEntries)
  }
  if (!acceptAcceptor.value.trim()) {
    ElMessage.warning('请填写验收人')
    return
  }
  acceptSubmitting.value = true
  try {
    const refreshed = workOrderStore.orderById(row.order.id)
    const pending = refreshed
      ? workOrderStore.rows.find((item) => item.order.id === row.order.id)?.pendingCount ?? 0
      : 0
    const result = await workOrderStore.acceptOrder(row.order.id, acceptAcceptor.value)
    if (!result.ok) {
      ElMessage.warning(`还有 ${result.pendingCount || pending} 条缺陷未登记为「已修复」，作业单留在待复验，不能闭环`)
      return
    }
    acceptVisible.value = false
    ElMessage.success('全部缺陷复验通过，作业单已闭环')
  } finally {
    acceptSubmitting.value = false
  }
}

async function reopen(row: WorkOrderRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤回验收会把作业单退回「待验收」、清空 ${row.defectCount} 条缺陷的复验结论，缺陷全部回到「已派工」。确认撤回？`,
      '撤回验收确认',
      { type: 'warning', confirmButtonText: '确认撤回', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await workOrderStore.reopenOrder(row.order.id)
  ElMessage.success('已撤回验收，缺陷回到已派工')
}

/* ---------------- 编辑 / 删除 ---------------- */
const editVisible = ref(false)
const editSubmitting = ref(false)
const editId = ref<string | null>(null)
const editForm = reactive({
  team: WORK_TEAMS[0],
  dueDate: workOrderStore.today,
  state: '待派' as WorkOrderState,
  acceptor: ''
})

function openEdit(order: WorkOrder): void {
  editId.value = order.id
  editForm.team = order.team
  editForm.dueDate = order.dueDate
  editForm.state = order.state
  editForm.acceptor = order.acceptor
  editVisible.value = true
}

async function submitEdit(): Promise<void> {
  if (!editId.value) return
  if (editForm.state === '已闭环' && !editForm.acceptor.trim()) {
    ElMessage.warning('闭环必须填写验收人')
    return
  }
  editSubmitting.value = true
  try {
    await workOrderStore.editOrder(editId.value, { ...editForm })
    editVisible.value = false
    ElMessage.success('作业单信息已更新，缺陷状态已同步')
  } finally {
    editSubmitting.value = false
  }
}

async function removeOrder(row: WorkOrderRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认撤掉作业单 #${row.order.id.slice(-6)}（${row.order.team} · 覆盖 ${row.defectCount} 条缺陷）？撤单后所含缺陷恢复「未派工（待处理）」。`,
      '撤掉作业单确认',
      { type: 'warning', confirmButtonText: '确认撤单', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await workOrderStore.removeWorkOrder(row.order.id)
  ElMessage.success('作业单已撤掉，缺陷恢复未派工')
}

function locate(row: WorkOrderRow): void {
  if (!row.blade) {
    ElMessage.warning('该作业单缺少叶片归属，无法定位')
    return
  }
  bladeStore.setCurrentBlade(row.blade.id)
  void router.push(`/blades/${row.blade.id}/segments`)
}

async function handleSeed(): Promise<void> {
  const seeded = await seedDemoData()
  if (seeded) {
    ElMessage.success('已生成演示数据：2 台机组 × 各 2 片叶片 × 各 3 个展向分段与 4 张作业单')
  } else {
    ElMessage.info('本地已有数据，未重复播种')
  }
}

const stats = computed(() => workOrderStore.stats)
const tableRows = computed(() => workOrderStore.sortedRows)
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>维修工单（作业单）</h2>
        <p>一次高空检修覆盖同叶片、同班组、同限期的多条缺陷；逐条登记修复结果，全部复验通过才能闭环。</p>
      </div>
      <div class="toolbar">
        <el-button :icon="Refresh" @click="workOrderStore.resetFilters()">清空筛选</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建作业单</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="作业单总数" :value="stats.total" suffix="张" tone="primary" icon="Files" />
      <StatBadge label="待派" :value="stats.pending" suffix="张" tone="info" icon="Document" />
      <StatBadge label="处理中" :value="stats.processing" suffix="张" tone="warning" icon="Tools" />
      <StatBadge label="待验收" :value="stats.awaiting" suffix="张" tone="primary" icon="Odometer" />
      <StatBadge label="待复验缺陷" :value="stats.pendingRepair" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="已闭环" :value="stats.closed" suffix="张" tone="success" icon="SuccessFilled" />
      <StatBadge label="超期未闭环" :value="stats.overdue" suffix="张" tone="danger" icon="WarningFilled" />
      <StatBadge
        label="闭环率"
        :value="stats.closedPercent"
        :percent="stats.closedPercent"
        suffix="%"
        tone="success"
        icon="PieChart"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      :query-keys="{ keyword: 'kw', teams: 'team', states: 'state', onlyOverdue: 'overdue' }"
      keyword-placeholder="搜索班组 / 状态 / 验收人 / 机组 / 缺陷类型…"
      switch-key="onlyOverdue"
      switch-label="仅看超期"
      :switch-value="workOrderStore.onlyOverdue"
      has-switch
      class="section-card"
      @change="handleFilterChange"
    />

    <div class="section-card">
      <div class="section-card__head">
        <h3>作业单清单（当前筛选 {{ tableRows.length }} 张）</h3>
        <span class="muted">今天：{{ workOrderStore.today }}</span>
      </div>

      <EmptyPanel
        v-if="tableRows.length === 0"
        title="没有符合条件的作业单"
        description="可以从缺陷标注台勾选同叶片缺陷批量派工，也可以直接在此新建作业单。"
        action-text="新建作业单"
        :show-seed="stats.total === 0"
        @action="openCreate"
        @seed="handleSeed"
      />

      <el-table v-else :data="tableRows" row-key="order.id" border>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="defect-panel">
              <div class="defect-panel__head">
                <strong>作业单所含缺陷（{{ row.defectCount }} 条）</strong>
                <el-tag size="small" type="success" effect="plain">
                  已复验通过 {{ row.repairedCount }} 条
                </el-tag>
                <el-tag v-if="row.pendingCount > 0 && row.order.state === '待验收'" size="small" type="danger" effect="dark">
                  待复验 {{ row.pendingCount }} 条
                </el-tag>
              </div>
              <el-table :data="row.items" size="small" border class="defect-subtable">
                <el-table-column label="分段" width="220">
                  <template #default="{ row: item }">
                    {{ item.segment ? `第 ${item.segment.index} 段 · ${formatRange(item.segment.startM, item.segment.endM)}` : '分段缺失' }}
                  </template>
                </el-table-column>
                <el-table-column label="缺陷" min-width="200">
                  <template #default="{ row: item }">
                    <div v-if="item.defect" class="cell-stack">
                      <span>{{ item.defect.type }}｜{{ faceText(item.defect.face) }}｜{{ item.defect.positionM }} m</span>
                      <SeverityTag
                        :severity="item.defect.severity"
                        :length-mm="item.defect.lengthMm"
                        :width-mm="item.defect.widthMm"
                        size="small"
                      />
                    </div>
                    <span v-else class="muted">缺陷已删除</span>
                  </template>
                </el-table-column>
                <el-table-column label="缺陷状态" width="100">
                  <template #default="{ row: item }">
                    <span v-if="item.defect">{{ item.defect.state }}</span>
                    <span v-else class="muted">—</span>
                  </template>
                </el-table-column>
                <el-table-column label="复验结论" width="120">
                  <template #default="{ row: item }">
                    <el-tag
                      v-if="item.result?.verdict === '已修复'"
                      size="small"
                      type="success"
                    >
                      已修复
                    </el-tag>
                    <el-tag
                      v-else-if="item.result?.verdict === '未通过'"
                      size="small"
                      type="danger"
                      effect="dark"
                    >
                      未通过
                    </el-tag>
                    <el-tag v-else size="small" type="info" effect="plain">未登记</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="备注" min-width="160">
                  <template #default="{ row: item }">
                    <span class="muted">{{ item.result?.note || '—' }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="作业单号" width="130">
          <template #default="{ row }">
            <span class="mono">#{{ row.order.id.slice(-6) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="叶片 / 机组" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.turbine?.code ?? '—' }}｜叶片 {{ row.blade?.serial ?? '—' }}</span>
              <span class="muted">覆盖 {{ row.defectCount }} 条缺陷</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="缺陷进度" width="150">
          <template #default="{ row }">
            <el-progress
              :percentage="row.defectCount === 0 ? 0 : Math.round((row.repairedCount / row.defectCount) * 100)"
              :stroke-width="10"
              :status="row.pendingCount === 0 && row.defectCount > 0 ? 'success' : undefined"
            />
            <span class="muted progress-text">{{ row.repairedCount }} / {{ row.defectCount }} 已修复</span>
          </template>
        </el-table-column>
        <el-table-column label="派工班组" prop="order.team" width="140" />
        <el-table-column label="限期" width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="mono">{{ row.order.dueDate || '—' }}</span>
              <span v-if="row.order.state === '已闭环'" class="muted text-success">已闭环</span>
              <span v-else-if="row.overdue" class="text-danger">
                已超期 {{ Math.abs(daysLeft(row.order.dueDate)) }} 天
              </span>
              <span v-else class="muted">剩余 {{ daysLeft(row.order.dueDate) }} 天</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <span
              class="state-pill"
              :style="{ color: '#ffffff', backgroundColor: stateColor(row.order.state) }"
            >
              {{ row.order.state }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="验收人" width="100">
          <template #default="{ row }">{{ row.order.acceptor || '—' }}</template>
        </el-table-column>
        <el-table-column label="闭环时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.order.closedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.order.state !== '已闭环'"
              link
              type="primary"
              :icon="row.order.state === '待验收' ? Check : Right"
              @click="advance(row)"
            >
              {{ row.order.state === '待验收' ? '验收登记' : '推进状态' }}
            </el-button>
            <el-button
              v-else
              link
              type="warning"
              :icon="RefreshLeft"
              @click="reopen(row)"
            >
              撤回验收
            </el-button>
            <el-button link type="primary" @click="openEdit(row.order)">编辑</el-button>
            <el-button link type="primary" @click="locate(row)">定位叶片</el-button>
            <el-button link type="danger" @click="removeOrder(row)">撤单</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="createVisible" title="新建作业单（派工）" width="720px" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="派工叶片" required>
          <el-select v-model="createForm.bladeId" class="full-width" placeholder="一次派工只能覆盖同一叶片">
            <el-option
              v-for="group in dispatchableBlades"
              :key="group.bladeId"
              :label="`${group.label}（${group.defects.length} 条可派工缺陷）`"
              :value="group.bladeId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="覆盖缺陷" required>
          <el-checkbox-group v-model="createForm.defectIds" class="defect-check-group">
            <el-checkbox
              v-for="option in bladeDispatchOptions"
              :key="option.defect.id"
              :value="option.defect.id"
            >
              {{ defectOptionLabel(option) }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="派工班组">
          <el-select v-model="createForm.team" class="full-width">
            <el-option v-for="team in WORK_TEAMS" :key="team" :label="team" :value="team" />
          </el-select>
        </el-form-item>
        <el-form-item label="限期">
          <el-date-picker v-model="createForm.dueDate" type="date" value-format="YYYY-MM-DD" />
          <el-button link type="primary" class="quick-date" @click="createForm.dueDate = dateAfter(3)">
            +3 天
          </el-button>
          <el-button link type="primary" @click="createForm.dueDate = dateAfter(14)">+14 天</el-button>
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="勾选的多条缺陷合并为一张作业单，同班组、同限期一次派工完成。"
        />
        <el-alert
          v-if="dispatchable.length === 0"
          type="warning"
          :closable="false"
          show-icon
          title="当前没有可派工的缺陷：所有缺陷都已修复或已存在作业单。"
        />
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createSubmitting"
          :disabled="bladeDispatchOptions.length === 0"
          @click="submitCreate"
        >
          确认派工（{{ createForm.defectIds.length }} 条）
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="acceptVisible" title="验收登记 · 逐条复验" width="780px" destroy-on-close>
      <div v-if="acceptTarget" class="accept-head">
        <span class="mono">#{{ acceptTarget.order.id.slice(-6) }}</span>
        <span class="muted unit">
          {{ acceptTarget.turbine?.code }}｜叶片 {{ acceptTarget.blade?.serial }}｜{{ acceptTarget.order.team }}｜限期 {{ acceptTarget.order.dueDate }}
        </span>
      </div>
      <el-table :data="acceptTarget?.items ?? []" size="small" border max-height="320">
        <el-table-column label="分段 / 缺陷" min-width="220">
          <template #default="{ row: item }">
            <div v-if="item.defect" class="cell-stack">
              <span>{{ item.segment ? `第 ${item.segment.index} 段` : '分段缺失' }}｜{{ item.defect.type }}（{{ item.defect.severity }}）</span>
              <span class="muted">{{ faceText(item.defect.face) }}｜{{ item.defect.positionM }} m</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="复验结论" width="220">
          <template #default="{ row: item }">
            <el-radio-group
              v-if="item.defect"
              v-model="acceptForm[item.defect.id].verdict"
            >
              <el-radio value="已修复">已修复</el-radio>
              <el-radio value="未通过">未通过</el-radio>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column label="复验备注 / 返工说明" min-width="200">
          <template #default="{ row: item }">
            <el-input
              v-if="item.defect"
              v-model="acceptForm[item.defect.id].note"
              size="small"
              placeholder="如 返修复发、待补材等"
            />
          </template>
        </el-table-column>
      </el-table>
      <el-form label-width="80px" class="accept-form">
        <el-form-item label="验收人" required>
          <el-input v-model="acceptAcceptor" placeholder="如 赵鹏" clearable />
        </el-form-item>
      </el-form>
      <el-alert
        :type="acceptPendingCount === 0 ? 'success' : 'warning'"
        :closable="false"
        show-icon
        :title="
          acceptPendingCount === 0
            ? '全部缺陷已登记为「已修复」，可以闭环验收。'
            : `还有 ${acceptPendingCount} 条缺陷未登记为「已修复」，保存后作业单留在待复验，不能闭环。`
        "
      />
      <template #footer>
        <el-button @click="acceptVisible = false">取消</el-button>
        <el-button :loading="acceptSubmitting" @click="saveResults">保存登记</el-button>
        <el-button
          type="primary"
          :loading="acceptSubmitting"
          :disabled="acceptPendingCount > 0 || !acceptAcceptor.trim()"
          @click="submitAccept"
        >
          全部通过，闭环验收
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑作业单" width="560px" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="派工班组">
          <el-select v-model="editForm.team" class="full-width">
            <el-option v-for="team in WORK_TEAMS" :key="team" :label="team" :value="team" />
          </el-select>
        </el-form-item>
        <el-form-item label="限期">
          <el-date-picker v-model="editForm.dueDate" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="工单状态">
          <el-select v-model="editForm.state" class="full-width">
            <el-option v-for="state in WORK_ORDER_STATES" :key="state" :label="state" :value="state" />
          </el-select>
        </el-form-item>
        <el-form-item label="验收人">
          <el-input v-model="editForm.acceptor" placeholder="闭环时填写的验收人" clearable />
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="手工把状态改为「已闭环」会为未登记缺陷补登「已修复」并回写；改回非闭环会清空复验结论，缺陷回到已派工。"
        />
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.state-pill {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.full-width {
  width: 100%;
}

.quick-date {
  margin-left: 8px;
}

.unit {
  margin-left: 8px;
  font-size: 12px;
}

.progress-text {
  font-size: 12px;
}

.defect-panel {
  padding: 8px 16px 12px;
  background: #f7fafb;
}

.defect-panel__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 13px;
}

.defect-subtable {
  width: 100%;
}

.defect-check-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--line, #dcdfe6);
  border-radius: 6px;
}

.accept-head {
  margin-bottom: 12px;
  font-size: 14px;
}

.accept-form {
  margin-top: 12px;
}
</style>
