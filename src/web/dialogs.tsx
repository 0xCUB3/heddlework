import { useEffect, useMemo, useState } from 'react'
import { questionnaireFromTool, type AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Dialogs({ state }: { state: WorkbenchSnapshot }) {
  const questionnaire = useMemo(() => {
    for (const tool of state.liveTools) {
      const found = questionnaireFromTool(tool)
      if (found) return found
    }
    return undefined
  }, [state.liveTools])
  const dialog = state.dialog
  if (questionnaire) return <AskUserForm toolCallId={questionnaire.toolCallId} questions={questionnaire.questions} />
  if (!dialog) return null

  const respond = (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    void workspaceClient().send({ type: 'respondToDialog', ...payload })
  }

  if (dialog.method === 'confirm') {
    return <ConfirmSheet title={dialog.title} message={dialog.message} deadlineAt={dialog.deadlineAt} onApprove={() => respond({ confirmed: true })} onDeny={() => respond({ confirmed: false, cancelled: true })} />
  }

  return (
    <div className="web-dialog" role="dialog" aria-label={dialog.title}>
      <h2>{dialog.title}</h2>
      {dialog.message ? <p>{dialog.message}</p> : null}
      {dialog.method === 'select' ? (dialog.options ?? []).map((option) => (
        <button key={option} type="button" onClick={() => respond({ value: option })}>{option}</button>
      )) : null}
      {dialog.method === 'input' || dialog.method === 'editor' ? (
        <PromptDialog placeholder={dialog.placeholder} prefill={dialog.prefill} onSubmit={(value) => respond({ value })} onCancel={() => respond({ cancelled: true })} />
      ) : null}
      {dialog.method === 'tree' ? (dialog.treeOptions ?? []).map((option) => (
        <button key={option.entryId} type="button" onClick={() => respond({ value: option.entryId })}>{option.title}</button>
      )) : null}
    </div>
  )
}

function ConfirmSheet({ title, message, deadlineAt, onApprove, onDeny }: { title: string; message?: string | undefined; deadlineAt?: number | undefined; onApprove: () => void; onDeny: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (deadlineAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [deadlineAt])
  const remaining = deadlineAt === undefined ? undefined : Math.max(0, Math.ceil((deadlineAt - now) / 1000))
  return (
    <div className="web-dialog web-dialog-confirm web-sheet" role="dialog" aria-label={title}>
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
      {remaining !== undefined ? <p className="web-meta">{remaining}s</p> : null}
      <div className="web-composer-row">
        <button type="button" className="web-approve" onClick={onApprove}>Approve</button>
        <button type="button" className="web-deny" onClick={onDeny}>Deny</button>
      </div>
    </div>
  )
}

function PromptDialog({ placeholder, prefill, onSubmit, onCancel }: { placeholder?: string | undefined; prefill?: string | undefined; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(prefill ?? '')
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(value) }}>
      <textarea placeholder={placeholder} value={value} onChange={(event) => setValue(event.target.value)} />
      <div className="web-composer-row">
        <button type="submit">OK</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function AskUserForm({ toolCallId, questions }: { toolCallId: string; questions: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string }> }> }) {
  const [answers, setAnswers] = useState<AskUserSubmissionAnswer[]>(questions.map((question) => (
    question.multiSelect ? { kind: 'multi', optionIndices: [] } : { kind: 'option', optionIndex: 0 }
  )))
  return (
    <form className="web-dialog" onSubmit={(event) => {
      event.preventDefault()
      void workspaceClient().send({ type: 'submitAskUserQuestionnaire', toolCallId, answers })
    }}>
      {questions.map((question, index) => (
        <fieldset key={question.header}>
          <legend>{question.header}</legend>
          <p>{question.question}</p>
          {question.options.map((option, optionIndex) => (
            <label key={option.label}>
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`q-${index}`}
                checked={checkedAnswer(answers[index], question.multiSelect, optionIndex)}
                onChange={() => {
                  setAnswers((current) => current.map((answer, answerIndex) => {
                    if (answerIndex !== index) return answer
                    if (question.multiSelect && answer.kind === 'multi') {
                      const next = answer.optionIndices.includes(optionIndex)
                        ? answer.optionIndices.filter((value) => value !== optionIndex)
                        : [...answer.optionIndices, optionIndex]
                      return { kind: 'multi', optionIndices: next }
                    }
                    return { kind: 'option', optionIndex }
                  }))
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="web-composer-row">
        <button type="submit">Submit</button>
        <button type="button" onClick={() => void workspaceClient().send({ type: 'cancelAskUserQuestionnaire', toolCallId })}>Cancel</button>
      </div>
    </form>
  )
}

function checkedAnswer(answer: AskUserSubmissionAnswer | undefined, multi: boolean, optionIndex: number): boolean {
  if (!answer) return false
  if (multi && answer.kind === 'multi') return answer.optionIndices.includes(optionIndex)
  return answer.kind === 'option' && answer.optionIndex === optionIndex
}
