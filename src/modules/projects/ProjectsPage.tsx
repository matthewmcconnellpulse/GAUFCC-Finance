/**
 * Projects — Karbon-style tracker for the platform build and future feature
 * requests. Access: Pulse (edit) and CEO (watch delivery). Board view
 * (todo / in progress / blocked / done) and a hand-rolled SVG Gantt with
 * dependency arrows and a pink today line. The build plan itself is seeded
 * by the migrations, so the client can watch this very build land.
 */
import { useMemo, useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  LoadingRows,
  PageHeader,
  StatusChip,
  Textarea,
  cx,
} from '@/components/ui'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { Project, ProjectTask, ProjectTaskStatus } from '@/types/db'
import {
  fetchProjects,
  fetchTasks,
  insertProject,
  setTaskStatus,
  PROJECT_STATUS_META,
} from './lib'
import { BoardView, Modal, TaskModal } from './components'
import GanttChart from './GanttChart'

type ViewMode = 'board' | 'gantt'

export default function ProjectsPage() {
  const { isPulse, isCeo } = usePermissions()
  const canView = isPulse || isCeo
  const canEdit = isPulse

  const projectsQuery = useSupabaseQuery(() => fetchProjects(), [])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('board')
  const [taskModal, setTaskModal] = useState<'new' | ProjectTask | null>(null)
  const [projectModal, setProjectModal] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const projects = projectsQuery.data ?? []
  const project = useMemo<Project | null>(() => {
    if (projects.length === 0) return null
    return projects.find((p) => p.id === selectedProjectId) ?? projects[0]
  }, [projects, selectedProjectId])

  const tasksQuery = useSupabaseQuery(
    () => (project ? fetchTasks(project.id) : Promise.resolve([] as ProjectTask[])),
    [project?.id],
  )
  const tasks = tasksQuery.data ?? []
  const doneCount = tasks.filter((t) => t.status === 'done').length

  async function moveTask(task: ProjectTask, status: ProjectTaskStatus) {
    setStatusError(null)
    try {
      await setTaskStatus(task.id, status)
      tasksQuery.refetch()
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'The task could not be moved')
    }
  }

  if (!canView) {
    return (
      <div>
        <PageHeader title="Projects" />
        <Card>
          <EmptyState
            title="No access to the project tracker"
            hint="The delivery tracker is visible to the Pulse team and the CEO."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Delivery tracker for the platform build and future feature requests."
        actions={
          canEdit ? (
            <>
              <Button variant="ghost" onClick={() => setProjectModal(true)}>
                New project
              </Button>
              {project ? (
                <Button variant="primary" onClick={() => setTaskModal('new')}>
                  New task
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      {projectsQuery.loading ? (
        <Card>
          <LoadingRows cols={3} rows={6} />
        </Card>
      ) : projectsQuery.error ? (
        <ErrorNotice message={projectsQuery.error} />
      ) : projects.length === 0 ? (
        <Card>
          <EmptyState
            title="No projects yet"
            hint="The build plan is seeded by the database migrations — once they run it appears here."
            action={canEdit ? <Button variant="primary" onClick={() => setProjectModal(true)}>Create a project</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Project selector */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => {
                const active = project?.id === p.id
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProjectId(p.id)}
                    className={cx(
                      'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11.5px] font-medium border transition-colors',
                      active
                        ? 'bg-indigo text-paper border-indigo'
                        : 'bg-white text-stone-500 border-stone-300 hover:text-indigo',
                    )}
                  >
                    {p.name}
                    <StatusChip tone={PROJECT_STATUS_META[p.status].tone} className={cx(active && 'bg-white/15 !text-paper')}>
                      {PROJECT_STATUS_META[p.status].label}
                    </StatusChip>
                  </button>
                )
              })}
            </div>
            {/* View toggle */}
            <div className="inline-flex bg-white border border-stone-300 rounded-full p-[3px] ml-auto" role="tablist">
              {(['board', 'gantt'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    'rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors',
                    view === v ? 'bg-indigo text-paper' : 'text-stone-500 hover:text-indigo',
                  )}
                >
                  {v === 'board' ? 'Board' : 'Gantt'}
                </button>
              ))}
            </div>
          </div>

          {project ? (
            <>
              {/* Project summary */}
              <Card className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-display text-[18px] text-ink">{project.name}</div>
                    {project.description ? (
                      <p className="text-[12px] text-stone-500 mt-1 max-w-2xl leading-relaxed">{project.description}</p>
                    ) : null}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="figure text-[13px] text-ink">
                      {doneCount} of {tasks.length} done
                    </div>
                    <div className="w-36 h-1.5 rounded-full bg-stone-150 mt-1.5 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-mint-700"
                        style={{ width: tasks.length > 0 ? `${(doneCount / tasks.length) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                </div>
              </Card>

              {statusError ? <ErrorNotice message={statusError} /> : null}

              {/* Tasks */}
              {tasksQuery.loading ? (
                <Card>
                  <LoadingRows cols={4} rows={5} />
                </Card>
              ) : tasksQuery.error ? (
                <ErrorNotice message={tasksQuery.error} />
              ) : tasks.length === 0 ? (
                <Card>
                  <EmptyState
                    title="No tasks in this project"
                    hint={canEdit ? 'Add the first task to start tracking.' : 'Tasks will appear here once Pulse adds them.'}
                    action={canEdit ? <Button variant="primary" onClick={() => setTaskModal('new')}>Add a task</Button> : undefined}
                  />
                </Card>
              ) : view === 'board' ? (
                <BoardView
                  tasks={tasks}
                  canEdit={canEdit}
                  onEdit={(t) => setTaskModal(t)}
                  onStatusChange={(t, s) => void moveTask(t, s)}
                />
              ) : (
                <Card className="p-4">
                  <GanttChart tasks={tasks} canEdit={canEdit} onSelect={(t) => setTaskModal(t)} />
                </Card>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Modals */}
      {taskModal && project ? (
        <TaskModal
          projectId={project.id}
          existing={taskModal === 'new' ? null : taskModal}
          allTasks={tasks}
          onClose={() => setTaskModal(null)}
          onSaved={() => {
            setTaskModal(null)
            tasksQuery.refetch()
          }}
          onDeleted={() => {
            setTaskModal(null)
            tasksQuery.refetch()
          }}
        />
      ) : null}
      {projectModal ? (
        <NewProjectModal
          onClose={() => setProjectModal(false)}
          onSaved={(p) => {
            setProjectModal(false)
            setSelectedProjectId(p.id)
            projectsQuery.refetch()
          }}
          nextSortOrder={projects.length}
        />
      ) : null}
    </div>
  )
}

function NewProjectModal({
  onClose,
  onSaved,
  nextSortOrder,
}: {
  onClose: () => void
  onSaved: (p: Project) => void
  nextSortOrder: number
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) {
      setError('Give the project a name')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const p = await insertProject({
        name: name.trim(),
        description: description.trim() || null,
        status: 'planned',
        sort_order: nextSortOrder,
      })
      onSaved(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The project could not be created')
      setBusy(false)
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <div className="space-y-3.5">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Member communication platform" autoFocus />
        </Field>
        <Field label="Description" hint="What it is and why it matters — feature requests welcome">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
