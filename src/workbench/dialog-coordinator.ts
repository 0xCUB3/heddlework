import type { PiSessionTreeOption } from '../pi/session-tree.ts'
import type { ExtensionUiRequest, RpcRecord } from '../pi/types.ts'
import { errorMessage } from '../pi/types.ts'
import {
  addNotice,
  type ExtensionDialog,
  type ExtensionWidget,
  type WorkbenchState,
} from './state.ts'
import { currentTurnTracePosition } from './timeline.ts'
import {
  buildAskUserDialogActions,
  dialogMatchesAskUserAction,
  questionnaireFromTool,
  questionnaireMatchesDialog,
  type AskUserDialogAction,
  type AskUserSubmissionAnswer,
} from './ask-user.ts'
import {
  activeQuestionSurface,
  buildNativeQuestionDialogActions,
  customUiResultFromAnswer,
  dialogAgreesWithQuestion,
  encodeNativeQuestionAnswer,
  questionIdentityMatch,
  type NativeQuestion,
} from './native-question.ts'

interface AskUserDialogDriver {
  toolCallId: string
  actions: AskUserDialogAction[]
}

interface NativeQuestionDialogDriver {
  requestId: string
  actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string; optionIndex?: number }>
}

interface DialogCoordinatorHost {
  getState(): WorkbenchState
  patch(patch: Partial<WorkbenchState>): void
  setState(update: (state: WorkbenchState) => WorkbenchState): void
  send(record: RpcRecord): void
  ownership?(): 'owned' | 'attached' | undefined
}

interface DialogResponse {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

export class WorkbenchDialogCoordinator {
  readonly #host: DialogCoordinatorHost
  #dialogTimer: ReturnType<typeof setTimeout> | undefined
  #askUserDialogDriver: AskUserDialogDriver | undefined
  #nativeQuestionDriver: NativeQuestionDialogDriver | undefined
  #nextLocalDialogId = 0
  readonly #localDialogResponses = new Map<string, (response: DialogResponse) => void>()
  readonly #answered = new Set<string>()

  constructor(host: DialogCoordinatorHost) {
    this.#host = host
  }

  handleExtensionUi(request: ExtensionUiRequest, sessionTransitioning: boolean): void {
    if (sessionTransitioning) {
      if (isInteractiveRequest(request)) {
        try {
          this.#host.send({ type: 'extension_ui_response', id: request.id, cancelled: true })
        } catch {
          // The abandoned session no longer owns visible UI; switching remains authoritative.
        }
      }
      return
    }
    if (request.method === 'notify') {
      this.#host.setState((state) => addNotice(state, request.notifyType ?? 'info', request.message ?? 'Pi notification', currentTurnTracePosition(state.messages, state.liveAssistant, state.liveTools, state.forkMessages)))
      return
    }
    if (request.method === 'setStatus') {
      const state = this.#host.getState()
      const key = request.statusKey ?? request.id
      const statusItems = { ...state.statusItems }
      if (request.statusText) statusItems[key] = request.statusText
      else delete statusItems[key]
      this.#host.patch({ statusItems })
      return
    }
    if (request.method === 'setWidget') {
      const state = this.#host.getState()
      const key = request.widgetKey ?? request.id
      const widgets = { ...state.widgets }
      if (request.widgetLines) {
        const widget: ExtensionWidget = {
          key,
          lines: request.widgetLines,
          placement: request.widgetPlacement ?? 'aboveEditor',
        }
        widgets[key] = widget
      } else {
        delete widgets[key]
      }
      this.#host.patch({ widgets })
      return
    }
    if (request.method === 'setTitle') {
      this.#host.patch({ windowTitle: request.title ?? 'Heddlework' })
      return
    }
    if (request.method === 'set_editor_text') {
      this.#host.patch({ editorText: request.text ?? '' })
      return
    }

    const createdAt = Date.now()
    const method = request.method === 'unsupported' ? 'unsupported' as const : request.method
    const dialog: ExtensionDialog = {
      id: request.id,
      method: method === 'select' || method === 'confirm' || method === 'input' || method === 'editor' || method === 'unsupported' ? method : 'select',
      title: request.title ?? (method === 'unsupported' ? 'Terminal-only extension UI' : 'Pi needs your input'),
      createdAt,
      ...(request.message === undefined ? {} : { message: request.message }),
      ...(request.options === undefined ? {} : { options: request.options }),
      ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
      ...(request.timeout === undefined ? {} : { timeout: request.timeout, deadlineAt: createdAt + request.timeout }),
      ...(request.nativeQuestion ? { nativeQuestion: request.nativeQuestion as unknown as NativeQuestion } : {}),
    }
    const state = this.#host.getState()
    if (isSessionOnlyDialog(dialog) && !hasActiveConversation(state)) {
      this.#sendDialogResponse(dialog.id, { cancelled: true })
      return
    }
    if (this.#tryDriveAskUserDialog(dialog, false)) return
    if (this.#tryDriveNativeQuestionDialog(dialog, false)) return
    if (method === 'unsupported') {
      const surface = activeQuestionSurface(state)
      if (surface?.kind === 'question' || surface?.kind === 'tabbed') {
        this.#host.setState((current) => addNotice(
          current,
          'info',
          request.message ?? 'Terminal-only extension UI is waiting in the Pi terminal.',
        ))
        return
      }
    }
    this.#enqueueDialog(dialog)
  }

  handleNativeQuestion(question: NativeQuestion, sessionTransitioning: boolean): void {
    if (sessionTransitioning || this.#answered.has(question.requestId) || (question.toolCallId !== undefined && this.#answered.has(question.toolCallId))) return
    const existing = this.#host.getState().dialog
    const sameSurface = existing && (
      existing.id === question.requestId
      || existing.nativeQuestion?.requestId === question.requestId
      || (question.toolCallId !== undefined && (existing.id === question.toolCallId || existing.nativeQuestion?.toolCallId === question.toolCallId))
    )
    if (sameSurface && existing) {
      if (existing.id === question.requestId && existing.nativeQuestion?.requestId === question.requestId) return
      this.#host.patch({
        dialog: {
          ...existing,
          id: question.requestId,
          title: question.stem,
          nativeQuestion: question,
          ...(question.description ? { message: question.description } : {}),
          options: question.options.map((option) => option.label),
        },
      })
      return
    }
    this.#enqueueDialog({
      id: question.requestId,
      method: question.kind === 'unsupported' ? 'unsupported' : question.kind === 'text' ? 'editor' : 'select',
      title: question.stem,
      createdAt: Date.now(),
      ...(question.description ? { message: question.description } : {}),
      options: question.options.map((option) => option.label),
      nativeQuestion: question,
    })
  }

  restorePrompts(prompts: readonly RpcRecord[], sessionTransitioning: boolean): void {
    for (const prompt of prompts) {
      if (prompt.type === 'heddlework_native_question' && prompt.question && typeof prompt.question === 'object') {
        this.handleNativeQuestion(prompt.question as NativeQuestion, sessionTransitioning)
        continue
      }
      if (prompt.type === 'extension_ui_request') this.handleExtensionUi(prompt as ExtensionUiRequest, sessionTransitioning)
    }
  }

  showLocalSelect(title: string, options: string[], onResponse: (response: DialogResponse) => void): void {
    const id = `workbench-select-${++this.#nextLocalDialogId}`
    this.#localDialogResponses.set(id, onResponse)
    this.#enqueueDialog({ id, method: 'select', title, options, createdAt: Date.now() })
  }

  showLocalTree(title: string, treeOptions: PiSessionTreeOption[], onResponse: (response: DialogResponse) => void): void {
    const id = `workbench-tree-${++this.#nextLocalDialogId}`
    this.#localDialogResponses.set(id, onResponse)
    this.#enqueueDialog({ id, method: 'tree', title, treeOptions, createdAt: Date.now() })
  }

  showLocalInput(title: string, placeholder: string, onResponse: (response: DialogResponse) => void): void {
    const id = `workbench-input-${++this.#nextLocalDialogId}`
    this.#localDialogResponses.set(id, onResponse)
    this.#enqueueDialog({ id, method: 'input', title, placeholder, createdAt: Date.now() })
  }

  respond(response: DialogResponse): void {
    const dialog = this.#host.getState().dialog
    if (!dialog) return
    this.#removeDialog(dialog.id)
    this.#dropInputNotice(dialog.id)
    this.#sendDialogResponse(dialog.id, response)
  }

  dismiss(id: string): void {
    const state = this.#host.getState()
    const pending = [state.dialog, ...state.dialogQueue].find((dialog) => dialog?.id === id)
    if (!pending) return
    this.#removeDialog(id)
    this.#dropInputNotice(id)
  }

  submitQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[], note?: string): void {
    if (this.#answered.has(toolCallId)) {
      this.#host.setState((current) => addNotice(current, 'warning', 'That question was already answered'))
      return
    }
    const state = this.#host.getState()
    const surface = activeQuestionSurface(state)
    if (surface?.kind === 'question' && questionIdentityMatch(surface.question, toolCallId)) {
      this.#submitNativeQuestion(surface.question, answers, note)
      return
    }
    const tool = state.liveTools.find((candidate) => candidate.id === toolCallId)
    const questionnaire = tool ? questionnaireFromTool(tool) : undefined
    const dialog = state.dialog
    if (!questionnaire || !dialog || !questionnaireMatchesDialog(questionnaire, dialog)) {
      this.#host.setState((current) => addNotice(current, 'warning', 'The questionnaire is no longer awaiting this response'))
      return
    }
    try {
      this.#askUserDialogDriver = {
        toolCallId,
        actions: buildAskUserDialogActions(questionnaire, answers),
      }
      this.#host.patch({ questionnaireSubmitting: toolCallId, questionnaireCollapsed: undefined })
      if (!this.#tryDriveAskUserDialog(dialog, true)) {
        this.#askUserDialogDriver = undefined
        this.#host.patch({ questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
        this.#host.setState((current) => addNotice(current, 'error', 'The questionnaire dialog sequence did not match the active tool'))
      } else {
        this.#answered.add(toolCallId)
      }
    } catch (error) {
      this.#host.setState((current) => addNotice(current, 'warning', errorMessage(error)))
    }
  }

  cancelQuestionnaire(toolCallId: string): void {
    const state = this.#host.getState()
    const surface = activeQuestionSurface(state)
    if (surface?.kind === 'unsupported' && questionIdentityMatch(surface.question, toolCallId)) {
      if (state.dialog && (state.dialog.id === toolCallId || state.dialog.nativeQuestion?.requestId === toolCallId)) {
        this.respond({ cancelled: true })
      }
      return
    }
    if (surface?.kind === 'question' && questionIdentityMatch(surface.question, toolCallId)) {
      this.#answered.add(surface.question.requestId)
      if (surface.question.toolCallId) this.#answered.add(surface.question.toolCallId)
      this.#nativeQuestionDriver = undefined
      this.#host.patch({ questionnaireSubmitting: surface.question.requestId, questionnaireCollapsed: undefined })
      if (this.#host.ownership?.() === 'attached') {
        this.#answerNativeQuestion(surface.question, { contract: 'heddlework.question.v1.answer', requestId: surface.question.requestId, cancelled: true })
      }
      if (state.dialog && (state.dialog.id === surface.question.requestId || dialogAgreesWithQuestion(state.dialog, surface.question))) {
        this.respond({ cancelled: true })
      }
      return
    }
    const tool = state.liveTools.find((candidate) => candidate.id === toolCallId)
    const questionnaire = tool ? questionnaireFromTool(tool) : undefined
    if (!questionnaire || !questionnaireMatchesDialog(questionnaire, state.dialog)) return
    this.#askUserDialogDriver = undefined
    this.#answered.add(toolCallId)
    this.#host.patch({ questionnaireSubmitting: toolCallId, questionnaireCollapsed: undefined })
    this.respond({ cancelled: true })
  }

  setQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void {
    const state = this.#host.getState()
    const surface = activeQuestionSurface(state)
    if (surface?.kind === 'question' && questionIdentityMatch(surface.question, toolCallId)) {
      this.#host.patch({ questionnaireCollapsed: collapsed ? surface.question.requestId : undefined })
      return
    }
    const tool = state.liveTools.find((candidate) => candidate.id === toolCallId)
    const questionnaire = tool ? questionnaireFromTool(tool) : undefined
    if (!questionnaire || (!questionnaireMatchesDialog(questionnaire, state.dialog) && state.questionnaireCollapsed !== toolCallId && state.questionnaireSubmitting !== toolCallId)) return
    this.#host.patch({ questionnaireCollapsed: collapsed ? toolCallId : undefined })
  }

  handleToolExecutionEnd(toolCallId: string): void {
    if (this.#askUserDialogDriver?.toolCallId === toolCallId) this.#askUserDialogDriver = undefined
    if (this.#nativeQuestionDriver?.requestId === toolCallId) this.#nativeQuestionDriver = undefined
    this.#answered.delete(toolCallId)
    const state = this.#host.getState()
    const dialog = state.dialog
    if (dialog?.nativeQuestion?.toolCallId === toolCallId) this.#answered.delete(dialog.nativeQuestion.requestId)
    if (state.questionnaireSubmitting === toolCallId || state.questionnaireCollapsed === toolCallId
      || (dialog?.nativeQuestion && questionIdentityMatch(dialog.nativeQuestion, toolCallId) && (
        state.questionnaireSubmitting === dialog.nativeQuestion.requestId
        || state.questionnaireCollapsed === dialog.nativeQuestion.requestId
      ))) {
      this.#host.patch({ questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
    }
    if (dialog && (dialog.id === toolCallId || dialog.nativeQuestion?.requestId === toolCallId || dialog.nativeQuestion?.toolCallId === toolCallId)) {
      this.#removeDialog(dialog.id)
    }
  }

  cancelAll(): void {
    const state = this.#host.getState()
    const pending = [state.dialog, ...state.dialogQueue]
      .filter((dialog): dialog is ExtensionDialog => dialog !== undefined)
    this.#askUserDialogDriver = undefined
    this.#nativeQuestionDriver = undefined
    this.#answered.clear()
    this.#host.patch({ dialog: undefined, dialogQueue: [], questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
    this.#clearDialogTimer()
    for (const dialog of pending) {
      this.#dropInputNotice(dialog.id)
      this.#sendDialogResponse(dialog.id, { cancelled: true })
    }
  }

  #dropInputNotice(dialogId: string): void {
    this.#host.setState((state) => ({
      ...state,
      notices: state.notices.filter((notice) => notice.eventId !== `input:${dialogId}`),
    }))
  }

  dispose(): void {
    this.cancelAll()
  }

  #submitNativeQuestion(question: NativeQuestion, answers: readonly AskUserSubmissionAnswer[], note?: string): void {
    const state = this.#host.getState()
    try {
      const encoded = encodeNativeQuestionAnswer(question, answers, note)
      const attached = this.#host.ownership?.() === 'attached'
      const useLiveAnswer = attached && question.responseShape !== 'rpc-dialog'
      this.#host.patch({ questionnaireSubmitting: question.requestId, questionnaireCollapsed: undefined })
      this.#answered.add(question.requestId)
      if (question.toolCallId) this.#answered.add(question.toolCallId)
      if (useLiveAnswer) {
        this.#answerNativeQuestion(question, encoded)
        if (state.dialog && (state.dialog.id === question.requestId || dialogAgreesWithQuestion(state.dialog, question))) {
          this.#removeDialog(state.dialog.id)
        }
        return
      }
      const dialog = state.dialog
      this.#nativeQuestionDriver = {
        requestId: question.requestId,
        actions: buildNativeQuestionDialogActions(question, answers, note),
      }
      if (!dialog || !dialogAgreesWithQuestion(dialog, question)) return
      if (!this.#tryDriveNativeQuestionDialog(dialog, true)) {
        this.#nativeQuestionDriver = undefined
        this.#answered.delete(question.requestId)
        this.#host.patch({ questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
        this.#host.setState((current) => addNotice(current, 'error', 'The questionnaire dialog sequence did not match the active tool'))
      }
    } catch (error) {
      this.#answered.delete(question.requestId)
      this.#host.setState((current) => addNotice(current, 'warning', errorMessage(error)))
    }
  }

  #answerNativeQuestion(question: NativeQuestion, answer: ReturnType<typeof encodeNativeQuestionAnswer>): void {
    try {
      this.#host.send({
        type: 'answer_native_question',
        requestId: question.requestId,
        id: question.requestId,
        ...(question.toolCallId ? { toolCallId: question.toolCallId } : {}),
        answer: {
          ...answer,
          result: customUiResultFromAnswer(question, answer),
        },
      })
    } catch (error) {
      this.#host.setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  #tryDriveNativeQuestionDialog(dialog: ExtensionDialog, stored: boolean): boolean {
    const driver = this.#nativeQuestionDriver
    const action = driver?.actions[0]
    if (!driver || !action || dialog.method !== action.method) return false
    let response: { value: string }
    if (action.method === 'select') {
      const value = dialog.options?.[action.optionIndex ?? -1]
      if (value === undefined) return false
      response = { value }
    } else {
      response = { value: action.value ?? '' }
    }
    driver.actions.shift()
    if (driver.actions.length === 0) this.#nativeQuestionDriver = undefined
    if (stored) this.#removeDialog(dialog.id)
    this.#sendDialogResponse(dialog.id, response)
    return true
  }

  #enqueueDialog(dialog: ExtensionDialog): void {
    const state = this.#host.getState()
    if (!state.dialog) this.#host.patch({ dialog })
    else this.#host.patch({ dialogQueue: [...state.dialogQueue, dialog] })
    this.#scheduleDialogTimer()
    if (dialog.id.startsWith('workbench-')) return
    this.#host.setState((current) => addNotice(current, 'warning', dialog.title || 'Input needed', {
      channel: 'ledger',
      reason: 'input',
      eventId: `input:${dialog.id}`,
    }))
  }

  #tryDriveAskUserDialog(dialog: ExtensionDialog, stored: boolean): boolean {
    const driver = this.#askUserDialogDriver
    const action = driver?.actions[0]
    if (!driver || !action || !dialogMatchesAskUserAction(dialog, action)) return false
    let response: { value: string }
    if (action.method === 'select') {
      const value = dialog.options?.[action.optionIndex ?? -1]
      if (value === undefined) return false
      response = { value }
    } else {
      response = { value: action.value ?? '' }
    }
    driver.actions.shift()
    if (driver.actions.length === 0) this.#askUserDialogDriver = undefined
    if (stored) this.#removeDialog(dialog.id)
    this.#sendDialogResponse(dialog.id, response)
    return true
  }

  #sendDialogResponse(id: string, response: DialogResponse): void {
    const localResponse = this.#localDialogResponses.get(id)
    if (localResponse) {
      this.#localDialogResponses.delete(id)
      try {
        localResponse(response)
      } catch (error) {
        this.#host.setState((state) => addNotice(state, 'error', errorMessage(error)))
      }
      return
    }
    try {
      this.#host.send({ type: 'extension_ui_response', id, ...response })
    } catch (error) {
      this.#host.setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  #removeDialog(id: string): void {
    const state = this.#host.getState()
    const pending = [state.dialog, ...state.dialogQueue]
      .filter((dialog): dialog is ExtensionDialog => dialog !== undefined && dialog.id !== id)
    this.#host.patch({ dialog: pending[0], dialogQueue: pending.slice(1) })
    this.#scheduleDialogTimer()
  }

  #scheduleDialogTimer(): void {
    this.#clearDialogTimer()
    const state = this.#host.getState()
    const deadlines = [state.dialog, ...state.dialogQueue]
      .flatMap((dialog) => dialog?.deadlineAt === undefined ? [] : [dialog.deadlineAt])
    const nextDeadline = deadlines.length > 0 ? Math.min(...deadlines) : undefined
    if (nextDeadline === undefined) return
    this.#dialogTimer = setTimeout(() => {
      this.#dialogTimer = undefined
      const now = Date.now()
      const current = this.#host.getState()
      const pending = [current.dialog, ...current.dialogQueue]
        .filter((dialog): dialog is ExtensionDialog => dialog !== undefined)
        .filter((dialog) => dialog.deadlineAt === undefined || now < dialog.deadlineAt + 50)
      this.#host.patch({ dialog: pending[0], dialogQueue: pending.slice(1) })
      this.#scheduleDialogTimer()
    }, Math.max(0, nextDeadline + 50 - Date.now()))
  }

  #clearDialogTimer(): void {
    if (this.#dialogTimer) clearTimeout(this.#dialogTimer)
    this.#dialogTimer = undefined
  }
}

function isInteractiveRequest(request: ExtensionUiRequest): boolean {
  return request.method === 'select' || request.method === 'confirm' || request.method === 'input' || request.method === 'editor' || request.method === 'unsupported'
}

function hasActiveConversation(state: WorkbenchState): boolean {
  return state.session.isStreaming
    || state.liveAssistant !== undefined
    || state.liveTools.length > 0
    || state.messages.some((message) => message.role === 'user' || message.role === 'assistant')
}

function isSessionOnlyDialog(dialog: ExtensionDialog): boolean {
  return dialog.title.includes('Extend billable human time?')
}
