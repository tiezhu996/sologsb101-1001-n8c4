<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Check, Plus, Refresh, RefreshLeft, Right } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useWorkOrderStore, type DispatchOption, type WorkOrderItem, type WorkOrderRow } from '@/stores/workOrderStore'
import { useBladeStore } from '@/stores/bladeStore'
import {
  WORK_ORDER_STATE_COLOR,
  WORK_ORDER_STATES,
  WORK_TEAMS,
  type WorkOrderState
} from '@/types/workOrder'
import { hasRepairResult } from '@/types/defect'
import { seedDemoData } from '@/utils/db'

const router = useRouter()
const workOrderStore = useWorkOrderStore()
const bladeStore = useBladeStore()

function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

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
  const today = new Date(`${todayString()}T00:00:00`).getTime()
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

const queryKeys = {
  keyword: 'kw',
  teams: 'team',
  states: 'state',
  onlyOverdue: 'overdue'
}

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

function hasRepair(item: WorkOrderItem): boolean {
  return hasRepairResult(item.defect)
}

/* ---------------- 新建作业单（一次派工覆盖同叶片多条缺陷） ---------------- */
const createVisible = ref(false)
const createSubmitting = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive({
  bladeId: '',
  defectIds: [] as string[],
  team: WORK_TEAMS[0],
  dueDate: dateAfter(7)
})

const createRules: FormRules = {
  bladeId: [{ required: true, message: '请选择叶片', trigger: 'change' }],
  defectIds: [{ required: true, type: 'array', min: 1, message: '请至少选择一条缺陷', trigger: 'change' }]
}

const dispatchable = computed<DispatchOption[]>(() => workOrderStore.dispatchableDefects)

/** 有可派工缺陷的叶片选项（机组｜叶片） */
const bladeOptions = computed(() => {
  const seen = new Map<string, { label: string; value: string }>()
  dispatchable.value.forEach((row) => {
    if (!row.blade || seen.has(row.blade.id)) return
    seen.set(row.blade.id, {
      label: `${row.turbine?.code ?? '未知机组'}｜叶片 ${row.blade.serial}`,
      value: row.blade.id
    })
  })
  return Array.from(seen.values())
})

/** 当前叶片下可派工的缺陷 */
const defectOptions = computed<DispatchOption[]>(() =>
  dispatchable.value.filter((row) => row.blade?.id === createForm.bladeId)
)

function defectOptionLabel(row: DispatchOption): string {
  const segment = row.segment ? `第 ${row.segment.index} 段` : '分段缺失'
  return `${segment}｜${row.defect.type}（${row.defect.severity}）｜${row.defect.positionM} m`
}

function handleCreateBladeChange(bladeId: string): void {
  createForm.bladeId = bladeId
  // 默认全选该叶片可派工缺陷：一次高空检修尽量一次派完
  createForm.defectIds = defectOptions.value.map((row) => row.defect.id)
}

function openCreate(): void {
  const firstBlade = bladeOptions.value[0]?.value ?? ''
  createForm.bladeId = firstBlade
  createForm.team = WORK_TEAMS[0]
  createForm.dueDate = dateAfter(7)
  createForm.defectIds = []
  if (firstBlade) handleCreateBladeChange(firstBlade)
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!createFormRef.value) return
  const valid = await createFormRef.value.validate().catch(() => false)
  if (!valid) return
  createSubmitting.value = true
  try {
    const order = await workOrderStore.dispatchGroup(createForm.defectIds, createForm.team, createForm.dueDate)
    if (!order) {
      ElMessage.warning('所选缺陷均不可派工（已修复或已在其他作业单中）')
      return
    }
    createVisible.value = false
    ElMessage.success(
      `已生成 1 张作业单（覆盖 ${order.defectIds.length} 条缺陷），派工给「${createForm.team}」，限期 ${createForm.dueDate}`
    )
  } finally {
    createSubmitting.value = false
  }
}

/* ---------------- 修复结果登记 ---------------- */
const repairVisible = ref(false)
const repairSubmitting = ref(false)
const repairTarget = ref<{ row: WorkOrderRow; item: WorkOrderItem } | null>(null)
const repairFormRef = ref<FormInstance>()
const repairForm = reactive({ result: '' })
const repairRules: FormRules = {
  result: [{ required: true, message: '请填写修复结果', trigger: 'blur' }]
}

function openRepair(row: WorkOrderRow, item: WorkOrderItem): void {
  repairTarget.value = { row, item }
  repairForm.result = item.defect.repairResult ?? ''
  repairVisible.value = true
}

async function submitRepair(): Promise<void> {
  if (!repairFormRef.value || !repairTarget.value) return
  const valid = await repairFormRef.value.validate().catch(() => false)
  if (!valid) return
  repairSubmitting.value = true
  try {
    await workOrderStore.registerRepairResult(repairTarget.value.item.defect.id, repairForm.result)
    repairVisible.value = false
    ElMessage.success('修复结果已登记')
  } finally {
    repairSubmitting.value = false
  }
}

/* ---------------- 状态流转与验收 ---------------- */
async function advance(row: WorkOrderRow): Promise<void> {
  if (row.order.state === '待复验') {
    if (!row.readyToClose) {
      ElMessage.warning(
        `还有 ${row.items.length - row.registeredCount} 条缺陷未登记修复结果，全部登记后才能验收闭环`
      )
      return
    }
    openAccept(row)
    return
  }
  const next = await workOrderStore.advanceState(row.order.id)
  if (next) ElMessage.success(`作业单已推进到「${next}」`)
  else ElMessage.info('该作业单已闭环，如需修正请使用「撤回验收」')
}

const acceptVisible = ref(false)
const acceptSubmitting = ref(false)
const acceptTarget = ref<WorkOrderRow | null>(null)
const acceptForm = reactive({ acceptor: '' })
const acceptFormRef = ref<FormInstance>()
const acceptRules: FormRules = {
  acceptor: [{ required: true, message: '请填写验收人', trigger: 'blur' }]
}

function openAccept(row: WorkOrderRow): void {
  acceptTarget.value = row
  acceptForm.acceptor = row.order.acceptor || ''
  acceptVisible.value = true
}

async function submitAccept(): Promise<void> {
  if (!acceptFormRef.value || !acceptTarget.value) return
  const valid = await acceptFormRef.value.validate().catch(() => false)
  if (!valid) return
  acceptSubmitting.value = true
  try {
    const result = await workOrderStore.acceptOrder(acceptTarget.value.order.id, acceptForm.acceptor)
    if (!result.ok) {
      acceptVisible.value = false
      ElMessage.warning(
        `还有 ${result.missing.length} 条缺陷未登记修复结果，作业单保留在「待复验」`
      )
      return
    }
    acceptVisible.value = false
    ElMessage.success('验收通过，作业单已闭环，所含缺陷已回写为「已修复」')
  } finally {
    acceptSubmitting.value = false
  }
}

async function reopen(row: WorkOrderRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤回验收会把作业单退回「待复验」，所含 ${row.items.length} 条缺陷一起回到「已派工」。确认撤回？`,
      '撤回验收确认',
      { type: 'warning', confirmButtonText: '确认撤回', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await workOrderStore.reopenOrder(row.order.id)
  ElMessage.success('已撤回验收，所含缺陷已回到「已派工」')
}

/* ---------------- 编辑 / 撤单 ---------------- */
const editVisible = ref(false)
const editSubmitting = ref(false)
const editId = ref<string | null>(null)
const editForm = reactive({
  team: WORK_TEAMS[0],
  dueDate: todayString(),
  state: '待派' as WorkOrderState,
  acceptor: ''
})

function openEdit(row: WorkOrderRow): void {
  editId.value = row.order.id
  editForm.team = row.order.team
  editForm.dueDate = row.order.dueDate
  editForm.state = row.order.state
  editForm.acceptor = row.order.acceptor
  editVisible.value = true
}

async function submitEdit(): Promise<void> {
  if (!editId.value) return
  editSubmitting.value = true
  try {
    const closed = editForm.state === '已闭环'
    await workOrderStore.updateWorkOrder(editId.value, {
      team: editForm.team,
      dueDate: editForm.dueDate,
      state: editForm.state,
      acceptor: editForm.acceptor,
      closedAt: closed ? Date.now() : null
    })
    editVisible.value = false
    ElMessage.success('作业单信息已更新，并同步了所含缺陷状态')
  } finally {
    editSubmitting.value = false
  }
}

async function removeOrder(row: WorkOrderRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认撤掉作业单 #${row.order.id.slice(-6)}（${row.order.team} · ${row.order.state}）？所含 ${row.items.length} 条缺陷会恢复为「待处理」（未派工）。`,
      '撤掉作业单确认',
      { type: 'warning', confirmButtonText: '确认撤单', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await workOrderStore.removeWorkOrder(row.order.id)
  ElMessage.success('作业单已撤掉，所含缺陷恢复未派工')
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
    ElMessage.success('已生成演示数据：2 台机组 × 各 2 片叶片 × 18 条缺陷与 5 张作业单')
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
        <h2>维修工单</h2>
        <p>按作业单管理：一次派工覆盖同叶片、同班组、同限期的多条缺陷；所含缺陷全部登记修复结果后才能验收闭环。</p>
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
      <StatBadge label="待复验" :value="stats.awaiting" suffix="张" tone="primary" icon="Odometer" />
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
      :query-keys="queryKeys"
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
        <el-table-column label="作业单号" width="130">
          <template #default="{ row }">
            <span class="mono">#{{ row.order.id.slice(-6) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="机组 / 叶片" width="130">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.turbine?.code ?? '—' }}</span>
              <span class="muted">叶片 {{ row.blade?.serial ?? '—' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所含缺陷（修复结果登记）" min-width="330">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="muted">共 {{ row.items.length }} 条｜已登记 {{ row.registeredCount }} 条</span>
              <div v-for="item in row.items" :key="item.defect.id" class="defect-line">
                <span class="defect-line__text">
                  {{ item.segment ? `第 ${item.segment.index} 段` : '分段缺失' }} ·
                  {{ item.defect.type }}（{{ item.defect.severity }}）· {{ item.defect.positionM }} m
                </span>
                <el-tag v-if="item.defect.state === '已修复'" size="small" type="success" effect="plain">
                  已修复
                </el-tag>
                <el-tag v-else-if="hasRepair(item)" size="small" type="primary" effect="plain">已登记</el-tag>
                <el-tag v-else size="small" type="warning" effect="plain">待复验</el-tag>
                <el-button
                  v-if="row.order.state !== '已闭环' && item.defect.state !== '已修复'"
                  link
                  type="primary"
                  size="small"
                  @click="openRepair(row, item)"
                >
                  {{ hasRepair(item) ? '修改结果' : '登记结果' }}
                </el-button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="派工班组" prop="order.team" width="130" />
        <el-table-column label="限期" width="150">
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
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <span
              class="state-pill"
              :style="{ color: '#ffffff', backgroundColor: stateColor(row.order.state) }"
            >
              {{ row.order.state }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="验收" width="150">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.order.acceptor || '—' }}</span>
              <span class="muted">{{ formatDateTime(row.order.closedAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.order.state === '待复验' && !row.readyToClose"
              content="所含缺陷全部登记修复结果后才能闭环"
              placement="top"
            >
              <span>
                <el-button link type="primary" :icon="Check" disabled>验收闭环</el-button>
              </span>
            </el-tooltip>
            <el-button
              v-else-if="row.order.state !== '已闭环'"
              link
              type="primary"
              :icon="row.order.state === '待复验' ? Check : Right"
              @click="advance(row)"
            >
              {{ row.order.state === '待复验' ? '验收闭环' : '推进状态' }}
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
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="locate(row)">定位分段</el-button>
            <el-button link type="danger" @click="removeOrder(row)">撤单</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="createVisible" title="新建作业单（派工）" width="640px" destroy-on-close>
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="110px">
        <el-form-item label="叶片" prop="bladeId">
          <el-select
            :model-value="createForm.bladeId"
            filterable
            class="full-width"
            placeholder="选择要检修的叶片"
            @change="handleCreateBladeChange"
          >
            <el-option
              v-for="option in bladeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="所含缺陷" prop="defectIds">
          <el-select
            v-model="createForm.defectIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            class="full-width"
            placeholder="选择该叶片上本次一起处理的缺陷"
          >
            <el-option
              v-for="row in defectOptions"
              :key="row.defect.id"
              :label="defectOptionLabel(row)"
              :value="row.defect.id"
            />
          </el-select>
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
          v-if="dispatchable.length === 0"
          type="warning"
          :closable="false"
          show-icon
          title="当前没有可派工的缺陷：所有缺陷都已修复或已存在作业单。"
        />
        <el-alert
          v-else
          type="info"
          :closable="false"
          show-icon
          title="一张作业单只覆盖同一叶片的缺陷；跨叶片请分开建单，或在缺陷标注台批量派工（自动按叶片分组）。"
        />
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createSubmitting"
          :disabled="createForm.defectIds.length === 0"
          @click="submitCreate"
        >
          确认派工
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="repairVisible" title="登记修复结果" width="560px" destroy-on-close>
      <el-form ref="repairFormRef" :model="repairForm" :rules="repairRules" label-width="100px">
        <el-form-item label="缺陷">
          <span>
            {{ repairTarget?.item.defect.type }}（{{ repairTarget?.item.defect.severity }}）
          </span>
          <span class="muted unit">
            {{ repairTarget?.item.segment ? `第 ${repairTarget.item.segment.index} 段` : '分段缺失' }}｜
            {{ repairTarget?.item.defect.positionM }} m
          </span>
        </el-form-item>
        <el-form-item label="作业单">
          <span class="mono">#{{ repairTarget?.row.order.id.slice(-6) }}</span>
          <span class="muted unit">{{ repairTarget?.row.order.team }}｜限期 {{ repairTarget?.row.order.dueDate }}</span>
        </el-form-item>
        <el-form-item label="修复结果" prop="result">
          <el-input
            v-model="repairForm.result"
            type="textarea"
            :rows="3"
            placeholder="如：裂纹开槽灌注结构胶，打磨找平，复测合格"
          />
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="所含缺陷全部登记修复结果后，作业单才能验收闭环；未登记的缺陷会留在「待复验」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="repairVisible = false">取消</el-button>
        <el-button type="primary" :loading="repairSubmitting" @click="submitRepair">保存登记</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="acceptVisible" title="闭环验收" width="520px" destroy-on-close>
      <el-form ref="acceptFormRef" :model="acceptForm" :rules="acceptRules" label-width="100px">
        <el-form-item label="作业单">
          <span class="mono">#{{ acceptTarget?.order.id.slice(-6) }}</span>
          <span class="muted unit">
            {{ acceptTarget?.order.team }}｜限期 {{ acceptTarget?.order.dueDate }}｜覆盖缺陷
            {{ acceptTarget?.items.length ?? 0 }} 条
          </span>
        </el-form-item>
        <el-form-item label="验收人" prop="acceptor">
          <el-input v-model="acceptForm.acceptor" placeholder="如 赵鹏" clearable />
        </el-form-item>
        <el-alert
          type="success"
          :closable="false"
          show-icon
          title="验收通过后作业单置为「已闭环」，所含缺陷一起回写为「已修复」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="acceptVisible = false">取消</el-button>
        <el-button type="primary" :loading="acceptSubmitting" @click="submitAccept">确认验收</el-button>
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
          title="手工把状态改为「已闭环」会把所含缺陷一起回写为「已修复」，并记录闭环时间。"
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

.defect-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.defect-line__text {
  min-width: 0;
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
</style>
