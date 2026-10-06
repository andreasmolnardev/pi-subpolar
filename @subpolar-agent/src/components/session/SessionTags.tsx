import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { updateStoredSession } from '@/api/sessions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { StoredSession } from '@/api/sessions'

const MAX_TAG_LENGTH = 32
const MAX_TAGS = 20
const TAG_PATTERN = /^[\p{L}\p{N}_ -]+$/u

export function SessionTags({ session }: { session: StoredSession }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (tags: string[]) => updateStoredSession(session.id, { tags }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })

  const saveTags = (tags: string[]) => mutation.mutate(tags)

  const addTag = () => {
    const tag = draft.trim()
    if (!tag) {
      setValidationError('Enter a tag first.')
      return
    }
    if (tag.length > MAX_TAG_LENGTH) {
      setValidationError(`Tags must be ${MAX_TAG_LENGTH} characters or fewer.`)
      return
    }
    if (!TAG_PATTERN.test(tag)) {
      setValidationError('Use letters, numbers, spaces, hyphens, or underscores.')
      return
    }
    if (session.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setValidationError('That tag is already added.')
      return
    }
    if (session.tags.length >= MAX_TAGS) {
      setValidationError(`You can add up to ${MAX_TAGS} tags.`)
      return
    }
    setValidationError(null)
    setDraft('')
    saveTags([...session.tags, tag])
  }

  const removeTag = (tagToRemove: string) => {
    setValidationError(null)
    saveTags(session.tags.filter((tag) => tag !== tagToRemove))
  }

  return (
    <div className="mt-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1" aria-label="Session tags">
        {session.tags.map((tag) => (
          <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground">
            <span className="truncate">{tag}</span>
            <button
              type="button"
              className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove tag ${tag}`}
              disabled={mutation.isPending}
              onClick={() => removeTag(tag)}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <form
        className="mt-2 flex max-w-sm items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          addTag()
        }}
      >
        <Input
          aria-label="New session tag"
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          placeholder="Add a tag"
          disabled={mutation.isPending}
          onChange={(event) => {
            setDraft(event.target.value)
            setValidationError(null)
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={mutation.isPending || !draft.trim()}>
          {mutation.isPending ? 'Saving...' : 'Add'}
        </Button>
      </form>
      {validationError ? <p className="mt-1 text-xs text-destructive" role="alert">{validationError}</p> : null}
      {mutation.isError ? <p className="mt-1 text-xs text-destructive" role="alert">Could not save tags. Please try again.</p> : null}
    </div>
  )
}
