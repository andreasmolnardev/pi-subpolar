interface AssistantSuggestionsProps {
  suggestions: string[]
  onSelect: (suggestion: string) => void
}

export function AssistantSuggestions({ suggestions, onSelect }: AssistantSuggestionsProps) {
  if (suggestions.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 pt-1" aria-label="Suggested follow-up messages">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          className="rounded-full border border-border bg-background px-3 py-1 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onSelect(suggestion)}
        >
          {suggestion}
        </button>
      ))}
    </div>
  )
}
