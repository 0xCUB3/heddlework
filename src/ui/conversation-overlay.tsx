import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchController } from '../workbench/controller.ts'
import {
  questionnaireFromTool,
  questionnaireMatchesDialog,
  type AskUserQuestion,
  type AskUserQuestionnaire,
  type AskUserSubmissionAnswer,
} from '../workbench/ask-user.ts'
import type { ExtensionDialog, WorkbenchState } from '../workbench/state.ts'
import { Button } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import { filterExtensionOptions, parseExtensionOption, parseExtensionTitle } from './extension-ui.ts'
import { openExternal } from './open-external.ts'
import { MotionDiv } from './motion.ts'
import { useResponsiveLayout } from './responsive.tsx'

const DIALOG_TRANSITION_SECONDS = 0.16
const DIALOG_EXIT_DELAY_SECONDS = 0.08
const DIALOG_RETAIN_MS = (DIALOG_TRANSITION_SECONDS + DIALOG_EXIT_DELAY_SECONDS) * 1_000 + 20

interface ExtensionDialogResponse {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

interface AnswerDraft {
  kind: 'none' | 'option' | 'multi' | 'custom'
  optionIndex: number | undefined
  optionIndices: number[]
  custom: string
}

export function ConversationExtensionOverlay({ state, controller }: { state: WorkbenchState; controller: WorkbenchController }) {
  const { mobile } = useResponsiveLayout()
  const questionnaire = useMemo(() => {
    const candidates = state.liveTools.flatMap((tool) => {
      const parsed = questionnaireFromTool(tool)
      return parsed ? [parsed] : []
    })
    return candidates.find((candidate) => (
      candidate.toolCallId === state.questionnaireSubmitting
      || candidate.toolCallId === state.questionnaireCollapsed
      || questionnaireMatchesDialog(candidate, state.dialog)
    ))
  }, [state.dialog, state.liveTools, state.questionnaireCollapsed, state.questionnaireSubmitting])
  const [presentedDialog, beginDialogTransition] = useRetainedDialog(state.dialog)
  const respondToPresentedDialog = (response: ExtensionDialogResponse) => {
    beginDialogTransition()
    controller.respondToDialog(response)
  }

  if (questionnaire && questionnaire.toolCallId === state.questionnaireCollapsed) return null
  if (!questionnaire && !presentedDialog) return null
  return (
    <div
      testId="conversation-extension-overlay"
      style={{
        position: 'absolute',
        ...(questionnaire
          ? { top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.background }
          : { top: mobile ? 8 : 12, right: mobile ? 8 : 16, bottom: mobile ? 8 : 12, left: mobile ? 8 : 16 }),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: questionnaire ? 'center' : 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {questionnaire
        ? <QuestionnaireOverlay key={questionnaire.toolCallId} questionnaire={questionnaire} submitting={state.questionnaireSubmitting === questionnaire.toolCallId} controller={controller} />
        : presentedDialog
          ? <TransitionedGenericDialog dialog={presentedDialog} active={state.dialog?.id === presentedDialog.id} queued={state.dialogQueue.length} onRespond={respondToPresentedDialog} />
          : null}
    </div>
  )
}

function useRetainedDialog(dialog: ExtensionDialog | undefined): readonly [ExtensionDialog | undefined, () => void] {
  const [retained, setRetained] = useState(dialog)
  const retainOnExit = useRef(false)
  useEffect(() => {
    if (dialog) {
      retainOnExit.current = false
      setRetained(dialog)
      return
    }
    if (!retainOnExit.current) {
      setRetained(undefined)
      return
    }
    const timer = setTimeout(() => {
      retainOnExit.current = false
      setRetained(undefined)
    }, DIALOG_RETAIN_MS)
    return () => clearTimeout(timer)
  }, [dialog])
  const presented = dialog ?? (retainOnExit.current ? retained : undefined)
  return [presented, () => { retainOnExit.current = true }]
}

function TransitionedGenericDialog({ dialog, active, queued, onRespond }: { dialog: ExtensionDialog; active: boolean; queued: number; onRespond(response: ExtensionDialogResponse): void }) {
  return (
    <MotionDiv
      testId="extension-dialog-transition"
      initial={{ opacity: 0.96, top: 4 }}
      animate={{ opacity: active ? 1 : 0, top: active ? 0 : 4 }}
      transition={{ duration: DIALOG_TRANSITION_SECONDS, delay: active ? 0 : DIALOG_EXIT_DELAY_SECONDS, ease: 'easeOut' }}
      style={{ position: 'relative', pointerEvents: active ? 'auto' : 'none', width: '100%', maxWidth: 820, maxHeight: '92%', minWidth: 0, display: 'flex', flexDirection: 'column' }}
    >
      <GenericDialog dialog={dialog} interactive={active} queued={queued} onRespond={onRespond} />
    </MotionDiv>
  )
}

function QuestionnaireOverlay({ questionnaire, submitting, controller }: { questionnaire: AskUserQuestionnaire; submitting: boolean; controller: WorkbenchController }) {
  const { mobile } = useResponsiveLayout()
  const [currentTab, setCurrentTab] = useState(0)
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() => questionnaire.questions.map((question) => ({
    kind: question.multiSelect ? 'multi' : 'none',
    optionIndex: undefined,
    optionIndices: [],
    custom: '',
  })))
  const submitTab = questionnaire.questions.length
  const complete = drafts.every((draft, index) => questionnaire.questions[index]?.multiSelect || draft.kind === 'option' || (draft.kind === 'custom' && draft.custom.trim().length > 0))

  const updateDraft = (index: number, update: (draft: AnswerDraft) => AnswerDraft) => {
    setDrafts((current) => current.map((draft, candidate) => candidate === index ? update(draft) : draft))
  }
  const submit = () => {
    if (!complete || submitting) return
    const answers: AskUserSubmissionAnswer[] = questionnaire.questions.map((question, index) => {
      const draft = drafts[index]!
      if (draft.kind === 'custom') return { kind: 'custom', value: draft.custom }
      if (question.multiSelect) return { kind: 'multi', optionIndices: draft.optionIndices }
      return { kind: 'option', optionIndex: draft.optionIndex! }
    })
    controller.submitAskUserQuestionnaire(questionnaire.toolCallId, answers)
  }

  const activeQuestion = currentTab < submitTab ? questionnaire.questions[currentTab] : undefined
  return (
    <div testId="ask-user-overlay" style={{ pointerEvents: 'auto', width: '100%', height: '100%', maxWidth: 1040, minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: 9, borderWidth: 0, backgroundColor: colors.background, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 62, paddingLeft: mobile ? 14 : 20, paddingRight: mobile ? 8 : 12, borderBottomWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background }}>
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <text style={{ color: colors.warning, fontSize: 9, fontWeight: 750 }}>ASK USER QUESTION</text>
          <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>The agent needs a decision before it can continue</text>
        </div>
        <Button label="Hide" compact tone="quiet" onClick={() => controller.setAskUserQuestionnaireCollapsed(questionnaire.toolCallId, true)} testId="ask-user-collapse" />
      </div>

      <QuestionTabs questionnaire={questionnaire} currentTab={currentTab} drafts={drafts} onChange={setCurrentTab} />

      {activeQuestion
        ? <QuestionPage question={activeQuestion} index={currentTab} draft={drafts[currentTab]!} onChange={(update) => updateDraft(currentTab, update)} />
        : <QuestionnaireReview questionnaire={questionnaire} drafts={drafts} complete={complete} onSelect={setCurrentTab} />}

      <div style={{ minHeight: 56, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14, borderTopWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background }}>
        <Button label="Cancel" compact tone="quiet" disabled={submitting} onClick={() => controller.cancelAskUserQuestionnaire(questionnaire.toolCallId)} />
        <div style={{ flexGrow: 1 }} />
        {currentTab > 0 && <Button label="Back" compact onClick={() => setCurrentTab((value) => Math.max(0, value - 1))} />}
        {currentTab < submitTab
          ? <Button label={currentTab === submitTab - 1 ? 'Review' : 'Next'} compact tone="primary" onClick={() => setCurrentTab((value) => Math.min(submitTab, value + 1))} />
          : <Button label={submitting ? 'Sending…' : 'Submit answers'} compact tone="primary" disabled={!complete || submitting} onClick={submit} testId="ask-user-submit" />}
      </div>
    </div>
  )
}

function QuestionTabs({ questionnaire, currentTab, drafts, onChange }: { questionnaire: AskUserQuestionnaire; currentTab: number; drafts: AnswerDraft[]; onChange(index: number): void }) {
  return (
    <div testId="ask-user-tabs" style={{ display: 'flex', flexDirection: 'row', gap: 0, minHeight: 46, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, overflow: 'scroll' }}>
      {questionnaire.questions.map((question, index) => {
        const active = currentTab === index
        const answered = drafts[index]?.kind === 'option'
          || (drafts[index]?.kind === 'multi' && (drafts[index]?.optionIndices.length ?? 0) > 0)
          || (drafts[index]?.kind === 'custom' && Boolean(drafts[index]?.custom.trim()))
        return (
          <div key={`${index}-${question.header}`} testId={`ask-user-tab-${index}`} tabIndex={0} style={{ minWidth: 118, height: 46, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 10, borderRadius: 0, borderWidth: 0, borderBottomWidth: active ? 2 : 0, borderColor: active ? colors.primary : colors.transparent, backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => onChange(index)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(index) }}>
            <text style={{ color: answered ? colors.success : colors.textFaint, fontSize: 10 }}>{answered ? '✓' : String(index + 1)}</text>
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{question.header}</text>
          </div>
        )
      })}
      <div testId="ask-user-tab-submit" tabIndex={0} style={{ minWidth: 94, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 0, borderWidth: 0, borderBottomWidth: currentTab === questionnaire.questions.length ? 2 : 0, borderColor: currentTab === questionnaire.questions.length ? colors.primary : colors.transparent, backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => onChange(questionnaire.questions.length)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(questionnaire.questions.length) }}>
        <text style={{ color: currentTab === questionnaire.questions.length ? colors.text : colors.textMuted, fontSize: 10, fontWeight: 600 }}>Submit</text>
      </div>
    </div>
  )
}

function QuestionPage({ question, index, draft, onChange }: { question: AskUserQuestion; index: number; draft: AnswerDraft; onChange(update: (draft: AnswerDraft) => AnswerDraft): void }) {
  const { mobile } = useResponsiveLayout()
  const hasPreviews = !question.multiSelect && question.options.some((option) => option.preview)
  const previewIndex = draft.kind === 'option' ? draft.optionIndex : question.options.findIndex((option) => option.preview)
  const preview = previewIndex === undefined || previewIndex < 0 ? undefined : question.options[previewIndex]?.preview
  return (
    <div style={{ minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: mobile && hasPreviews ? 'column' : 'row', overflow: 'hidden' }}>
      <div style={{ width: mobile ? '100%' : hasPreviews ? '42%' : '100%', height: mobile && hasPreviews ? '58%' : 'auto', minWidth: mobile ? 0 : hasPreviews ? 280 : 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 0, paddingTop: mobile ? 14 : 18, paddingRight: mobile ? 14 : 18, paddingBottom: mobile ? 14 : 18, paddingLeft: mobile ? 14 : 18, borderRightWidth: hasPreviews && !mobile ? 1 : 0, borderBottomWidth: hasPreviews && mobile ? 1 : 0, borderColor: colors.borderStrong, backgroundColor: colors.background, overflow: 'scroll' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingBottom: 15 }}>
          <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>{`QUESTION ${index + 1} · ${question.header.toUpperCase()}`}</text>
          <text testId="ask-user-question" style={{ color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: 650, whiteSpace: 'normal' }}>{question.question}</text>
          {question.multiSelect && <text style={{ color: colors.textMuted, fontSize: 10 }}>Choose any number of options, or enter a custom answer.</text>}
        </div>
        {question.options.map((option, optionIndex) => {
          const selected = draft.kind === 'option'
            ? draft.optionIndex === optionIndex
            : draft.kind === 'multi' && draft.optionIndices.includes(optionIndex)
          const choose = () => onChange((current) => {
            if (!question.multiSelect) return { ...current, kind: 'option', optionIndex, custom: '' }
            const present = current.kind === 'multi' ? current.optionIndices : []
            return {
              ...current,
              kind: 'multi',
              custom: '',
              optionIndex: undefined,
              optionIndices: present.includes(optionIndex) ? present.filter((value) => value !== optionIndex) : [...present, optionIndex],
            }
          })
          return <QuestionOption key={`${optionIndex}-${option.label}`} index={optionIndex} label={option.label} description={option.description} selected={selected} multi={question.multiSelect} onClick={choose} />
        })}
        <div testId="ask-user-custom-option" tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 7, minHeight: 48, paddingTop: 12, paddingRight: 10, paddingBottom: 12, paddingLeft: 10, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: draft.kind === 'custom' ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={() => onChange((current) => ({ ...current, kind: 'custom', optionIndex: undefined, optionIndices: [] }))} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange((current) => ({ ...current, kind: 'custom', optionIndex: undefined, optionIndices: [] })) }}>
          <text style={{ color: draft.kind === 'custom' ? colors.text : colors.textMuted, fontSize: 11, fontWeight: 650 }}>Type something else</text>
          {draft.kind === 'custom' && (
            <textarea testId="ask-user-custom-input" value={draft.custom} placeholder="Enter your answer…" minRows={2} maxRows={5} autoFocus theme={nativeTheme} style={{ width: '100%', minWidth: 0, padding: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, color: colors.text, fontSize: 11, lineHeight: 17 }} onChange={(event) => onChange((current) => ({ ...current, custom: String(event.value ?? '') }))} />
          )}
        </div>
      </div>
      {hasPreviews && (
        <div testId="ask-user-preview" style={{ minWidth: 0, minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: mobile ? 14 : 20, backgroundColor: colors.card, overflow: 'scroll' }}>
          <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>PREVIEW</text>
          {preview
            ? <markdown source={preview} theme={questionnaireMarkdownTheme()} style={{ width: '100%', minWidth: 0 }} onLinkClick={(event) => openExternal(String(event.value ?? ''))} />
            : <text style={{ color: colors.textFaint, fontSize: 11 }}>This option has no preview.</text>}
        </div>
      )}
    </div>
  )
}

function QuestionOption({ index, label, description, selected, multi, onClick }: { index: number; label: string; description: string; selected: boolean; multi: boolean; onClick(): void }) {
  return (
    <div testId={`ask-user-option-${index}`} tabIndex={0} style={{ minHeight: 62, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 12, paddingRight: 10, paddingBottom: 12, paddingLeft: 10, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: selected ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onClick() }}>
      <div style={{ width: 20, height: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}><text style={{ color: selected ? colors.info : colors.textFaint, fontSize: 9, fontWeight: selected ? 700 : 500 }}>{selected ? '✓' : multi ? '□' : String(index + 1).padStart(2, '0')}</text></div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: selected ? colors.text : colors.textMuted, fontSize: 12, fontWeight: 650, whiteSpace: 'normal' }}>{label}</text>
        <text style={{ color: colors.textFaint, fontSize: 10, lineHeight: 15, whiteSpace: 'normal' }}>{description}</text>
      </div>
    </div>
  )
}

function QuestionnaireReview({ questionnaire, drafts, complete, onSelect }: { questionnaire: AskUserQuestionnaire; drafts: AnswerDraft[]; complete: boolean; onSelect(index: number): void }) {
  return (
    <div testId="ask-user-review" style={{ minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: 16, overflow: 'scroll' }}>
      <text style={{ color: colors.text, fontSize: 15, fontWeight: 650 }}>Review answers</text>
      {!complete && <text style={{ color: colors.warning, fontSize: 10 }}>Choose an answer for each single-choice question before submitting.</text>}
      {questionnaire.questions.map((question, index) => {
        const draft = drafts[index]!
        const answer = draft.kind === 'option'
          ? question.options[draft.optionIndex!]?.label
          : draft.kind === 'custom'
            ? draft.custom.trim() || 'Unanswered'
            : draft.optionIndices.length > 0
              ? draft.optionIndices.map((optionIndex) => question.options[optionIndex]?.label).filter(Boolean).join(', ')
              : 'No options selected'
        return (
          <div key={`${index}-${question.question}`} testId={`ask-user-review-${index}`} tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 5, minHeight: 88, paddingTop: 14, paddingRight: 10, paddingBottom: 14, paddingLeft: 10, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={() => onSelect(index)} onKeyDown={(event) => { if (event.key === 'enter') onSelect(index) }}>
            <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 700 }}>{question.header.toUpperCase()}</text>
            <text style={{ color: colors.text, fontSize: 11, fontWeight: 600, whiteSpace: 'normal' }}>{question.question}</text>
            <text style={{ color: answer === 'Unanswered' ? colors.warning : colors.textMuted, fontSize: 11, whiteSpace: 'normal' }}>{answer}</text>
          </div>
        )
      })}
    </div>
  )
}

function GenericDialog({ dialog, interactive, queued, onRespond }: { dialog: ExtensionDialog; interactive: boolean; queued: number; onRespond(response: ExtensionDialogResponse): void }) {
  const [valueState, setValueState] = useState(() => ({ dialogId: dialog.id, value: dialog.prefill ?? '' }))
  const [queryState, setQueryState] = useState(() => ({ dialogId: dialog.id, value: '' }))
  const value = valueState.dialogId === dialog.id ? valueState.value : dialog.prefill ?? ''
  const query = queryState.dialogId === dialog.id ? queryState.value : ''
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (dialog.deadlineAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [dialog.deadlineAt])
  const title = parseExtensionTitle(dialog.title)
  const options = useMemo(() => (dialog.options ?? []).map(parseExtensionOption), [dialog.options])
  const filtered = useMemo(() => filterExtensionOptions(options, query), [options, query])
  const remaining = dialog.deadlineAt === undefined ? undefined : Math.max(0, Math.ceil((dialog.deadlineAt - now) / 1_000))
  const cancelLabel = title.title.includes('›') ? 'Back' : 'Cancel'

  return (
    <div testId="extension-dialog" style={{ pointerEvents: interactive ? 'auto' : 'none', width: '100%', maxWidth: 820, maxHeight: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', minWidth: 0, gap: 9 }}>
        <div testId="extension-dialog-marker" style={{ width: 6, height: 6, marginTop: 6, flexShrink: 0, borderRadius: 3, backgroundColor: colors.warning }} />
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <text testId="extension-dialog-title" style={{ color: colors.text, fontSize: 13, fontWeight: 650, lineHeight: 18, minWidth: 0, width: '100%', whiteSpace: 'normal' }}>{title.title}</text>
          {title.detail && <text style={{ color: colors.textMuted, fontSize: 10, lineHeight: 15, width: '100%', maxHeight: 76, whiteSpace: 'normal', overflow: 'hidden' }}>{title.detail}</text>}
        </div>
        {(queued > 0 || remaining !== undefined) && <text style={{ color: colors.textFaint, fontSize: 9, flexShrink: 0 }}>{[queued > 0 ? `1 of ${queued + 1}` : '', remaining !== undefined ? `${remaining}s` : ''].filter(Boolean).join(' · ')}</text>}
      </div>
      {dialog.message && <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17, minWidth: 0, width: '100%', whiteSpace: 'normal' }}>{dialog.message}</text>}
      {dialog.method === 'select' && (
        <>
          {options.length > 5 && (
            <div testId="extension-dialog-search-frame" style={{ width: '100%', height: 34, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 10, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
              <input testId="extension-dialog-search" value={query} placeholder="Search choices…" autoFocus theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }} style={{ minWidth: 0, height: 28, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 11 }} onChange={(event) => setQueryState({ dialogId: dialog.id, value: String(event.value ?? '') })} />
            </div>
          )}
          <MotionDiv key={dialog.id} testId="extension-dialog-options" initial={{ opacity: 0.96, top: 4 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: DIALOG_TRANSITION_SECONDS, ease: 'easeOut' }} style={{ position: 'relative', minHeight: 0, maxHeight: 360, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'scroll' }}>
            {filtered.map((option, index) => (
              <div key={`${index}-${option.value}`} testId={`extension-dialog-option-${index}`} tabIndex={0} style={{ minHeight: option.detail ? 52 : 48, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, paddingTop: option.detail ? 9 : 0, paddingRight: 9, paddingBottom: option.detail ? 9 : 0, paddingLeft: 9, borderRadius: 8, borderWidth: 0, borderBottomWidth: 0, backgroundColor: colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={() => onRespond({ value: option.value })} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onRespond({ value: option.value }) }}>
                {option.ordinal && <text style={{ width: 19, color: colors.textFaint, fontSize: 10, flexShrink: 0 }}>{option.ordinal}</text>}
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
                  <text testId={`extension-dialog-option-label-${index}`} style={{ color: colors.text, fontSize: 11, lineHeight: 16, fontWeight: 600, whiteSpace: 'normal' }}>{option.label}</text>
                  {option.detail && <text style={{ color: colors.textFaint, fontSize: 10, lineHeight: 15, whiteSpace: 'normal' }}>{option.detail}</text>}
                </div>
              </div>
            ))}
            {filtered.length === 0 && <text style={{ color: colors.textFaint, fontSize: 10, padding: 12 }}>No choices match your search.</text>}
          </MotionDiv>
          <div style={{ display: 'flex', flexDirection: 'row' }}><Button label={cancelLabel} tone="quiet" compact onClick={() => onRespond({ cancelled: true })} /></div>
        </>
      )}
      {dialog.method === 'confirm' && (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 7 }}>
          <Button label="Confirm" tone="primary" onClick={() => onRespond({ confirmed: true })} />
          <Button label="Decline" onClick={() => onRespond({ confirmed: false })} />
          <Button label={cancelLabel} tone="quiet" onClick={() => onRespond({ cancelled: true })} />
        </div>
      )}
      {(dialog.method === 'input' || dialog.method === 'editor') && (
        <>
          <textarea testId="extension-dialog-input" value={value} placeholder={dialog.placeholder ?? ''} minRows={dialog.method === 'editor' ? 5 : 1} maxRows={dialog.method === 'editor' ? 12 : 4} autoFocus theme={nativeTheme} style={{ width: '100%', minWidth: 0, padding: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, color: colors.text, fontSize: 12, lineHeight: 18 }} onChange={(event) => setValueState({ dialogId: dialog.id, value: String(event.value ?? '') })} onSubmit={() => onRespond({ value })} />
          <div style={{ display: 'flex', flexDirection: 'row', gap: 7 }}>
            <Button label="Submit" tone="primary" onClick={() => onRespond({ value })} />
            <Button label={cancelLabel} tone="quiet" onClick={() => onRespond({ cancelled: true })} />
          </div>
        </>
      )}
    </div>
  )
}

function questionnaireMarkdownTheme() {
  return {
    ...nativeTheme,
    text: colors.textMuted,
    textMuted: colors.textFaint,
    metrics: {
      ...nativeTheme.metrics,
      mdTextSize: 12,
      mdLineHeight: 19,
      mdBlockGap: 8,
      mdHeadingSizes: [14, 13, 12, 12],
      mdHeadingLineHeights: [21, 20, 19, 19],
      codeTextSize: 11,
      codeLineHeight: 18,
    },
  }
}
